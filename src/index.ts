import express from "express";
import dotenv from "dotenv";
import { connectDB } from "./lib/db";
import cron from "node-cron";
import { syncContracts } from "./services/syncContracts";
import { initConfig } from "./lib/config";
import authRouter from "./routes/auth";
import cors from "cors";

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
app.use("/auth", authRouter);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

async function start() {
  await connectDB();
  console.log("Connected to MongoDB");

  await initConfig();

  cron.schedule("3,18,33,48 * * * *", () => {
    syncContracts();
  });

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
