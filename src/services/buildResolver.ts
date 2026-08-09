import { Blueprint } from "../models/Blueprint";
import { Structure, IIndustryProfile } from "../models/Structure";
import { Type } from "../models/Type";
import { ToolsUser, IBuildStructurePreferences } from "../models/ToolsUser";
import { runJaniceAppraisal } from "./janiceAppraisal";
import { getSystemCostIndex } from "./industryCostIndex";

export type BuyPriceSource = "buy" | "split";

export type ResolveInput = {
  targetTypeId: number;
  quantity: number;
  assumedME: number; // percent, e.g. 10 - manufacturing only, never applies to reaction
  buyPriceSource: BuyPriceSource;
  haulRatePerM3: number;
  characterId: string;
};

export type BuildTreeNode = {
  typeId: number;
  name: string;
  decision: "build" | "buy";
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

type ActivityStructure = {
  structureId: number;
  systemId: number;
  profile: IIndustryProfile;
};

type StructuresByActivity = Partial<Record<"manufacturing" | "reaction", ActivityStructure>>;

// Per-unit result of the memoized bottom-up resolve - unitCost/decision are
// made once per typeId based purely on that item's own unit economics, per
// the brief. children carries each material's quantity-per-one-unit-of-this-
// item so the real tree can be walked out afterward with the actual
// requested quantity (see buildRealTree).
type ResolvedNode = {
  typeId: number;
  decision: "build" | "buy";
  unitCost: number;
  children?: { childTypeId: number; quantityPerUnit: number }[];
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
    if (structure?.systemId && profile) {
      result[activity] = { structureId, systemId: structure.systemId, profile };
    }
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

async function resolve(
  typeId: number,
  cache: Map<number, ResolvedNode>,
  prices: Map<number, PriceInfo>,
  nameByTypeId: Map<number, string>,
  structuresByActivity: StructuresByActivity,
  assumedME: number,
  haulRatePerM3: number,
  warnings: Set<string>,
): Promise<ResolvedNode> {
  const cached = cache.get(typeId);
  if (cached) return cached;

  const name = nameByTypeId.get(typeId) ?? `Type ${typeId}`;
  const buyPrice = getBuyPrice(typeId, name, prices, haulRatePerM3, warnings);

  const blueprint = await Blueprint.findOne({ productTypeId: typeId }).lean();
  if (!blueprint) {
    const node: ResolvedNode = { typeId, decision: "buy", unitCost: buyPrice };
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
    const node: ResolvedNode = { typeId, decision: "buy", unitCost: buyPrice };
    cache.set(typeId, node);
    return node;
  }

  // materialReduction/timeReduction/costReduction and assumedME are all
  // entered and stored as percentages (e.g. 2 = 2%), so every multiplier
  // below divides by 100 - the brief's own pseudocode treats them as
  // already-fractional (0-1), but percentages are what the admin form and
  // the Manufacturing Planner's ME input actually take.
  const meMultiplier = blueprint.activity === "reaction" ? 1 : 1 - assumedME / 100;
  const rigMultiplier = 1 - (structureEntry.profile.materialReduction ?? 0) / 100;

  const children: { childTypeId: number; quantityPerUnit: number }[] = [];
  let materialUnitCost = 0;

  for (const material of blueprint.materials) {
    const perOutputQty =
      Math.ceil(material.quantity * meMultiplier * rigMultiplier) / blueprint.outputQuantity;
    const childNode = await resolve(
      material.typeId,
      cache,
      prices,
      nameByTypeId,
      structuresByActivity,
      assumedME,
      haulRatePerM3,
      warnings,
    );
    children.push({ childTypeId: material.typeId, quantityPerUnit: perOutputQty });
    materialUnitCost += childNode.unitCost * perOutputQty;
  }

  const costIndex = await getSystemCostIndex(structureEntry.systemId, blueprint.activity);
  const jobUnitCost =
    materialUnitCost * costIndex * (1 - (structureEntry.profile.costReduction ?? 0) / 100);
  const buildUnitCost = materialUnitCost + jobUnitCost;
  const decision: "build" | "buy" = buildUnitCost < buyPrice ? "build" : "buy";

  const node: ResolvedNode = {
    typeId,
    decision,
    unitCost: decision === "build" ? buildUnitCost : buyPrice,
    children: decision === "build" ? children : undefined,
  };
  cache.set(typeId, node);
  return node;
}

// Walks the per-unit resolved cache from the top with the real requested
// quantity, multiplying quantityPerUnit down through the tree - per the
// brief, this deliberately does NOT dedupe shared components across
// branches (that's what the shopping list step is for); a component used
// under two different parents shows up twice here, once per branch, each
// with its own real quantity in that branch.
function buildRealTree(
  typeId: number,
  quantity: number,
  cache: Map<number, ResolvedNode>,
  nameByTypeId: Map<number, string>,
): BuildTreeNode {
  const node = cache.get(typeId);
  const name = nameByTypeId.get(typeId) ?? `Type ${typeId}`;

  if (!node) {
    return { typeId, name, decision: "buy", quantity, unitCost: 0, subtotal: 0 };
  }

  const subtotal = node.unitCost * quantity;
  const children = node.children?.map((child) =>
    buildRealTree(child.childTypeId, quantity * child.quantityPerUnit, cache, nameByTypeId),
  );

  return { typeId, name, decision: node.decision, quantity, unitCost: node.unitCost, subtotal, children };
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

  const prices = await getPrices([...treeTypeIds], nameByTypeId, buyPriceSource);

  const toolsUser = await ToolsUser.findOne({ characterId }).lean();
  const structuresByActivity = await loadStructuresByActivity(
    toolsUser?.buildStructurePreferences ?? {},
  );

  const warnings = new Set<string>();
  const cache = new Map<number, ResolvedNode>();
  await resolve(
    targetTypeId,
    cache,
    prices,
    nameByTypeId,
    structuresByActivity,
    assumedME,
    haulRatePerM3,
    warnings,
  );

  const tree = buildRealTree(targetTypeId, quantity, cache, nameByTypeId);

  const shoppingListMap = new Map<number, ShoppingListEntry>();
  accumulateShoppingList(tree, prices, shoppingListMap);

  const totalBuildCost = tree.subtotal;
  const totalBuyEverythingCost = getBuyPrice(
    targetTypeId,
    tree.name,
    prices,
    haulRatePerM3,
    warnings,
  ) * quantity;
  const totalBuyVolumeM3 = [...shoppingListMap.values()].reduce(
    (sum, entry) => sum + entry.volumeM3 * entry.quantity,
    0,
  );

  return {
    target: { typeId: targetTypeId, name: tree.name, quantity },
    summary: {
      totalBuildCost,
      totalBuyEverythingCost,
      iskSaved: totalBuyEverythingCost - totalBuildCost,
      percentSaved:
        totalBuyEverythingCost > 0
          ? ((totalBuyEverythingCost - totalBuildCost) / totalBuyEverythingCost) * 100
          : 0,
      jobCount: countBuildNodes(tree),
      totalBuyVolumeM3,
    },
    tree,
    shoppingList: [...shoppingListMap.values()].sort((a, b) => b.subtotal - a.subtotal),
    warnings: [...warnings],
  };
}

