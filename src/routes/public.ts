import { Router } from "express";
import { Route } from "../models/Routes";
import { runJaniceAppraisal } from "../services/janiceAppraisal";

const publicRouter = Router();

publicRouter.get("/routes", async (req, res) => {
  const pickup = req.query.pickup as string | undefined;
  const destination = req.query.destination as string | undefined;

  try {
    if (!pickup && !destination) {
      const routes = await Route.find();
      res.status(200).json({ ok: true, data: routes });
    } else if (pickup && !destination) {
      const routes = await Route.find({ systems: pickup });
      res.status(200).json({ ok: true, data: routes });
    } else if (!pickup && destination) {
      const routes = await Route.find({ systems: destination });
      res.status(200).json({ ok: true, data: routes });
    } else {
      const routes = await Route.find({
        systems: { $all: [pickup, destination] },
      });
      res.status(200).json({ ok: true, data: routes });
    }
  } catch (err) {
    console.error("Failed to fetch routes:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch routes", error: err });
  }
});

publicRouter.post("/appraisal", async (req, res) => {
  const { itemsText } = req.body;

  if (!itemsText) {
    res.status(400).json({ ok: false, message: "itemsText is required" });
    return;
  }

  try {
    const appraisal = await runJaniceAppraisal(itemsText);
    res.status(200).json({ ok: true, data: appraisal });
  } catch (err) {
    console.error("Appraisal failed:", err);
    res.status(500).json({ ok: false, message: "Appraisal failed" });
  }
});

export default publicRouter;
