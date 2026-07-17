import express from "express";
import dotenv from "dotenv";
import { connectDB } from "./lib/db";
import cron from "node-cron";
import { syncContracts } from "./services/syncContracts";
import { updateRecommendedRatesForAllItems } from "./services/pricingRecommendation";
import { syncCorpAssetStock } from "./services/corpAssetSync";
import { expireStaleBuyOrders } from "./services/buyOrder";
import { initConfig } from "./lib/config";
import { initSystemCache } from "./lib/systemCache";
import authRouter from "./routes/auth";
import cors from "cors";
import { adminAuth } from "./lib/adminAuth";
import adminRouter from "./routes/admin";
import publicRouter from "./routes/public";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(
  cors({
    origin: [
      "https://equinox-galactic-admin.web.app",
      "https://equinox-galactic.web.app",
    ],
  }),
);
app.use("/equinox/auth", authRouter);
app.use("/equinox/admin", adminAuth, adminRouter);
app.use("/equinox", publicRouter);

app.get("/equinox/health", (req, res) => {
  res.json({ status: "ok" });
});

async function start() {
  await connectDB();
  console.log("Connected to MongoDB");

  await initConfig();
  await initSystemCache();

  cron.schedule("3,18,33,48 * * * *", () => {
    syncContracts();
    expireStaleBuyOrders();
  });

  // 2pm server time - a few hours after ESI's daily market data refresh
  // (~11:00 UTC, shortly after downtime). updateRecommendedRatesForAllItems()
  // no-ops if a previous pass is still running, so this is safe even if a
  // run somehow spans past the next day's trigger.
  cron.schedule("0 14 * * *", () => {
    updateRecommendedRatesForAllItems();
  });

  // Hourly - Purchase Stock's available quantity is only as fresh as the
  // last poll, so this runs more often than the once-daily pricing job but
  // doesn't need contract-sync's 15-minute cadence.
  cron.schedule("0 21 * * *", () => {
    syncCorpAssetStock();
  });

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
