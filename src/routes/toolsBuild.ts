import { Router, Request } from "express";
import { Type } from "../models/Type";
import { Blueprint } from "../models/Blueprint";
import { Structure, IIndustryProfile } from "../models/Structure";
import { ToolsUser } from "../models/ToolsUser";
import { IndustryBonusType } from "../models/IndustryBonusType";
import { ToolsAuthedRequest } from "../lib/toolsAuth";
import { resolveBuildPlan } from "../services/buildResolver";

// The Manufacturing Planner's structure selects only ever show what's
// fitted (rig names), not a computed bonus % - the real effective bonus
// is item-dependent (category-scoped, see services/industryCategory.ts)
// and only knowable once an item is actually being resolved, so this is
// the one lightweight lookup shared by /structures and
// /structure-preference to attach real rig/structure names to a profile.
async function describeProfile(profile: IIndustryProfile) {
  const bonusTypeIds = [profile.structureTypeId, ...profile.rigTypeIds];
  const bonusTypes = await IndustryBonusType.find({ typeId: { $in: bonusTypeIds } })
    .select("typeId name kind")
    .lean();
  const byId = new Map(bonusTypes.map((b) => [b.typeId, b]));

  return {
    activity: profile.activity,
    securityClass: profile.securityClass,
    facilityTaxPercent: profile.facilityTaxPercent,
    structureTypeId: profile.structureTypeId,
    structureTypeName: byId.get(profile.structureTypeId)?.name ?? null,
    rigTypeIds: profile.rigTypeIds,
    rigNames: profile.rigTypeIds.map((id) => byId.get(id)?.name ?? `Type ${id}`),
  };
}

// Mounted at /tools/build inside routes/tools.ts, under the same
// requireToolsAuth middleware as every other tools route - no separate
// auth work needed.
const toolsBuildRouter = Router();

function toolsUser(req: Request) {
  return (req as ToolsAuthedRequest).toolsUser!;
}

// The Type collection (seeded by seedBlueprints.ts) holds every typeId
// referenced anywhere in the blueprint DAG - products, materials, AND the
// blueprint items themselves - so it's a superset of what's actually
// sensible to pick as a resolve target. A blueprint item (e.g. "Rifter
// Blueprint") or a raw material has no recipe of its own and will always
// silently resolve to a warning-free "buy" - correct, but useless and
// confusing to ask for. Cached briefly since Blueprint.productTypeId only
// changes when someone re-runs the seed script.
const BUILDABLE_CACHE_TTL_MS = 5 * 60 * 1000;
let buildableTypeIdsCache: { ids: Set<number>; expiresAt: number } | null = null;

async function getBuildableTypeIds(): Promise<Set<number>> {
  if (buildableTypeIdsCache && buildableTypeIdsCache.expiresAt > Date.now()) {
    return buildableTypeIdsCache.ids;
  }
  const productTypeIds = await Blueprint.distinct("productTypeId");
  const ids = new Set<number>(productTypeIds);
  buildableTypeIdsCache = { ids, expiresAt: Date.now() + BUILDABLE_CACHE_TTL_MS };
  return ids;
}

toolsBuildRouter.get("/items/search", async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();

  if (!q || q.length < 2) {
    res.status(200).json({ ok: true, data: [] });
    return;
  }

  try {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const [candidates, buildableTypeIds] = await Promise.all([
      Type.find({ name: { $regex: `^${escaped}`, $options: "i" } })
        .select("typeId name")
        .limit(100),
      getBuildableTypeIds(),
    ]);

    const data = candidates.filter((type) => buildableTypeIds.has(type.typeId)).slice(0, 20);

    res.status(200).json({ ok: true, data });
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

    const data = await Promise.all(
      structures.map(async (s) => {
        const profile = s.industryProfiles.find((p) => p.activity === activity);
        return {
          structureId: s.structureId,
          name: s.name,
          systemName: s.systemName,
          profile: profile ? await describeProfile(profile) : null,
        };
      }),
    );

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

    const activities = ["manufacturing", "reaction", "research", "copying", "invention"] as const;
    const data: Record<string, unknown> = {};

    for (const activity of activities) {
      const structureId = prefs[activity];
      const structure = structureId ? byId.get(structureId) : null;
      const profile = structure?.industryProfiles.find((p) => p.activity === activity);
      data[activity] =
        structure && profile
          ? {
              structureId: structure.structureId,
              name: structure.name,
              systemName: structure.systemName,
              profile: await describeProfile(profile),
            }
          : null;
    }

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
