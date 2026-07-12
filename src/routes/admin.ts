import { Router } from "express";
import { Config } from "../models/Config";
import { Route } from "../models/Routes";
import { Stats } from "../models/Stats";
import { System } from "../models/System";
import { MainRoute } from "../models/MainRoute";
import { ShipCategory } from "../models/ShipCategory";
import { BuybackCategory } from "../models/BuybackCategory";
import { BuybackItem } from "../models/BuybackItem";
import { BuybackQuote } from "../models/BuybackQuote";
import { BuybackLocation } from "../models/BuybackLocation";
import {
  ensureSystemIsCached,
  getSystemIdByName,
} from "../utils/system-utils";
import { calculateOptimalRoute } from "../services/routeCalculator";
import { findJumpPath } from "../services/jumpPathfinder";

const adminRouter = Router();

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
    const stats = await Stats.findOne();
    res.status(200).json({ ok: true, data: stats });
  } catch (err) {
    console.error("Failed to get stats:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to get stats", error: err });
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
  const { name, isHub, distance, distanceFromHub } = req.body;

  if (!name || typeof distance !== "number") {
    res.status(400).json({
      ok: false,
      message: "name and distance are required",
    });
    return;
  }

  try {
    const location = await BuybackLocation.create({
      name,
      isHub: Boolean(isHub),
      distance,
      distanceFromHub: distanceFromHub ?? null,
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
  const { name, isHub, distance, distanceFromHub } = req.body;

  try {
    const location = await BuybackLocation.findByIdAndUpdate(
      req.params.id,
      { name, isHub, distance, distanceFromHub },
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
    res.status(200).json({ ok: true, data: categories });
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
  const { accepted, percentOffered, variable, haulable, acceptedLocationIds } =
    req.body;

  try {
    const category = await BuybackCategory.findByIdAndUpdate(
      req.params.id,
      { accepted, percentOffered, variable, haulable, acceptedLocationIds },
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

adminRouter.get("/buyback-items", async (req, res) => {
  const q = req.query.q as string | undefined;
  const categoryId = req.query.categoryId as string | undefined;

  const filter: Record<string, unknown> = {};
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
  const { accepted, rateOverride, notes, variable, haulable, acceptedLocationIds } =
    req.body;

  try {
    const item = await BuybackItem.findByIdAndUpdate(
      req.params.id,
      {
        accepted,
        rateOverride,
        notes,
        variable,
        haulable,
        acceptedLocationIds,
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

export default adminRouter;
