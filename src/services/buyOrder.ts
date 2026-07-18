import { BuyOrder, IBuyOrder, IBuyOrderItem } from "../models/BuyOrder";
import { BuybackItem, IBuybackItem } from "../models/BuybackItem";
import { BuybackLocation, IBuybackLocation } from "../models/BuybackLocation";
import { ReprocessingMaterial } from "../models/ReprocessingMaterial";
import { generateReferenceId } from "../utils/reference-id";
import { runJaniceAppraisal } from "./janiceAppraisal";
import { notifyNewBuyOrder } from "./discordNotify";
import {
  REPROCESSING_EFFICIENCY,
  calculateReprocessingYield,
} from "./reprocessing";

const RESERVATION_HOURS = 48;

type PriceCartError =
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "invalid_location" }
  | { ok: false; reason: "invalid_item"; typeId: number }
  | {
      ok: false;
      reason: "insufficient_stock";
      typeId: number;
      available: number;
    }
  | { ok: false; reason: "no_price"; typeId: number };

export type PricedCartItem = {
  typeId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
};

export type PriceCartResult =
  | {
      ok: true;
      location: IBuybackLocation;
      items: PricedCartItem[];
      totalPrice: number;
    }
  | PriceCartError;

export type BuyOrderResult = { ok: true; buyOrder: IBuyOrder } | PriceCartError;

// Live available-to-sell quantity per (typeId, locationId) - stock at one
// hub can't be pooled with another to fill an order, since fulfilling that
// way means shipping between locations, which is an extra cost out of scope
// for this service. On-hand at that location minus every non-terminal
// reservation AT THAT LOCATION, minus completed orders too UNLESS the asset
// poll has already caught up past that completion - otherwise a completed
// order would hand its quantity back to "available" before the physical
// stock reduction is even reflected.
export async function computeAvailableQuantities(
  items: IBuybackItem[],
  locationId: string,
): Promise<Map<number, number>> {
  const typeIds = items.map((item) => item.typeId);

  const stockByTypeId = new Map<number, number>();
  const stockUpdatedAtByTypeId = new Map<number, Date | null>();
  for (const item of items) {
    const entry = item.stockByLocation.find(
      (s) => String(s.locationId) === locationId,
    );
    stockByTypeId.set(item.typeId, entry?.quantity ?? 0);
    stockUpdatedAtByTypeId.set(item.typeId, entry?.stockUpdatedAt ?? null);
  }

  const orders = await BuyOrder.find({
    status: { $ne: "cancelled" },
    locationId,
    "items.typeId": { $in: typeIds },
  });

  const reservedByTypeId = new Map<number, number>();
  for (const order of orders) {
    for (const line of order.items) {
      if (!stockByTypeId.has(line.typeId)) continue;

      const stockUpdatedAt = stockUpdatedAtByTypeId.get(line.typeId) ?? null;
      const countsAsReserved =
        order.status !== "completed" ||
        stockUpdatedAt === null ||
        order.completedAt === null ||
        order.completedAt > stockUpdatedAt;

      if (!countsAsReserved) continue;

      reservedByTypeId.set(
        line.typeId,
        (reservedByTypeId.get(line.typeId) ?? 0) + line.quantity,
      );
    }
  }

  const availableByTypeId = new Map<number, number>();
  for (const item of items) {
    const onHand = stockByTypeId.get(item.typeId) ?? 0;
    const reserved = reservedByTypeId.get(item.typeId) ?? 0;
    availableByTypeId.set(item.typeId, Math.max(0, onHand - reserved));
  }
  return availableByTypeId;
}

// Prices a cart against live Janice buy values - one appraisal call covers
// the whole cart regardless of composition. Items flagged with a
// reprocessingCategory are reprocessed locally (SDE-derived yields, see
// reprocessing.ts) and priced by their resulting minerals instead of
// themselves; only whole portionSize batches reprocess, any leftover
// remainder is priced as the raw item. Both paths fold into the same
// appraisal request since Janice's per-unit price doesn't depend on the
// quantity in the request line.
async function priceCartItems(
  locationId: string,
  requestedItems: { typeId: number; quantity: number }[],
): Promise<PriceCartResult> {
  if (requestedItems.length === 0) return { ok: false, reason: "empty" };

  const location = await BuybackLocation.findOne({
    _id: locationId,
    isHub: true,
    stockLocationId: { $ne: null },
  });
  if (!location) return { ok: false, reason: "invalid_location" };

  const typeIds = requestedItems.map((req) => req.typeId);
  const catalogItems = await BuybackItem.find({ typeId: { $in: typeIds } });
  const catalogByTypeId = new Map(
    catalogItems.map((item) => [item.typeId, item]),
  );

  for (const req of requestedItems) {
    if (!catalogByTypeId.has(req.typeId)) {
      return { ok: false, reason: "invalid_item", typeId: req.typeId };
    }
  }

  const availableByTypeId = await computeAvailableQuantities(
    catalogItems,
    locationId,
  );

  for (const req of requestedItems) {
    const available = availableByTypeId.get(req.typeId) ?? 0;
    if (req.quantity > available) {
      return {
        ok: false,
        reason: "insufficient_stock",
        typeId: req.typeId,
        available,
      };
    }
  }

  const reprocessingTypeIds = requestedItems
    .map((req) => req.typeId)
    .filter((typeId) => catalogByTypeId.get(typeId)!.reprocessingCategory !== null);
  const reprocessingDataByTypeId = new Map(
    (
      await ReprocessingMaterial.find({
        typeId: { $in: reprocessingTypeIds },
      })
    ).map((data) => [data.typeId, data]),
  );

  const yieldByTypeId = new Map<
    number,
    ReturnType<typeof calculateReprocessingYield>
  >();
  for (const req of requestedItems) {
    const catalogItem = catalogByTypeId.get(req.typeId)!;
    if (!catalogItem.reprocessingCategory) continue;

    const reprocessingData = reprocessingDataByTypeId.get(req.typeId);
    if (!reprocessingData) {
      return { ok: false, reason: "no_price", typeId: req.typeId };
    }

    const efficiency = REPROCESSING_EFFICIENCY[catalogItem.reprocessingCategory];
    yieldByTypeId.set(
      req.typeId,
      calculateReprocessingYield(reprocessingData, req.quantity, efficiency),
    );
  }

  // One request line per distinct typeId - a mineral yielded from one ore
  // could also be yielded (or directly requested) elsewhere in the same
  // cart, so quantities are summed rather than duplicated across lines.
  const priceRequestByTypeId = new Map<number, { name: string; quantity: number }>();
  const addPriceRequest = (typeId: number, name: string, quantity: number) => {
    if (quantity <= 0) return;
    const existing = priceRequestByTypeId.get(typeId);
    if (existing) existing.quantity += quantity;
    else priceRequestByTypeId.set(typeId, { name, quantity });
  };

  for (const req of requestedItems) {
    const catalogItem = catalogByTypeId.get(req.typeId)!;
    const yieldResult = yieldByTypeId.get(req.typeId);

    if (!yieldResult) {
      addPriceRequest(req.typeId, catalogItem.name, req.quantity);
      continue;
    }

    for (const material of yieldResult.materials) {
      addPriceRequest(material.materialTypeId, material.materialName, material.quantity);
    }
    // Leftover units that don't fill a full reprocessing batch are priced
    // as the raw item itself.
    addPriceRequest(req.typeId, catalogItem.name, yieldResult.remainder);
  }

  const itemsText = Array.from(priceRequestByTypeId.values())
    .map((line) => `${line.name} ${line.quantity}`)
    .join("\n");
  const appraisal = await runJaniceAppraisal(itemsText, "buy");
  const unitPriceByTypeId = new Map(
    appraisal.items.map((item) => [
      item.itemType.eid,
      item.immediatePrices.buyPrice,
    ]),
  );

  const pricedItems: PricedCartItem[] = [];
  for (const req of requestedItems) {
    const catalogItem = catalogByTypeId.get(req.typeId)!;
    const yieldResult = yieldByTypeId.get(req.typeId);

    // A 0-quantity line was never added to the appraisal request above (see
    // addPriceRequest's guard), so there's no price to look up for it - and
    // none is needed, since 0 units is always worth 0 regardless of price.
    if (req.quantity <= 0) {
      pricedItems.push({
        typeId: req.typeId,
        name: catalogItem.name,
        quantity: req.quantity,
        unitPrice: 0,
        totalPrice: 0,
      });
      continue;
    }

    let totalPrice: number;
    if (!yieldResult) {
      const unitPrice = unitPriceByTypeId.get(req.typeId);
      if (unitPrice === undefined || unitPrice <= 0) {
        return { ok: false, reason: "no_price", typeId: req.typeId };
      }
      totalPrice = unitPrice * req.quantity;
    } else {
      let materialsValue = 0;
      for (const material of yieldResult.materials) {
        if (material.quantity <= 0) continue;
        const materialUnitPrice = unitPriceByTypeId.get(material.materialTypeId);
        if (materialUnitPrice === undefined || materialUnitPrice <= 0) {
          return { ok: false, reason: "no_price", typeId: req.typeId };
        }
        materialsValue += material.quantity * materialUnitPrice;
      }

      let remainderValue = 0;
      if (yieldResult.remainder > 0) {
        const rawUnitPrice = unitPriceByTypeId.get(req.typeId);
        if (rawUnitPrice === undefined || rawUnitPrice <= 0) {
          return { ok: false, reason: "no_price", typeId: req.typeId };
        }
        remainderValue = yieldResult.remainder * rawUnitPrice;
      }

      totalPrice = materialsValue + remainderValue;
    }

    pricedItems.push({
      typeId: req.typeId,
      name: catalogItem.name,
      quantity: req.quantity,
      unitPrice: totalPrice / req.quantity,
      totalPrice,
    });
  }

  const totalPrice = pricedItems.reduce((sum, item) => sum + item.totalPrice, 0);

  return { ok: true, location, items: pricedItems, totalPrice };
}

// Preview pricing for the cart UI's "Get Cart Total" button - no order is
// created, no reservation is made, no Discord ping fires. Called again
// (independently) at actual submission time so the locked order price
// always reflects the freshest market data, not a possibly-stale preview.
export async function quoteCart(
  locationId: string,
  requestedItems: { typeId: number; quantity: number }[],
): Promise<PriceCartResult> {
  return priceCartItems(locationId, requestedItems);
}

export async function createBuyOrder(
  locationId: string,
  requestedItems: { typeId: number; quantity: number }[],
  customerCharacterName: string,
): Promise<BuyOrderResult> {
  const priced = await priceCartItems(locationId, requestedItems);
  if (!priced.ok) return priced;

  const orderItems: IBuyOrderItem[] = priced.items;
  const referenceId = generateReferenceId("NOXP");
  const expiresAt = new Date(
    Date.now() + RESERVATION_HOURS * 60 * 60 * 1000,
  );

  const buyOrder = await BuyOrder.create({
    referenceId,
    customerCharacterName,
    locationId,
    locationName: priced.location.name,
    items: orderItems,
    totalPrice: priced.totalPrice,
    status: "pending_contract",
    expiresAt,
  });

  try {
    await notifyNewBuyOrder(buyOrder);
  } catch (err) {
    console.error("Failed to send Discord ping for new buy order:", err);
  }

  return { ok: true, buyOrder };
}

// Folded into the existing syncContracts cron (every 15 min) rather than a
// separate schedule - releases the reservation on any order that never got
// a matching contract created in time. Contract cancellation (a different,
// faster release path) is handled separately in syncContracts.ts once it
// actually detects the contract.
export async function expireStaleBuyOrders(): Promise<void> {
  const result = await BuyOrder.updateMany(
    { status: "pending_contract", expiresAt: { $lt: new Date() } },
    { status: "cancelled" },
  );
  if (result.modifiedCount > 0) {
    console.log(`[buyOrder] expired ${result.modifiedCount} stale buy orders`);
  }
}
