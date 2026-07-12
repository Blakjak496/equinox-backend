import mongoose from "mongoose";
import dotenv from "dotenv";
import { updateLiquidityIndexForAllItems } from "../services/liquidityIndex";

dotenv.config();

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  await updateLiquidityIndexForAllItems();

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Liquidity batch run failed:", err);
  process.exit(1);
});
