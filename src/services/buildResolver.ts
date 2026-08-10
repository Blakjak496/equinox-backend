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

export type PriceSource = "buy" | "sell";

export type ResolveInput = {
  targetTypeId: number;
  quantity: number;
  assumedME: number; // percent, e.g. 10 - manufacturing only, never applies to reaction
  // Priced independently - a serious manufacturer typically stands up buy
  // orders for materials (paying the lower buy price) but sells their
  // output at the going sell price, so the two sides of the same resolve
  // are rarely the same market side. materialPriceSource prices every
  // material/component in the tree; productPriceSource prices only the
  // target item's own informational market-alternative value (see
  // resolve()'s forceBuild) - it never affects any build-vs-buy decision.
  materialPriceSource: PriceSource;
  productPriceSource: PriceSource;
  haulRatePerM3: number;
  characterId: string;
};

// "pooled" - this occurrence's material need is covered by one shared
// production run combined with the SAME typeId's demand from elsewhere in
// the tree (see the pooling section below) - distinct from "build" (this
// occurrence has its own dedicated, independent production) so the UI can
// show it differently and so job/shopping-list counting doesn't double up
// a batch that's really only produced once. quantity/inputCost/jobCost/
// totalCost are still THIS occurrence's own share (its own demand × the
// pooled rate, split proportionally - see buildRealTree); the pool* fields
// below summarize the shared batch as a whole (same numbers at every
// occurrence of this typeId), kept for internal bookkeeping (see
// resolveBuildPlan's pooledBatches, the one place each pooled item's real,
// drillable breakdown actually lives) rather than as their own UI column.
//
// "hybrid" - demand doesn't divide evenly into whole batches, and the
// optimal answer is neither "build all of it" (round up and waste part of
// an extra batch) nor "buy all of it" (ignore the full batches that ARE
// worth producing) - some whole batches get built, and whatever's left
// over (too little to justify one more full batch) is bought directly. See
// computeOptimalBatchSplit. inputCost below already merges both pieces
// (the built portion's materials + the bought remainder's purchase price)
// into one number - the row's own "hybrid" decision already says a mix is
// happening, so the two don't need to be shown as separate figures.
// buyQuantity/buyUnitCost describe the bought portion specifically, kept
// for internal bookkeeping (accumulateShoppingList needs to know exactly
// how many units to add to the shopping list) rather than as their own UI
// column - the built portion's own materials are in children as usual.
export type BuildTreeNode = {
  typeId: number;
  name: string;
  decision: "build" | "buy" | "pooled" | "hybrid";
  quantity: number;
  // All three are TOTALS for this row's quantity, not per-unit figures.
  // inputCost - material cost (build), purchase price (buy), or a blend of
  // both (hybrid/pooled, see above). jobCost - the real EIV-based
  // installation fee for whatever was actually built here; always exactly
  // 0 for "buy" (nothing is manufactured - the UI shows "--", not "0", to
  // make that a deliberate absence rather than a coincidentally-zero
  // number). totalCost - inputCost + jobCost, always.
  inputCost: number;
  jobCost: number;
  totalCost: number;
  buyQuantity?: number;
  buyUnitCost?: number;
  poolTotalQuantity?: number;
  poolBuildQuantity?: number;
  poolBuyQuantity?: number;
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
    // Sum, across the whole plan (main tree + every pooled batch), of
    // every node's own inputCost/jobCost - totalCost = totalInputCost +
    // totalJobCost always, same relationship as on any individual node.
    totalInputCost: number;
    totalJobCost: number;
    totalCost: number;
    // What it would cost to buy the target's own direct materials outright
    // instead of running any of them through the decision engine, PLUS the
    // one real job that still has to run regardless - the target itself
    // is always manufactured (see resolve()'s forceBuild), so there's no
    // version of this comparison where zero jobs are run.
    totalBuyEverythingCost: number;
    iskSaved: number;
    percentSaved: number;
    jobCount: number;
    totalBuyVolumeM3: number;
  };
  tree: BuildTreeNode;
  // One entry per pooled typeId (see BuildTreeNode's "pooled" comment) -
  // the actual, drillable breakdown of what each shared batch builds
  // (children) and buys (poolBuyQuantity), shown ONCE here rather than
  // duplicated at every occurrence in the main tree above.
  pooledBatches: BuildTreeNode[];
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
  // The EIV-based per-unit job/installation fee alone (see resolve()) -
  // unlike materialUnitCost (folded into unitCost above), this does NOT
  // depend on how materials are actually sourced downstream, so it stays
  // valid as a per-unit constant no matter what buildRealTree's real,
  // batch-aware recursion ends up deciding for this node's own materials.
  // Only meaningful when decision === "build".
  jobUnitCost: number;
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
  // Leftover units bought directly rather than produced, when the combined
  // pooled demand doesn't divide evenly into whole batches and one more
  // full batch isn't worth it just for the remainder (see
  // computeOptimalBatchSplit) - folded into the shopping list separately,
  // since materialsSubtree only ever represents what was actually built.
  buyQuantity: number;
  // Total real job cost across the WHOLE materialsSubtree (its own
  // installation fee plus every nested sub-component's, recursively - see
  // sumJobCost) - stored here so each occurrence can split its own
  // inputCost/jobCost proportionally (see buildRealTree's pooled branch)
  // without re-walking materialsSubtree on every occurrence.
  jobCost: number;
};

// Short-TTL, module-level - batches of overlapping/repeated resolves within
// a few minutes of each other reuse prices instead of re-hitting Janice,
// per the brief's pricing section. Keyed by pricing source since buy vs
// sell prices differ.
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
const priceCache = new Map<string, { price: PriceInfo; expiresAt: number }>();

function priceCacheKey(typeId: number, source: PriceSource): string {
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
  priceSource: PriceSource,
): Promise<Map<number, PriceInfo>> {
  const now = Date.now();
  const result = new Map<number, PriceInfo>();
  const toFetch: number[] = [];

  for (const typeId of typeIds) {
    const cached = priceCache.get(priceCacheKey(typeId, priceSource));
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
    const appraisal = await runJaniceAppraisal(itemsText, priceSource);
    for (const item of appraisal.items) {
      const typeId = item.itemType.eid;
      const unitPrice = priceSource === "sell" ? item.immediatePrices.sellPrice : item.immediatePrices.buyPrice;
      const price: PriceInfo = { unitPrice, m3PerUnit: item.itemType.packagedVolume };
      result.set(typeId, price);
      priceCache.set(priceCacheKey(typeId, priceSource), {
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
//
// productPrices - only consulted when forceBuild is true (i.e. only ever
// for the root call), sourcing that one informational buy price from the
// product's own price basis (default sell - what building this is being
// compared against) rather than `prices`, which is every material's price
// basis (default buy). Never passed down into the materials recursion.
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
  productPrices?: Map<number, PriceInfo>,
): Promise<ResolvedNode> {
  const cached = cache.get(typeId);
  if (cached) return cached;

  const name = nameByTypeId.get(typeId) ?? `Type ${typeId}`;
  const buyPrice = getBuyPrice(typeId, name, forceBuild && productPrices ? productPrices : prices, haulRatePerM3, warnings);

  const override = poolOverrides.get(typeId);
  if (override) {
    const node: ResolvedNode = {
      typeId,
      decision: "build",
      unitCost: override.unitCostPerDemand,
      buyPrice,
      outputQuantity: 1,
      jobUnitCost: 0,
    };
    cache.set(typeId, node);
    return node;
  }

  const blueprint = await Blueprint.findOne({ productTypeId: typeId }).lean();
  if (!blueprint) {
    const node: ResolvedNode = { typeId, decision: "buy", unitCost: buyPrice, buyPrice, outputQuantity: 1, jobUnitCost: 0 };
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
    const node: ResolvedNode = { typeId, decision: "buy", unitCost: buyPrice, buyPrice, outputQuantity: 1, jobUnitCost: 0 };
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
    jobUnitCost,
    children: decision === "build" ? children : undefined,
  };
  cache.set(typeId, node);
  return node;
}

// A blueprint can only be run a whole number of times, each run producing
// exactly batchSize units - demand rarely divides evenly into that, so the
// real choice isn't "build" vs "buy" as an all-or-nothing pair, it's how
// many WHOLE batches to build (if any) and whether to buy the leftover
// remainder outright rather than wasting a further batch to cover it.
//
// Building a full batch is always at least as good as buying the same
// units it replaces whenever buildUnitCost < buyPrice (the only case this
// is ever called for - see the callers), so it's never worth building
// FEWER than floor(demand / batchSize) whole batches. The only real
// decision is what to do with what's left over after that: build one MORE
// batch (wasting batchSize - remainder units, but still cheaper overall if
// batchSize * buildUnitCost < remainder * buyPrice) or just buy the
// remainder directly. Used for both a single branch's own real demand
// (buildRealTree) and combined pooled demand across branches
// (detectPoolingOpportunities) - the economics are identical either way.
function computeOptimalBatchSplit(
  demand: number,
  batchSize: number,
  buildUnitCost: number,
  buyPrice: number,
): { buildQuantity: number; buyQuantity: number; totalCost: number } {
  const fullBatches = Math.floor(demand / batchSize);
  const remainder = demand - fullBatches * batchSize;

  if (remainder === 0) {
    return { buildQuantity: demand, buyQuantity: 0, totalCost: demand * buildUnitCost };
  }

  const extraBatchCost = batchSize * buildUnitCost;
  const remainderBuyCost = remainder * buyPrice;

  if (extraBatchCost < remainderBuyCost) {
    const buildQuantity = (fullBatches + 1) * batchSize;
    return { buildQuantity, buyQuantity: 0, totalCost: buildQuantity * buildUnitCost };
  }

  const buildQuantity = fullBatches * batchSize;
  return {
    buildQuantity,
    buyQuantity: remainder,
    totalCost: buildQuantity * buildUnitCost + remainder * buyPrice,
  };
}

// One (demand, subtotal) pair per occurrence of a typeId encountered while
// walking the real tree - fed to detectPoolingOpportunities afterward.
type DemandLog = Map<number, { demand: number; subtotal: number }[]>;

function logDemand(demandLog: DemandLog, typeId: number, demand: number, subtotal: number): void {
  const entries = demandLog.get(typeId) ?? [];
  entries.push({ demand, subtotal });
  demandLog.set(typeId, entries);
}

// Folds a speculative DemandLog (built while evaluating whether a decision
// actually holds up against real, cascading costs - see buildRealTree)
// into the real, shared one, ONLY once that decision is confirmed. Never
// called for a path that gets discarded - see the callers.
function mergeDemandLog(from: DemandLog, into: DemandLog): void {
  for (const [typeId, entries] of from) {
    const existing = into.get(typeId);
    if (existing) existing.push(...entries);
    else into.set(typeId, [...entries]);
  }
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
    return { typeId, name, decision: "buy", quantity: rawQuantity, inputCost: 0, jobCost: 0, totalCost: 0 };
  }

  if (poolOverrides.has(typeId)) {
    // resolve() already substituted unitCost = the pooled fair-share rate
    // for this typeId - no batch re-check needed (outputQuantity is 1 on
    // the override's synthetic node). pool* below is the shared batch's
    // own totals, kept for bookkeeping - but NOT its children: this typeId
    // can appear at several places in the tree, and attaching the same
    // real breakdown at every one of them would show the identical
    // subtree over and over. The one real, drillable copy lives in
    // resolveBuildPlan's pooledBatches instead. The batch's real cost is
    // already counted exactly once via PoolOverride.materialsSubtree in
    // resolveBuildPlan, not per-occurrence (see accumulateShoppingList's
    // explicit guard for "pooled"). inputCost/jobCost here are this
    // occurrence's own proportional SHARE of the pool's real totals (its
    // demand as a fraction of the whole pool's demand), not the pool's
    // totals themselves - see resolveBuildPlan's pooledBatches for those.
    const override = poolOverrides.get(typeId)!;
    const poolTotalQuantity = override.materialsSubtree.quantity + override.buyQuantity;
    const totalCost = node.unitCost * rawQuantity;
    const shareRatio = poolTotalQuantity > 0 ? rawQuantity / poolTotalQuantity : 0;
    const jobCost = shareRatio * override.jobCost;
    logDemand(demandLog, typeId, rawQuantity, totalCost);
    return {
      typeId,
      name,
      decision: "pooled",
      quantity: rawQuantity,
      inputCost: totalCost - jobCost,
      jobCost,
      totalCost,
      poolTotalQuantity,
      poolBuildQuantity: override.materialsSubtree.quantity,
      poolBuyQuantity: override.buyQuantity,
    };
  }

  if (node.decision !== "build") {
    // Idealized 'buy' - stable under any real demand, nothing to re-check.
    const totalCost = node.buyPrice * rawQuantity;
    logDemand(demandLog, typeId, rawQuantity, totalCost);
    return { typeId, name, decision: "buy", quantity: rawQuantity, inputCost: totalCost, jobCost: 0, totalCost };
  }

  if (skipDemandCheck) {
    // Root - always fully build the real requested quantity, no buy
    // comparison and no partial-batch-plus-buy split (see resolve()'s
    // forceBuild comment); a blueprint still only runs in whole batches,
    // so this rounds up to the nearest one, same as always.
    const realBuildQuantity = Math.ceil(rawQuantity / node.outputQuantity) * node.outputQuantity;
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
    // Real bottom-up cost - sum of what the children ACTUALLY end up
    // costing (after their own batch/hybrid re-checks), not
    // node.unitCost's idealized, full-efficiency figure. Keeps this node's
    // own displayed cost consistent with what's shown right underneath it
    // (see the long comment on ResolvedNode.jobUnitCost for why job cost
    // alone is still safe to take from the idealized pass).
    const inputCost = (children ?? []).reduce((sum, child) => sum + child.totalCost, 0);
    const jobCost = realBuildQuantity * node.jobUnitCost;
    logDemand(demandLog, typeId, rawQuantity, inputCost + jobCost);
    return {
      typeId,
      name,
      decision: "build",
      quantity: realBuildQuantity,
      inputCost,
      jobCost,
      totalCost: inputCost + jobCost,
      children,
    };
  }

  // node.unitCost/node.buyPrice (idealized - see ResolvedNode) pick HOW
  // MUCH to build vs buy here - a heuristic, not a full search over every
  // candidate batch count (that would mean a full recursion per candidate
  // at every node, compounding into an exponential blowup on a deep tree).
  // What is guaranteed, not just heuristic, is that whatever this heuristic
  // picks gets checked against reality before being trusted - see below.
  const split = computeOptimalBatchSplit(rawQuantity, node.outputQuantity, node.unitCost, node.buyPrice);

  if (split.buyQuantity === rawQuantity) {
    // Not even one full batch is worth producing for this demand alone -
    // buy all of it (no children involved, so there's no idealized-vs-real
    // gap to correct here). Pooling, checked separately after this whole
    // walk completes, is what can still recover a build here if enough
    // OTHER demand for the same typeId exists elsewhere in the tree - see
    // resolveBuildPlan.
    logDemand(demandLog, typeId, rawQuantity, split.totalCost);
    return { typeId, name, decision: "buy", quantity: rawQuantity, inputCost: split.totalCost, jobCost: 0, totalCost: split.totalCost };
  }

  // Recurse into a LOCAL demand log first, not the real shared one - real
  // per-unit costs can only be equal to or HIGHER than the idealized figure
  // computeOptimalBatchSplit's decision was based on (batch waste never
  // makes anything cheaper), so a decision the idealized heuristic thought
  // was a clear win can still turn out to not actually beat buying once a
  // descendant's own real batch waste is known. Nothing is committed to
  // the caller's demandLog (or returned as this node's decision) until
  // that's confirmed below - see the downgrade branch.
  const localDemandLog: DemandLog = new Map();
  const children = node.children?.map((child) =>
    buildRealTree(
      child.childTypeId,
      split.buildQuantity * child.quantityPerUnit,
      cache,
      nameByTypeId,
      warnings,
      poolOverrides,
      localDemandLog,
    ),
  );

  // Real cost of the built portion - sum of the children's own real
  // totals (whatever they actually decided, batch waste and all) plus
  // this node's own per-unit job fee (a real constant regardless of how
  // the materials were sourced - see ResolvedNode.jobUnitCost), NOT
  // split.totalCost's idealized figure. The bought portion (buyQuantity,
  // if any) is already a real number as-is.
  const materialInputCost = (children ?? []).reduce((sum, child) => sum + child.totalCost, 0);
  const jobCost = split.buildQuantity * node.jobUnitCost; // only the built portion incurs a job fee - bought units are just purchased
  const realBuildPortionCost = materialInputCost + jobCost;
  const realTotalCost = realBuildPortionCost + split.buyQuantity * node.buyPrice;
  const pureBuyCost = rawQuantity * node.buyPrice;

  if (realTotalCost >= pureBuyCost) {
    // The idealized heuristic said building (or hybrid) would win, but the
    // REAL cost - now that it's known - doesn't actually beat buying the
    // whole real demand outright. Discard the speculative children and
    // localDemandLog entirely (never merged - nothing here happened as far
    // as the rest of the tree/pooling is concerned) and buy instead. This
    // doesn't try OTHER build quantities to see if some different batch
    // count would have won (see the header comment above) - it only
    // guarantees the decision actually made is never worse than buying.
    logDemand(demandLog, typeId, rawQuantity, pureBuyCost);
    return { typeId, name, decision: "buy", quantity: rawQuantity, inputCost: pureBuyCost, jobCost: 0, totalCost: pureBuyCost };
  }

  mergeDemandLog(localDemandLog, demandLog);
  logDemand(demandLog, typeId, rawQuantity, realTotalCost);

  if (split.buyQuantity === 0) {
    return {
      typeId,
      name,
      decision: "build",
      quantity: split.buildQuantity,
      inputCost: materialInputCost,
      jobCost,
      totalCost: realBuildPortionCost,
      children,
    };
  }

  // Whole batches worth producing (children above), plus a leftover
  // remainder that isn't worth a further batch - bought directly instead.
  // inputCost merges both pieces (built materials + the bought remainder's
  // purchase price) into one number - see the type comment on "hybrid".
  const boughtCost = split.buyQuantity * node.buyPrice;
  return {
    typeId,
    name,
    decision: "hybrid",
    quantity: rawQuantity,
    inputCost: materialInputCost + boughtCost,
    jobCost,
    totalCost: realTotalCost,
    buyQuantity: split.buyQuantity,
    buyUnitCost: node.buyPrice,
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
    // Idealized split - a cheap pre-filter (how many batches WOULD be
    // worth it at full efficiency, and is that even in the right
    // ballpark before paying for a real recursion below) - the number
    // actually charged per occurrence never comes from this, see below.
    const idealizedSplit = computeOptimalBatchSplit(
      totalDemand,
      idealized.outputQuantity,
      idealized.unitCost,
      idealized.buyPrice,
    );

    if (idealizedSplit.totalCost >= currentCost) continue; // not even idealized-cheaper - skip the recursion below entirely

    // Resolve the one real subtree for producing just the WHOLE batches
    // worth building (idealizedSplit.buildQuantity, already an exact
    // multiple of outputQuantity) - fresh (empty pool/demand maps - nested
    // pooling within a pooled batch's own materials is intentionally not
    // chased further, a rare enough third-order effect not to be worth the
    // added complexity here). This subtree's own subtotal is already the
    // REAL, self-consistent cost (see buildRealTree), which is what
    // actually gets charged below - not the idealized estimate above,
    // which was only ever a filter to avoid this recursion when it's
    // obviously not going to help.
    const materialsSubtree = buildRealTree(
      typeId,
      idealizedSplit.buildQuantity,
      cache,
      nameByTypeId,
      warnings,
      new Map(),
      new Map(),
    );
    const realPoolCost = materialsSubtree.totalCost + idealizedSplit.buyQuantity * idealized.buyPrice;

    // Re-confirm with the REAL cost now that it's known - nested batch
    // waste inside the pooled batch's own materials can erode some or all
    // of the idealized estimate's apparent benefit.
    if (realPoolCost >= currentCost) continue;

    newOverrides.set(typeId, {
      unitCostPerDemand: realPoolCost / totalDemand,
      materialsSubtree,
      buyQuantity: idealizedSplit.buyQuantity,
      // Every job cost within the pooled subtree, recursively - not just
      // materialsSubtree's own top-level fee - see PoolOverride.jobCost.
      jobCost: sumJobCost(materialsSubtree),
    });
  }

  return newOverrides;
}

function addShoppingListEntry(
  out: Map<number, ShoppingListEntry>,
  typeId: number,
  name: string,
  quantity: number,
  unitCost: number,
  subtotal: number,
  volumeM3: number,
): void {
  const existing = out.get(typeId);
  if (existing) {
    existing.quantity += quantity;
    existing.subtotal += subtotal;
    return;
  }
  out.set(typeId, { typeId, name, quantity, unitCost, subtotal, volumeM3 });
}

function accumulateShoppingList(
  node: BuildTreeNode,
  prices: Map<number, PriceInfo>,
  out: Map<number, ShoppingListEntry>,
): void {
  if (node.decision === "buy") {
    addShoppingListEntry(
      out,
      node.typeId,
      node.name,
      node.quantity,
      node.quantity > 0 ? node.totalCost / node.quantity : 0,
      node.totalCost,
      prices.get(node.typeId)?.m3PerUnit ?? 0,
    );
    return;
  }

  if (node.decision === "hybrid" && node.buyQuantity && node.buyUnitCost !== undefined) {
    // The bought portion of this same item - not represented as a child
    // (children only cover the materials for the BUILT portion), so it
    // needs its own shopping-list entry alongside recursing into children
    // below for whatever was actually built.
    addShoppingListEntry(
      out,
      node.typeId,
      node.name,
      node.buyQuantity,
      node.buyUnitCost,
      node.buyQuantity * node.buyUnitCost,
      prices.get(node.typeId)?.m3PerUnit ?? 0,
    );
  }

  // "pooled" occurrences in the main tree carry no children at all (see
  // buildRealTree) - the real, drillable breakdown lives only in
  // resolveBuildPlan's pooledBatches, which is what this guard actually
  // protects: pooledBatches entries DO carry children (a copy of the
  // shared batch's own materials, folded into the shopping list exactly
  // once via PoolOverride.materialsSubtree, separately, in
  // resolveBuildPlan) - recursing into them here too would double it.
  if (node.decision === "pooled") return;

  for (const child of node.children ?? []) {
    accumulateShoppingList(child, prices, out);
  }
}

function countBuildNodes(node: BuildTreeNode): number {
  if (node.decision !== "build" && node.decision !== "hybrid") return 0;
  let count = 1;
  for (const child of node.children ?? []) count += countBuildNodes(child);
  return count;
}

// "pooled" occurrences DO carry their own jobCost (their proportional
// share of the pool's real total, for that one row's own Job Cost column -
// see buildRealTree) - but summing that share across every occurrence of
// a pooled typeId adds back up to the pool's FULL job cost by
// construction, which is ALSO counted separately via PoolOverride's own
// materialsSubtree in resolveBuildPlan. Counting both would double it, so
// this excludes "pooled" nodes entirely and leaves them to the pool's own
// authoritative sum - same pattern as countBuildNodes excluding "pooled"
// from its own count for the same reason.
function sumJobCost(node: BuildTreeNode): number {
  if (node.decision === "pooled") return 0;
  let total = node.jobCost;
  for (const child of node.children ?? []) total += sumJobCost(child);
  return total;
}

// What it would cost to buy every one of the target's own DIRECT materials
// (its blueprint's immediate inputs, i.e. resolvedTree's children) off the
// market instead of running any of them through the decision engine, PLUS
// the one real job that still has to run to assemble them - the target
// itself is always manufactured (see resolve()'s forceBuild), so there's
// no version of this comparison where zero jobs run, even in the "just
// buy the inputs" baseline. This is the natural "did going deeper actually
// help" contrast against resolvedTree.totalCost, the fully recursive,
// build/buy/hybrid/pooled-optimized figure. Deliberately NOT the target's
// own market price (see resolve()'s forceBuild comment) - with the target
// forced to always build, comparing against its own buy price would just
// reduce to "total cost vs the item's JBV/JSV" for both figures, which
// isn't comparing anything this tool actually computed. child.quantity is
// already the real, ME/rig-adjusted amount needed (same figure totalCost's
// own material cost was derived from), so this is a genuine apples-to-
// apples "materials sourced via the plan" vs "materials all bought
// outright, one job still run" comparison. Falls back to resolvedTree's
// own totalCost when there are no children at all (no blueprint, or no
// structure configured for the activity - resolvedTree is a plain buy
// leaf already, nothing to contrast it against, and its own jobCost is 0
// in that case anyway, so adding it changes nothing).
function computeBuyEverythingCost(
  resolvedTree: BuildTreeNode,
  prices: Map<number, PriceInfo>,
  haulRatePerM3: number,
  warnings: Set<string>,
): number {
  const directMaterialsCost =
    resolvedTree.children && resolvedTree.children.length > 0
      ? resolvedTree.children.reduce(
          (sum, child) => sum + getBuyPrice(child.typeId, child.name, prices, haulRatePerM3, warnings) * child.quantity,
          0,
        )
      : resolvedTree.totalCost;
  return directMaterialsCost + resolvedTree.jobCost;
}

export async function resolveBuildPlan(input: ResolveInput): Promise<BuildResolveResult> {
  const { targetTypeId, quantity, assumedME, materialPriceSource, productPriceSource, haulRatePerM3, characterId } =
    input;

  const treeTypeIds = new Set<number>();
  await collectTreeTypeIds(targetTypeId, treeTypeIds);

  const types = await Type.find({ typeId: { $in: [...treeTypeIds] } }).lean();
  const nameByTypeId = new Map(types.map((t) => [t.typeId, t.name]));

  // prices - every material/component in the tree, priced on
  // materialPriceSource. productPrices - the target item's own price ONLY,
  // priced separately on productPriceSource (see resolve()'s forceBuild
  // header comment for why these are deliberately not the same map).
  const [prices, productPrices, adjustedPrices] = await Promise.all([
    getPrices([...treeTypeIds], nameByTypeId, materialPriceSource),
    getPrices([targetTypeId], nameByTypeId, productPriceSource),
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
      productPrices,
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
  // shared batches) are resolved once, separately from the main tree - fold
  // them into the same shopping list / job count exactly once here. Any
  // leftover demand the pool didn't build (buyQuantity - combined demand
  // that didn't divide evenly into whole batches) is bought directly and
  // isn't part of materialsSubtree at all, so it needs its own entry too.
  //
  // pooledBatches - one self-contained node per pooled typeId, built here
  // rather than reusing materialsSubtree as-is, since materialsSubtree
  // only covers what was BUILT - this also folds in the bought remainder
  // (poolBuyQuantity) so the whole shared batch (built + bought) is
  // visible as a single entry, matching what each occurrence's inline
  // pool* note already summarizes (see buildRealTree).
  const pooledBatches: BuildTreeNode[] = [];
  for (const [typeId, override] of poolOverrides) {
    accumulateShoppingList(override.materialsSubtree, prices, shoppingListMap);
    const name = nameByTypeId.get(typeId) ?? `Type ${typeId}`;
    let buyPrice = 0;
    if (override.buyQuantity > 0) {
      buyPrice = getBuyPrice(typeId, name, prices, haulRatePerM3, warnings);
      addShoppingListEntry(
        shoppingListMap,
        typeId,
        name,
        override.buyQuantity,
        buyPrice,
        override.buyQuantity * buyPrice,
        prices.get(typeId)?.m3PerUnit ?? 0,
      );
    }

    const poolTotalQuantity = override.materialsSubtree.quantity + override.buyQuantity;
    const totalCost = override.unitCostPerDemand * poolTotalQuantity;
    pooledBatches.push({
      typeId,
      name,
      decision: "pooled",
      quantity: poolTotalQuantity,
      inputCost: totalCost - override.jobCost,
      jobCost: override.jobCost,
      totalCost,
      poolTotalQuantity,
      poolBuildQuantity: override.materialsSubtree.quantity,
      poolBuyQuantity: override.buyQuantity,
      children: override.materialsSubtree.children,
    });
  }

  const jobCount =
    countBuildNodes(resolvedTree) +
    [...poolOverrides.values()].reduce((sum, o) => sum + countBuildNodes(o.materialsSubtree), 0);

  const totalJobCost =
    sumJobCost(resolvedTree) +
    [...poolOverrides.values()].reduce((sum, o) => sum + sumJobCost(o.materialsSubtree), 0);

  const totalCost = resolvedTree.totalCost;
  const totalInputCost = totalCost - totalJobCost;

  const totalBuyEverythingCost = computeBuyEverythingCost(resolvedTree, prices, haulRatePerM3, warnings);

  const totalBuyVolumeM3 = [...shoppingListMap.values()].reduce(
    (sum, entry) => sum + entry.volumeM3 * entry.quantity,
    0,
  );

  // The target's own market price - purely informational (the build tree
  // row itself doesn't show it either, since the target is always forced
  // to "build" - see resolve()'s forceBuild comment), not part of either
  // summary figure above. Surfaced only via this warning, so a forced
  // build that's actually pricier than just buying the finished item
  // outright doesn't go unnoticed. Only fires when buying really would be
  // cheaper - most items won't hit this, since forceBuild only overrides
  // the decision, not the underlying economics.
  const targetMarketPrice =
    getBuyPrice(targetTypeId, resolvedTree.name, productPrices, haulRatePerM3, warnings) * resolvedTree.quantity;
  if (targetMarketPrice > 0 && totalCost > targetMarketPrice) {
    const percentMore = ((totalCost - targetMarketPrice) / targetMarketPrice) * 100;
    warnings.add(
      `Buying ${resolvedTree.name} directly would cost ${targetMarketPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} ISK - building it costs ${percentMore.toFixed(1)}% more, likely an illiquid/unreliable market price for an item this size. The build breakdown below is shown regardless, since that's what this tool is for.`,
    );
  }

  return {
    target: { typeId: targetTypeId, name: resolvedTree.name, quantity: resolvedTree.quantity },
    summary: {
      totalInputCost,
      totalJobCost,
      totalCost,
      totalBuyEverythingCost,
      iskSaved: totalBuyEverythingCost - totalCost,
      percentSaved:
        totalBuyEverythingCost > 0 ? ((totalBuyEverythingCost - totalCost) / totalBuyEverythingCost) * 100 : 0,
      jobCount,
      totalBuyVolumeM3,
    },
    tree: resolvedTree,
    pooledBatches,
    shoppingList: [...shoppingListMap.values()].sort((a, b) => b.subtotal - a.subtotal),
    warnings: [...warnings],
  };
}
