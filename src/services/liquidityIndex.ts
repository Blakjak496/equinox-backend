import { BuybackCategory } from "../models/BuybackCategory";
import { BuybackItem, IBuybackItem } from "../models/BuybackItem";
import { getEsiLimitInfo } from "../utils/general-utils";

const USER_AGENT = "EquinoxGalactic (liquidity index)";
const REGION_ID = 10000002; // The Forge - Jita's region
const HISTORY_DAYS = 30;
const HISTORY_REQ_PER_SEC = 4; // documented cap is 300/min (5/s) - stay under it
const HISTORY_INTERVAL_MS = 1000 / HISTORY_REQ_PER_SEC;
const ERROR_BUDGET_CIRCUIT_BREAKER = 10;
const ORDERS_PAGE_CONCURRENCY = 8;

type EsiMarketOrder = {
  type_id: number;
  is_buy_order: boolean;
  volume_remain: number;
};

type EsiMarketHistoryEntry = {
  volume: number;
  order_count: number;
};

type EsiTypeInfo = {
  volume?: number;
  packaged_volume?: number;
};

let running = false;
let lastHistoryRequestStartedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRateLimitHeader(headers: Headers) {
  const group = headers.get("x-ratelimit-group");
  const limitRaw = headers.get("x-ratelimit-limit"); // e.g. "150/15m"
  const remainingRaw = headers.get("x-ratelimit-remaining");
  const remaining = remainingRaw !== null ? Number(remainingRaw) : null;
  return { group, limitRaw, remaining };
}

// Wraps every ESI call made by this job: identifies itself with a proper
// User-Agent, checks the legacy error-budget headers (circuit-breaks by
// sleeping rather than aborting - this is a background job, not a live
// request), and retries once on 429/420 after honoring Retry-After.
async function esiFetch(url: string, retriesLeft = 3): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });

  if ((res.status === 429 || res.status === 420) && retriesLeft > 0) {
    const retryAfter = Number(res.headers.get("retry-after")) || 60;
    console.warn(
      `[liquidityIndex] ${res.status} received, sleeping ${retryAfter}s before retry`,
    );
    await sleep(retryAfter * 1000);
    return esiFetch(url, retriesLeft - 1);
  }

  const { remain, reset } = getEsiLimitInfo(res.headers);
  if (remain !== null && reset !== null && remain < ERROR_BUDGET_CIRCUIT_BREAKER) {
    console.warn(
      `[liquidityIndex] error budget low (remain=${remain}), sleeping ${reset}s`,
    );
    await sleep(reset * 1000);
  }

  return res;
}

async function paceHistoryRequest(): Promise<void> {
  const elapsed = Date.now() - lastHistoryRequestStartedAt;
  if (elapsed < HISTORY_INTERVAL_MS) {
    await sleep(HISTORY_INTERVAL_MS - elapsed);
  }
  lastHistoryRequestStartedAt = Date.now();
}

function aggregateOrdersPage(
  orders: EsiMarketOrder[],
  acceptedTypeIds: Set<number>,
  sellVolumeByType: Map<number, number>,
  buyOrderCountByType: Map<number, number>,
): void {
  for (const order of orders) {
    if (!acceptedTypeIds.has(order.type_id)) continue;
    if (order.is_buy_order) {
      buyOrderCountByType.set(
        order.type_id,
        (buyOrderCountByType.get(order.type_id) ?? 0) + 1,
      );
    } else {
      sellVolumeByType.set(
        order.type_id,
        (sellVolumeByType.get(order.type_id) ?? 0) + order.volume_remain,
      );
    }
  }
}

// One bulk sweep of Jita's entire order book covers every accepted item at
// once - far cheaper than a per-item orders call, since ESI has no type_id
// filter that would let us skip pages here anyway.
async function sweepJitaOrders(acceptedTypeIds: Set<number>): Promise<{
  sellVolumeByType: Map<number, number>;
  buyOrderCountByType: Map<number, number>;
}> {
  const sellVolumeByType = new Map<number, number>();
  const buyOrderCountByType = new Map<number, number>();

  const baseUrl = `https://esi.evetech.net/latest/markets/${REGION_ID}/orders/?datasource=tranquility`;

  const firstRes = await esiFetch(`${baseUrl}&page=1`);
  if (!firstRes.ok) {
    throw new Error(`ESI orders sweep failed on page 1: ${firstRes.status}`);
  }
  const totalPages = Number(firstRes.headers.get("x-pages")) || 1;
  console.log(`[liquidityIndex] orders sweep: ${totalPages} pages`);

  const firstPage = (await firstRes.json()) as EsiMarketOrder[];
  aggregateOrdersPage(
    firstPage,
    acceptedTypeIds,
    sellVolumeByType,
    buyOrderCountByType,
  );

  let lastRemaining: number | null = null;

  for (
    let start = 2;
    start <= totalPages;
    start += ORDERS_PAGE_CONCURRENCY
  ) {
    const pages: number[] = [];
    for (let p = start; p < start + ORDERS_PAGE_CONCURRENCY && p <= totalPages; p++) {
      pages.push(p);
    }

    const batchRemaining = await Promise.all(
      pages.map(async (page) => {
        const res = await esiFetch(`${baseUrl}&page=${page}`);
        if (!res.ok) {
          console.warn(`[liquidityIndex] orders page ${page} failed: ${res.status}`);
          return null;
        }
        const data = (await res.json()) as EsiMarketOrder[];
        aggregateOrdersPage(
          data,
          acceptedTypeIds,
          sellVolumeByType,
          buyOrderCountByType,
        );
        return parseRateLimitHeader(res.headers).remaining;
      }),
    );

    const seen = batchRemaining.filter((v): v is number => v !== null);
    if (seen.length > 0) lastRemaining = Math.min(...seen);

    const lastPageInBatch = Math.min(start + ORDERS_PAGE_CONCURRENCY - 1, totalPages);
    if (lastPageInBatch % 200 < ORDERS_PAGE_CONCURRENCY) {
      console.log(
        `[liquidityIndex] orders sweep progress: page ${lastPageInBatch}/${totalPages}, rl remaining=${lastRemaining ?? "unknown"}`,
      );
    }
  }

  return { sellVolumeByType, buyOrderCountByType };
}

async function fetchHistory(
  typeId: number,
): Promise<{ avgVolume: number; avgOrderCount: number } | null> {
  await paceHistoryRequest();

  const url = `https://esi.evetech.net/latest/markets/${REGION_ID}/history/?datasource=tranquility&type_id=${typeId}`;
  const res = await esiFetch(url);
  if (!res.ok) {
    console.warn(`[liquidityIndex] history fetch failed for typeId=${typeId}: ${res.status}`);
    return null;
  }

  const data = (await res.json()) as EsiMarketHistoryEntry[];
  const recent = data.slice(-HISTORY_DAYS);
  if (recent.length === 0) {
    return { avgVolume: 0, avgOrderCount: 0 };
  }

  const avgVolume = recent.reduce((sum, e) => sum + e.volume, 0) / recent.length;
  const avgOrderCount =
    recent.reduce((sum, e) => sum + e.order_count, 0) / recent.length;

  return { avgVolume, avgOrderCount };
}

async function fetchPackagedVolume(typeId: number): Promise<number | null> {
  const url = `https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility`;
  const res = await esiFetch(url);
  if (!res.ok) {
    console.warn(`[liquidityIndex] type lookup failed for typeId=${typeId}: ${res.status}`);
    return null;
  }

  const data = (await res.json()) as EsiTypeInfo;
  return data.packaged_volume ?? data.volume ?? null;
}

export function calculateLiquidity(params: {
  avgVolume: number;
  avgOrderCount: number;
  sellVolumeListed: number;
  buyActiveOrders: number;
  packagedVolume: number;
}): { liJita: number; lm: number } {
  const v =
    params.sellVolumeListed > 0 ? params.avgVolume / params.sellVolumeListed : 0;
  const c =
    params.buyActiveOrders > 0 ? params.avgOrderCount / params.buyActiveOrders : 0;
  const liJita = Math.min(1.0, 0.7 * v + 0.3 * c);
  const m = 1 + Math.log10(params.packagedVolume + 1);
  const lm = Math.pow(liJita, m);
  return { liJita, lm };
}

export async function updateLiquidityIndexForAllItems(): Promise<void> {
  if (running) {
    console.log("[liquidityIndex] already running, skipping this trigger");
    return;
  }
  running = true;
  const startedAt = Date.now();

  try {
    const categories = await BuybackCategory.find();
    const categoryById = new Map(
      categories.map((category) => [String(category._id), category]),
    );

    const allItems = await BuybackItem.find().sort({ liquidityUpdatedAt: 1 });
    const acceptedItems = allItems.filter((item) => {
      const category = categoryById.get(String(item.categoryId));
      const accepted = item.accepted ?? category?.accepted ?? false;
      return accepted;
    });

    console.log(
      `[liquidityIndex] ${acceptedItems.length}/${allItems.length} items are accepted - processing those`,
    );

    const acceptedTypeIds = new Set(acceptedItems.map((item) => item.typeId));

    console.log("[liquidityIndex] starting Jita orders sweep...");
    const { sellVolumeByType, buyOrderCountByType } =
      await sweepJitaOrders(acceptedTypeIds);
    console.log(
      `[liquidityIndex] sweep complete: ${sellVolumeByType.size} types with sell orders, ${buyOrderCountByType.size} types with buy orders`,
    );

    let updated = 0;
    let failed = 0;
    let skippedHistory = 0;

    for (const item of acceptedItems) {
      try {
        const sellVolumeListed = sellVolumeByType.get(item.typeId) ?? 0;
        const buyActiveOrders = buyOrderCountByType.get(item.typeId) ?? 0;

        if (sellVolumeListed === 0 && buyActiveOrders === 0) {
          // V and C are both mathematically forced to 0 by the
          // zero-denominator guard regardless of history data, so
          // LI_Jita = 0 and LM = 0 follow without spending a history call.
          await writeLiquidity(item, { liJita: 0, lm: 0 }, item.packagedVolume);
          skippedHistory++;
          updated++;
          continue;
        }

        let packagedVolume = item.packagedVolume;
        if (packagedVolume === null) {
          packagedVolume = await fetchPackagedVolume(item.typeId);
          if (packagedVolume === null) {
            failed++;
            continue;
          }
        }

        const history = await fetchHistory(item.typeId);
        if (history === null) {
          failed++;
          continue;
        }

        const { liJita, lm } = calculateLiquidity({
          avgVolume: history.avgVolume,
          avgOrderCount: history.avgOrderCount,
          sellVolumeListed,
          buyActiveOrders,
          packagedVolume,
        });

        await writeLiquidity(item, { liJita, lm }, packagedVolume);
        updated++;
      } catch (err) {
        console.error(`[liquidityIndex] failed processing typeId=${item.typeId}:`, err);
        failed++;
      }
    }

    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[liquidityIndex] run complete in ${durationSec}s: ${updated} updated, ${failed} failed, ${skippedHistory} skipped history (zero orders both sides)`,
    );
  } finally {
    running = false;
  }
}

async function writeLiquidity(
  item: IBuybackItem,
  result: { liJita: number; lm: number },
  packagedVolume: number | null,
): Promise<void> {
  await BuybackItem.updateOne(
    { _id: item._id },
    {
      liquidityModifier: result.lm,
      jitaLiquidityIndex: result.liJita,
      packagedVolume,
      liquidityUpdatedAt: new Date(),
    },
  );
}
