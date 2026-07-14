import { BuybackCategory, IBuybackCategory } from "../models/BuybackCategory";
import { BuybackItem, IBuybackItem } from "../models/BuybackItem";
import { BuybackMarketSnapshot } from "../models/BuybackMarketSnapshot";
import { Config } from "../models/Config";
import { getEsiLimitInfo } from "../utils/general-utils";

const USER_AGENT = "EquinoxGalactic (pricing engine)";
const REGION_ID = 10000002; // The Forge - Jita's region
const HISTORY_DAYS = 30;
const HISTORY_REQ_PER_SEC = 4; // documented cap is 300/min (5/s) - stay under it
const HISTORY_INTERVAL_MS = 1000 / HISTORY_REQ_PER_SEC;
const ERROR_BUDGET_CIRCUIT_BREAKER = 10;
const ORDERS_PAGE_CONCURRENCY = 8;
const SNAPSHOT_TTL_DAYS = 31;

// fixed per spec - not operator-editable like salesTaxRate
const MIN_MARGIN = 0.05;
// capital-class ships aren't hauled, sold in place - none of the
// volume/liquidity logic applies. Reusing haulable=false as the
// capital-class signal, since that's what it was introduced for.
const CAPITAL_CLASS_FLAT_OFFER_PERCENT = 65;
// a recommendation only flags if it differs from the active rate by more
// than this - avoids flagging on sub-noise floating point drift
const RECOMMENDATION_FLAG_THRESHOLD_PERCENT = 0.05;

const LOGISTICS_DRAG_COEFFICIENT = 0.004357;
const LOGISTICS_DRAG_EXPONENT = 0.3424;

const SIGMOID_STEEPNESS = 8.5;
const SIGMOID_INFLECTION = 0.32;
const SIGMOID_CEILING = 1.02;

function sigmoid(vD: number): number {
  return (
    SIGMOID_CEILING /
    (1 + Math.exp(-SIGMOID_STEEPNESS * (vD - SIGMOID_INFLECTION)))
  );
}

// f0/f1/scale are fixed constants (don't depend on any item's data) -
// computed once at module load rather than hardcoded decimal literals, but
// functionally the same "precompute once" the spec calls for.
const SIGMOID_F0 = sigmoid(0);
const SIGMOID_F1 = sigmoid(1);
const SIGMOID_SCALE = SIGMOID_CEILING / (SIGMOID_F1 - SIGMOID_F0);

// Full ESI order/history shapes are stored verbatim (BuybackMarketSnapshot,
// BuybackItem.dailyVolumeHistory) rather than pre-picked down to just the
// fields the formula needs.
type EsiMarketOrder = {
  order_id: number;
  type_id: number;
  is_buy_order: boolean;
  duration: number;
  issued: string;
  location_id: number;
  min_volume: number;
  price: number;
  range: string;
  system_id: number;
  volume_remain: number;
  volume_total: number;
};

type EsiMarketHistoryEntry = {
  date: string;
  average: number;
  highest: number;
  lowest: number;
  order_count: number;
  volume: number;
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
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
      `[pricingRecommendation] ${res.status} received, sleeping ${retryAfter}s before retry`,
    );
    await sleep(retryAfter * 1000);
    return esiFetch(url, retriesLeft - 1);
  }

  const { remain, reset } = getEsiLimitInfo(res.headers);
  if (remain !== null && reset !== null && remain < ERROR_BUDGET_CIRCUIT_BREAKER) {
    console.warn(
      `[pricingRecommendation] error budget low (remain=${remain}), sleeping ${reset}s`,
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

// Sell-side only: SActive is "units currently listed for sale" - the
// standing sell-order book, not buy orders. Keeps the raw matching order
// objects too (not just their summed volume) so the snapshot can store the
// full response rather than a pre-aggregated number.
function aggregateOrdersPage(
  orders: EsiMarketOrder[],
  typeIds: Set<number>,
  sellVolumeByType: Map<number, number>,
  ordersByType: Map<number, EsiMarketOrder[]>,
): void {
  for (const order of orders) {
    if (order.is_buy_order) continue;
    if (!typeIds.has(order.type_id)) continue;

    sellVolumeByType.set(
      order.type_id,
      (sellVolumeByType.get(order.type_id) ?? 0) + order.volume_remain,
    );

    const existing = ordersByType.get(order.type_id);
    if (existing) {
      existing.push(order);
    } else {
      ordersByType.set(order.type_id, [order]);
    }
  }
}

// One bulk sweep of Jita's entire order book covers every item at once -
// far cheaper than a per-item orders call, since ESI has no type_id filter
// that would let us skip pages here anyway.
async function sweepJitaOrders(typeIds: Set<number>): Promise<{
  sellVolumeByType: Map<number, number>;
  ordersByType: Map<number, EsiMarketOrder[]>;
}> {
  const sellVolumeByType = new Map<number, number>();
  const ordersByType = new Map<number, EsiMarketOrder[]>();

  const baseUrl = `https://esi.evetech.net/latest/markets/${REGION_ID}/orders/?datasource=tranquility`;

  const firstRes = await esiFetch(`${baseUrl}&page=1`);
  if (!firstRes.ok) {
    throw new Error(`ESI orders sweep failed on page 1: ${firstRes.status}`);
  }
  const totalPages = Number(firstRes.headers.get("x-pages")) || 1;
  console.log(`[pricingRecommendation] orders sweep: ${totalPages} pages`);

  const firstPage = (await firstRes.json()) as EsiMarketOrder[];
  aggregateOrdersPage(firstPage, typeIds, sellVolumeByType, ordersByType);

  let lastRemaining: number | null = null;

  for (let start = 2; start <= totalPages; start += ORDERS_PAGE_CONCURRENCY) {
    const pages: number[] = [];
    for (let p = start; p < start + ORDERS_PAGE_CONCURRENCY && p <= totalPages; p++) {
      pages.push(p);
    }

    const batchRemaining = await Promise.all(
      pages.map(async (page) => {
        const res = await esiFetch(`${baseUrl}&page=${page}`);
        if (!res.ok) {
          console.warn(`[pricingRecommendation] orders page ${page} failed: ${res.status}`);
          return null;
        }
        const data = (await res.json()) as EsiMarketOrder[];
        aggregateOrdersPage(data, typeIds, sellVolumeByType, ordersByType);
        return parseRateLimitHeader(res.headers).remaining;
      }),
    );

    const seen = batchRemaining.filter((v): v is number => v !== null);
    if (seen.length > 0) lastRemaining = Math.min(...seen);

    const lastPageInBatch = Math.min(start + ORDERS_PAGE_CONCURRENCY - 1, totalPages);
    if (lastPageInBatch % 200 < ORDERS_PAGE_CONCURRENCY) {
      console.log(
        `[pricingRecommendation] orders sweep progress: page ${lastPageInBatch}/${totalPages}, rl remaining=${lastRemaining ?? "unknown"}`,
      );
    }
  }

  return { sellVolumeByType, ordersByType };
}

// AvgVolume and StdDev both come from the same 30-day history call -
// StdDev is the SAMPLE standard deviation (N-1=29) of the volume series
// itself, never derived from order_count (see spec Section 1 for why that
// proxy fails on flat markets).
async function fetchHistory(typeId: number): Promise<{
  avgVolume: number;
  stdDev: number;
  series: EsiMarketHistoryEntry[];
} | null> {
  await paceHistoryRequest();

  const url = `https://esi.evetech.net/latest/markets/${REGION_ID}/history/?datasource=tranquility&type_id=${typeId}`;
  const res = await esiFetch(url);
  if (!res.ok) {
    console.warn(`[pricingRecommendation] history fetch failed for typeId=${typeId}: ${res.status}`);
    return null;
  }

  const data = (await res.json()) as EsiMarketHistoryEntry[];
  const recent = data.slice(-HISTORY_DAYS);
  if (recent.length === 0) {
    return { avgVolume: 0, stdDev: 0, series: [] };
  }

  const avgVolume =
    recent.reduce((sum, e) => sum + e.volume, 0) / recent.length;

  const stdDev =
    recent.length > 1
      ? Math.sqrt(
          recent.reduce((sum, e) => sum + (e.volume - avgVolume) ** 2, 0) /
            (recent.length - 1),
        )
      : 0;

  return { avgVolume, stdDev, series: recent };
}

async function fetchPackagedVolume(typeId: number): Promise<number | null> {
  const url = `https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility`;
  const res = await esiFetch(url);
  if (!res.ok) {
    console.warn(`[pricingRecommendation] type lookup failed for typeId=${typeId}: ${res.status}`);
    return null;
  }

  const data = (await res.json()) as EsiTypeInfo;
  return data.packaged_volume ?? data.volume ?? null;
}

// Pure formula implementation (spec Section 2). All rate-like inputs and
// outputs are fractions (0.90, not 90) - callers convert to/from percent.
export function calculateRecommendedRate(params: {
  volume: number;
  avgVolume: number;
  stdDev: number;
  sActive: number;
  baseRate: number;
  salesTaxRate: number;
}): {
  logisticsDrag: number;
  volumeAdjustedBaseline: number;
  proxyInflow: number;
  demandVelocity: number;
  marketMultiplier: number;
  rawOffer: number;
  maxSafeOffer: number;
  finalOffer: number;
} {
  const logisticsDrag =
    LOGISTICS_DRAG_COEFFICIENT * Math.pow(params.volume, LOGISTICS_DRAG_EXPONENT);
  const volumeAdjustedBaseline = params.baseRate - logisticsDrag;

  const proxyInflow =
    params.avgVolume +
    params.avgVolume *
      Math.log(1 + params.stdDev / (params.avgVolume + 1)) +
    params.sActive / 30 +
    1;

  const demandVelocity = params.avgVolume / proxyInflow;

  const marketMultiplier = Math.max(
    0,
    SIGMOID_SCALE * (sigmoid(demandVelocity) - SIGMOID_F0),
  );

  const rawOffer = volumeAdjustedBaseline * marketMultiplier;
  const maxSafeOffer = 1.0 - params.salesTaxRate - MIN_MARGIN;
  const finalOffer = Math.min(rawOffer, maxSafeOffer);

  return {
    logisticsDrag,
    volumeAdjustedBaseline,
    proxyInflow,
    demandVelocity,
    marketMultiplier,
    rawOffer,
    maxSafeOffer,
    finalOffer,
  };
}

function applyRecommendationFlag(
  item: IBuybackItem,
  category: IBuybackCategory | undefined,
  recommendedRate: number,
): boolean {
  const currentActiveRate = item.rateOverride ?? category?.percentOffered ?? 0;
  return (
    Math.abs(recommendedRate - currentActiveRate) >
      RECOMMENDATION_FLAG_THRESHOLD_PERCENT &&
    recommendedRate !== item.dismissedRecommendedRate
  );
}

async function writeScopeExcluded(
  item: IBuybackItem,
  category: IBuybackCategory | undefined,
  recommendedRate: number,
): Promise<void> {
  const recommendationPending = applyRecommendationFlag(
    item,
    category,
    recommendedRate,
  );

  await BuybackItem.updateOne(
    { _id: item._id },
    {
      recommendedRate,
      recommendedRateUpdatedAt: new Date(),
      recommendationPending,
    },
  );
}

async function writeRecommendation(
  item: IBuybackItem,
  category: IBuybackCategory | undefined,
  result: {
    recommendedRate: number;
    packagedVolume: number;
    avgVolume: number;
    stdDev: number;
    sActive: number;
    demandVelocity: number;
    marketMultiplier: number;
    series: EsiMarketHistoryEntry[];
    orders: EsiMarketOrder[];
  },
): Promise<void> {
  const recommendationPending = applyRecommendationFlag(
    item,
    category,
    result.recommendedRate,
  );

  await BuybackItem.updateOne(
    { _id: item._id },
    {
      recommendedRate: result.recommendedRate,
      recommendedRateUpdatedAt: new Date(),
      packagedVolume: result.packagedVolume,
      avgVolume: result.avgVolume,
      stdDev: result.stdDev,
      sActive: result.sActive,
      demandVelocity: result.demandVelocity,
      marketMultiplier: result.marketMultiplier,
      dailyVolumeHistory: result.series,
      recommendationPending,
    },
  );

  const expiresAt = new Date(
    Date.now() + SNAPSHOT_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  await BuybackMarketSnapshot.create({
    typeId: item.typeId,
    sActive: result.sActive,
    orders: result.orders,
    expiresAt,
  });
}

export async function updateRecommendedRatesForAllItems(): Promise<void> {
  if (running) {
    console.log("[pricingRecommendation] already running, skipping this trigger");
    return;
  }
  running = true;
  const startedAt = Date.now();

  try {
    const config = await Config.findOne();
    const salesTaxRate = config?.salesTaxRate ?? 0.042;

    const categories = await BuybackCategory.find();
    const categoryById = new Map(
      categories.map((category) => [String(category._id), category]),
    );

    const allItems = await BuybackItem.find().sort({
      recommendedRateUpdatedAt: 1,
    });
    const acceptedItems = allItems.filter((item) => {
      const category = categoryById.get(String(item.categoryId));
      const accepted = item.accepted ?? category?.accepted ?? false;
      return accepted;
    });

    console.log(
      `[pricingRecommendation] ${acceptedItems.length}/${allItems.length} items are accepted - processing those`,
    );

    // Scope exclusions apply before any ESI calls for that item (spec
    // Section 6) - split up front so the sweep/history budget is only
    // spent on items that actually run the formula.
    const excludedItems: { item: IBuybackItem; recommendedRate: number }[] = [];
    const eligibleItems: IBuybackItem[] = [];

    for (const item of acceptedItems) {
      const category = categoryById.get(String(item.categoryId));
      const haulable = item.haulable ?? category?.haulable ?? true;
      const variable = item.variable ?? category?.variable ?? true;
      const baseRatePercent = item.rateOverride ?? category?.percentOffered ?? 0;

      if (!haulable) {
        excludedItems.push({ item, recommendedRate: CAPITAL_CLASS_FLAT_OFFER_PERCENT });
        continue;
      }
      if (!variable) {
        excludedItems.push({ item, recommendedRate: baseRatePercent });
        continue;
      }
      eligibleItems.push(item);
    }

    console.log(
      `[pricingRecommendation] ${excludedItems.length} scope-excluded (flat/passthrough), ${eligibleItems.length} run through the formula`,
    );

    for (const { item, recommendedRate } of excludedItems) {
      const category = categoryById.get(String(item.categoryId));
      await writeScopeExcluded(item, category, recommendedRate);
    }

    const eligibleTypeIds = new Set(eligibleItems.map((item) => item.typeId));

    console.log("[pricingRecommendation] starting Jita orders sweep...");
    const { sellVolumeByType, ordersByType } = await sweepJitaOrders(eligibleTypeIds);
    console.log(
      `[pricingRecommendation] sweep complete: ${sellVolumeByType.size} types with sell orders`,
    );

    let updated = excludedItems.length;
    let failed = 0;

    for (const item of eligibleItems) {
      try {
        const category = categoryById.get(String(item.categoryId));
        const baseRatePercent = item.rateOverride ?? category?.percentOffered ?? 0;
        const sActive = sellVolumeByType.get(item.typeId) ?? 0;
        const orders = ordersByType.get(item.typeId) ?? [];

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

        const calc = calculateRecommendedRate({
          volume: packagedVolume,
          avgVolume: history.avgVolume,
          stdDev: history.stdDev,
          sActive,
          baseRate: baseRatePercent / 100,
          salesTaxRate,
        });

        await writeRecommendation(item, category, {
          recommendedRate: round2(calc.finalOffer * 100),
          packagedVolume,
          avgVolume: history.avgVolume,
          stdDev: history.stdDev,
          sActive,
          demandVelocity: calc.demandVelocity,
          marketMultiplier: calc.marketMultiplier,
          series: history.series,
          orders,
        });
        updated++;
      } catch (err) {
        console.error(`[pricingRecommendation] failed processing typeId=${item.typeId}:`, err);
        failed++;
      }
    }

    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[pricingRecommendation] run complete in ${durationSec}s: ${updated} updated, ${failed} failed`,
    );
  } finally {
    running = false;
  }
}
