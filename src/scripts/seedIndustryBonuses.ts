import mongoose from "mongoose";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";
import { IndustryBonusType } from "../models/IndustryBonusType";
import { Type } from "../models/Type";
import { IndustryCategory } from "../types/industryCategory";

dotenv.config();

const BASE_URL = "https://www.fuzzwork.co.uk/dump/latest/csv";

// Dogma attribute IDs, confirmed live against real types (Sotiyo, Tatara,
// a real ME rig, a real reaction rig) - see the Manufacturing Planner
// redesign plan for the full verification trail. Structure attributes are
// stored as raw multipliers in the SDE (e.g. 0.99); rig attributes are
// already percent (e.g. -2.0) - both get normalized to percent here so
// IndustryBonusType never mixes units.
const STRUCTURE_ATTRS = {
  manufacturing: { material: 2600, cost: 2601, time: 2602 },
  reaction: { material: null, cost: null, time: 2721 }, // confirmed: no material/cost structure bonus for reactions
} as const;
const RIG_ATTRS = {
  manufacturing: { material: 2594, cost: 2595, time: 2593 },
  reaction: { material: 2714, cost: null, time: 2713 }, // confirmed: no cost rig for reactions
} as const;

// groupID, not just name, is required to identify these reliably - the
// SDE has an unrelated item (a "Large Collidable Object", typeId 58735,
// groupID 226) that also happens to be named "Azbel", confirmed live. Real
// Engineering Complexes share groupID 1404, real Refineries share 1406.
const ENGINEERING_COMPLEX_GROUP_ID = 1404;
const REFINERY_GROUP_ID = 1406;
const STRUCTURE_TYPE_NAMES: { name: string; groupId: number; activity: "manufacturing" | "reaction" }[] = [
  { name: "Raitaru", groupId: ENGINEERING_COMPLEX_GROUP_ID, activity: "manufacturing" },
  { name: "Azbel", groupId: ENGINEERING_COMPLEX_GROUP_ID, activity: "manufacturing" },
  { name: "Sotiyo", groupId: ENGINEERING_COMPLEX_GROUP_ID, activity: "manufacturing" },
  { name: "Athanor", groupId: REFINERY_GROUP_ID, activity: "reaction" },
  { name: "Tatara", groupId: REFINERY_GROUP_ID, activity: "reaction" },
];

// Ordered, most-specific-first - matched against a real rig's own type
// name. Confirmed against every actual "Standup [SML]-Set/XL-Set
// ...Efficiency..." rig type in the live SDE - this is the one genuinely
// hand-built piece (CCP doesn't expose rig category scope as a queryable
// field), everything else here is read straight from real data. Most
// entries map to a single category, but real "XL-Set" rigs consolidate
// several into one rig (confirmed against their actual descriptions, not
// guessed): "Ship Manufacturing Efficiency" (bare, no size/tier qualifier)
// covers "any ship"; "Equipment and Consumable" covers ship modules/rigs,
// personal deployables, implants and cargo containers (explicitly NOT
// ammunition, per its real description); "Structure and Component" covers
// components, Upwell structures, structure modules, starbase structures,
// AND fuel blocks (which is why Fuel Block classifies as "structure", not
// a reaction category, in industryCategory.ts - fuel blocks are a
// manufacturing product, not a reaction one).
const MANUFACTURING_PHRASES: [RegExp, IndustryCategory[]][] = [
  [/Basic Small Ship/i, ["basic_small_ship"]],
  [/Basic Medium Ship/i, ["basic_medium_ship"]],
  [/Basic Large Ship/i, ["basic_large_ship"]],
  [/Advanced Small Ship/i, ["advanced_small_ship"]],
  [/Advanced Medium Ship/i, ["advanced_medium_ship"]],
  [/Advanced Large Ship/i, ["advanced_large_ship"]],
  [/Capital Ship/i, ["capital_ship"]],
  [/Basic Capital Component/i, ["basic_capital_component"]],
  [/Advanced Component/i, ["advanced_component"]],
  [/Equipment and Consumable/i, ["equipment"]], // XL - covers no ammo, see header comment
  [/Structure and Component/i, ["structure", "advanced_component", "basic_capital_component"]], // XL
  [
    /Ship Manufacturing/i, // XL, bare "any ship" - checked after every specific ship-size/tier phrase above
    [
      "basic_small_ship",
      "basic_medium_ship",
      "basic_large_ship",
      "advanced_small_ship",
      "advanced_medium_ship",
      "advanced_large_ship",
      "capital_ship",
    ],
  ],
  [/Equipment/i, ["equipment"]],
  [/Ammunition/i, ["ammunition"]],
  [/Drone and Fighter/i, ["drone_and_fighter"]],
  [/Structure Manufacturing/i, ["structure"]],
];
const REACTION_PHRASES: [RegExp, IndustryCategory[]][] = [
  [/Composite Reactor/i, ["composite_reaction"]],
  [/Hybrid Reactor/i, ["hybrid_reaction"]],
  [/Biochemical Reactor/i, ["biochemical_reaction"]],
  // Generic L-Set rig, no tier prefix - explicitly covers every reaction
  // category rather than relying on a resolver-side wildcard special case.
  [/Reactor Efficiency/i, ["composite_reaction", "hybrid_reaction", "biochemical_reaction", "any_reaction"]],
];

// Every real Standup structure rig, not just the manufacturing/reaction
// ones - admins set structures up with whatever's *actually* fitted
// (combat, EWAR, moon drilling, reprocessing, research/invention rigs
// included), not just the ones this tool happens to use. A rig outside
// classifyRigCategory's known phrases still gets an IndustryBonusType doc
// (category: [], material/time/cost bonus percents: null, since it won't
// carry the 2593-2595/2713-2714 attributes this script reads) - it just
// never contributes anything in the resolver, exactly as if it weren't
// listed at all. ("S-Set" doesn't currently exist in the live SDE, but the
// pattern allows for it in case that changes.) "Blueprint" variants are
// excluded by the caller before this ever gets checked.
const RIG_NAME_PATTERN = /^Standup (XL|[SML])-Set /i;

type InvTypesRow = { typeID: string; groupID: string; typeName: string };
type DgmTypeAttributeRow = {
  typeID: string;
  attributeID: string;
  valueInt: string;
  valueFloat: string;
};
type InvGroupsRow = { groupID: string; categoryID: string };

async function fetchCsv<T>(filename: string): Promise<T[]> {
  const url = `${BASE_URL}/${filename}`;
  console.log(`Fetching ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${filename}: ${res.status}`);
  const text = await res.text();
  return parse(text, { columns: true, skip_empty_lines: true });
}

function classifyRigCategory(
  name: string,
  activity: "manufacturing" | "reaction",
): IndustryCategory[] | null {
  const phrases = activity === "manufacturing" ? MANUFACTURING_PHRASES : REACTION_PHRASES;
  for (const [pattern, categories] of phrases) {
    if (pattern.test(name)) return categories;
  }
  return null;
}

function attributeValue(
  attrsByType: Map<number, Map<number, number>>,
  typeId: number,
  attributeId: number | null,
): number | null {
  if (attributeId == null) return null;
  return attrsByType.get(typeId)?.get(attributeId) ?? null;
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  const [invTypes, invGroups] = await Promise.all([
    fetchCsv<InvTypesRow>("invTypes.csv"),
    fetchCsv<InvGroupsRow>("invGroups.csv"),
  ]);
  console.log(`Parsed ${invTypes.length} types, ${invGroups.length} groups`);

  const categoryIdByGroupId = new Map(
    invGroups.map((row) => [Number(row.groupID), Number(row.categoryID)]),
  );

  // -- find every real structure type + rig type --
  const structureCandidates = invTypes.filter((row) =>
    STRUCTURE_TYPE_NAMES.some((s) => s.name === row.typeName && s.groupId === Number(row.groupID)),
  );
  const rigCandidates = invTypes.filter(
    (row) => RIG_NAME_PATTERN.test(row.typeName) && !row.typeName.includes("Blueprint"),
  );
  console.log(
    `Found ${structureCandidates.length} structure types, ${rigCandidates.length} rig types`,
  );

  const relevantTypeIds = new Set<number>([
    ...structureCandidates.map((r) => Number(r.typeID)),
    ...rigCandidates.map((r) => Number(r.typeID)),
  ]);

  // dgmTypeAttributes.csv is large (~650k rows) - fetched and filtered down
  // to just the handful of typeIds we actually care about, only ever run
  // manually per the other seed:* scripts, not on a hot path.
  const dgmTypeAttributes = await fetchCsv<DgmTypeAttributeRow>("dgmTypeAttributes.csv");
  console.log(`Parsed ${dgmTypeAttributes.length} dogma type-attribute rows`);

  const attrsByType = new Map<number, Map<number, number>>();
  for (const row of dgmTypeAttributes) {
    const typeId = Number(row.typeID);
    if (!relevantTypeIds.has(typeId)) continue;

    const attributeId = Number(row.attributeID);
    const value = row.valueFloat !== "" ? Number(row.valueFloat) : Number(row.valueInt);

    const byAttr = attrsByType.get(typeId) ?? new Map<number, number>();
    byAttr.set(attributeId, value);
    attrsByType.set(typeId, byAttr);
  }

  const bonusTypeOps = [];

  for (const row of structureCandidates) {
    const typeId = Number(row.typeID);
    const activity = STRUCTURE_TYPE_NAMES.find(
      (s) => s.name === row.typeName && s.groupId === Number(row.groupID),
    )!.activity;
    const attrs = STRUCTURE_ATTRS[activity];

    // Rounded to 4dp - (multiplier - 1) * 100 on a binary float (e.g. 0.99)
    // otherwise leaves noise like -1.0000000000000009 instead of a clean -1.
    const toPercent = (multiplier: number | null) =>
      multiplier == null ? null : Math.round((multiplier - 1) * 100 * 10000) / 10000;

    bonusTypeOps.push({
      updateOne: {
        filter: { typeId },
        update: {
          $set: {
            typeId,
            name: row.typeName,
            kind: "structure" as const,
            activity,
            category: [],
            materialBonusPercent: toPercent(attributeValue(attrsByType, typeId, attrs.material)),
            timeBonusPercent: toPercent(attributeValue(attrsByType, typeId, attrs.time)),
            costBonusPercent: toPercent(attributeValue(attrsByType, typeId, attrs.cost)),
          },
        },
        upsert: true,
      },
    });
  }

  // Every real rig gets a doc, even ones with no known category (combat,
  // EWAR, moon drilling, reprocessing, research/invention rigs) - they
  // just end up with category: [] and null bonus percents (they don't
  // carry the material/time/cost attributes this script reads), so they
  // show up as pickable in the admin UI but never contribute anything in
  // the resolver, matching what's actually fitted on a real structure.
  let unclassifiedCount = 0;
  for (const row of rigCandidates) {
    const typeId = Number(row.typeID);
    const activity: "manufacturing" | "reaction" = /Reactor/i.test(row.typeName)
      ? "reaction"
      : "manufacturing";
    const category = classifyRigCategory(row.typeName, activity) ?? [];
    if (category.length === 0) unclassifiedCount++;

    const attrs = RIG_ATTRS[activity];
    bonusTypeOps.push({
      updateOne: {
        filter: { typeId },
        update: {
          $set: {
            typeId,
            name: row.typeName,
            kind: "rig" as const,
            activity,
            category,
            materialBonusPercent: attributeValue(attrsByType, typeId, attrs.material),
            timeBonusPercent: attributeValue(attrsByType, typeId, attrs.time),
            costBonusPercent: attributeValue(attrsByType, typeId, attrs.cost),
          },
        },
        upsert: true,
      },
    });
  }

  console.log(
    `Built ${bonusTypeOps.length} IndustryBonusType docs (${unclassifiedCount} rigs have no known material/time/cost category - e.g. combat/EWAR/mining/research rigs - included anyway, but inert in the resolver).`,
  );

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const bonusResult = bonusTypeOps.length
    ? await IndustryBonusType.bulkWrite(bonusTypeOps)
    : null;
  console.log(
    `IndustryBonusType: ${bonusResult?.upsertedCount ?? 0} inserted, ${bonusResult?.modifiedCount ?? 0} updated`,
  );

  // Backfill groupId/categoryId onto every Type doc already seeded (by
  // seedBlueprints.ts) - run that script first. classifyProductCategory
  // (services/industryCategory.ts) needs both fields to be a plain DB read
  // at resolve time rather than a live SDE fetch.
  const groupIdByTypeId = new Map(invTypes.map((row) => [Number(row.typeID), Number(row.groupID)]));
  const existingTypes = await Type.find().select("typeId").lean();
  const typeOps = existingTypes
    .map((doc) => {
      const groupId = groupIdByTypeId.get(doc.typeId);
      if (groupId == null) return null;
      const categoryId = categoryIdByGroupId.get(groupId) ?? null;
      return {
        updateOne: {
          filter: { typeId: doc.typeId },
          update: { $set: { groupId, categoryId } },
        },
      };
    })
    .filter((op): op is NonNullable<typeof op> => op !== null);

  const typeResult = typeOps.length ? await Type.bulkWrite(typeOps) : null;
  console.log(`Type groupId/categoryId backfilled on ${typeResult?.modifiedCount ?? 0} docs`);

  await mongoose.disconnect();
  console.log("Done. Restart the backend to pick up the new data.");
}

run().catch((err) => {
  console.error("Industry bonus seed failed:", err);
  process.exit(1);
});
