import { Router } from "express";
import { Config } from "../models/Config";
import { Route } from "../models/Routes";

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

export default adminRouter;
