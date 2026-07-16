import { Router } from "express";
import { Config } from "../models/Config";
import { Route } from "../models/Routes";
import { Stats } from "../models/Stats";
import { Contract } from "../models/Contract";
import { System } from "../models/System";
import { MainRoute } from "../models/MainRoute";
import { ShipCategory } from "../models/ShipCategory";
import { BuybackCategory } from "../models/BuybackCategory";
import { BuybackItem } from "../models/BuybackItem";
import { BuybackQuote } from "../models/BuybackQuote";
import { BuybackLocation } from "../models/BuybackLocation";
import { BuyOrder } from "../models/BuyOrder";
import { Structure } from "../models/Structure";
import { Station } from "../models/Station";
import { computeAvailableQuantities } from "../services/buyOrder";
import {
  ensureSystemIsCached,
  getSystemIdByName,
} from "../utils/system-utils";
import { calculateOptimalRoute } from "../services/routeCalculator";
import { findJumpPath } from "../services/jumpPathfinder";

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
    const result = await calculateOptimalRoute(
      pickup,
      dropoff,
      mainRoutes,
      shipCategory.jumpRangeLY,
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
  const { name, jumpRangeLY } = req.body;

  if (!name || typeof jumpRangeLY !== "number") {
    res.status(400).json({
      ok: false,
      message: "name and jumpRangeLY are required",
    });
    return;
  }

  try {
    const shipCategory = await ShipCategory.create({ name, jumpRangeLY });
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
  const { name, jumpRangeLY } = req.body;

  try {
    const shipCategory = await ShipCategory.findByIdAndUpdate(
      req.params.id,
      { name, jumpRangeLY },
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

adminRouter.post("/jump-routes/plan", async (req, res) => {
  const { waypointNames, shipCategoryId } = req.body;

  if (!Array.isArray(waypointNames) || waypointNames.length < 2 || !shipCategoryId) {
    res.status(400).json({
      ok: false,
      message: "waypointNames (at least 2) and shipCategoryId are required",
    });
    return;
  }

  try {
    const shipCategory = await ShipCategory.findById(shipCategoryId);
    if (!shipCategory) {
      res.status(404).json({ ok: false, message: "Ship category not found" });
      return;
    }

    const systemIds = await Promise.all(
      waypointNames.map((name: string) => getSystemIdByName(name)),
    );

    const missingIndex = systemIds.findIndex((id) => !id);
    if (missingIndex !== -1) {
      res.status(404).json({
        ok: false,
        message: `Could not resolve "${waypointNames[missingIndex]}"`,
      });
      return;
    }

    const systems = await Promise.all(
      systemIds.map((id) => ensureSystemIsCached(id!)),
    );

    const fullPath = [systems[0]];
    let totalDistanceLY = 0;

    for (let i = 0; i < systems.length - 1; i++) {
      const leg = findJumpPath(
        systems[i]!.systemId,
        systems[i + 1]!.systemId,
        shipCategory.jumpRangeLY,
      );

      if ("error" in leg) {
        res.status(400).json({ ok: false, message: leg.error });
        return;
      }

      totalDistanceLY += leg.totalDistanceLY;
      fullPath.push(...leg.path.slice(1));
    }

    res.status(200).json({
      ok: true,
      data: {
        path: fullPath.map((system) => system!.name),
        totalDistanceLY,
      },
    });
  } catch (err) {
    console.error("Failed to plan jump route:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to plan jump route", error: err });
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

    // A category is only worth showing if it has at least one item that
    // isn't confirmed non-tradable - categories with zero items, or where
    // every item has been flagged nonTradable, are hidden (not deleted -
    // legitimate items can still be added to them later).
    const visibleCategoryIds = await BuybackItem.distinct("categoryId", {
      nonTradable: { $ne: true },
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

// Every item resolving accepted (item.accepted ?? category.accepted),
// across all categories, with the owning category populated - used by the
// pricing page's category tree, which only ever shows accepted items and
// needs to know up front which categories have any before rendering them.
// extraMatch lets callers narrow further (e.g. recommendationPending: true)
// while still guaranteeing the result never includes an item that isn't
// currently accepted - a pending-recommendation flag on an item the
// operator doesn't even accept shouldn't show up anywhere actionable.
async function fetchResolvedAcceptedItems(extraMatch: Record<string, unknown> = {}) {
  return BuybackItem.aggregate([
    {
      $lookup: {
        from: BuybackCategory.collection.name,
        localField: "categoryId",
        foreignField: "_id",
        as: "category",
      },
    },
    { $unwind: "$category" },
    {
      $match: {
        $expr: { $eq: [{ $ifNull: ["$accepted", "$category.accepted"] }, true] },
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
  ]);
}

adminRouter.get("/buyback-items", async (req, res) => {
  const q = req.query.q as string | undefined;
  const categoryId = req.query.categoryId as string | undefined;
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
  if (categoryId) filter.categoryId = categoryId;
  if (q && q.length >= 2) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.name = { $regex: escaped, $options: "i" };
  }

  if (!categoryId && !q) {
    res.status(200).json({ ok: true, data: [] });
    return;
  }

  try {
    const items = await BuybackItem.find(filter)
      .populate("categoryId", "name accepted percentOffered")
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
    ).populate("categoryId", "name accepted percentOffered");

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

    res.status(200).json({ ok: true, data: order });
  } catch (err) {
    console.error("Failed to update buy order:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to update buy order", error: err });
  }
});

export default adminRouter;
