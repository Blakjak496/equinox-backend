import { Router, Request } from "express";
import { Type } from "../models/Type";
import { Structure } from "../models/Structure";
import { ToolsUser } from "../models/ToolsUser";
import { ToolsAuthedRequest } from "../lib/toolsAuth";
import { resolveBuildPlan } from "../services/buildResolver";

// Mounted at /tools/build inside routes/tools.ts, under the same
// requireToolsAuth middleware as every other tools route - no separate
// auth work needed.
const toolsBuildRouter = Router();

function toolsUser(req: Request) {
  return (req as ToolsAuthedRequest).toolsUser!;
}

toolsBuildRouter.get("/items/search", async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();

  if (!q || q.length < 2) {
    res.status(200).json({ ok: true, data: [] });
    return;
  }

  try {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const types = await Type.find({ name: { $regex: `^${escaped}`, $options: "i" } })
      .select("typeId name")
      .limit(20);

    res.status(200).json({ ok: true, data: types });
  } catch (err) {
    console.error("Failed to search items:", err);
    res.status(500).json({ ok: false, message: "Failed to search items", error: err });
  }
});

toolsBuildRouter.get("/structures", async (req, res) => {
  const activity = req.query.activity as string | undefined;
  if (activity !== "manufacturing" && activity !== "reaction") {
    res.status(400).json({ ok: false, message: "activity must be 'manufacturing' or 'reaction'" });
    return;
  }

  try {
    const structures = await Structure.find({ "industryProfiles.activity": activity })
      .select("structureId name systemName industryProfiles")
      .lean();

    const data = structures.map((s) => ({
      structureId: s.structureId,
      name: s.name,
      systemName: s.systemName,
      profile: s.industryProfiles.find((p) => p.activity === activity) ?? null,
    }));

    res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error("Failed to fetch build structures:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch build structures", error: err });
  }
});

toolsBuildRouter.get("/structure-preference", async (req, res) => {
  try {
    const user = await ToolsUser.findOne({ characterId: toolsUser(req).characterId }).lean();
    const prefs = user?.buildStructurePreferences ?? {};

    const structureIds = Object.values(prefs).filter((id): id is number => typeof id === "number");
    const structures = structureIds.length
      ? await Structure.find({ structureId: { $in: structureIds } })
          .select("structureId name systemName industryProfiles")
          .lean()
      : [];
    const byId = new Map(structures.map((s) => [s.structureId, s]));

    const data = (["manufacturing", "reaction", "research", "copying", "invention"] as const).reduce(
      (acc, activity) => {
        const structureId = prefs[activity];
        const structure = structureId ? byId.get(structureId) : null;
        acc[activity] = structure
          ? {
              structureId: structure.structureId,
              name: structure.name,
              systemName: structure.systemName,
              profile: structure.industryProfiles.find((p) => p.activity === activity) ?? null,
            }
          : null;
        return acc;
      },
      {} as Record<string, unknown>,
    );

    res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error("Failed to fetch structure preference:", err);
    res.status(500).json({ ok: false, message: "Failed to fetch structure preference", error: err });
  }
});

toolsBuildRouter.put("/structure-preference", async (req, res) => {
  const { activity, structureId } = req.body ?? {};

  if (!["manufacturing", "reaction", "research", "copying", "invention"].includes(activity)) {
    res.status(400).json({ ok: false, message: "Invalid activity" });
    return;
  }
  if (!Number.isFinite(Number(structureId))) {
    res.status(400).json({ ok: false, message: "A valid structureId is required" });
    return;
  }

  try {
    await ToolsUser.updateOne(
      { characterId: toolsUser(req).characterId },
      { $set: { [`buildStructurePreferences.${activity}`]: Number(structureId) } },
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Failed to save structure preference:", err);
    res.status(500).json({ ok: false, message: "Failed to save structure preference", error: err });
  }
});

toolsBuildRouter.post("/resolve", async (req, res) => {
  const { targetItem, quantity, assumedME, buyPriceSource, haulRatePerM3 } = req.body ?? {};

  const targetTypeId = Number(targetItem);
  const parsedQuantity = Number(quantity);
  const parsedME = Number(assumedME ?? 0);
  const parsedHaulRate = Number(haulRatePerM3 ?? 0);

  if (!Number.isFinite(targetTypeId) || targetTypeId <= 0) {
    res.status(400).json({ ok: false, message: "A valid targetItem is required" });
    return;
  }
  if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
    res.status(400).json({ ok: false, message: "A valid quantity is required" });
    return;
  }
  if (buyPriceSource !== "buy" && buyPriceSource !== "split") {
    res.status(400).json({ ok: false, message: "buyPriceSource must be 'buy' or 'split'" });
    return;
  }

  try {
    const result = await resolveBuildPlan({
      targetTypeId,
      quantity: parsedQuantity,
      assumedME: parsedME,
      buyPriceSource,
      haulRatePerM3: parsedHaulRate,
      characterId: toolsUser(req).characterId,
    });
    res.status(200).json({ ok: true, data: result });
  } catch (err) {
    console.error("Failed to resolve build plan:", err);
    res.status(500).json({ ok: false, message: "Failed to resolve build plan", error: err });
  }
});

export default toolsBuildRouter;
