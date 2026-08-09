import { Router } from "express";
import { Config } from "../models/Config";
import { Route } from "../models/Routes";
import { Stats } from "../models/Stats";
import { Contract } from "../models/Contract";
import { System } from "../models/System";
import { MainRoute } from "../models/MainRoute";
import { ShipCategory } from "../models/ShipCategory";
import { BuybackCategory } from "../models/BuybackCategory";
import { BuybackGroup } from "../models/BuybackGroup";
import { BuybackItem } from "../models/BuybackItem";
import { BuybackQuote } from "../models/BuybackQuote";
import { BuybackLocation } from "../models/BuybackLocation";
import { BuyOrder } from "../models/BuyOrder";
import { Structure } from "../models/Structure";
import { Station } from "../models/Station";
import { computeAvailableQuantities } from "../services/buyOrder";
import { syncCorpAssetStock } from "../services/corpAssetSync";
import { notifyBuyOrderUpdate } from "../services/discordNotify";
import { getAccessToken, resolveCharacterIdForRole } from "../lib/esiClient";
import { getOrFetchStructure } from "../utils/structure-utils";
import {
  ensureSystemIsCached,
  getSystemIdByName,
} from "../utils/system-utils";
import { calculateOptimalRoute } from "../services/routeCalculator";
import {
  discoverKeepstars,
  KEEPSTAR_TYPE_ID,
} from "../services/keepstarDiscovery";
import { discoverJumpBridges } from "../services/jumpBridgeDiscovery";
import { JumpBridge } from "../models/JumpBridge";
import { computeMapBoundsAndRegions } from "../services/mapView";
import { effectiveJumpRangeLY } from "../utils/jumpRange";
import { EsiAuth } from "../models/EsiAuth";
import { getOrFetchCorporation } from "../utils/corporation-utils";
import {
  dedupeJumpBridgePairs,
  getKnownJumpBridgePairs,
  buildJumpBridgeExportText,
} from "../services/jumpBridgeExport";
import { planJumpRoute } from "../services/jumpRoutePlanner";

const adminRouter = Router();

// This data changes constantly (background jobs, PATCHes, quote matching)
// and the admin UI always needs the current state - Express sets a weak
// ETag on every response by default, which is enough for a browser to
// conditionally-cache a GET and later replay a stale body via 304 without
// ever hitting this router again. Disable caching outright for the whole
// admin API rather than relying on every client to force a fresh fetch.
adminRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

adminRouter.get("/config", async (_req, res) => {
  try {
    const config = await Config.findOne();

    res.status(200).json({ ok: true, data: config });
  } catch (err) {
    console.error("Failed to get config:", err);
    res.status(500).json({
      ok: false,
      message: "Something went wrong while fetching the config document",
      error: err,
    });
  }
});

adminRouter.patch("/config", async (req, res) => {
  const update = { ...req.body };

  try {
    await Config.findOneAndUpdate({}, { ...update }, {});

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Failed to update config:", err);
    res.status(500).json({
      ok: false,
      message: "Something went wrong while updating the config document",
      error: err,
    });
  }
});

adminRouter.get("/esi-characters", async (_req, res) => {
  try {
    const characters = await EsiAuth.find().sort({ connectedAt: 1 });
    const data = await Promise.all(
      characters.map(async (character) => {
        const corporation = await getOrFetchCorporation(
          Number(character.corporationId),
        );
        return {
          characterId: character.characterId,
          characterName: character.characterName,
          corporationId: character.corporationId,
          corporationName: corporation.name,
          needsReconnect: character.needsReconnect,
          connectedAt: character.connectedAt,
        };
      }),
    );

    res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error("Failed to list ESI characters:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to list ESI characters",
      error: err,
    });
  }
});

// Removing a character that's currently assigned to a Settings role falls
// back to "whichever character is connected" automatically
// (resolveCharacterIdForRole in lib/esiClient.ts already handles a dangling
// assignment) - clearing it here too just keeps the Settings dropdowns
// honest instead of showing a phantom selection.
adminRouter.delete("/esi-characters/:characterId", async (req, res) => {
  const characterId = req.params.characterId;

  try {
    await EsiAuth.deleteOne({ characterId });

    const config = await Config.findOne();
    const clearedFields: Record<string, null> = {};
    if (config?.businessCharacterId === characterId) {
      clearedFields.businessCharacterId = null;
    }
    if (config?.structureCharacterId === characterId) {
      clearedFields.structureCharacterId = null;
    }
    if (Object.keys(clearedFields).length > 0) {
      await Config.updateOne({}, clearedFields);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Failed to remove ESI character:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to remove ESI character",
      error: err,
    });
  }
});

adminRouter.post("/routes", async (req, res) => {
  const newRoute = { ...req.body };
  const systems = newRoute.systems;

  if (!systems || systems.length !== 2) {
    res.status(400).json({
      ok: false,
      message: "Systems must be provided to create a route",
    });
  } else {
    const route = newRoute.oneWay
      ? await Route.findOne({ systems })
      : await Route.findOne({ systems: { $all: systems } });

    if (route) {
      res.status(409).json({
        ok: false,
        message: "The route you are trying to create already exists",
      });
    } else {
      try {
        await Route.findOneAndUpdate(
          { systems },
          { ...newRoute },
          { upsert: true, setDefaultsOnInsert: true },
        );

        res.status(200).json({ ok: true });
      } catch (err) {
        console.error("Failed to create new route:", err);
        res.status(500).json({
          ok: false,
          message: "Something went wrong while creating the new route",
          error: err,
        });
      }
    }
  }
});

adminRouter.patch("/routes", async (req, res) => {
  const updates = { ...req.body };
  const systems = updates.systems;

  if (!systems || systems.length !== 2) {
    res.status(400).json({
      ok: false,
      message: "Systems must be provided to update a route",
    });
  } else {
    try {
      await Route.findOneAndUpdate({ systems }, { ...updates }, {});

      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("Failed to update route:", err);
      res
        .status(500)
        .json({ ok: false, message: "Failed to update route", error: err });
    }
  }
});

adminRouter.delete("/routes", async (req, res) => {
  const { systems } = req.body;

  if (!systems || systems.length !== 2) {
    res.status(400).json({
      ok: false,
      message: "Systems must be provided to delete a route",
    });
  } else {
    try {
      await Route.findOneAndDelete({ systems });
      res.status(200).json({ ok: true });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, message: "Failed to delete route", error: err });
    }
  }
});

adminRouter.get("/stats", async (req, res) => {
  try {
    const [
      stats,
      pendingAgg,
      matchedCount,
      expiredQuoteCount,
      discrepancyCount,
      pendingRecommendationItems,
    ] = await Promise.all([
      Stats.findOne(),
      // A quote with no matching in-game contract yet is just a quote, not
      // a contract - "pending contracts" has to be sourced from real
      // Contract documents (linked via buybackQuoteId) or a fictional quote
      // would inflate this count/value with nothing behind it.
      Contract.aggregate([
        { $match: { buybackQuoteId: { $ne: null }, status: "outstanding" } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            value: { $sum: "$price" },
          },
        },
      ]),
      // "matched" inherently means a real contract was found and linked
      // (matchedContractId is only ever set by the match), so this one
      // genuinely does describe contracts, not just quotes.
      BuybackQuote.countDocuments({ status: "matched" }),
      // An expired quote never had a contract linked either - same
      // quote-vs-contract distinction, just framed as "Quotes" not
      // "Contracts".
      BuybackQuote.countDocuments({ status: "expired" }),
      BuybackQuote.countDocuments({ discrepancy: true }),
      fetchResolvedAcceptedItems({ recommendationPending: true }),
    ]);

    const pendingBuybackContracts = pendingAgg[0]?.count ?? 0;
    const pendingBuybackValue = pendingAgg[0]?.value ?? 0;

    res.status(200).json({
      ok: true,
      data: {
        ...(stats?.toObject() ?? {}),
        pendingBuybackContracts,
        pendingBuybackValue,
        matchedBuybackContracts: matchedCount,
        expiredBuybackQuotes: expiredQuoteCount,
        discrepancyCount,
        itemsWithPendingRecommendation: pendingRecommendationItems.length,
      },
    });
  } catch (err) {
    console.error("Failed to get stats:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to get stats", error: err });
  }
});

const TREND_DAYS = 30;

// Zero-fills every day in the window so the frontend always gets a
// continuous 30-point series (no gaps on days with no activity).
function buildDailySeries<T extends { _id: string; count: number }>(
  aggResult: T[],
  valueKey: keyof T,
): { date: string; count: number; value: number }[] {
  const byDate = new Map(aggResult.map((row) => [row._id, row]));
  const series: { date: string; count: number; value: number }[] = [];

  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const row = byDate.get(dateStr);
    series.push({
      date: dateStr,
      count: row?.count ?? 0,
      value: (row?.[valueKey] as number | undefined) ?? 0,
    });
  }

  return series;
}

adminRouter.get("/stats/trends", async (_req, res) => {
  try {
    const windowStart = new Date(
      Date.now() - TREND_DAYS * 24 * 60 * 60 * 1000,
    );

    const [haulingAgg, buybackAgg] = await Promise.all([
      Contract.aggregate([
        { $match: { status: "finished", dateCompleted: { $ne: null } } },
        {
          $addFields: {
            completedDate: { $dateFromString: { dateString: "$dateCompleted" } },
          },
        },
        { $match: { completedDate: { $gte: windowStart } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$completedDate" } },
            count: { $sum: 1 },
            revenue: { $sum: "$reward" },
          },
        },
      ]),
      BuybackQuote.aggregate([
        { $match: { createdAt: { $gte: windowStart } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 },
            value: { $sum: "$netTotalPrice" },
          },
        },
      ]),
    ]);

    res.status(200).json({
      ok: true,
      data: {
        hauling: buildDailySeries(haulingAgg, "revenue"),
        buyback: buildDailySeries(buybackAgg, "value"),
      },
    });
  } catch (err) {
    console.error("Failed to get stats trends:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to get stats trends", error: err });
  }
});

adminRouter.get("/systems/all", async (_req, res) => {
  try {
    const systems = await System.find().select("systemId name");
    res.status(200).json({ ok: true, data: systems });
  } catch (err) {
    console.error("Failed to fetch all systems:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch all systems", error: err });
  }
});

adminRouter.get("/systems/search", async (req, res) => {
  const q = req.query.q as string | undefined;

  if (!q || q.length < 2) {
    res.status(200).json({ ok: true, data: [] });
    return;
  }

  try {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const systems = await System.find({
      name: { $regex: `^${escaped}`, $options: "i" },
    })
      .select("systemId name")
      .limit(20);

    res.status(200).json({ ok: true, data: systems });
  } catch (err) {
    console.error("Failed to search systems:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to search systems", error: err });
  }
});

adminRouter.get("/systems/resolve", async (req, res) => {
  const name = req.query.name as string | undefined;

  if (!name) {
    res.status(400).json({ ok: false, message: "name is required" });
    return;
  }

  try {
    const systemId = await getSystemIdByName(name);

    if (!systemId) {
      res
        .status(404)
        .json({ ok: false, message: `No system found named "${name}"` });
      return;
    }

    const system = await ensureSystemIsCached(systemId);
    res.status(200).json({ ok: true, data: system });
  } catch (err) {
    console.error("Failed to resolve system:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to resolve system", error: err });
  }
});

adminRouter.get("/systems/:systemId", async (req, res) => {
  const systemId = Number(req.params.systemId);

  try {
    const system = await ensureSystemIsCached(systemId);

    if (!system) {
      res.status(404).json({ ok: false, message: "System not found" });
      return;
    }

    res.status(200).json({ ok: true, data: system });
  } catch (err) {
    console.error("Failed to fetch system:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch system", error: err });
  }
});

adminRouter.post("/routes/calculate", async (req, res) => {
  const { pickupSystemName, dropoffSystemName, shipCategoryId } = req.body;

  if (!pickupSystemName || !dropoffSystemName || !shipCategoryId) {
    res.status(400).json({
      ok: false,
      message:
        "pickupSystemName, dropoffSystemName and shipCategoryId are required",
    });
    return;
  }

  try {
    const shipCategory = await ShipCategory.findById(shipCategoryId);
    if (!shipCategory) {
      res.status(404).json({ ok: false, message: "Ship category not found" });
      return;
    }

    const [pickupId, dropoffId] = await Promise.all([
      getSystemIdByName(pickupSystemName),
      getSystemIdByName(dropoffSystemName),
    ]);

    if (!pickupId || !dropoffId) {
      res.status(404).json({
        ok: false,
        message: `Could not resolve ${!pickupId ? pickupSystemName : dropoffSystemName}`,
      });
      return;
    }

    const [pickup, dropoff] = await Promise.all([
      ensureSystemIsCached(pickupId),
      ensureSystemIsCached(dropoffId),
    ]);

    if (!pickup || !dropoff) {
      res
        .status(404)
        .json({ ok: false, message: "Failed to load pickup/dropoff system" });
      return;
    }

    const mainRoutes = await MainRoute.find({ active: true });
    // Freight costing has no per-user skill selector (it's an internal
    // admin calculation, not customer-facing like the Jump Planner) - fixed
    // at level 5 to match exactly what this number always represented
    // before baseRangeLY existed (confirmed with the user: every existing
    // category's range was entered at their own level-5-trained range).
    const result = await calculateOptimalRoute(
      pickup,
      dropoff,
      mainRoutes,
      effectiveJumpRangeLY(shipCategory.baseRangeLY, 5),
    );

    if ("error" in result) {
      res.status(400).json({ ok: false, message: result.error });
      return;
    }

    res.status(200).json({ ok: true, data: result });
  } catch (err) {
    console.error("Failed to calculate route cost:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to calculate route cost", error: err });
  }
});

adminRouter.get("/main-routes", async (_req, res) => {
  try {
    const mainRoutes = await MainRoute.find();
    res.status(200).json({ ok: true, data: mainRoutes });
  } catch (err) {
    console.error("Failed to fetch main routes:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch main routes", error: err });
  }
});

adminRouter.post("/main-routes", async (req, res) => {
  const { name, waypoints, active } = req.body;

  if (!name || !Array.isArray(waypoints) || waypoints.length < 2) {
    res.status(400).json({
      ok: false,
      message: "name and at least 2 waypoints are required",
    });
    return;
  }

  try {
    const mainRoute = await MainRoute.create({
      name,
      waypoints,
      active: active ?? true,
    });
    res.status(200).json({ ok: true, data: mainRoute });
  } catch (err) {
    console.error("Failed to create main route:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to create main route", error: err });
  }
});

adminRouter.put("/main-routes/:id", async (req, res) => {
  const { name, waypoints, active } = req.body;

  try {
    const mainRoute = await MainRoute.findByIdAndUpdate(
      req.params.id,
      { name, waypoints, active },
      { new: true },
    );

    if (!mainRoute) {
      res.status(404).json({ ok: false, message: "Main route not found" });
      return;
    }

    res.status(200).json({ ok: true, data: mainRoute });
  } catch (err) {
    console.error("Failed to update main route:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to update main route", error: err });
  }
});

adminRouter.delete("/main-routes/:id", async (req, res) => {
  try {
    await MainRoute.findByIdAndDelete(req.params.id);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Failed to delete main route:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to delete main route", error: err });
  }
});

adminRouter.get("/ship-categories", async (_req, res) => {
  try {
    const shipCategories = await ShipCategory.find();
    res.status(200).json({ ok: true, data: shipCategories });
  } catch (err) {
    console.error("Failed to fetch ship categories:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to fetch ship categories",
      error: err,
    });
  }
});

adminRouter.post("/ship-categories", async (req, res) => {
  const { name, baseRangeLY } = req.body;

  if (!name || typeof baseRangeLY !== "number") {
    res.status(400).json({
      ok: false,
      message: "name and baseRangeLY are required",
    });
    return;
  }

  try {
    const shipCategory = await ShipCategory.create({ name, baseRangeLY });
    res.status(200).json({ ok: true, data: shipCategory });
  } catch (err) {
    console.error("Failed to create ship category:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to create ship category",
      error: err,
    });
  }
});

adminRouter.put("/ship-categories/:id", async (req, res) => {
  const { name, baseRangeLY } = req.body;

  try {
    const shipCategory = await ShipCategory.findByIdAndUpdate(
      req.params.id,
      { name, baseRangeLY },
      { new: true },
    );

    if (!shipCategory) {
      res.status(404).json({ ok: false, message: "Ship category not found" });
      return;
    }

    res.status(200).json({ ok: true, data: shipCategory });
  } catch (err) {
    console.error("Failed to update ship category:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to update ship category",
      error: err,
    });
  }
});

adminRouter.delete("/ship-categories/:id", async (req, res) => {
  try {
    await ShipCategory.findByIdAndDelete(req.params.id);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Failed to delete ship category:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to delete ship category",
      error: err,
    });
  }
});

// Manufacturing structures for the Manufacturing Planner tool - layered onto the
// same Structure cache /structures/search and /structures/fetch already
// populate (see below), not a separate collection. This route lists only
// the structures an admin has actually attached an industry profile to.
adminRouter.get("/structures/industry", async (_req, res) => {
  try {
    const structures = await Structure.find({ "industryProfiles.0": { $exists: true } }).select(
      "structureId name systemName industryProfiles",
    );
    res.status(200).json({ ok: true, data: structures });
  } catch (err) {
    console.error("Failed to fetch industry structures:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to fetch industry structures",
      error: err,
    });
  }
});

adminRouter.put("/structures/:structureId/industry-profile", async (req, res) => {
  const structureId = Number(req.params.structureId);
  const { activity, structureType, rigs, securityClass, materialReduction, timeReduction, costReduction } =
    req.body ?? {};

  const validActivities = ["manufacturing", "reaction", "research", "copying", "invention"];
  const validSecurityClasses = ["highsec", "lowsec", "nullsec", "wormhole"];

  if (!Number.isFinite(structureId)) {
    res.status(400).json({ ok: false, message: "A valid structureId is required" });
    return;
  }
  if (!validActivities.includes(activity)) {
    res.status(400).json({ ok: false, message: "Invalid activity" });
    return;
  }
  if (!structureType || typeof structureType !== "string") {
    res.status(400).json({ ok: false, message: "structureType is required" });
    return;
  }
  if (!validSecurityClasses.includes(securityClass)) {
    res.status(400).json({ ok: false, message: "Invalid securityClass" });
    return;
  }

  try {
    const structure = await Structure.findOne({ structureId });
    if (!structure) {
      res.status(404).json({
        ok: false,
        message: "Structure not found - search or fetch it by ID first",
      });
      return;
    }

    const profile = {
      activity,
      structureType,
      rigs: Array.isArray(rigs) ? rigs.filter((r) => typeof r === "string" && r.trim()) : [],
      securityClass,
      materialReduction: materialReduction != null ? Number(materialReduction) : null,
      timeReduction: timeReduction != null ? Number(timeReduction) : null,
      costReduction: costReduction != null ? Number(costReduction) : null,
    };

    const existingIndex = structure.industryProfiles.findIndex((p) => p.activity === activity);
    if (existingIndex >= 0) {
      structure.industryProfiles[existingIndex] = profile;
    } else {
      structure.industryProfiles.push(profile);
    }

    await structure.save();
    res.status(200).json({ ok: true, data: structure });
  } catch (err) {
    console.error("Failed to save industry profile:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to save industry profile",
      error: err,
    });
  }
});

adminRouter.delete("/structures/:structureId/industry-profile/:activity", async (req, res) => {
  const structureId = Number(req.params.structureId);
  const { activity } = req.params;

  try {
    const structure = await Structure.findOneAndUpdate(
      { structureId },
      { $pull: { industryProfiles: { activity } } },
      { new: true },
    );

    if (!structure) {
      res.status(404).json({ ok: false, message: "Structure not found" });
      return;
    }

    res.status(200).json({ ok: true, data: structure });
  } catch (err) {
    console.error("Failed to delete industry profile:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to delete industry profile",
      error: err,
    });
  }
});

// Handles both a free-form jump route and one restricted to known Keepstar
// systems (the former "Keepstar Route Planner", now just this same endpoint
// with restrictToKeepstars: true) - map data (bounds/systemsInView/
// routePath/regions) is always computed and returned regardless of the
// restriction flag, since the map is useful for any route, not just a
// Keepstar-restricted one.
adminRouter.post("/jump-routes/plan", async (req, res) => {
  const { waypointNames, shipCategoryId, restrictToKeepstars, skillLevel } = req.body;

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
    res
      .status(500)
      .json({ ok: false, message: "Failed to plan jump route", error: err });
  }
});

// ESI has no endpoint that lists "every structure a character can dock at" -
// this character-scoped search is the closest available mechanism (see
// keepstarDiscovery.ts doc comment). Its exact query behavior is unverified
// outside a live server, so this route returns full per-structure detail
// (not a collapsed summary) for debugging directly in the admin UI.
adminRouter.post("/keepstar-routes/discover", async (req, res) => {
  const searchQuery = typeof req.body?.searchQuery === "string"
    ? req.body.searchQuery
    : "";

  try {
    const result = await discoverKeepstars(searchQuery);
    res.status(200).json({ ok: true, data: result });
  } catch (err) {
    console.error("Failed to discover keepstars:", err);
    res.status(500).json({
      ok: false,
      message: err instanceof Error ? err.message : "Failed to discover keepstars",
      error: err,
    });
  }
});

// The current confirmed allow-list for the Keepstar route planner - every
// Keepstar discovered so far (via the route above) that resolved with
// access "ok". Lives entirely off the existing Structure cache; nothing new
// is persisted for this feature.
adminRouter.get("/keepstar-routes/known", async (_req, res) => {
  try {
    const keepstars = await Structure.find({
      typeId: KEEPSTAR_TYPE_ID,
      access: "ok",
    }).sort({ systemName: 1, name: 1 });

    res.status(200).json({ ok: true, data: keepstars });
  } catch (err) {
    console.error("Failed to load known keepstars:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to load known keepstars",
      error: err,
    });
  }
});

adminRouter.post("/jump-bridges/discover", async (req, res) => {
  const searchQuery = typeof req.body?.searchQuery === "string"
    ? req.body.searchQuery
    : "";

  try {
    const result = await discoverJumpBridges(searchQuery);
    res.status(200).json({ ok: true, data: result });
  } catch (err) {
    console.error("Failed to discover jump bridges:", err);
    res.status(500).json({
      ok: false,
      message: err instanceof Error ? err.message : "Failed to discover jump bridges",
      error: err,
    });
  }
});

// Some alliances configure their Ansiblexes such that ESI can never resolve
// them for a character that hasn't docked there - not a search-visibility
// gap, an outright resolution failure, confirmed against this exact
// scenario (coalition-mate-owned structure, real docking access, still
// unresolvable). There's no ESI fallback for this - the structure ID (from
// copying the in-game structure link) is the only thing ESI can never
// substitute for, so everything else has to be supplied by hand too, same
// as SMT's own manual-entry workaround for the identical limitation.
adminRouter.post("/jump-bridges/manual", async (req, res) => {
  const structureId = Number(req.body?.structureId);
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const homeSystemNameInput =
    typeof req.body?.homeSystemName === "string" ? req.body.homeSystemName.trim() : "";
  const remoteSystemNameInput =
    typeof req.body?.remoteSystemName === "string" ? req.body.remoteSystemName.trim() : "";

  if (!Number.isFinite(structureId) || structureId <= 0) {
    res.status(400).json({ ok: false, message: "A valid structureId is required" });
    return;
  }
  if (!name || !homeSystemNameInput || !remoteSystemNameInput) {
    res.status(400).json({
      ok: false,
      message: "name, homeSystemName, and remoteSystemName are all required",
    });
    return;
  }

  try {
    const homeSystemId = await getSystemIdByName(homeSystemNameInput);
    if (!homeSystemId) {
      res.status(400).json({
        ok: false,
        message: `Could not resolve system "${homeSystemNameInput}"`,
      });
      return;
    }
    const remoteSystemId = await getSystemIdByName(remoteSystemNameInput);
    if (!remoteSystemId) {
      res.status(400).json({
        ok: false,
        message: `Could not resolve system "${remoteSystemNameInput}"`,
      });
      return;
    }

    // Same reasoning as jumpBridgeDiscovery.ts - both ends need to be
    // cached (position/regionId) for map rendering and the region-grouped
    // export, not just resolvable to an ID.
    const [homeSystem, remoteSystem] = await Promise.all([
      ensureSystemIsCached(homeSystemId),
      ensureSystemIsCached(remoteSystemId),
    ]);

    const saved = await JumpBridge.findOneAndUpdate(
      { structureId },
      {
        structureId,
        name,
        homeSystemName: homeSystem?.name ?? homeSystemNameInput,
        homeSystemId,
        remoteSystemName: remoteSystem?.name ?? remoteSystemNameInput,
        remoteSystemId,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.status(200).json({ ok: true, data: saved });
  } catch (err) {
    console.error("Failed to save manual jump bridge:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to save manual jump bridge",
      error: err,
    });
  }
});

// A jump bridge pair may be backed by 1 or 2 persisted JumpBridge docs (one
adminRouter.get("/jump-bridges/known", async (_req, res) => {
  try {
    const data = await getKnownJumpBridgePairs();
    res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error("Failed to load known jump bridges:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to load known jump bridges",
      error: err,
    });
  }
});

adminRouter.get("/jump-bridges/map", async (_req, res) => {
  try {
    const bridges = await JumpBridge.find();
    const pairs = dedupeJumpBridgePairs(bridges);

    const focalSystems = new Map<number, string>();
    for (const pair of pairs) {
      if (pair.systemAId) focalSystems.set(pair.systemAId, pair.systemAName);
      if (pair.systemBId) focalSystems.set(pair.systemBId, pair.systemBName);
    }

    if (focalSystems.size === 0) {
      res.status(200).json({
        ok: true,
        data: {
          bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
          systemsInView: [],
          routePath: [],
          regions: [],
          connections: [],
        },
      });
      return;
    }

    const mapView = await computeMapBoundsAndRegions(
      Array.from(focalSystems.entries()).map(([systemId, name]) => ({ systemId, name })),
      new Map(),
    );

    const positionBySystemId = new Map(
      mapView.systemsInView.map((s) => [s.systemId, { x: s.x, z: s.z }]),
    );

    const connections = pairs
      .map((pair) => {
        if (!pair.systemAId || !pair.systemBId) return null;
        const a = positionBySystemId.get(pair.systemAId);
        const b = positionBySystemId.get(pair.systemBId);
        if (!a || !b) return null;
        return { a, b, systemAName: pair.systemAName, systemBName: pair.systemBName };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    res.status(200).json({ ok: true, data: { ...mapView, connections } });
  } catch (err) {
    console.error("Failed to build jump bridge map:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to build jump bridge map",
      error: err,
    });
  }
});

adminRouter.get("/jump-bridges/export", async (req, res) => {
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

// Searches the Structure/Station caches (populated reactively by every
// freight and buyback contract synced so far via getOrFetchStructure) so
// stock locations can be linked to a real EVE location by picking from
// already-known names instead of typing a raw ID blind.
adminRouter.get("/structures/search", async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();

  if (!q) {
    res.status(200).json({ ok: true, data: [] });
    return;
  }

  try {
    const nameFilter = { name: { $regex: q, $options: "i" } };

    const [structures, stations] = await Promise.all([
      Structure.find({ ...nameFilter, access: "ok" })
        .select("structureId name systemName")
        .limit(25),
      Station.find(nameFilter).select("stationId name systemName").limit(25),
    ]);

    const results = [
      ...structures.map((s) => ({
        id: s.structureId,
        name: s.name,
        systemName: s.systemName,
      })),
      ...stations.map((s) => ({
        id: s.stationId,
        name: s.name,
        systemName: s.systemName,
      })),
    ].slice(0, 25);

    res.status(200).json({ ok: true, data: results });
  } catch (err) {
    console.error("Failed to search structures:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to search structures", error: err });
  }
});

// Fetches a single station/structure directly from ESI by ID and caches it,
// bypassing the name-based search above. Needed when a structure was
// destroyed and rebuilt under the same name: the new ID has never appeared
// on a synced contract, so getOrFetchStructure() has never run for it, and
// the search route above can only ever surface the stale, now-defunct
// cached entry under that name.
adminRouter.post("/structures/fetch", async (req, res) => {
  const locationId = Number(req.body?.locationId);

  if (!Number.isFinite(locationId) || locationId <= 0) {
    res
      .status(400)
      .json({ ok: false, message: "A valid locationId is required" });
    return;
  }

  try {
    const structureCharacterId = await resolveCharacterIdForRole("structure");
    const token = await getAccessToken(structureCharacterId);
    // Manual admin action - always ask ESI live rather than trusting the
    // cache. A cached access:"forbidden" doc is otherwise permanent (the
    // early-return cache-hit path never re-checks ESI), which would
    // silently make this button useless on any retry.
    const result = await getOrFetchStructure(locationId, token, {
      forceRefresh: true,
    });

    if (!result || ("access" in result && result.access === "forbidden")) {
      res.status(200).json({
        ok: false,
        message:
          "ESI accepted the ID but returned 403 for it just now. If the connected character definitely has corp roles and the app has esi-universe.read_structures.v1 granted, the most likely explanation is that this specific character has never personally docked at this structure - ESI's docking-access check for a rebuilt structure isn't satisfied just by corp ownership or having assets stored there.",
      });
      return;
    }

    const id = "structureId" in result ? result.structureId : result.stationId;
    res.status(200).json({
      ok: true,
      data: { id, name: result.name, systemName: result.systemName },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Failed to fetch structure by ID:", err);
    res.status(500).json({
      ok: false,
      message: `Failed to fetch structure from ESI: ${message}`,
    });
  }
});

adminRouter.get("/buyback-locations", async (_req, res) => {
  try {
    const locations = await BuybackLocation.find().sort({ name: 1 });
    res.status(200).json({ ok: true, data: locations });
  } catch (err) {
    console.error("Failed to fetch buyback locations:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to fetch buyback locations",
      error: err,
    });
  }
});

adminRouter.post("/buyback-locations", async (req, res) => {
  const {
    name,
    isHub,
    distance,
    pickupRatePerM3,
    stockLocationId,
    stockLocationName,
    stockLocationSystemName,
  } = req.body;

  if (!name || typeof distance !== "number") {
    res.status(400).json({
      ok: false,
      message: "name and distance are required",
    });
    return;
  }

  if (stockLocationId != null && !isHub) {
    res.status(400).json({
      ok: false,
      message: "Stock location can only be set on hub locations",
    });
    return;
  }

  try {
    const location = await BuybackLocation.create({
      name,
      isHub: Boolean(isHub),
      distance,
      pickupRatePerM3: pickupRatePerM3 ?? null,
      stockLocationId: stockLocationId ?? null,
      stockLocationName: stockLocationName ?? null,
      stockLocationSystemName: stockLocationSystemName ?? null,
    });
    res.status(200).json({ ok: true, data: location });
  } catch (err) {
    console.error("Failed to create buyback location:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to create buyback location",
      error: err,
    });
  }
});

adminRouter.put("/buyback-locations/:id", async (req, res) => {
  const {
    name,
    isHub,
    distance,
    pickupRatePerM3,
    stockLocationId,
    stockLocationName,
    stockLocationSystemName,
  } = req.body;

  if (stockLocationId != null && !isHub) {
    res.status(400).json({
      ok: false,
      message: "Stock location can only be set on hub locations",
    });
    return;
  }

  try {
    const location = await BuybackLocation.findByIdAndUpdate(
      req.params.id,
      {
        name,
        isHub,
        distance,
        pickupRatePerM3,
        stockLocationId,
        stockLocationName,
        stockLocationSystemName,
      },
      { new: true },
    );

    if (!location) {
      res
        .status(404)
        .json({ ok: false, message: "Buyback location not found" });
      return;
    }

    res.status(200).json({ ok: true, data: location });
  } catch (err) {
    console.error("Failed to update buyback location:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to update buyback location",
      error: err,
    });
  }
});

adminRouter.delete("/buyback-locations/:id", async (req, res) => {
  try {
    await BuybackLocation.findByIdAndDelete(req.params.id);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Failed to delete buyback location:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to delete buyback location",
      error: err,
    });
  }
});

adminRouter.get("/buyback-categories", async (_req, res) => {
  try {
    const categories = await BuybackCategory.find().sort({ name: 1 });

    // A category is only worth showing if it has at least one group with at
    // least one item that isn't confirmed non-tradable - a genuine 2-hop
    // check (items -> their group's categoryId), not a shortcut through the
    // group-level distinct alone, since a category can be indirectly
    // visible via a group that itself has no *directly* matching items.
    const visibleGroupIds = await BuybackItem.distinct("groupId", {
      nonTradable: { $ne: true },
    });
    const visibleCategoryIds = await BuybackGroup.distinct("categoryId", {
      _id: { $in: visibleGroupIds },
    });
    const visibleSet = new Set(visibleCategoryIds.map(String));
    const data = categories.filter((category) =>
      visibleSet.has(String(category._id)),
    );

    res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error("Failed to fetch buyback categories:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to fetch buyback categories",
      error: err,
    });
  }
});

adminRouter.patch("/buyback-categories/:id", async (req, res) => {
  const { accepted, percentOffered, haul, acceptedLocationIds } = req.body;

  try {
    const category = await BuybackCategory.findByIdAndUpdate(
      req.params.id,
      { accepted, percentOffered, haul, acceptedLocationIds },
      { new: true },
    );

    if (!category) {
      res
        .status(404)
        .json({ ok: false, message: "Buyback category not found" });
      return;
    }

    res.status(200).json({ ok: true, data: category });
  } catch (err) {
    console.error("Failed to update buyback category:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to update buyback category",
      error: err,
    });
  }
});

adminRouter.get("/buyback-groups", async (req, res) => {
  const categoryId = req.query.categoryId as string | undefined;

  try {
    const filter: Record<string, unknown> = {};
    if (categoryId) filter.categoryId = categoryId;

    const groups = await BuybackGroup.find(filter)
      .populate("categoryId", "name accepted percentOffered haul acceptedLocationIds")
      .sort({ name: 1 });

    // Same "has at least one non-nonTradable item" visibility rule the
    // group level has always used.
    const visibleGroupIds = await BuybackItem.distinct("groupId", {
      nonTradable: { $ne: true },
    });
    const visibleSet = new Set(visibleGroupIds.map(String));
    const data = groups.filter((group) => visibleSet.has(String(group._id)));

    res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error("Failed to fetch buyback groups:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to fetch buyback groups",
      error: err,
    });
  }
});

adminRouter.patch("/buyback-groups/:id", async (req, res) => {
  const { accepted, percentOffered, haul, acceptedLocationIds } = req.body;

  try {
    const group = await BuybackGroup.findByIdAndUpdate(
      req.params.id,
      { accepted, percentOffered, haul, acceptedLocationIds },
      { new: true },
    ).populate("categoryId", "name accepted percentOffered haul acceptedLocationIds");

    if (!group) {
      res.status(404).json({ ok: false, message: "Buyback group not found" });
      return;
    }

    res.status(200).json({ ok: true, data: group });
  } catch (err) {
    console.error("Failed to update buyback group:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to update buyback group",
      error: err,
    });
  }
});

// Every item resolving accepted (item.accepted ?? group.accepted ??
// category.accepted), across all groups, with the owning group (and that
// group's category) populated - used by the pricing page's category/group
// tree, which only ever shows accepted items and needs to know up front
// which groups have any before rendering them. extraMatch lets callers
// narrow further (e.g. recommendationPending: true) while still guaranteeing
// the result never includes an item that isn't currently accepted - a
// pending-recommendation flag on an item the operator doesn't even accept
// shouldn't show up anywhere actionable.
async function fetchResolvedAcceptedItems(extraMatch: Record<string, unknown> = {}) {
  return BuybackItem.aggregate([
    {
      $lookup: {
        from: BuybackGroup.collection.name,
        localField: "groupId",
        foreignField: "_id",
        as: "group",
      },
    },
    { $unwind: "$group" },
    {
      $lookup: {
        from: BuybackCategory.collection.name,
        localField: "group.categoryId",
        foreignField: "_id",
        as: "category",
      },
    },
    // preserveNullAndEmptyArrays: an orphaned group (categoryId points at a
    // category that no longer exists, or was never linked) degrades to
    // group-level resolution rather than dropping the item from every list.
    { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
    {
      $match: {
        $expr: {
          $eq: [
            {
              $ifNull: [
                "$accepted",
                { $ifNull: ["$group.accepted", "$category.accepted"] },
              ],
            },
            true,
          ],
        },
        nonTradable: { $ne: true },
        ...extraMatch,
      },
    },
    { $sort: { name: 1 } },
    {
      $project: {
        typeId: 1,
        name: 1,
        accepted: 1,
        rateOverride: 1,
        notes: 1,
        haul: 1,
        acceptedLocationIds: 1,
        packagedVolume: 1,
        avgVolume: 1,
        stdDev: 1,
        sActive: 1,
        demandVelocity: 1,
        marketMultiplier: 1,
        recommendedRate: 1,
        recommendedRateUpdatedAt: 1,
        recommendationPending: 1,
        dismissedRecommendedRate: 1,
        reprocessingCategory: 1,
        groupId: {
          _id: "$group._id",
          name: "$group.name",
          accepted: "$group.accepted",
          percentOffered: "$group.percentOffered",
          haul: "$group.haul",
          acceptedLocationIds: "$group.acceptedLocationIds",
          // named categoryId (not "category") to match the field name the
          // plain-populate routes (GET/PATCH /buyback-items without the
          // accepted=true aggregation path) return, so the frontend can
          // treat both response shapes identically.
          categoryId: {
            _id: "$category._id",
            name: "$category.name",
            accepted: "$category.accepted",
            percentOffered: "$category.percentOffered",
            haul: "$category.haul",
            acceptedLocationIds: "$category.acceptedLocationIds",
          },
        },
      },
    },
  ]);
}

adminRouter.get("/buyback-items", async (req, res) => {
  const q = req.query.q as string | undefined;
  const groupId = req.query.groupId as string | undefined;
  const recommendationPending = req.query.recommendationPending as
    | string
    | undefined;
  const accepted = req.query.accepted as string | undefined;

  // recommendationPending is routed through the same resolved-accepted
  // aggregation as accepted=true (even if accepted wasn't explicitly
  // requested) - a pending flag on an item the operator doesn't currently
  // accept should never surface anywhere actionable.
  if (accepted === "true" || recommendationPending === "true") {
    try {
      const items = await fetchResolvedAcceptedItems(
        recommendationPending === "true" ? { recommendationPending: true } : {},
      );
      res.status(200).json({ ok: true, data: items });
    } catch (err) {
      console.error("Failed to fetch accepted buyback items:", err);
      res.status(500).json({
        ok: false,
        message: "Failed to fetch accepted buyback items",
        error: err,
      });
    }
    return;
  }

  const filter: Record<string, unknown> = { nonTradable: { $ne: true } };
  if (groupId) filter.groupId = groupId;
  if (q && q.length >= 2) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.name = { $regex: escaped, $options: "i" };
  }

  if (!groupId && !q) {
    res.status(200).json({ ok: true, data: [] });
    return;
  }

  try {
    const items = await BuybackItem.find(filter)
      .populate({
        path: "groupId",
        select: "name accepted percentOffered haul acceptedLocationIds categoryId",
        populate: {
          path: "categoryId",
          select: "name accepted percentOffered haul acceptedLocationIds",
        },
      })
      .sort({ name: 1 })
      .limit(200);

    res.status(200).json({ ok: true, data: items });
  } catch (err) {
    console.error("Failed to fetch buyback items:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to fetch buyback items",
      error: err,
    });
  }
});

adminRouter.patch("/buyback-items/:id", async (req, res) => {
  const {
    accepted,
    rateOverride,
    notes,
    haul,
    acceptedLocationIds,
    recommendationPending,
    dismissedRecommendedRate,
    reprocessingCategory,
  } = req.body;

  try {
    const item = await BuybackItem.findByIdAndUpdate(
      req.params.id,
      {
        accepted,
        rateOverride,
        notes,
        haul,
        acceptedLocationIds,
        recommendationPending,
        dismissedRecommendedRate,
        reprocessingCategory,
      },
      { new: true },
    ).populate({
      path: "groupId",
      select: "name accepted percentOffered haul acceptedLocationIds categoryId",
      populate: {
        path: "categoryId",
        select: "name accepted percentOffered haul acceptedLocationIds",
      },
    });

    if (!item) {
      res.status(404).json({ ok: false, message: "Buyback item not found" });
      return;
    }

    res.status(200).json({ ok: true, data: item });
  } catch (err) {
    console.error("Failed to update buyback item:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to update buyback item",
      error: err,
    });
  }
});

adminRouter.get("/buyback-quotes", async (req, res) => {
  const status = req.query.status as string | undefined;

  // "discrepancy" is a pseudo-filter - it's an independent flag, not a
  // status value, since a matched quote's contract can still fail to
  // reconcile without changing its lifecycle stage.
  const filter: Record<string, unknown> =
    status === "discrepancy" ? { discrepancy: true } : status ? { status } : {};

  try {
    const quotes = await BuybackQuote.find(filter)
      .sort({ discrepancy: -1, createdAt: -1 })
      .limit(200);

    res.status(200).json({ ok: true, data: quotes });
  } catch (err) {
    console.error("Failed to fetch buyback quotes:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to fetch buyback quotes",
      error: err,
    });
  }
});

adminRouter.get("/buyback-stock", async (_req, res) => {
  try {
    const items = await BuybackItem.find({
      "stockByLocation.0": { $exists: true },
    }).sort({ name: 1 });

    const locationIds = new Set<string>();
    for (const item of items) {
      for (const entry of item.stockByLocation) {
        locationIds.add(String(entry.locationId));
      }
    }

    const availableByLocation = new Map<string, Map<number, number>>();
    for (const locationId of locationIds) {
      availableByLocation.set(
        locationId,
        await computeAvailableQuantities(items, locationId),
      );
    }

    const data = items.flatMap((item) =>
      item.stockByLocation
        .filter((entry) => entry.quantity > 0)
        .map((entry) => {
          const locationKey = String(entry.locationId);
          return {
            _id: `${item._id}:${locationKey}`,
            itemId: String(item._id),
            typeId: item.typeId,
            name: item.name,
            locationId: locationKey,
            locationName: entry.locationName,
            quantityOnHand: entry.quantity,
            availableQuantity:
              availableByLocation.get(locationKey)?.get(item.typeId) ?? 0,
            stockUpdatedAt: entry.stockUpdatedAt,
            oldestUnsoldAcquiredAt: entry.oldestUnsoldAcquiredAt,
          };
        }),
    );

    res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error("Failed to fetch buyback stock:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch buyback stock", error: err });
  }
});

// Manual on-hand correction for one item at one location - corpAssetSync
// only polls once a day (ESI caches hangar contents for 24h), so if
// something is physically pulled from the hangar outside of a fulfilled
// Purchase Stock order (used, sold in person, etc.) this lets the admin
// reflect that immediately instead of leaving stale stock purchasable for
// up to a day. The next sync overwrites this with real ESI data as usual -
// this is only a stopgap for the gap between polls, not a standing override.
adminRouter.patch(
  "/buyback-stock/:itemId/:locationId",
  async (req, res) => {
    const { quantity } = req.body;
    const { itemId, locationId } = req.params;

    if (
      typeof quantity !== "number" ||
      !Number.isFinite(quantity) ||
      quantity < 0
    ) {
      res
        .status(400)
        .json({ ok: false, message: "quantity must be a non-negative number" });
      return;
    }

    try {
      const item = await BuybackItem.findById(itemId);
      if (!item) {
        res.status(404).json({ ok: false, message: "Item not found" });
        return;
      }

      const entry = item.stockByLocation.find(
        (e) => String(e.locationId) === locationId,
      );
      if (!entry) {
        res.status(404).json({
          ok: false,
          message: "No stock entry at this location for this item",
        });
        return;
      }

      const previousQuantity = entry.quantity;
      entry.quantity = quantity;
      entry.stockUpdatedAt = new Date();
      if (previousQuantity === 0 && quantity > 0) {
        entry.oldestUnsoldAcquiredAt = new Date();
      } else if (quantity === 0) {
        entry.oldestUnsoldAcquiredAt = null;
      }

      await item.save();

      res.status(200).json({ ok: true, data: item });
    } catch (err) {
      console.error("Failed to manually update buyback stock:", err);
      res
        .status(500)
        .json({ ok: false, message: "Failed to update stock", error: err });
    }
  },
);

// Manually adds (increments) stock for an item that was just physically
// acquired but hasn't shown up in an ESI poll yet, at a location that may
// not have a stockByLocation entry for it at all yet (unlike the PATCH
// route above, which only edits a row already surfaced by GET
// /buyback-stock). The next corpAssetSync run always wins regardless - it
// fully overwrites stockByLocation from real ESI data, so this is purely a
// stopgap for the gap between polls (including the case where everything
// added here sells out before the next sync ever runs).
adminRouter.post("/buyback-stock/add", async (req, res) => {
  const { typeId, locationId, quantity } = req.body;

  if (
    typeof quantity !== "number" ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    res
      .status(400)
      .json({ ok: false, message: "quantity must be a positive number" });
    return;
  }

  try {
    const item = await BuybackItem.findOne({ typeId });
    if (!item) {
      res.status(404).json({ ok: false, message: "Item not found" });
      return;
    }

    const location = await BuybackLocation.findOne({
      _id: locationId,
      isHub: true,
      stockLocationId: { $ne: null },
    });
    if (!location) {
      res.status(400).json({
        ok: false,
        message: "Location is not a valid stock-eligible hub",
      });
      return;
    }

    const entry = item.stockByLocation.find(
      (e) => String(e.locationId) === locationId,
    );

    if (entry) {
      const previousQuantity = entry.quantity;
      entry.quantity += quantity;
      entry.stockUpdatedAt = new Date();
      if (previousQuantity === 0) {
        entry.oldestUnsoldAcquiredAt = new Date();
      }
    } else {
      item.stockByLocation.push({
        locationId: location._id,
        locationName: location.name,
        quantity,
        stockUpdatedAt: new Date(),
        oldestUnsoldAcquiredAt: new Date(),
      });
    }

    await item.save();

    res.status(200).json({ ok: true, data: item });
  } catch (err) {
    console.error("Failed to manually add buyback stock:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to add stock", error: err });
  }
});

// Manual trigger for the admin's "Run Sync Now" button on the stock page -
// same underlying function the daily cron calls, just on demand so a fix
// (e.g. re-authorizing SSO scopes) can be confirmed without waiting for the
// next scheduled run.
adminRouter.post("/buyback-stock/sync", async (_req, res) => {
  try {
    const result = await syncCorpAssetStock();

    if (!result.ok) {
      const messages: Record<string, string> = {
        already_running: "A sync is already in progress - try again shortly.",
        no_stock_locations:
          "No hub location has a stock location configured yet.",
      };
      res.status(200).json({
        ok: false,
        message:
          result.reason === "error" ? result.message : messages[result.reason],
      });
      return;
    }

    res.status(200).json({ ok: true, data: result });
  } catch (err) {
    console.error("Manual corp asset sync failed:", err);
    res
      .status(500)
      .json({ ok: false, message: "Corp asset sync failed", error: err });
  }
});

adminRouter.get("/buy-orders", async (req, res) => {
  const status = req.query.status as string | undefined;
  const filter: Record<string, unknown> = status ? { status } : {};

  try {
    const orders = await BuyOrder.find(filter).sort({ createdAt: -1 }).limit(200);
    res.status(200).json({ ok: true, data: orders });
  } catch (err) {
    console.error("Failed to fetch buy orders:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch buy orders", error: err });
  }
});

adminRouter.patch("/buy-orders/:id", async (req, res) => {
  const { status } = req.body;

  if (!["pending_contract", "contract_created", "completed", "cancelled"].includes(status)) {
    res.status(400).json({ ok: false, message: "Invalid status" });
    return;
  }

  try {
    const order = await BuyOrder.findByIdAndUpdate(
      req.params.id,
      {
        status,
        completedAt: status === "completed" ? new Date() : null,
      },
      { new: true },
    );

    if (!order) {
      res.status(404).json({ ok: false, message: "Buy order not found" });
      return;
    }

    try {
      await notifyBuyOrderUpdate(order);
    } catch (err) {
      console.error(
        `Failed to update Discord message for buy order ${order.referenceId}:`,
        err,
      );
    }

    res.status(200).json({ ok: true, data: order });
  } catch (err) {
    console.error("Failed to update buy order:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to update buy order", error: err });
  }
});

export default adminRouter;
