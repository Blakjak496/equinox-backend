import { BuybackCategory, IBuybackCategory } from "../models/BuybackCategory";
import { BuybackItem, IBuybackItem } from "../models/BuybackItem";
import { BuybackLocation } from "../models/BuybackLocation";
import { BuybackQuote, IBuybackQuoteItem } from "../models/BuybackQuote";
import { Config } from "../models/Config";
import { generateReferenceId } from "../utils/reference-id";
import { getNitrogenIsotopePrice, runJaniceAppraisal } from "./janiceAppraisal";

const CAP_ISK = 20_000_000_000;
const QUOTE_TTL_DAYS = 30;
// isotopes consumed per LY - matches the existing hauling calculator's
// fuelCostPerLY() constant in routeCalculator.ts
const ISOTOPES_PER_LY = 3000;
// jump freighter cargo capacity (m³) - the same 375,000 cap used elsewhere
const JF_CARGO_M3 = 375_000;
const MARGIN_FLOOR_PERCENT = 5;

export const INVALID_LOCATION_ERROR = "Invalid pickup location";

export type BuybackQuoteResult =
  | {
      ok: true;
      referenceId: string;
      items: IBuybackQuoteItem[];
      totalJbv: number;
      totalOfferValue: number;
      blendedPercent: number;
      haulingFee: number;
      netTotalPrice: number;
    }
  | {
      ok: false;
      reason: "cap_exceeded";
      netTotalPrice: number;
    };

export async function buildBuybackQuote(
  itemsText: string,
  locationId: string,
): Promise<BuybackQuoteResult> {
  const location = await BuybackLocation.findById(locationId);
  if (!location) throw new Error(INVALID_LOCATION_ERROR);

  const [isotopePrice, config, appraisal] = await Promise.all([
    getNitrogenIsotopePrice(),
    Config.findOne(),
    runJaniceAppraisal(itemsText, "buy"),
  ]);

  const salesTaxRate = config?.salesTaxRate ?? 0.042;
  const safeCeilingPercent = (1 - salesTaxRate) * 100;

  const haulingRatePerM3 =
    (location.distance * ISOTOPES_PER_LY * isotopePrice) / JF_CARGO_M3;

  const typeIds = appraisal.items.map((item) => item.itemType.eid);
  const buybackItems = await BuybackItem.find({ typeId: { $in: typeIds } });
  const itemByTypeId = new Map<number, IBuybackItem>(
    buybackItems.map((item) => [item.typeId, item]),
  );

  const categoryIds = buybackItems.map((item) => item.categoryId);
  const categories = await BuybackCategory.find({ _id: { $in: categoryIds } });
  const categoryById = new Map<string, IBuybackCategory>(
    categories.map((category) => [String(category._id), category]),
  );

  const quoteItems: IBuybackQuoteItem[] = [];
  let feeEligibleVolume = 0;

  for (const janiceItem of appraisal.items) {
    const typeId = janiceItem.itemType.eid;
    const name = janiceItem.itemType.name;
    const quantity = janiceItem.amount;
    const jbvPerUnit = janiceItem.immediatePrices.buyPrice;
    const totalJbv = jbvPerUnit * quantity;
    const unitVolume =
      janiceItem.itemType.packagedVolume || janiceItem.itemType.volume;

    const buybackItem = itemByTypeId.get(typeId);
    if (!buybackItem) {
      quoteItems.push(
        rejected(typeId, name, "Unknown", quantity, jbvPerUnit, totalJbv, "Item not recognised"),
      );
      continue;
    }

    const category = categoryById.get(String(buybackItem.categoryId));
    const categoryName = category?.name ?? "Uncategorised";

    if (jbvPerUnit <= 0) {
      quoteItems.push(
        rejected(typeId, name, categoryName, quantity, jbvPerUnit, totalJbv, "No buy value"),
      );
      continue;
    }

    const acceptedLocationIds =
      buybackItem.acceptedLocationIds ?? category?.acceptedLocationIds ?? null;
    if (
      acceptedLocationIds &&
      acceptedLocationIds.length > 0 &&
      !acceptedLocationIds.includes(locationId)
    ) {
      quoteItems.push(
        rejected(
          typeId,
          name,
          categoryName,
          quantity,
          jbvPerUnit,
          totalJbv,
          "Not accepted from this location",
        ),
      );
      continue;
    }

    const accepted = buybackItem.accepted ?? category?.accepted ?? false;
    if (!accepted) {
      quoteItems.push(
        rejected(typeId, name, categoryName, quantity, jbvPerUnit, totalJbv, "Not currently accepted"),
      );
      continue;
    }

    const basePercent = buybackItem.rateOverride ?? category?.percentOffered ?? 0;
    const variable = buybackItem.variable ?? category?.variable ?? true;

    let liquidityModifier = 1.0;
    if (variable) {
      const orderCount = janiceItem.buyOrderCount;
      if (orderCount < 10) liquidityModifier = 0.8;
      else if (orderCount >= 50) liquidityModifier = 1.03;
    }

    const liquidityAdjustedPercent = basePercent * liquidityModifier;

    // Downward-only safety net: never overrides a deliberately low
    // variable=false rate, and never pulls a large margin back down.
    let finalPercent = liquidityAdjustedPercent;
    if (
      variable &&
      safeCeilingPercent - liquidityAdjustedPercent < MARGIN_FLOOR_PERCENT
    ) {
      finalPercent = safeCeilingPercent - MARGIN_FLOOR_PERCENT;
    }

    const offerValue = totalJbv * (finalPercent / 100);

    const haulable = buybackItem.haulable ?? category?.haulable ?? true;
    if (haulable) {
      feeEligibleVolume += unitVolume * quantity;
    }

    quoteItems.push({
      typeId,
      name,
      categoryName,
      quantity,
      jbvPerUnit,
      totalJbv,
      percentOffered: finalPercent,
      offerValue,
      accepted: true,
      rejectReason: null,
    });
  }

  const totalJbv = quoteItems.reduce((sum, item) => sum + item.totalJbv, 0);
  const totalOfferValue = quoteItems.reduce(
    (sum, item) => sum + item.offerValue,
    0,
  );
  const blendedPercent = totalJbv > 0 ? (totalOfferValue / totalJbv) * 100 : 0;

  const haulingFee = haulingRatePerM3 * feeEligibleVolume;
  const netTotalPrice = totalOfferValue - haulingFee;

  if (netTotalPrice > CAP_ISK) {
    return { ok: false, reason: "cap_exceeded", netTotalPrice };
  }

  const referenceId = generateReferenceId("NOXC");
  const expiresAt = new Date(
    Date.now() + QUOTE_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  await BuybackQuote.create({
    referenceId,
    items: quoteItems,
    totalJbv,
    totalOfferValue,
    blendedPercent,
    locationId,
    locationName: location.name,
    haulingRatePerM3,
    haulingFee,
    netTotalPrice,
    status: "pending_contract",
    expiresAt,
  });

  return {
    ok: true,
    referenceId,
    items: quoteItems,
    totalJbv,
    totalOfferValue,
    blendedPercent,
    haulingFee,
    netTotalPrice,
  };
}

function rejected(
  typeId: number,
  name: string,
  categoryName: string,
  quantity: number,
  jbvPerUnit: number,
  totalJbv: number,
  rejectReason: string,
): IBuybackQuoteItem {
  return {
    typeId,
    name,
    categoryName,
    quantity,
    jbvPerUnit,
    totalJbv,
    percentOffered: 0,
    offerValue: 0,
    accepted: false,
    rejectReason,
  };
}
