import mongoose from "mongoose";
import dotenv from "dotenv";
import { Stats } from "../models/Stats";

dotenv.config();

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  await Stats.findOneAndUpdate(
    {},
    {
      avgCompletionSeconds7d: 7529,
      completedTotal: 162,
      inProgressCount: 0,
      outstandingCount: 0,
      revenueLifetime: 13129232243,
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  console.log("Seeded stats");
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
