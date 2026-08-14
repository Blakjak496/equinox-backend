import express from "express";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectDB } from "./lib/db";
import cron from "node-cron";
import { syncContracts } from "./services/syncContracts";
import { updateRecommendedRatesForAllItems } from "./services/pricingRecommendation";
import { syncCorpAssetStock } from "./services/corpAssetSync";
import { refreshAdjustedPrices } from "./services/adjustedPrices";
import { initConfig } from "./lib/config";
import { initSystemCache } from "./lib/systemCache";
import authRouter from "./routes/auth";
import cors from "cors";
import { adminAuth } from "./lib/adminAuth";
import adminRouter from "./routes/admin";
import publicRouter from "./routes/public";
import toolsAuthRouter from "./routes/toolsAuth";
import toolsRouter from "./routes/tools";
import { requireToolsAuth } from "./lib/toolsAuth";
import cortexAuthRouter from "./routes/cortexAuth";
import { BuybackGroup } from "./models/BuybackGroup";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(
  cors({
    origin: [
      "https://equinox-galactic-admin.web.app",
      "https://equinox-galactic.web.app",
      "https://equinoxgalactic.com",
      "https://www.equinoxgalactic.com",
      "https://equinox-galactic-tools.web.app",
      "https://tools.equinoxgalactic.com",
    ],
  }),
);
app.use("/equinox/auth", authRouter);
app.use("/equinox/admin", adminAuth, adminRouter);
app.use("/equinox/tools-auth", toolsAuthRouter);
app.use("/equinox/tools", requireToolsAuth, toolsRouter);
app.use("/equinox/cortex/auth", cortexAuthRouter);
app.use("/equinox", publicRouter);

app.get("/equinox/health", (req, res) => {
  res.json({ status: "ok" });
});

// Guards against the buyback Category/Group/Item migration running out of
// order (e.g. this code deployed and started before the collection rename
// + category link scripts have run) - fails loudly at boot instead of
// silently serving quotes that can never resolve group-level settings.
async function assertBuybackMigrationComplete() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("No active database connection");

  const collectionNames = new Set(
    (await db.listCollections().toArray()).map((c) => c.name),
  );
  if (!collectionNames.has("buybackgroups")) {
    throw new Error(
      "buybackgroups collection not found - run migrate:rename-group-collection before starting this version of the backend.",
    );
  }

  const groupCount = await BuybackGroup.countDocuments();
  if (groupCount > 0) {
    const linkedCount = await BuybackGroup.countDocuments({
      categoryId: { $ne: null },
    });
    if (linkedCount === 0) {
      throw new Error(
        "No BuybackGroup documents have a categoryId link - run seed:buyback-categories then seed:buyback-groups before starting this version of the backend.",
      );
    }
  }
}

async function start() {
  await connectDB();
  console.log("Connected to MongoDB");

  await assertBuybackMigrationComplete();

  await initConfig();
  await initSystemCache();

  cron.schedule("3,18,33,48 * * * *", () => {
    syncContracts();
  });

  // 2pm server time - a few hours after ESI's daily market data refresh
  // (~11:00 UTC, shortly after downtime). updateRecommendedRatesForAllItems()
  // no-ops if a previous pass is still running, so this is safe even if a
  // run somehow spans past the next day's trigger.
  cron.schedule("0 14 * * *", () => {
    updateRecommendedRatesForAllItems();
  });

  // Once daily, same slot as the pricing job - ESI caches corp asset/hangar
  // contents for 24h, so polling more often than that returns nothing new.
  // 2pm leaves enough runway for even an extended downtime to clear before
  // this runs, so stock reflects hangar contents as soon as realistically
  // possible after each daily reset.
  cron.schedule("0 14 * * *", () => {
    syncCorpAssetStock();
  });

  // Same slot again - ESI's adjusted/average prices (the Manufacturing
  // Planner's EIV basis) are also only refreshed once a day, so there's
  // nothing to gain from polling more often than the other 2pm jobs.
  cron.schedule("0 14 * * *", () => {
    refreshAdjustedPrices().catch((err) =>
      console.error("Failed to refresh adjusted prices:", err),
    );
  });

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
