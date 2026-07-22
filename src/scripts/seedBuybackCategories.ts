import mongoose from "mongoose";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";
import { BuybackCategory } from "../models/BuybackCategory";

dotenv.config();

const SDE_URL = "https://www.fuzzwork.co.uk/dump/latest/csv/invCategories.csv";

type SdeRow = {
  categoryID: string;
  categoryName: string;
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
  console.log(
    `Parsed ${rows.length} categories (${publishedRows.length} published)`,
  );

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  // name is kept in sync on every run; all admin-editable fields are only
  // set on first insert so this stays safe to re-run without clobbering
  // admin edits.
  const operations = publishedRows.map((row) => ({
    updateOne: {
      filter: { categoryId: Number(row.categoryID) },
      update: {
        $set: { categoryId: Number(row.categoryID), name: row.categoryName },
        $setOnInsert: {
          accepted: false,
          percentOffered: 0,
          haul: true,
          acceptedLocationIds: null,
        },
      },
      upsert: true,
    },
  }));

  const result = await BuybackCategory.bulkWrite(operations);
  console.log(
    `Seeded buyback categories: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`,
  );

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
