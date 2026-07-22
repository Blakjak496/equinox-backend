import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

// One-time migration: today's `buybackcategories` collection actually holds
// EVE-group-shaped data (the real EVE category concept didn't exist yet).
// A new BuybackCategory model is about to be deployed for the real category,
// which would collide with this collection name if seeded first - so the
// existing collection must be renamed to `buybackgroups` BEFORE any new code
// touches it. Uses the raw driver handle (not Mongoose models) since this
// runs before the new model files are deployed.
//
// Run with --dry-run first to confirm counts before actually renaming.
async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  const dryRun = process.argv.includes("--dry-run");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  if (!db) throw new Error("No active database connection");

  const collectionNames = new Set(
    (await db.listCollections().toArray()).map((c) => c.name),
  );

  if (collectionNames.has("buybackgroups")) {
    console.log("buybackgroups already exists - already migrated, skipping.");
    await mongoose.disconnect();
    return;
  }

  if (!collectionNames.has("buybackcategories")) {
    throw new Error(
      "buybackcategories collection not found - nothing to rename. Aborting.",
    );
  }

  const oldCollection = db.collection("buybackcategories");
  const countBefore = await oldCollection.countDocuments();
  console.log(`buybackcategories has ${countBefore} documents`);

  const sample = await oldCollection.findOne();
  if (sample && sample.groupId === undefined) {
    throw new Error(
      "Sample document in buybackcategories has no groupId field - this doesn't look like group-shaped data. Aborting rather than guessing.",
    );
  }

  if (dryRun) {
    console.log(
      `[dry-run] Would rename buybackcategories (${countBefore} docs) -> buybackgroups. No changes made.`,
    );
    await mongoose.disconnect();
    return;
  }

  await db.renameCollection("buybackcategories", "buybackgroups");
  const countAfter = await db.collection("buybackgroups").countDocuments();
  console.log(
    `Renamed buybackcategories -> buybackgroups. Before: ${countBefore}, after: ${countAfter}.`,
  );
  if (countBefore !== countAfter) {
    console.error(
      "WARNING: document count changed during rename - investigate before proceeding further.",
    );
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Group collection rename failed:", err);
  process.exit(1);
});
