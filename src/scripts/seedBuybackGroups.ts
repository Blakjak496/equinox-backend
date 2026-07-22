import mongoose from "mongoose";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";
import { BuybackCategory } from "../models/BuybackCategory";
import { BuybackGroup } from "../models/BuybackGroup";

dotenv.config();

const SDE_URL = "https://www.fuzzwork.co.uk/dump/latest/csv/invGroups.csv";

type SdeRow = {
  groupID: string;
  categoryID: string;
  groupName: string;
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
    `Parsed ${rows.length} groups (${publishedRows.length} published)`,
  );

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  // Run seedBuybackCategories first - groups whose category isn't a known
  // (published) category get skipped rather than left unlinked.
  const categories = await BuybackCategory.find().select("categoryId _id");
  const categoryIdByEveId = new Map(
    categories.map((category) => [category.categoryId, category._id]),
  );

  let skipped = 0;
  // name/categoryId are kept in sync on every run (a group's real-category
  // classification shouldn't silently drift out of sync with the SDE even
  // though its own admin-configured settings should never be touched here);
  // the four settings fields are only set on first insert so this stays
  // safe to re-run without clobbering admin edits.
  const operations = publishedRows.flatMap((row) => {
    const categoryId = categoryIdByEveId.get(Number(row.categoryID));
    if (!categoryId) {
      skipped++;
      return [];
    }

    return [
      {
        updateOne: {
          filter: { groupId: Number(row.groupID) },
          update: {
            $set: {
              groupId: Number(row.groupID),
              name: row.groupName,
              categoryId,
            },
            $setOnInsert: {
              accepted: null,
              percentOffered: null,
              haul: null,
              acceptedLocationIds: null,
            },
          },
          upsert: true,
        },
      },
    ];
  });

  const result = await BuybackGroup.bulkWrite(operations);
  console.log(
    `Seeded buyback groups: ${result.upsertedCount} inserted, ${result.modifiedCount} updated, ${skipped} skipped (unknown/unpublished category)`,
  );

  // Existing groups this run never touched at all (groupId isn't in the
  // current SDE dump, e.g. removed/unpublished upstream since they were
  // first seeded) - these never got a categoryId link. Print them by name
  // rather than leaving them silently unlinked, since an unlinked group's
  // own settings still apply (categoryId is only needed to inherit further
  // up), but it can never fall back to a category default.
  const orphans = await BuybackGroup.find({ categoryId: null }).select(
    "groupId name",
  );
  if (orphans.length > 0) {
    console.warn(
      `${orphans.length} existing group(s) have no linked category (removed/unpublished upstream?):`,
    );
    orphans.forEach((g) => console.warn(`  - ${g.name} (groupId ${g.groupId})`));
  }

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
