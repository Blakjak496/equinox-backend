import { Router } from "express";
import { Route } from "../models/Routes";
import { BuybackLocation } from "../models/BuybackLocation";
import { BuybackItem } from "../models/BuybackItem";
import { Config } from "../models/Config";
import { runJaniceAppraisal } from "../services/janiceAppraisal";
import { buildBuybackQuote, INVALID_LOCATION_ERROR } from "../services/buybackQuote";
import {
  createBuyOrder,
  quoteCart,
  computeAvailableQuantities,
} from "../services/buyOrder";

const publicRouter = Router();

// Same reasoning as adminRouter: pricing/location data here can change at
// any time from the admin side, and Express's default weak ETag is enough
// for a browser to serve a stale cached body via 304 instead of hitting
// this router again. Customers should never see stale pricing.
publicRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

publicRouter.get("/config", async (_req, res) => {
  try {
    const config = await Config.findOne();
    res.status(200).json({
      ok: true,
      data: {
        runnersEnabled: config?.runnersEnabled ?? true,
        cartelEnabled: config?.cartelEnabled ?? true,
      },
    });
  } catch (err) {
    console.error("Failed to fetch public config:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch config", error: err });
  }
});

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
        pickupFee: result.pickupFee,
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

// Only hub locations with a stockLocationId set are eligible to sell from -
// mirrors the same restriction corpAssetSync enforces when polling.
publicRouter.get("/stock/locations", async (_req, res) => {
  try {
    const locations = await BuybackLocation.find({
      isHub: true,
      stockLocationId: { $ne: null },
    })
      .select("name")
      .sort({ name: 1 });
    res.status(200).json({ ok: true, data: locations });
  } catch (err) {
    console.error("Failed to fetch stock locations:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch stock locations", error: err });
  }
});

// No pricing here deliberately - this is the passively-loaded listing, and
// Janice pricing only runs on an explicit customer action (the cart's "Get
// Cart Total" quote, or actual order submission) to avoid an appraisal call
// on every page load.
publicRouter.get("/stock", async (req, res) => {
  const locationId = req.query.locationId as string | undefined;

  if (!locationId) {
    res.status(400).json({ ok: false, message: "locationId is required" });
    return;
  }

  try {
    const items = await BuybackItem.find({
      stockByLocation: {
        $elemMatch: { locationId, quantity: { $gt: 0 } },
      },
    });
    const availableByTypeId = await computeAvailableQuantities(
      items,
      locationId,
    );

    const data = items
      .map((item) => ({
        typeId: item.typeId,
        name: item.name,
        availableQuantity: availableByTypeId.get(item.typeId) ?? 0,
      }))
      .filter((item) => item.availableQuantity > 0);

    res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error("Failed to fetch stock:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch stock", error: err });
  }
});

publicRouter.post("/stock/quote", async (req, res) => {
  const { locationId, items } = req.body;

  if (!locationId || typeof locationId !== "string") {
    res.status(400).json({ ok: false, message: "locationId is required" });
    return;
  }

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ ok: false, message: "items is required" });
    return;
  }

  try {
    const result = await quoteCart(locationId, items);

    if (!result.ok) {
      const messages: Record<string, string> = {
        empty: "No items in cart",
        invalid_location: "Selected location is not available for purchase",
        invalid_item: "One or more items are not available for purchase",
        insufficient_stock: "Requested quantity exceeds available stock",
        no_price: "Unable to price one or more items right now",
      };
      res.status(400).json({
        ok: false,
        message: messages[result.reason],
        reason: result.reason,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      data: { items: result.items, totalPrice: result.totalPrice },
    });
  } catch (err) {
    console.error("Cart quote failed:", err);
    res.status(500).json({ ok: false, message: "Cart quote failed" });
  }
});

publicRouter.post("/buy", async (req, res) => {
  const { customerCharacterName, locationId, items } = req.body;

  if (!customerCharacterName || typeof customerCharacterName !== "string") {
    res
      .status(400)
      .json({ ok: false, message: "customerCharacterName is required" });
    return;
  }

  if (!locationId || typeof locationId !== "string") {
    res.status(400).json({ ok: false, message: "locationId is required" });
    return;
  }

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ ok: false, message: "items is required" });
    return;
  }

  try {
    const result = await createBuyOrder(
      locationId,
      items,
      customerCharacterName.trim(),
    );

    if (!result.ok) {
      const messages: Record<string, string> = {
        empty: "No items in order",
        invalid_location: "Selected location is not available for purchase",
        invalid_item: "One or more items are not available for purchase",
        insufficient_stock: "Requested quantity exceeds available stock",
        no_price: "Unable to price one or more items right now",
      };
      res.status(400).json({
        ok: false,
        message: messages[result.reason],
        reason: result.reason,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      data: {
        referenceId: result.buyOrder.referenceId,
        locationName: result.buyOrder.locationName,
        items: result.buyOrder.items,
        totalPrice: result.buyOrder.totalPrice,
        expiresAt: result.buyOrder.expiresAt,
      },
    });
  } catch (err) {
    console.error("Buy order failed:", err);
    res.status(500).json({ ok: false, message: "Buy order failed" });
  }
});

export default publicRouter;
