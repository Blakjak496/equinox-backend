import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

// One-time migration: every existing ShipCategory.jumpRangeLY was entered
// as the admin's own actual range at Jump Drive Calibration level 5 (their
// trained level), confirmed directly with the user - not a base/unskilled
// value. Jump Drive Calibration gives +20%/level (confirmed against the
// skill's own in-game description, not assumed - see utils/jumpRange.ts),
// so level 5 is +100% (double) the base range. Dividing by 2 recovers the
// true level-0 base range, which is what the app now stores and applies
// the user-selected skill level to at plan time instead of baking one
// level in permanently.
async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  const dryRun = process.argv.includes("--dry-run");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  if (!db) throw new Error("No active database connection");

  const shipCategories = db.collection("shipcategories");
  const sample = await shipCategories.findOne();

  if (sample && sample.baseRangeLY !== undefined && sample.jumpRangeLY === undefined) {
    console.log("Sample document already has baseRangeLY - already migrated, skipping.");
    await mongoose.disconnect();
    return;
  }

  if (sample && sample.jumpRangeLY === undefined) {
    throw new Error(
      "Sample document has neither jumpRangeLY nor baseRangeLY - this doesn't look like ship category data. Aborting.",
    );
  }

  const docs = await shipCategories
    .find({ jumpRangeLY: { $exists: true } })
    .toArray();

  console.log(`${docs.length} ship category document(s) have a jumpRangeLY field to convert:`);
  for (const doc of docs) {
    console.log(
      `  ${doc.name}: jumpRangeLY=${doc.jumpRangeLY} -> baseRangeLY=${doc.jumpRangeLY / 2}`,
    );
  }

  if (dryRun) {
    console.log(`[dry-run] Would convert ${docs.length} document(s). No changes made.`);
    await mongoose.disconnect();
    return;
  }

  const result = await shipCategories.updateMany(
    { jumpRangeLY: { $exists: true } },
    [
      { $set: { baseRangeLY: { $divide: ["$jumpRangeLY", 2] } } },
      { $unset: "jumpRangeLY" },
    ],
  );
  console.log(
    `Converted jumpRangeLY -> baseRangeLY on ${result.modifiedCount}/${result.matchedCount} shipcategories documents.`,
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Ship category base range migration failed:", err);
  process.exit(1);
});
