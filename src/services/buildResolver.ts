import { Blueprint } from "../models/Blueprint";
import { Structure, IIndustryProfile } from "../models/Structure";
import { Type } from "../models/Type";
import { ToolsUser, IBuildStructurePreferences } from "../models/ToolsUser";
import { IndustryBonusType, IIndustryBonusTypeFields } from "../models/IndustryBonusType";
import { runJaniceAppraisal } from "./janiceAppraisal";
import { getSystemCostIndex } from "./industryCostIndex";
import { getAdjustedPrices } from "./adjustedPrices";
import { classifyProductCategory } from "./industryCategory";
import { combineStructureAndRigMultiplier } from "./industryBonus";
import { IndustryCategory } from "../types/industryCategory";

export type BuyPriceSource = "buy" | "split";

export type ResolveInput = {
  targetTypeId: number;
  quantity: number;
  assumedME: number; // percent, e.g. 10 - manufacturing only, never applies to reaction
  buyPriceSource: BuyPriceSource;
  haulRatePerM3: number;
  characterId: string;
};

// "pooled" - this occurrence's material need is covered by one shared
// production run combined with the SAME typeId's demand from elsewhere in
// the tree (see the pooling section below) - distinct from "build" (this
// occurrence has its own dedicated, independent production) so the UI can
// show it differently and so job/shopping-list counting doesn't double up
// a batch that's really only produced once.
export type BuildTreeNode = {
  typeId: number;
  name: string;
  decision: "build" | "buy" | "pooled";
  quantity: number;
  unitCost: number;
  subtotal: number;
  children?: BuildTreeNode[];
};

export type ShoppingListEntry = {
  typeId: number;
  name: string;
  quantity: number;
  unitCost: number;
  subtotal: number;
  volumeM3: number;
};

export type BuildResolveResult = {
  target: { typeId: number; name: string; quantity: number };
  summary: {
    totalBuildCost: number;
    totalBuyEverythingCost: number;
    iskSaved: number;
    percentSaved: number;
    jobCount: number;
    totalBuyVolumeM3: number;
  };
  tree: BuildTreeNode;
  shoppingList: ShoppingListEntry[];
  warnings: string[];
};

type PriceInfo = { unitPrice: number; m3PerUnit: number };

// A structure's real, SDE-sourced bonus data for one activity - the
// structure type's own flat bonus, plus whichever rigs are actually
// fitted (each carrying its own category scope - see
// models/IndustryBonusType.ts). Replaces v1's flat admin-typed
// materialReduction/costReduction.
type ActivityStructure = {
  structureId: number;
  systemId: number;
  facilityTaxPercent: number;
  structureBonus: IIndustryBonusTypeFields | null;
  rigBonuses: IIndustryBonusTypeFields[];
};

type StructuresByActivity = Partial<Record<"manufacturing" | "reaction", ActivityStructure>>;

// Fixed rate per activity, not configurable - confirmed real rates:
// manufacturing, reactions, and blueprint copying are all 4%; blueprint
// ME/TE research is 2%. Only manufacturing/reaction are ever looked up
// here (Blueprint.activity is never anything else), but keyed by activity
// rather than a bare constant so the rate applied is the real per-activity
// rule, not a coincidence of the two supported activities sharing a value.
const SCC_SURCHARGE_BY_ACTIVITY: Record<"manufacturing" | "reaction", number> = {
  manufacturing: 0.04,
  reaction: 0.04,
};

// Per-unit result of the memoized bottom-up resolve - decision/unitCost are
// this typeId's IDEALIZED choice, made once, assuming a perfectly
// efficient full batch at every level (i.e. as if demand always divides
// evenly into whole runs, so batching never wastes anything). That's a
// valid, demand-independent "best case" cost for building - and critically,
// an idealized 'buy' decision is stable under ANY real demand (batch waste
// can only make building relatively worse than this best case, never
// better), so it's never revisited. An idealized 'build' decision, though,
// can still lose to buying once the REAL demand at a given point in the
// tree is checked - a blueprint can only run a whole number of times, so a
// small real demand relative to a large outputQuantity can make the
// idealized-cheap build option actually more expensive than just buying
// the real amount needed. buildRealTree does that real, demand-aware
// re-check (walking top-down, unlike this bottom-up pass) and is the only
// place a plain decision can flip, always build -> buy, never the reverse
// (pooling, below, is the one exception - see resolveBuildPlan). buyPrice
// is carried alongside unitCost (which is buildUnitCost when decision is
// "build") specifically so that re-check has something to compare real
// build cost against regardless of this pass's own decision. children
// carries each material's quantity-per-one-unit-of-this-item so the real
// tree can be walked out afterward with the actual requested quantity.
// outputQuantity is the blueprint's batch size (e.g. 40 for any fuel
// block) - only meaningful when decision === "build".
type ResolvedNode = {
  typeId: number;
  decision: "build" | "buy";
  unitCost: number;
  buyPrice: number;
  outputQuantity: number;
  children?: { childTypeId: number; quantityPerUnit: number }[];
};

// A pooling decision made ONCE for a typeId that's needed in more than one
// place in the tree (e.g. two different components both consuming fuel
// blocks). Rather than each occurrence separately deciding build-vs-buy
// against only its own local demand (which can make batch waste look
// worse than it really is - see resolveBuildPlan's header comment),
// pooling combines their demand into one shared production run when doing
// so is cheaper overall, and bills each occurrence its fair share.
type PoolOverride = {
  // pooledBatchCost / totalDemand - NOT pooledBatchCost / pooledQuantity.
  // Dividing by total DEMAND (not the possibly-larger produced quantity)
  // means every occurrence's fair share (its own demand × this rate) sums
  // EXACTLY to the real batch cost across all occurrences, with no
  // leftover surplus cost unaccounted for and no arbitrary "first
  // occurrence pays for the spare units" attribution.
  unitCostPerDemand: number;
  // The one real subtree for producing the whole pooled batch (materials
  // resolved once, at the combined quantity) - folded into the shopping
  // list and job count separately, exactly once, since individual
  // occurrences in the main tree don't carry their own children once
  // pooled (see buildRealTree).
  materialsSubtree: BuildTreeNode;
};

// Short-TTL, module-level - batches of overlapping/repeated resolves within
// a few minutes of each other reuse prices instead of re-hitting Janice,
// per the brief's pricing section. Keyed by pricing source since buy vs
// split prices differ.
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
const priceCache = new Map<string, { price: PriceInfo; expiresAt: number }>();

function priceCacheKey(typeId: number, source: BuyPriceSource): string {
  return `${typeId}:${source}`;
}

// Walks the full blueprint DAG reachable from the target, memoized by
// typeId, purely to discover every typeId that could need a buy price -
// every node's build-vs-buy decision requires comparing its own buy price
// against its bottom-up build cost, so the whole reachable tree needs
// pricing regardless of which nodes ultimately resolve to "build".
async function collectTreeTypeIds(typeId: number, visited: Set<number>): Promise<void> {
  if (visited.has(typeId)) return;
  visited.add(typeId);

  const blueprint = await Blueprint.findOne({ productTypeId: typeId }).lean();
  if (!blueprint) return;

  for (const material of blueprint.materials) {
    await collectTreeTypeIds(material.typeId, visited);
  }
}

// Batches every typeId not already cached into a single Janice call (one
// call per resolve, not one per item, per the brief). itemsText mirrors
// the "<name> <quantity>" format already used by buybackQuote.ts - a
// quantity of 1 per line is enough since immediate pricing is a top-of-book
// unit price, independent of the quantity typed.
async function getPrices(
  typeIds: number[],
  nameByTypeId: Map<number, string>,
  buyPriceSource: BuyPriceSource,
): Promise<Map<number, PriceInfo>> {
  const now = Date.now();
  const result = new Map<number, PriceInfo>();
  const toFetch: number[] = [];

  for (const typeId of typeIds) {
    const cached = priceCache.get(priceCacheKey(typeId, buyPriceSource));
    if (cached && cached.expiresAt > now) {
      result.set(typeId, cached.price);
    } else {
      toFetch.push(typeId);
    }
  }

  const itemsText = toFetch
    .map((typeId) => nameByTypeId.get(typeId))
    .filter((name): name is string => Boolean(name))
    .map((name) => `${name} 1`)
    .join("\n");

  if (itemsText) {
    const appraisal = await runJaniceAppraisal(itemsText, buyPriceSource);
    for (const item of appraisal.items) {
      const typeId = item.itemType.eid;
      const unitPrice =
        buyPriceSource === "split"
          ? item.immediatePrices.splitPrice
          : item.immediatePrices.buyPrice;
      const price: PriceInfo = { unitPrice, m3PerUnit: item.itemType.packagedVolume };
      result.set(typeId, price);
      priceCache.set(priceCacheKey(typeId, buyPriceSource), {
        price,
        expiresAt: now + PRICE_CACHE_TTL_MS,
      });
    }
  }

  return result;
}

async function loadStructuresByActivity(
  prefs: IBuildStructurePreferences,
): Promise<StructuresByActivity> {
  const result: StructuresByActivity = {};

  for (const activity of ["manufacturing", "reaction"] as const) {
    const structureId = prefs[activity];
    if (!structureId) continue;

    const structure = await Structure.findOne({ structureId }).lean();
    const profile = structure?.industryProfiles.find((p) => p.activity === activity);
    if (!structure?.systemId || !profile) continue;

    const bonusTypeIds = [profile.structureTypeId, ...profile.rigTypeIds];
    const bonusTypes = await IndustryBonusType.find({ typeId: { $in: bonusTypeIds } }).lean();
    const byTypeId = new Map(bonusTypes.map((b) => [b.typeId, b]));

    result[activity] = {
      structureId,
      systemId: structure.systemId,
      facilityTaxPercent: (profile as IIndustryProfile).facilityTaxPercent ?? 0,
      structureBonus: byTypeId.get(profile.structureTypeId) ?? null,
      rigBonuses: profile.rigTypeIds
        .map((id) => byTypeId.get(id))
        .filter((b) => b !== undefined) as IIndustryBonusTypeFields[],
    };
  }

  return result;
}

// prices.get() can legitimately miss (an item Janice has no market data
// for) - rather than let that poison every total upstream with Infinity
// (as the brief's own `?? Infinity` sketch would), it's priced at 0 with a
// visible warning so the rest of the resolve still produces a usable
// result.
function getBuyPrice(
  typeId: number,
  name: string,
  prices: Map<number, PriceInfo>,
  haulRatePerM3: number,
  warnings: Set<string>,
): number {
  const price = prices.get(typeId);
  if (!price) {
    warnings.add(`No market price found for "${name}" - priced at 0 ISK.`);
    return 0;
  }
  return price.unitPrice + price.m3PerUnit * haulRatePerM3;
}

function bonusPercent(
  bonus: IIndustryBonusTypeFields | null | undefined,
  field: "material" | "time" | "cost",
): number | null {
  if (!bonus) return null;
  if (field === "material") return bonus.materialBonusPercent;
  if (field === "time") return bonus.timeBonusPercent;
  return bonus.costBonusPercent;
}

// Combines a structure's flat bonus with whichever of its fitted rigs
// actually cover `category` into one multiplier, with EVE's real stacking
// penalty applied across same-type rig bonuses (see industryBonus.ts). A
// rig's `category` is a list, not a single value - most rigs cover exactly
// one, but real "XL-Set" rigs consolidate several (e.g. "any ship") into
// one rig, and "any_reaction" (the generic L-Set reactor rig) is just
// another category in that list rather than a separate special case.
function combinedMultiplier(
  activityStructure: ActivityStructure,
  category: IndustryCategory | null,
  field: "material" | "time" | "cost",
): number {
  const structurePercent = bonusPercent(activityStructure.structureBonus, field);
  const rigPercents = activityStructure.rigBonuses
    .filter(
      (rig) => category != null && (rig.category.includes(category) || rig.category.includes("any_reaction")),
    )
    .map((rig) => bonusPercent(rig, field))
    .filter((p): p is number => p != null);

  return combineStructureAndRigMultiplier(structurePercent, rigPercents);
}

// poolOverrides short-circuits this typeId's normal idealized resolve
// entirely: once pooled, its "unit cost" for any consumer is the pooled
// fair-share rate, not a fresh build-vs-buy comparison, and it carries no
// children here (its own materials are resolved once, separately, into
// PoolOverride.materialsSubtree) so a consuming parent's own materialUnitCost
// sum picks up the pooled rate without re-deriving or re-charging for the
// batch's materials itself.
//
// forceBuild - set only on the single top-level call for the plan's own
// target item (never threaded down into the materials recursion below, so
// it has no effect on any component's own decision). Some items - low-
// liquidity supercapitals being the motivating case - have a handful of
// wildly unrepresentative market orders that make "buy" win the comparison
// even though nobody could realistically source one that way. The user is
// explicitly asking this tool to plan how to BUILD the target, so its own
// decision skips the price comparison entirely and always shows the build
// breakdown (as long as a blueprint and a structure for its activity both
// exist - forceBuild never fabricates a build path that isn't actually
// there). The buy price is still computed and returned either way, so
// resolveBuildPlan can surface "buying instead would cost X" without the
// decision engine itself being swayed by it.
async function resolve(
  typeId: number,
  cache: Map<number, ResolvedNode>,
  prices: Map<number, PriceInfo>,
  adjustedPrices: Map<number, number>,
  nameByTypeId: Map<number, string>,
  structuresByActivity: StructuresByActivity,
  assumedME: number,
  haulRatePerM3: number,
  warnings: Set<string>,
  poolOverrides: Map<number, PoolOverride>,
  forceBuild = false,
): Promise<ResolvedNode> {
  const cached = cache.get(typeId);
  if (cached) return cached;

  const name = nameByTypeId.get(typeId) ?? `Type ${typeId}`;
  const buyPrice = getBuyPrice(typeId, name, prices, haulRatePerM3, warnings);

  const override = poolOverrides.get(typeId);
  if (override) {
    const node: ResolvedNode = {
      typeId,
      decision: "build",
      unitCost: override.unitCostPerDemand,
      buyPrice,
      outputQuantity: 1,
    };
    cache.set(typeId, node);
    return node;
  }

  const blueprint = await Blueprint.findOne({ productTypeId: typeId }).lean();
  if (!blueprint) {
    const node: ResolvedNode = { typeId, decision: "buy", unitCost: buyPrice, buyPrice, outputQuantity: 1 };
    cache.set(typeId, node);
    return node;
  }

  const structureEntry = structuresByActivity[blueprint.activity];
  if (!structureEntry) {
    warnings.add(
      blueprint.activity === "reaction"
        ? "No reaction structure selected - reaction materials are priced as buy-only."
        : "No manufacturing structure selected - manufactured materials are priced as buy-only.",
    );
    const node: ResolvedNode = { typeId, decision: "buy", unitCost: buyPrice, buyPrice, outputQuantity: 1 };
    cache.set(typeId, node);
    return node;
  }

  const category = await classifyProductCategory(typeId);

  // assumedME is entered/stored as a percentage (e.g. 10 = 10%), so this
  // divides by 100 same as every other bonus below.
  const meMultiplier = blueprint.activity === "reaction" ? 1 : 1 - assumedME / 100;
  const materialMultiplier = combinedMultiplier(structureEntry, category, "material");

  const children: { childTypeId: number; quantityPerUnit: number }[] = [];
  let materialUnitCost = 0;
  // Estimated Item Value (EIV) per run - the blueprint's own direct
  // materials at their RAW (ME 0, unbonused) base quantity priced at each
  // material's ESI-published adjusted price. Deliberately not recursive
  // and not ME/rig-adjusted - this is CCP's fixed basis for the job
  // installation fee, a different number from materialUnitCost (which IS
  // ME/rig-adjusted and Janice-priced - "what you actually pay").
  let eivPerRun = 0;

  for (const material of blueprint.materials) {
    const perOutputQty =
      Math.ceil(material.quantity * meMultiplier * materialMultiplier) / blueprint.outputQuantity;
    const childNode = await resolve(
      material.typeId,
      cache,
      prices,
      adjustedPrices,
      nameByTypeId,
      structuresByActivity,
      assumedME,
      haulRatePerM3,
      warnings,
      poolOverrides,
    );
    children.push({ childTypeId: material.typeId, quantityPerUnit: perOutputQty });
    materialUnitCost += childNode.unitCost * perOutputQty;

    eivPerRun += material.quantity * (adjustedPrices.get(material.typeId) ?? 0);
  }

  const eivPerUnit = eivPerRun / blueprint.outputQuantity;
  const costMultiplier = combinedMultiplier(structureEntry, category, "cost");
  const costIndex = await getSystemCostIndex(structureEntry.systemId, blueprint.activity);
  const facilityTaxRate = structureEntry.facilityTaxPercent / 100;

  const sccSurcharge = SCC_SURCHARGE_BY_ACTIVITY[blueprint.activity];
  const jobUnitCost = eivPerUnit * (costIndex * costMultiplier + facilityTaxRate + sccSurcharge);
  const buildUnitCost = materialUnitCost + jobUnitCost;
  const decision: "build" | "buy" = forceBuild || buildUnitCost < buyPrice ? "build" : "buy";

  const node: ResolvedNode = {
    typeId,
    decision,
    unitCost: decision === "build" ? buildUnitCost : buyPrice,
    buyPrice,
    outputQuantity: blueprint.outputQuantity,
    children: decision === "build" ? children : undefined,
  };
  cache.set(typeId, node);
  return node;
}

// One (demand, subtotal) pair per occurrence of a typeId encountered while
// walking the real tree - fed to detectPoolingOpportunities afterward.
type DemandLog = Map<number, { demand: number; subtotal: number }[]>;

function logDemand(demandLog: DemandLog, typeId: number, demand: number, subtotal: number): void {
  const entries = demandLog.get(typeId) ?? [];
  entries.push({ demand, subtotal });
  demandLog.set(typeId, entries);
}

// Walks the resolved cache top-down with the real requested quantity,
// multiplying quantityPerUnit down through the tree - per the brief, this
// deliberately does NOT dedupe shared components across branches (that's
// what the shopping list step is for); a component used under two
// different parents shows up twice here, once per branch, each with its
// own real quantity in that branch.
//
// This is also where an idealized 'build' decision from resolve() gets
// its real, demand-aware re-check (see the long comment on ResolvedNode
// for why only 'build' ever needs revisiting, never 'buy'). A blueprint
// can only be run a whole number of times, each run producing exactly
// outputQuantity units - e.g. every fuel block blueprint makes 40 per run,
// so needing 5 means producing 40, not a fractional run, and paying for
// all 40 whether or not building still comes out cheaper than buying the
// 5 actually needed once that waste is accounted for. Re-deciding here
// (rather than trusting resolve()'s idealized, batch-agnostic comparison)
// is what stops the tool from recommending "build" all the way down a
// chain purely because building looks cheap at idealized full-batch
// scale, when the real demand at that point can't fill a batch.
//
// Every (typeId, real demand, real cost) triple encountered is logged
// regardless of decision, whether or not it's already pooled - resolveBuildPlan
// uses this after each pass to look for NEW pooling opportunities (or
// confirm there are none left, ending the round loop).
//
// skipDemandCheck - set only on the single top-level call for the plan's
// own target item (never propagated into the children recursion below),
// mirroring resolve()'s forceBuild - see that function's header comment
// for why. Without this, a target item that resolve() forced to "build"
// could still get silently downgraded back to "buy" right here if its own
// batch size doesn't evenly divide the requested quantity, quietly
// reintroducing the exact problem forceBuild exists to avoid.
function buildRealTree(
  typeId: number,
  rawQuantity: number,
  cache: Map<number, ResolvedNode>,
  nameByTypeId: Map<number, string>,
  warnings: Set<string>,
  poolOverrides: Map<number, PoolOverride>,
  demandLog: DemandLog,
  skipDemandCheck = false,
): BuildTreeNode {
  const node = cache.get(typeId);
  const name = nameByTypeId.get(typeId) ?? `Type ${typeId}`;

  if (!node) {
    logDemand(demandLog, typeId, rawQuantity, 0);
    return { typeId, name, decision: "buy", quantity: rawQuantity, unitCost: 0, subtotal: 0 };
  }

  if (poolOverrides.has(typeId)) {
    // resolve() already substituted unitCost = the pooled fair-share rate
    // for this typeId - no batch re-check needed (outputQuantity is 1 on
    // the override's synthetic node) and no children here, since the
    // pooled batch's own materials are accounted for once, via
    // PoolOverride.materialsSubtree, not per-occurrence.
    const subtotal = node.unitCost * rawQuantity;
    logDemand(demandLog, typeId, rawQuantity, subtotal);
    return { typeId, name, decision: "pooled", quantity: rawQuantity, unitCost: node.unitCost, subtotal };
  }

  if (node.decision !== "build") {
    // Idealized 'buy' - stable under any real demand, nothing to re-check.
    const subtotal = node.buyPrice * rawQuantity;
    logDemand(demandLog, typeId, rawQuantity, subtotal);
    return { typeId, name, decision: "buy", quantity: rawQuantity, unitCost: node.buyPrice, subtotal };
  }

  const realBuildQuantity = Math.ceil(rawQuantity / node.outputQuantity) * node.outputQuantity;
  const realBuildCost = realBuildQuantity * node.unitCost;
  const realBuyCost = rawQuantity * node.buyPrice;

  if (!skipDemandCheck && realBuildCost >= realBuyCost) {
    // Idealized full-batch build looked cheaper, but the batch this
    // specific demand would actually force (realBuildQuantity, likely
    // larger than what's needed) costs more than just buying the real
    // amount - downgrade to buy and stop here; materials that would have
    // gone into this build are never consumed at all. (Pooling, checked
    // separately after this whole walk completes, is what can still
    // recover a "build" here if enough OTHER demand for the same typeId
    // exists elsewhere in the tree - see resolveBuildPlan.)
    if (node.outputQuantity > 1) {
      warnings.add(
        `${name}: building would need a full batch of ${node.outputQuantity} for only ${rawQuantity} actually needed - buying instead.`,
      );
    }
    logDemand(demandLog, typeId, rawQuantity, realBuyCost);
    return { typeId, name, decision: "buy", quantity: rawQuantity, unitCost: node.buyPrice, subtotal: realBuyCost };
  }

  const children = node.children?.map((child) =>
    buildRealTree(
      child.childTypeId,
      realBuildQuantity * child.quantityPerUnit,
      cache,
      nameByTypeId,
      warnings,
      poolOverrides,
      demandLog,
    ),
  );

  logDemand(demandLog, typeId, rawQuantity, realBuildCost);
  return {
    typeId,
    name,
    decision: "build",
    quantity: realBuildQuantity,
    unitCost: node.unitCost,
    subtotal: realBuildCost,
    children,
  };
}

// Looks across the WHOLE tree just walked for typeIds that showed up more
// than once (demandLog has >1 entry) and aren't already pooled, and checks
// whether combining their demand into one shared production run would
// have cost less than what they collectively cost as resolved. This is
// the piece that catches the case a purely per-node re-check can't: two
// components that each independently look cheaper to buy (their own 5-unit
// need doesn't justify a 40-unit batch) can still be cheaper to build
// TOGETHER once their combined 10-unit demand is considered - and because
// building a component cheaper can itself flip THAT component's own
// build-vs-buy decision (its materials just got cheaper), resolveBuildPlan
// re-resolves the whole tree from scratch with any newly-found pool
// applied, repeating until a full pass finds no further improvement.
async function detectPoolingOpportunities(
  demandLog: DemandLog,
  cache: Map<number, ResolvedNode>,
  poolOverrides: Map<number, PoolOverride>,
  nameByTypeId: Map<number, string>,
  prices: Map<number, PriceInfo>,
  adjustedPrices: Map<number, number>,
  structuresByActivity: StructuresByActivity,
  assumedME: number,
  haulRatePerM3: number,
  warnings: Set<string>,
): Promise<Map<number, PoolOverride>> {
  const newOverrides = new Map<number, PoolOverride>();

  for (const [typeId, entries] of demandLog) {
    if (entries.length < 2) continue; // only ever needed in one place - nothing to pool
    if (poolOverrides.has(typeId)) continue; // already pooled in an earlier round

    const idealized = cache.get(typeId);
    // Idealized 'buy' (or no blueprint at all) can never benefit from
    // pooling - see the note on ResolvedNode: real/combined demand can
    // only be equal to or worse than the idealized full-batch figure,
    // never better, so if that already loses to buying, no amount of
    // pooling recovers it.
    if (!idealized || idealized.decision !== "build") continue;

    const totalDemand = entries.reduce((sum, e) => sum + e.demand, 0);
    const currentCost = entries.reduce((sum, e) => sum + e.subtotal, 0);
    const pooledQuantity = Math.ceil(totalDemand / idealized.outputQuantity) * idealized.outputQuantity;
    const pooledBatchCost = pooledQuantity * idealized.unitCost;

    if (pooledBatchCost >= currentCost) continue; // pooling doesn't actually help here

    // Resolve the one real subtree for producing the whole pooled batch,
    // fresh (empty pool/demand maps - nested pooling within a pooled
    // batch's own materials is intentionally not chased further, a rare
    // enough third-order effect not to be worth the added complexity here).
    const materialsSubtree = buildRealTree(
      typeId,
      pooledQuantity,
      cache,
      nameByTypeId,
      warnings,
      new Map(),
      new Map(),
    );

    newOverrides.set(typeId, {
      unitCostPerDemand: pooledBatchCost / totalDemand,
      materialsSubtree,
    });
  }

  return newOverrides;
}

function accumulateShoppingList(
  node: BuildTreeNode,
  prices: Map<number, PriceInfo>,
  out: Map<number, ShoppingListEntry>,
): void {
  if (node.decision === "buy") {
    const existing = out.get(node.typeId);
    if (existing) {
      existing.quantity += node.quantity;
      existing.subtotal += node.subtotal;
      return;
    }
    out.set(node.typeId, {
      typeId: node.typeId,
      name: node.name,
      quantity: node.quantity,
      unitCost: node.unitCost,
      subtotal: node.subtotal,
      volumeM3: prices.get(node.typeId)?.m3PerUnit ?? 0,
    });
    return;
  }

  // "pooled" nodes carry no children (their materials live in the pool's
  // own materialsSubtree, folded in separately by resolveBuildPlan) and
  // aren't buy leaves themselves, so there's nothing to recurse into here.
  for (const child of node.children ?? []) {
    accumulateShoppingList(child, prices, out);
  }
}

function countBuildNodes(node: BuildTreeNode): number {
  if (node.decision !== "build") return 0;
  let count = 1;
  for (const child of node.children ?? []) count += countBuildNodes(child);
  return count;
}

export async function resolveBuildPlan(input: ResolveInput): Promise<BuildResolveResult> {
  const { targetTypeId, quantity, assumedME, buyPriceSource, haulRatePerM3, characterId } = input;

  const treeTypeIds = new Set<number>();
  await collectTreeTypeIds(targetTypeId, treeTypeIds);

  const types = await Type.find({ typeId: { $in: [...treeTypeIds] } }).lean();
  const nameByTypeId = new Map(types.map((t) => [t.typeId, t.name]));

  const [prices, adjustedPrices] = await Promise.all([
    getPrices([...treeTypeIds], nameByTypeId, buyPriceSource),
    getAdjustedPrices([...treeTypeIds]),
  ]);

  const toolsUser = await ToolsUser.findOne({ characterId }).lean();
  const structuresByActivity = await loadStructuresByActivity(
    toolsUser?.buildStructurePreferences ?? {},
  );

  const warnings = new Set<string>();
  const poolOverrides = new Map<number, PoolOverride>();
  let tree: BuildTreeNode | null = null;

  // Feeding a newly-found pool back into resolve() (not just patching the
  // final tree) means the existing bottom-up cost math already handles
  // knock-on effects correctly with no special-casing: a component that
  // consumes a now-cheaper pooled material gets a genuinely lower
  // materialUnitCost from resolve() itself, which can flip THAT
  // component's own build-vs-buy decision too, and so on up the chain.
  // Pooling can only ever make costs go down (never up - it's only ever
  // applied when strictly cheaper) and buy prices never change, so a
  // decision can flip build-favoring at most once per typeId across
  // rounds and never flip back - the loop is guaranteed to terminate; the
  // round cap below is just a safety net against an unforeseen bug, not
  // something expected to actually get hit.
  const MAX_POOLING_ROUNDS = 8;
  let converged = false;

  for (let round = 0; round < MAX_POOLING_ROUNDS; round++) {
    const cache = new Map<number, ResolvedNode>();
    await resolve(
      targetTypeId,
      cache,
      prices,
      adjustedPrices,
      nameByTypeId,
      structuresByActivity,
      assumedME,
      haulRatePerM3,
      warnings,
      poolOverrides,
      true, // forceBuild - the plan's own target always shows how it's built, see resolve()'s header comment
    );

    const demandLog: DemandLog = new Map();
    tree = buildRealTree(
      targetTypeId,
      quantity,
      cache,
      nameByTypeId,
      warnings,
      poolOverrides,
      demandLog,
      true, // skipDemandCheck - matches forceBuild above, see buildRealTree's header comment
    );

    const newOverrides = await detectPoolingOpportunities(
      demandLog,
      cache,
      poolOverrides,
      nameByTypeId,
      prices,
      adjustedPrices,
      structuresByActivity,
      assumedME,
      haulRatePerM3,
      warnings,
    );

    if (newOverrides.size === 0) {
      converged = true;
      break;
    }
    for (const [typeId, override] of newOverrides) poolOverrides.set(typeId, override);
  }

  if (!converged) {
    warnings.add(
      "Pooling opportunities across shared components didn't fully settle within the usual number of passes - results may be conservative in places.",
    );
  }

  const resolvedTree = tree!;

  const shoppingListMap = new Map<number, ShoppingListEntry>();
  accumulateShoppingList(resolvedTree, prices, shoppingListMap);
  // Each pool's own materials (e.g. what it took to actually produce the
  // shared batch) are resolved once, separately from the main tree - fold
  // them into the same shopping list / job count exactly once here.
  for (const override of poolOverrides.values()) {
    accumulateShoppingList(override.materialsSubtree, prices, shoppingListMap);
  }

  const totalBuildCost = resolvedTree.subtotal;
  // tree.quantity, not the raw requested quantity - if the target itself
  // is a batched build (e.g. asking for 5 fuel blocks, batch size 40),
  // the plan actually produces/needs 40, so "what would buying instead
  // have cost" has to compare against that same real quantity, not the 5
  // originally typed, or the comparison and percent-saved figures below
  // would be comparing two different quantities against each other.
  const totalBuyEverythingCost = getBuyPrice(
    targetTypeId,
    resolvedTree.name,
    prices,
    haulRatePerM3,
    warnings,
  ) * resolvedTree.quantity;
  const totalBuyVolumeM3 = [...shoppingListMap.values()].reduce(
    (sum, entry) => sum + entry.volumeM3 * entry.quantity,
    0,
  );

  // The target's own decision is forced to "build" above regardless of its
  // market buy price (see resolve()'s forceBuild) - surface that comparison
  // explicitly here rather than leaving it implicit in the summary stats,
  // so a forced build that's actually pricier than buying doesn't go
  // unnoticed. Only fires when buying really would be cheaper - most items
  // won't hit this, since forceBuild only overrides the decision, not the
  // underlying economics.
  if (totalBuyEverythingCost > 0 && totalBuildCost > totalBuyEverythingCost) {
    const percentMore = ((totalBuildCost - totalBuyEverythingCost) / totalBuyEverythingCost) * 100;
    warnings.add(
      `Buying ${resolvedTree.name} directly would cost ${totalBuyEverythingCost.toLocaleString(undefined, { maximumFractionDigits: 2 })} ISK - building it costs ${percentMore.toFixed(1)}% more, likely an illiquid/unreliable market price for an item this size. The build breakdown below is shown regardless, since that's what this tool is for.`,
    );
  }

  const jobCount =
    countBuildNodes(resolvedTree) +
    [...poolOverrides.values()].reduce((sum, o) => sum + countBuildNodes(o.materialsSubtree), 0);

  return {
    target: { typeId: targetTypeId, name: resolvedTree.name, quantity: resolvedTree.quantity },
    summary: {
      totalBuildCost,
      totalBuyEverythingCost,
      iskSaved: totalBuyEverythingCost - totalBuildCost,
      percentSaved:
        totalBuyEverythingCost > 0
          ? ((totalBuyEverythingCost - totalBuildCost) / totalBuyEverythingCost) * 100
          : 0,
      jobCount,
      totalBuyVolumeM3,
    },
    tree: resolvedTree,
    shoppingList: [...shoppingListMap.values()].sort((a, b) => b.subtotal - a.subtotal),
    warnings: [...warnings],
  };
}
