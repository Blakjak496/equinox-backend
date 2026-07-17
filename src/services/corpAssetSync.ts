import { getAccessToken } from "../lib/esiClient";
import { BuybackItem, IBuybackItemLocationStock } from "../models/BuybackItem";
import { BuybackLocation } from "../models/BuybackLocation";
import { EsiAuth } from "../models/EsiAuth";
import { getEsiLimitInfo } from "../utils/general-utils";

const USER_AGENT = "EquinoxGalactic (corp asset sync)";
const ERROR_BUDGET_CIRCUIT_BREAKER = 10;
// Corp hangar "Division 6" - the resale stock hangar. Other divisions hold
// unrelated JF fuel/industry materials and must not be counted as stock.
const STOCK_LOCATION_FLAG = "CorpSAG6";

type EsiCorpAsset = {
  item_id: number;
  type_id: number;
  quantity: number;
  location_id: number;
  location_flag: string;
  location_type: string;
  is_singleton: boolean;
};

let running = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Items sitting inside a container or ship that's itself parked in a hangar
// (rather than loose) report location_id as that container/ship's own
// item_id, not the station/structure - while location_flag still reflects
// the parent hangar's flag. Resolving up through the asset tree (climbing
// via item_id -> location_id until a location_id isn't itself another
// asset in this same fetch) recovers the true top-level location regardless
// of nesting depth.
function resolveTopLevelLocationId(
  asset: EsiCorpAsset,
  assetsByItemId: Map<number, EsiCorpAsset>,
): number {
  let locationId = asset.location_id;
  const seen = new Set<number>();
  while (assetsByItemId.has(locationId) && !seen.has(locationId)) {
    seen.add(locationId);
    locationId = assetsByItemId.get(locationId)!.location_id;
  }
  return locationId;
}

async function esiFetch(url: string, token: string, retriesLeft = 3): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });

  if ((res.status === 429 || res.status === 420) && retriesLeft > 0) {
    const retryAfter = Number(res.headers.get("retry-after")) || 60;
    console.warn(
      `[corpAssetSync] ${res.status} received, sleeping ${retryAfter}s before retry`,
    );
    await sleep(retryAfter * 1000);
    return esiFetch(url, token, retriesLeft - 1);
  }

  const { remain, reset } = getEsiLimitInfo(res.headers);
  if (remain !== null && reset !== null && remain < ERROR_BUDGET_CIRCUIT_BREAKER) {
    console.warn(
      `[corpAssetSync] error budget low (remain=${remain}), sleeping ${reset}s`,
    );
    await sleep(reset * 1000);
  }

  return res;
}

// The corp-assets endpoint returns every asset the corp owns across every
// station/structure in one paginated response - there's no location filter
// param, so this fetches the whole thing once and the caller filters down
// to the configured stock locations/division.
async function fetchAllCorpAssets(
  corporationId: number,
  token: string,
): Promise<EsiCorpAsset[]> {
  const baseUrl = `https://esi.evetech.net/latest/corporations/${corporationId}/assets/?datasource=tranquility`;

  const firstRes = await esiFetch(`${baseUrl}&page=1`, token);
  if (!firstRes.ok) {
    const body = await firstRes.text().catch(() => "");
    throw new Error(
      `ESI corp assets failed on page 1 for corporationId=${corporationId}: ${firstRes.status} ${body}`,
    );
  }

  const totalPages = Number(firstRes.headers.get("x-pages")) || 1;
  const firstPage = (await firstRes.json()) as EsiCorpAsset[];
  const assets = [...firstPage];

  for (let page = 2; page <= totalPages; page++) {
    const res = await esiFetch(`${baseUrl}&page=${page}`, token);
    if (!res.ok) {
      console.warn(`[corpAssetSync] assets page ${page} failed: ${res.status}`);
      continue;
    }
    assets.push(...((await res.json()) as EsiCorpAsset[]));
  }

  return assets;
}

export type CorpAssetSyncResult =
  | {
      ok: true;
      assetsScanned: number;
      hubLocationCount: number;
      itemsChanged: number;
      itemsTotal: number;
      durationSec: number;
    }
  | { ok: false; reason: "already_running" }
  | { ok: false; reason: "no_stock_locations" }
  | { ok: false; reason: "error"; message: string };

export async function syncCorpAssetStock(): Promise<CorpAssetSyncResult> {
  if (running) {
    console.log("[corpAssetSync] already running, skipping this trigger");
    return { ok: false, reason: "already_running" };
  }
  running = true;
  const startedAt = Date.now();

  try {
    // Only hub locations are eligible to sell stock from - satellite
    // locations are collection points for buyback, not warehouses, and
    // fulfilling an order by shipping between locations is an extra cost
    // that's out of scope for this service.
    const stockLocations = await BuybackLocation.find({
      stockLocationId: { $ne: null },
      isHub: true,
    });

    if (stockLocations.length === 0) {
      console.log(
        "[corpAssetSync] no hub BuybackLocation has a stockLocationId set, skipping",
      );
      return { ok: false, reason: "no_stock_locations" };
    }

    const locationByStockLocationId = new Map(
      stockLocations.map((loc) => [Number(loc.stockLocationId), loc]),
    );
    const qualifyingLocationIds = new Set(
      stockLocations.map((loc) => String(loc._id)),
    );

    // Anything ESI-related (token refresh, the assets call itself) is the
    // one part of this run that can genuinely fail at runtime - e.g. a
    // missing scope or a director losing the corp role needed to read
    // assets. Caught here (rather than left to throw into an un-awaited
    // cron callback) so both the cron and the admin's manual trigger get a
    // clean result back instead of an unhandled rejection.
    let assets;
    try {
      const token = await getAccessToken();
      const auth = await EsiAuth.findOne();
      const corporationId = Number(auth!.corporationId);
      assets = await fetchAllCorpAssets(corporationId, token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[corpAssetSync] failed to fetch corp assets:", err);
      return { ok: false, reason: "error", message };
    }

    const items = await BuybackItem.find();
    const catalogTypeIds = new Set(items.map((item) => item.typeId));

    // Every asset in this fetch, keyed by its own item_id - used to resolve
    // nested items (in a container/ship sitting in the hangar) up to their
    // true top-level station/structure location.
    const assetsByItemId = new Map(assets.map((a) => [a.item_id, a]));

    // Diagnostics: when a run finds nothing, this pinpoints exactly which
    // filter excluded everything (wrong location_flag, resolved location not
    // matching a configured stock location, or the type just isn't in the
    // catalog) without needing a code change to investigate.
    const flagCounts = new Map<string, number>();
    for (const asset of assets) {
      flagCounts.set(
        asset.location_flag,
        (flagCounts.get(asset.location_flag) ?? 0) + 1,
      );
    }
    const stockFlagAssets = assets.filter(
      (asset) => asset.location_flag === STOCK_LOCATION_FLAG,
    );
    const atConfiguredLocation = stockFlagAssets.filter((asset) =>
      locationByStockLocationId.has(
        resolveTopLevelLocationId(asset, assetsByItemId),
      ),
    );
    const inCatalog = atConfiguredLocation.filter((asset) =>
      catalogTypeIds.has(asset.type_id),
    );
    console.log(
      `[corpAssetSync] diagnostics: location_flag breakdown = ${Array.from(
        flagCounts.entries(),
      )
        .map(([flag, count]) => `${flag}:${count}`)
        .join(", ")}`,
    );
    console.log(
      `[corpAssetSync] diagnostics: ${stockFlagAssets.length} assets have location_flag=${STOCK_LOCATION_FLAG}, ${atConfiguredLocation.length} of those are at a configured stock location (after resolving container/ship nesting), ${inCatalog.length} of those match a catalog typeId`,
    );
    if (stockFlagAssets.length > 0 && atConfiguredLocation.length === 0) {
      console.log(
        `[corpAssetSync] diagnostics: raw dump of ${STOCK_LOCATION_FLAG} assets: ${JSON.stringify(
          stockFlagAssets.map((a) => ({
            item_id: a.item_id,
            location_id: a.location_id,
            location_type: a.location_type,
            location_flag: a.location_flag,
            is_singleton: a.is_singleton,
            type_id: a.type_id,
            quantity: a.quantity,
          })),
        )}`,
      );
    }
    if (stockFlagAssets.length > 0 && atConfiguredLocation.length === 0) {
      const sampleLocationIds = Array.from(
        new Set(
          stockFlagAssets.map(
            (a) =>
              `${a.location_id}->resolved:${resolveTopLevelLocationId(a, assetsByItemId)}`,
          ),
        ),
      ).slice(0, 5);
      console.log(
        `[corpAssetSync] diagnostics: sample location_id(s) seen on CorpSAG6 assets: ${sampleLocationIds.join(", ")} - configured stockLocationId(s): ${Array.from(locationByStockLocationId.keys()).join(", ")}`,
      );
    }

    // Bucketed by BuybackLocation._id (as a string) -> typeId -> quantity.
    const quantityByLocationAndType = new Map<string, Map<number, number>>();
    for (const asset of assets) {
      if (asset.location_flag !== STOCK_LOCATION_FLAG) continue;
      const resolvedLocationId = resolveTopLevelLocationId(
        asset,
        assetsByItemId,
      );
      const location = locationByStockLocationId.get(resolvedLocationId);
      if (!location) continue;

      const locationKey = String(location._id);
      const byType =
        quantityByLocationAndType.get(locationKey) ?? new Map<number, number>();
      byType.set(asset.type_id, (byType.get(asset.type_id) ?? 0) + asset.quantity);
      quantityByLocationAndType.set(locationKey, byType);
    }

    const now = new Date();
    let changed = 0;

    for (const item of items) {
      // Drop any existing entries for locations that no longer qualify
      // (unhubbed, or stockLocationId cleared) before writing fresh ones.
      const priorByLocation = new Map(
        item.stockByLocation
          .filter((entry) => qualifyingLocationIds.has(String(entry.locationId)))
          .map((entry) => [String(entry.locationId), entry]),
      );

      const nextStockByLocation: IBuybackItemLocationStock[] = [];
      let itemChanged = item.stockByLocation.length !== priorByLocation.size;

      for (const location of stockLocations) {
        const locationKey = String(location._id);
        const newQuantity =
          quantityByLocationAndType.get(locationKey)?.get(item.typeId) ?? 0;
        const prior = priorByLocation.get(locationKey);
        const previousQuantity = prior?.quantity ?? 0;

        let oldestUnsoldAcquiredAt = prior?.oldestUnsoldAcquiredAt ?? null;
        if (previousQuantity === 0 && newQuantity > 0) {
          oldestUnsoldAcquiredAt = now;
        } else if (newQuantity === 0) {
          oldestUnsoldAcquiredAt = null;
        }

        // Locations the item has never had stock at are skipped entirely -
        // no point carrying a permanent zero row for every item at every
        // hub.
        if (newQuantity === 0 && !prior) continue;

        if (newQuantity !== previousQuantity) itemChanged = true;

        nextStockByLocation.push({
          locationId: location._id,
          locationName: location.name,
          quantity: newQuantity,
          // stockUpdatedAt always advances, even when the quantity is
          // unchanged from last run - it reflects "confirmed accurate as of
          // this poll", which the admin freshness display depends on.
          stockUpdatedAt: now,
          oldestUnsoldAcquiredAt,
        });
      }

      if (!itemChanged) continue;

      await BuybackItem.updateOne(
        { _id: item._id },
        { stockByLocation: nextStockByLocation },
      );
      changed++;
    }

    const durationSec = (Date.now() - startedAt) / 1000;
    console.log(
      `[corpAssetSync] run complete in ${durationSec.toFixed(1)}s: ${assets.length} assets scanned across ${stockLocations.length} hub location(s), ${changed}/${items.length} items changed`,
    );

    return {
      ok: true,
      assetsScanned: assets.length,
      hubLocationCount: stockLocations.length,
      itemsChanged: changed,
      itemsTotal: items.length,
      durationSec,
    };
  } finally {
    running = false;
  }
}
