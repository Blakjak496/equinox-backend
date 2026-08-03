import { Router } from "express";
import { System } from "../models/System";
import { ShipCategory } from "../models/ShipCategory";
import { getKnownJumpBridgePairs, buildJumpBridgeExportText } from "../services/jumpBridgeExport";
import { planJumpRoute } from "../services/jumpRoutePlanner";

// Read-only surface for the corp-wide Tools app - every route here is
// mounted behind requireToolsAuth (see index.ts). No discovery, no
// mutation: everything reuses the exact same logic admin.ts's equivalent
// routes use, just without write access or Keepstar/structure discovery.
const toolsRouter = Router();

toolsRouter.get("/ship-categories", async (_req, res) => {
  try {
    const shipCategories = await ShipCategory.find();
    res.status(200).json({ ok: true, data: shipCategories });
  } catch (err) {
    console.error("Failed to fetch ship categories:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch ship categories", error: err });
  }
});

toolsRouter.get("/systems/all", async (_req, res) => {
  try {
    const systems = await System.find().select("systemId name");
    res.status(200).json({ ok: true, data: systems });
  } catch (err) {
    console.error("Failed to fetch all systems:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch all systems", error: err });
  }
});

toolsRouter.get("/systems/search", async (req, res) => {
  const q = req.query.q as string | undefined;

  if (!q || q.length < 2) {
    res.status(200).json({ ok: true, data: [] });
    return;
  }

  try {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const systems = await System.find({ name: { $regex: `^${escaped}`, $options: "i" } })
      .select("systemId name")
      .limit(20);

    res.status(200).json({ ok: true, data: systems });
  } catch (err) {
    console.error("Failed to search systems:", err);
    res.status(500).json({ ok: false, message: "Failed to search systems", error: err });
  }
});

toolsRouter.get("/jump-bridges/known", async (_req, res) => {
  try {
    const data = await getKnownJumpBridgePairs();
    res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error("Failed to load known jump bridges:", err);
    res.status(500).json({ ok: false, message: "Failed to load known jump bridges", error: err });
  }
});

toolsRouter.get("/jump-bridges/export", async (req, res) => {
  const format = req.query.format;
  if (format !== "rift" && format !== "smt") {
    res.status(400).json({ ok: false, message: "format must be 'rift' or 'smt'" });
    return;
  }

  try {
    const { text, filename } = await buildJumpBridgeExportText(format);
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).send(text);
  } catch (err) {
    console.error("Failed to export jump bridges:", err);
    res.status(500).json({
      ok: false,
      message: err instanceof Error ? err.message : "Failed to export jump bridges",
      error: err,
    });
  }
});

toolsRouter.post("/jump-routes/plan", async (req, res) => {
  const { waypointNames, shipCategoryId, restrictToKeepstars, skillLevel } = req.body ?? {};

  try {
    const result = await planJumpRoute(
      waypointNames,
      shipCategoryId,
      Boolean(restrictToKeepstars),
      Number(skillLevel),
    );
    if (!result.ok) {
      res.status(result.status).json({ ok: false, message: result.message });
      return;
    }
    res.status(200).json({ ok: true, data: result.data });
  } catch (err) {
    console.error("Failed to plan jump route:", err);
    res.status(500).json({ ok: false, message: "Failed to plan jump route", error: err });
  }
});

export default toolsRouter;
