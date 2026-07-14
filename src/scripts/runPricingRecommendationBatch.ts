import mongoose from "mongoose";
import dotenv from "dotenv";
import { updateRecommendedRatesForAllItems } from "../services/pricingRecommendation";

dotenv.config();

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  await updateRecommendedRatesForAllItems();

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Pricing recommendation batch run failed:", err);
  process.exit(1);
});
