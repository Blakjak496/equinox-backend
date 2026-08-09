import mongoose from "mongoose";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";
import { Blueprint } from "../models/Blueprint";
import { Type } from "../models/Type";

dotenv.config();

const BASE_URL = "https://www.fuzzwork.co.uk/dump/latest/csv";

// Confirmed against a live pull of industryActivity.csv's distinct
// activityID values, not assumed from memory - 1 = Manufacturing,
// 11 = Reaction. The Blueprint model only ever stores these two; research
// (3/4), copying (5), and invention (8) activity rows are irrelevant to the
// build resolver and are filtered out below.
const MANUFACTURING_ACTIVITY_ID = 1;
const REACTION_ACTIVITY_ID = 11;

type IndustryActivityRow = { typeID: string; activityID: string };
type IndustryActivityMaterialRow = {
  typeID: string;
  activityID: string;
  materialTypeID: string;
  quantity: string;
};
type IndustryActivityProductRow = {
  typeID: string;
  activityID: string;
  productTypeID: string;
  quantity: string;
};
type InvTypesRow = { typeID: string; typeName: string };

async function fetchCsv<T>(filename: string): Promise<T[]> {
  const url = `${BASE_URL}/${filename}`;
  console.log(`Fetching ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${filename}: ${res.status}`);
  const text = await res.text();
  return parse(text, { columns: true, skip_empty_lines: true });
}

function activityKey(blueprintTypeId: number, activityId: number): string {
  return `${blueprintTypeId}:${activityId}`;
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  const [activities, materials, products, invTypes] = await Promise.all([
    fetchCsv<IndustryActivityRow>("industryActivity.csv"),
    fetchCsv<IndustryActivityMaterialRow>("industryActivityMaterials.csv"),
    fetchCsv<IndustryActivityProductRow>("industryActivityProducts.csv"),
    fetchCsv<InvTypesRow>("invTypes.csv"),
  ]);
  console.log(
    `Parsed ${activities.length} activity rows, ${materials.length} material rows, ${products.length} product rows, ${invTypes.length} types`,
  );

  const nameByTypeId = new Map(
    invTypes.map((row) => [Number(row.typeID), row.typeName]),
  );

  const relevantActivities = activities.filter((row) => {
    const activityId = Number(row.activityID);
    return activityId === MANUFACTURING_ACTIVITY_ID || activityId === REACTION_ACTIVITY_ID;
  });

  const materialsByKey = new Map<string, { typeId: number; quantity: number }[]>();
  for (const row of materials) {
    const activityId = Number(row.activityID);
    if (activityId !== MANUFACTURING_ACTIVITY_ID && activityId !== REACTION_ACTIVITY_ID) continue;

    const key = activityKey(Number(row.typeID), activityId);
    const list = materialsByKey.get(key) ?? [];
    list.push({ typeId: Number(row.materialTypeID), quantity: Number(row.quantity) });
    materialsByKey.set(key, list);
  }

  // A blueprint/activity combo can in principle output more than one
  // product row in the SDE (byproducts) - only the first is treated as
  // "the" product a build resolves toward; extras are ignored rather than
  // creating ambiguous multi-product Blueprint docs.
  const productByKey = new Map<string, { productTypeId: number; quantity: number }>();
  for (const row of products) {
    const activityId = Number(row.activityID);
    if (activityId !== MANUFACTURING_ACTIVITY_ID && activityId !== REACTION_ACTIVITY_ID) continue;

    const key = activityKey(Number(row.typeID), activityId);
    if (!productByKey.has(key)) {
      productByKey.set(key, {
        productTypeId: Number(row.productTypeID),
        quantity: Number(row.quantity),
      });
    }
  }

  const referencedTypeIds = new Set<number>();
  const seenProductTypeIds = new Set<number>();
  const blueprintOps = [];
  let skippedNoProduct = 0;
  let skippedDuplicateProduct = 0;

  for (const row of relevantActivities) {
    const blueprintTypeId = Number(row.typeID);
    const activityId = Number(row.activityID);
    const key = activityKey(blueprintTypeId, activityId);

    const product = productByKey.get(key);
    if (!product) {
      skippedNoProduct++;
      continue;
    }

    if (seenProductTypeIds.has(product.productTypeId)) {
      // findBlueprintForProduct assumes exactly one producing blueprint per
      // product (see services/buildResolver.ts) - if the SDE ever has two,
      // the first one encountered wins and this is logged so it can be
      // investigated rather than silently resolved wrong.
      skippedDuplicateProduct++;
      console.warn(
        `Duplicate blueprint for productTypeId=${product.productTypeId} (blueprintTypeId=${blueprintTypeId}, activityId=${activityId}) - keeping the first one seen.`,
      );
      continue;
    }
    seenProductTypeIds.add(product.productTypeId);

    const blueprintMaterials = materialsByKey.get(key) ?? [];
    const activity: "manufacturing" | "reaction" =
      activityId === REACTION_ACTIVITY_ID ? "reaction" : "manufacturing";

    referencedTypeIds.add(blueprintTypeId);
    referencedTypeIds.add(product.productTypeId);
    for (const mat of blueprintMaterials) referencedTypeIds.add(mat.typeId);

    blueprintOps.push({
      updateOne: {
        filter: { productTypeId: product.productTypeId },
        update: {
          $set: {
            blueprintTypeId,
            productTypeId: product.productTypeId,
            activity,
            outputQuantity: product.quantity,
            materials: blueprintMaterials,
          },
        },
        upsert: true,
      },
    });
  }

  console.log(
    `Built ${blueprintOps.length} blueprint docs (${skippedNoProduct} skipped - no product row, ${skippedDuplicateProduct} skipped - duplicate product).`,
  );

  const typeOps = [...referencedTypeIds]
    .filter((typeId) => nameByTypeId.has(typeId))
    .map((typeId) => ({
      updateOne: {
        filter: { typeId },
        update: { $set: { typeId, name: nameByTypeId.get(typeId) } },
        upsert: true,
      },
    }));

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const blueprintResult = blueprintOps.length
    ? await Blueprint.bulkWrite(blueprintOps)
    : null;
  console.log(
    `Blueprints: ${blueprintResult?.upsertedCount ?? 0} inserted, ${blueprintResult?.modifiedCount ?? 0} updated`,
  );

  const typeResult = typeOps.length ? await Type.bulkWrite(typeOps) : null;
  console.log(
    `Types: ${typeResult?.upsertedCount ?? 0} inserted, ${typeResult?.modifiedCount ?? 0} updated`,
  );

  await mongoose.disconnect();
  console.log("Done. Restart the backend to pick up the new data.");
}

run().catch((err) => {
  console.error("Blueprint seed failed:", err);
  process.exit(1);
});
