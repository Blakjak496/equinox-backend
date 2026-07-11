import { Router } from "express";
import { Route } from "../models/Routes";
import { BuybackLocation } from "../models/BuybackLocation";
import { runJaniceAppraisal } from "../services/janiceAppraisal";
import { buildBuybackQuote, INVALID_LOCATION_ERROR } from "../services/buybackQuote";

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

publicRouter.get("/buyback/locations", async (_req, res) => {
  try {
    const locations = await BuybackLocation.find()
      .select("name isHub")
      .sort({ name: 1 });
    res.status(200).json({ ok: true, data: locations });
  } catch (err) {
    console.error("Failed to fetch buyback locations:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch buyback locations", error: err });
  }
});

publicRouter.post("/buyback/quote", async (req, res) => {
  const { itemsText, locationId } = req.body;

  if (!itemsText) {
    res.status(400).json({ ok: false, message: "itemsText is required" });
    return;
  }

  if (!locationId) {
    res.status(400).json({ ok: false, message: "locationId is required" });
    return;
  }

  try {
    const result = await buildBuybackQuote(itemsText, locationId);

    if (!result.ok) {
      res.status(200).json({
        ok: true,
        data: {
          capExceeded: true,
          netTotalPrice: result.netTotalPrice,
          message:
            "This submission's net total exceeds the 20,000,000,000 ISK cap. Please split it into multiple submissions.",
        },
      });
      return;
    }

    res.status(200).json({
      ok: true,
      data: {
        capExceeded: false,
        referenceId: result.referenceId,
        items: result.items,
        totalJbv: result.totalJbv,
        totalOfferValue: result.totalOfferValue,
        blendedPercent: result.blendedPercent,
        haulingFee: result.haulingFee,
        netTotalPrice: result.netTotalPrice,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message === INVALID_LOCATION_ERROR) {
      res.status(400).json({ ok: false, message: INVALID_LOCATION_ERROR });
      return;
    }
    console.error("Buyback quote failed:", err);
    res.status(500).json({ ok: false, message: "Buyback quote failed" });
  }
});

export default publicRouter;
