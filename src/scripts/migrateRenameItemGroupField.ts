import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

// One-time migration: BuybackItem.categoryId actually pointed at what's now
// BuybackGroup (the real BuybackCategory model didn't exist until this
// migration). Renames the field in place so it matches the new schema -
// the ObjectId values themselves are untouched and keep pointing at the
// same (renamed) documents.
async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  const dryRun = process.argv.includes("--dry-run");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  if (!db) throw new Error("No active database connection");

  const items = db.collection("buybackitems");
  const sample = await items.findOne();

  if (sample && sample.groupId !== undefined && sample.categoryId === undefined) {
    console.log("Sample document already has groupId - already migrated, skipping.");
    await mongoose.disconnect();
    return;
  }

  if (sample && sample.categoryId === undefined) {
    throw new Error(
      "Sample document has neither categoryId nor groupId - this doesn't look like item data. Aborting.",
    );
  }

  const countToMigrate = await items.countDocuments({
    categoryId: { $exists: true },
  });
  console.log(`${countToMigrate} item documents have a categoryId field to rename`);

  if (dryRun) {
    console.log(
      `[dry-run] Would rename categoryId -> groupId on ${countToMigrate} buybackitems documents. No changes made.`,
    );
    await mongoose.disconnect();
    return;
  }

  const result = await items.updateMany(
    { categoryId: { $exists: true } },
    { $rename: { categoryId: "groupId" } },
  );
  console.log(
    `Renamed categoryId -> groupId on ${result.modifiedCount}/${result.matchedCount} buybackitems documents.`,
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Item field rename failed:", err);
  process.exit(1);
});
