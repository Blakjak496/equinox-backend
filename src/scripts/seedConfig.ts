import mongoose from "mongoose";
import dotenv from "dotenv";
import { Config, IConfig } from "../models/Config";

dotenv.config();

const ConfigInput = {
  maxCollateral: 15_000_000_000,
};

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  await Config.findOneAndUpdate(ConfigInput, { upsert: true });
  console.log("Seeded config values");
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
