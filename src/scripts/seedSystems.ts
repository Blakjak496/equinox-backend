import mongoose from "mongoose";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";
import { System } from "../models/System";

dotenv.config();

const SDE_URL =
  "https://www.fuzzwork.co.uk/dump/latest/csv/mapSolarSystems.csv";

type SdeRow = {
  solarSystemID: string;
  solarSystemName: string;
  regionID: string;
  x: string;
  y: string;
  z: string;
  security: string;
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

  console.log(`Parsed ${rows.length} systems`);

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const operations = rows.map((row) => ({
    updateOne: {
      filter: { systemId: Number(row.solarSystemID) },
      update: {
        $set: {
          systemId: Number(row.solarSystemID),
          name: row.solarSystemName,
          position: {
            x: Number(row.x),
            y: Number(row.y),
            z: Number(row.z),
          },
          securityStatus: Number(row.security),
          regionId: Number(row.regionID),
        },
      },
      upsert: true,
    },
  }));

  const result = await System.bulkWrite(operations);
  console.log(
    `Seeded systems: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`,
  );

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
