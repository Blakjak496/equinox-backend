import { Router } from "express";
import { Config } from "../models/Config";
import { Route } from "../models/Routes";
import { Stats } from "../models/Stats";
import { System } from "../models/System";
import { MainRoute } from "../models/MainRoute";
import {
  ensureSystemIsCached,
  getSystemIdByName,
} from "../utils/system-utils";
import { calculateOptimalRoute } from "../services/routeCalculator";

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

adminRouter.patch("/systems/:systemId", async (req, res) => {
  const systemId = Number(req.params.systemId);
  const { hasTetherableStructure } = req.body;

  if (typeof hasTetherableStructure !== "boolean") {
    res
      .status(400)
      .json({ ok: false, message: "hasTetherableStructure must be a boolean" });
    return;
  }

  try {
    const system = await System.findOneAndUpdate(
      { systemId },
      { hasTetherableStructure },
      { new: true },
    );

    if (!system) {
      res.status(404).json({ ok: false, message: "System not found" });
      return;
    }

    res.status(200).json({ ok: true, data: system });
  } catch (err) {
    console.error("Failed to update system:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to update system", error: err });
  }
});

adminRouter.post("/routes/calculate", async (req, res) => {
  const { pickupSystemName, dropoffSystemName } = req.body;

  if (!pickupSystemName || !dropoffSystemName) {
    res.status(400).json({
      ok: false,
      message: "pickupSystemName and dropoffSystemName are required",
    });
    return;
  }

  try {
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
    const result = await calculateOptimalRoute(pickup, dropoff, mainRoutes);

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

export default adminRouter;
