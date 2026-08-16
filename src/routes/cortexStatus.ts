import { Router } from "express";
import { CortexSystemStatus } from "../models/CortexSystemStatus";
import { adminAuth } from "../lib/adminAuth";

const cortexStatusRouter = Router();

cortexStatusRouter.get("/status", async (_req, res) => {
  const doc = await CortexSystemStatus.findOne();
  res.status(200).json({ ok: true, data: { status: doc?.status ?? null } });
});

cortexStatusRouter.put("/status", adminAuth, async (req, res) => {
  const { status } = req.body ?? {};
  if (![1, 2, 3].includes(status)) {
    res.status(400).json({ ok: false, message: "status must be 1, 2, or 3" });
    return;
  }

  await CortexSystemStatus.findOneAndUpdate({}, { status }, { upsert: true });
  res.status(200).json({ ok: true });
});

export default cortexStatusRouter;
