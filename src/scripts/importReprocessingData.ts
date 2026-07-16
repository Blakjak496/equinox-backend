import mongoose from "mongoose";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";
import { BuybackItem } from "../models/BuybackItem";
import { ReprocessingMaterial } from "../models/ReprocessingMaterial";

dotenv.config();

const BASE_URL = "https://www.fuzzwork.co.uk/dump/latest/csv";

// Ore and ice reprocess at the same efficiency rate and both live under the
// SDE "Asteroid" category - no need to distinguish them further here, only
// for display naming (handled by materialName already being set per row).
const ASTEROID_CATEGORY_ID = 25;
// Harvestable gas cloud materials. Their SDE category ("Celestial") is far
// too broad to use directly (it also covers planets, wrecks, stations,
// etc.) - these two specific groups are exactly and only the reprocessable
// gas types, so group-level matching is the reliable signal here.
const GAS_GROUP_IDS = new Set([711, 4168]);

type InvTypesRow = {
  typeID: string;
  groupID: string;
  typeName: string;
  portionSize: string;
};

type InvGroupsRow = {
  groupID: string;
  categoryID: string;
};

type InvTypeMaterialsRow = {
  typeID: string;
  materialTypeID: string;
  quantity: string;
};

async function fetchCsv<T>(filename: string): Promise<T[]> {
  const url = `${BASE_URL}/${filename}`;
  console.log(`Fetching ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${filename}: ${res.status}`);
  const text = await res.text();
  return parse(text, { columns: true, skip_empty_lines: true });
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  const [invTypes, invGroups, invTypeMaterials] = await Promise.all([
    fetchCsv<InvTypesRow>("invTypes.csv"),
    fetchCsv<InvGroupsRow>("invGroups.csv"),
    fetchCsv<InvTypeMaterialsRow>("invTypeMaterials.csv"),
  ]);
  console.log(
    `Parsed ${invTypes.length} types, ${invGroups.length} groups, ${invTypeMaterials.length} material rows`,
  );

  const nameByTypeId = new Map(
    invTypes.map((row) => [Number(row.typeID), row.typeName]),
  );
  const groupByTypeId = new Map(
    invTypes.map((row) => [Number(row.typeID), Number(row.groupID)]),
  );
  const portionSizeByTypeId = new Map(
    invTypes.map((row) => [Number(row.typeID), Number(row.portionSize)]),
  );
  const categoryByGroupId = new Map(
    invGroups.map((row) => [Number(row.groupID), Number(row.categoryID)]),
  );

  const materialsByTypeId = new Map<
    number,
    { materialTypeId: number; materialName: string; quantity: number }[]
  >();
  for (const row of invTypeMaterials) {
    const typeId = Number(row.typeID);
    const materialTypeId = Number(row.materialTypeID);
    const materialName = nameByTypeId.get(materialTypeId);
    if (!materialName) continue;

    const list = materialsByTypeId.get(typeId) ?? [];
    list.push({ materialTypeId, materialName, quantity: Number(row.quantity) });
    materialsByTypeId.set(typeId, list);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const catalogItems = await BuybackItem.find().select(
    "typeId reprocessingCategory",
  );
  console.log(
    `${catalogItems.length} catalog items to check against reprocessing data`,
  );

  const reprocessingOps = [];
  const categoryOps = [];
  let skippedNoMaterials = 0;

  for (const item of catalogItems) {
    const materials = materialsByTypeId.get(item.typeId);
    if (!materials || materials.length === 0) {
      skippedNoMaterials++;
      continue;
    }

    const portionSize = portionSizeByTypeId.get(item.typeId) ?? 1;

    reprocessingOps.push({
      updateOne: {
        filter: { typeId: item.typeId },
        update: { $set: { typeId: item.typeId, portionSize, materials } },
        upsert: true,
      },
    });

    // Only auto-set the category if the admin hasn't already made a call on
    // this item (including a deliberate "leave it manual") - re-running
    // this import shouldn't clobber an existing edit.
    if (item.reprocessingCategory == null) {
      const groupId = groupByTypeId.get(item.typeId);
      const categoryId =
        groupId !== undefined ? categoryByGroupId.get(groupId) : undefined;

      let autoCategory: "ore_ice" | "gas" | null = null;
      if (categoryId === ASTEROID_CATEGORY_ID) autoCategory = "ore_ice";
      else if (groupId !== undefined && GAS_GROUP_IDS.has(groupId))
        autoCategory = "gas";

      if (autoCategory) {
        categoryOps.push({
          updateOne: {
            filter: { typeId: item.typeId },
            update: { $set: { reprocessingCategory: autoCategory } },
          },
        });
      }
    }
  }

  const reprocessingResult = reprocessingOps.length
    ? await ReprocessingMaterial.bulkWrite(reprocessingOps)
    : null;
  const categoryResult = categoryOps.length
    ? await BuybackItem.bulkWrite(categoryOps)
    : null;

  console.log(
    `Reprocessing data: ${reprocessingResult?.upsertedCount ?? 0} inserted, ${reprocessingResult?.modifiedCount ?? 0} updated (${skippedNoMaterials} catalog items have no reprocessing materials).`,
  );
  console.log(
    `Auto-set reprocessingCategory on ${categoryResult?.modifiedCount ?? 0} items (ore_ice via SDE category, gas via known harvestable-cloud groups). Everything else needs a manual admin pick, including scrap/salvage.`,
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Reprocessing data import failed:", err);
  process.exit(1);
});
