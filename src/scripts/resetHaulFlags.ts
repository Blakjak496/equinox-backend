import mongoose from "mongoose";
import dotenv from "dotenv";
import { BuybackGroup } from "../models/BuybackGroup";
import { BuybackItem } from "../models/BuybackItem";

dotenv.config();

// One-off cleanup: haul is meant to be an edge-case override ("this
// specific thing sells better locally"), but nearly everything ended up
// haul=false, forcing a manual re-check on almost every group/item. This
// resets every group to haul=true and clears every item-level override
// back to null (inherit), so haul=false becomes the rare deliberate
// exception it was always supposed to be - and a group-level change
// still cascades to every item that hasn't been individually overridden.
async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const groupResult = await BuybackGroup.updateMany({}, { haul: true });
  console.log(
    `Groups: ${groupResult.modifiedCount}/${groupResult.matchedCount} set to haul=true`,
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
