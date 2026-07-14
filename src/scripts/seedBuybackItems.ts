import mongoose from "mongoose";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";
import { BuybackCategory } from "../models/BuybackCategory";
import { BuybackItem } from "../models/BuybackItem";

dotenv.config();

const SDE_URL = "https://www.fuzzwork.co.uk/dump/latest/csv/invTypes.csv";

type SdeRow = {
  typeID: string;
  groupID: string;
  typeName: string;
  published: string;
};

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  console.log(`Fetching ${SDE_URL}...`);
  const res = await fetch(SDE_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch SDE export: ${res.status}`);
  }
  const csvText = await res.text();

  const rows: SdeRow[] = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
  });

  const publishedRows = rows.filter((row) => row.published === "1");
  console.log(`Parsed ${rows.length} types (${publishedRows.length} published)`);

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  // Run seedBuybackCategories first - items whose group isn't a known
  // (published) category get skipped rather than left uncategorized.
  const categories = await BuybackCategory.find().select("groupId _id");
  const categoryIdByGroup = new Map(
    categories.map((category) => [category.groupId, category._id]),
  );

  let skipped = 0;
  const operations = publishedRows.flatMap((row) => {
    const categoryId = categoryIdByGroup.get(Number(row.groupID));
    if (!categoryId) {
      skipped++;
      return [];
    }

    // name/categoryId are kept in sync on every run; all admin-editable
    // fields are only set on first insert so this stays safe to re-run
    // without clobbering admin edits.
    return [
      {
        updateOne: {
          filter: { typeId: Number(row.typeID) },
          update: {
            $set: {
              typeId: Number(row.typeID),
              name: row.typeName,
              categoryId,
            },
            $setOnInsert: {
              accepted: null,
              rateOverride: null,
              notes: null,
              haul: null,
              acceptedLocationIds: null,
            },
          },
          upsert: true,
        },
      },
    ];
  });

  const result = await BuybackItem.bulkWrite(operations);
  console.log(
    `Seeded buyback items: ${result.upsertedCount} inserted, ${result.modifiedCount} updated, ${skipped} skipped (unknown/unpublished group)`,
  );

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
