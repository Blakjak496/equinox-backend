import mongoose from "mongoose";
import dotenv from "dotenv";
import { BuybackCategory } from "../models/BuybackCategory";
import { BuybackItem } from "../models/BuybackItem";

dotenv.config();

// One-off cleanup: haul is meant to be an edge-case override ("this
// specific thing sells better locally"), but nearly everything ended up
// haul=false, forcing a manual re-check on almost every category/item. This
// resets every category to haul=true and clears every item-level override
// back to null (inherit), so haul=false becomes the rare deliberate
// exception it was always supposed to be - and a category-level change
// still cascades to every item that hasn't been individually overridden.
async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const categoryResult = await BuybackCategory.updateMany({}, { haul: true });
  console.log(
    `Categories: ${categoryResult.modifiedCount}/${categoryResult.matchedCount} set to haul=true`,
  );

  const itemResult = await BuybackItem.updateMany(
    { haul: { $ne: null } },
    { haul: null },
  );
  console.log(
    `Items: ${itemResult.modifiedCount}/${itemResult.matchedCount} haul overrides cleared (now inherit from category)`,
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Haul flag reset failed:", err);
  process.exit(1);
});
