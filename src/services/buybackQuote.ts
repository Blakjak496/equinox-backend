import { BuybackCategory, IBuybackCategory } from "../models/BuybackCategory";
import { BuybackGroup, IBuybackGroup } from "../models/BuybackGroup";
import { BuybackItem, IBuybackItem } from "../models/BuybackItem";
import { BuybackLocation } from "../models/BuybackLocation";
import { BuybackQuote, IBuybackQuoteItem } from "../models/BuybackQuote";
import { Config } from "../models/Config";
import { generateReferenceId } from "../utils/reference-id";
import { parseItemsText } from "../utils/parseItemsText";
import { fetchTypeVolume } from "../utils/esi-type-utils";
import { runJaniceAppraisal, buildJaniceUrl } from "./janiceAppraisal";

const CAP_ISK = 20_000_000_000;
const QUOTE_TTL_DAYS = 30;
const DEFAULT_MARGIN_FLOOR_PERCENT = 5;

export const INVALID_LOCATION_ERROR = "Invalid pickup location";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type BuybackQuoteResult =
  | {
      ok: true;
      referenceId: string;
      // Points at the single Janice appraisal, scoped to only the
      // accepted items (null if nothing was accepted) - Janice is never
      // asked to price or identify anything that isn't already known
      // locally to be accepted.
      janiceUrl: string | null;
      items: IBuybackQuoteItem[];
      totalJbv: number;
      totalOfferValue: number;
      blendedPercent: number;
      pickupFee: number;
      netTotalPrice: number;
    }
  | {
      ok: false;
      reason: "cap_exceeded";
      netTotalPrice: number;
    };

// Provisionally accepted pending Janice pricing - every accept/reject/
// location/volume decision is already final by the time this exists;
// only jbvPerUnit is still unknown. Carries its position in the customer's
// original input so the final itemized list can be reassembled in the
// order they typed it, rather than grouping all-rejected-then-all-accepted.
type PendingAcceptedItem = {
  index: number;
  typeId: number;
  name: string;
  categoryName: string;
  quantity: number;
  volume: number;
  haul: boolean;
  finalPercent: number;
};

export async function buildBuybackQuote(
  itemsText: string,
  locationId: string,
): Promise<BuybackQuoteResult> {
  const location = await BuybackLocation.findById(locationId);
  if (!location) throw new Error(INVALID_LOCATION_ERROR);

  const config = await Config.findOne();
  const salesTaxRate = config?.salesTaxRate ?? 0.042;
  const safeCeilingPercent = (1 - salesTaxRate) * 100;
  const marginFloorPercent =
    config?.marginFloorPercent ?? DEFAULT_MARGIN_FLOOR_PERCENT;

  const parsedLines = parseItemsText(itemsText);

  // Resolve every line against the full local catalogue (every published
  // EVE item, not just accepted ones - see seedBuybackItems.ts) rather
  // than asking Janice to identify what the customer typed. Case-
  // insensitive exact match only, no fuzzy matching - a wrong match here
  // is a pricing error, not just a cosmetic one.
  const catalog = await BuybackItem.find().select("typeId name").lean();
  const typeIdByName = new Map<string, number>(
    catalog.map((item) => [item.name.toLowerCase(), item.typeId]),
  );

  const resolvedLines = parsedLines.map((line) => ({
    ...line,
    typeId: typeIdByName.get(line.name.toLowerCase()) ?? null,
  }));

  const matchedTypeIds = [
    ...new Set(
      resolvedLines
        .map((line) => line.typeId)
        .filter((typeId): typeId is number => typeId !== null),
    ),
  ];

  const buybackItems = await BuybackItem.find({ typeId: { $in: matchedTypeIds } });
  const itemByTypeId = new Map<number, IBuybackItem>(
    buybackItems.map((item) => [item.typeId, item]),
  );

  const groupIds = buybackItems.map((item) => item.groupId);
  const groups = await BuybackGroup.find({ _id: { $in: groupIds } });
  const groupById = new Map<string, IBuybackGroup>(
    groups.map((group) => [String(group._id), group]),
  );

  const categoryIds = groups.map((group) => group.categoryId);
  const categories = await BuybackCategory.find({ _id: { $in: categoryIds } });
  const categoryById = new Map<string, IBuybackCategory>(
    categories.map((category) => [String(category._id), category]),
  );

  // Indexed by the line's position in the customer's original input, so
  // the final list can be reassembled in that order once accepted items
  // come back from Janice out of band below - null is a placeholder for
  // "still pending", never a real gap by the time this function returns.
  const quoteItemsByIndex: (IBuybackQuoteItem | null)[] = resolvedLines.map(() => null);
  const pendingAccepted: PendingAcceptedItem[] = [];

  for (const [index, line] of resolvedLines.entries()) {
    if (line.typeId === null) {
      quoteItemsByIndex[index] = rejected(
        0,
        line.rawLine,
        "Unknown",
        line.quantity,
        0,
        0,
        0,
        "Item not recognised",
      );
      continue;
    }

    const buybackItem = itemByTypeId.get(line.typeId);
    if (!buybackItem) {
      quoteItemsByIndex[index] = rejected(
        line.typeId,
        line.name,
        "Unknown",
        line.quantity,
        0,
        0,
        0,
        "Item not recognised",
      );
      continue;
    }

    const group = groupById.get(String(buybackItem.groupId));
    const category = group ? categoryById.get(String(group.categoryId)) : undefined;
    // Customer-facing snapshot shows the real EVE category (e.g.
    // "Asteroid"), not the group (e.g. "Arkonor") - kept consistent with
    // what the admin UI and calculator app both call "category" now.
    const categoryName = category?.name ?? "Uncategorised";

    // Not-accepted items are rejected immediately - no need to fetch
    // volume or evaluate location restrictions for something that isn't
    // bought back at all, and never sent to Janice below.
    const accepted =
      buybackItem.accepted ?? group?.accepted ?? category?.accepted ?? false;
    if (!accepted) {
      quoteItemsByIndex[index] = rejected(
        line.typeId,
        buybackItem.name,
        categoryName,
        line.quantity,
        0,
        0,
        0,
        "Not currently accepted",
      );
      continue;
    }

    const acceptedLocationIds =
      buybackItem.acceptedLocationIds ??
      group?.acceptedLocationIds ??
      category?.acceptedLocationIds ??
      null;
    if (
      acceptedLocationIds &&
      acceptedLocationIds.length > 0 &&
      !acceptedLocationIds.includes(locationId)
    ) {
      quoteItemsByIndex[index] = rejected(
        line.typeId,
        buybackItem.name,
        categoryName,
        line.quantity,
        0,
        0,
        0,
        "Not accepted from this location",
      );
      continue;
    }

    // Static per-type data, cached permanently once fetched - independent
    // of Janice entirely, so it's available even for items that haven't
    // been through the nightly pricing batch yet.
    let packagedVolume = buybackItem.packagedVolume;
    if (packagedVolume === null) {
      packagedVolume = await fetchTypeVolume(line.typeId);
      if (packagedVolume !== null) {
        await BuybackItem.updateOne({ _id: buybackItem._id }, { packagedVolume });
      }
    }
    const volume = (packagedVolume ?? 0) * line.quantity;

    const basePercent =
      buybackItem.rateOverride ?? group?.percentOffered ?? category?.percentOffered ?? 0;

    // Downward-only safety net, applied to every item: catches any rate -
    // manually set, inherited, or just stale - that no longer clears the
    // minimum margin after tax because JBV shifted since it was last set.
    // Rounded immediately - safeCeilingPercent is derived from a tax rate
    // fraction (e.g. 0.0337), and subtracting from it lands on values like
    // 91.63000000000001 without this.
    let finalPercent = basePercent;
    if (safeCeilingPercent - basePercent < marginFloorPercent) {
      finalPercent = round2(safeCeilingPercent - marginFloorPercent);
    }

    const haul = buybackItem.haul ?? group?.haul ?? category?.haul ?? true;

    pendingAccepted.push({
      index,
      typeId: line.typeId,
      name: buybackItem.name,
      categoryName,
      quantity: line.quantity,
      volume,
      haul,
      finalPercent,
    });
  }

  let totalJbv = 0;
  let janiceUrl: string | null = null;
  let feeEligibleVolume = 0;

  // Janice is called exactly once here, with only the items already known
  // locally to be accepted - it's used purely for pricing (JBV), never
  // for identifying or evaluating anything that isn't already going to be
  // bought back.
  if (pendingAccepted.length > 0) {
    const acceptedItemsText = pendingAccepted
      .map((item) => `${item.name} ${item.quantity}`)
      .join("\n");
    const appraisal = await runJaniceAppraisal(acceptedItemsText, "buy");

    const jbvPerUnitByTypeId = new Map<number, number>(
      appraisal.items.map((item) => [item.itemType.eid, item.immediatePrices.buyPrice]),
    );

    for (const item of pendingAccepted) {
      const jbvPerUnit = jbvPerUnitByTypeId.get(item.typeId) ?? 0;
      if (jbvPerUnit <= 0) {
        quoteItemsByIndex[item.index] = rejected(
          item.typeId,
          item.name,
          item.categoryName,
          item.quantity,
          0,
          0,
          item.volume,
          "No buy value",
        );
        continue;
      }

      const itemTotalJbv = jbvPerUnit * item.quantity;
      const offerValue = itemTotalJbv * (item.finalPercent / 100);

      if (item.haul) {
        feeEligibleVolume += item.volume;
      }

      quoteItemsByIndex[item.index] = {
        typeId: item.typeId,
        name: item.name,
        categoryName: item.categoryName,
        quantity: item.quantity,
        jbvPerUnit,
        totalJbv: itemTotalJbv,
        volume: item.volume,
        percentOffered: item.finalPercent,
        offerValue,
        accepted: true,
        rejectReason: null,
      };
    }

    // The appraisal's own aggregate, not a manual sum - items rejected
    // above for zero buy value contribute nothing to it either way, so
    // this always matches the sum of the accepted rows' totalJbv.
    totalJbv = appraisal.immediatePrices.totalBuyPrice;
    janiceUrl = appraisal.code ? buildJaniceUrl(appraisal.code) : null;
  }

  // Every index was resolved in one of the two loops above - either
  // rejected immediately or filled in once Janice priced it.
  const quoteItems = quoteItemsByIndex as IBuybackQuoteItem[];

  const totalOfferValue = quoteItems.reduce(
    (sum, item) => sum + item.offerValue,
    0,
  );
  const blendedPercent =
    totalJbv > 0 ? round2((totalOfferValue / totalJbv) * 100) : 0;

  // Per-m3 pickup fee for satellite locations with a pickup service - scales
  // with fee-eligible volume, so a contract that needs several trips to
  // clear is actually charged for several trips, rather than a flat
  // one-trip fee regardless of size.
  const pickupFee =
    location.pickupRatePerM3 != null
      ? location.pickupRatePerM3 * feeEligibleVolume
      : 0;

  const netTotalPrice = totalOfferValue - pickupFee;

  if (netTotalPrice > CAP_ISK) {
    return { ok: false, reason: "cap_exceeded", netTotalPrice };
  }

  const referenceId = generateReferenceId("NOXC");
  const expiresAt = new Date(
    Date.now() + QUOTE_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  await BuybackQuote.create({
    referenceId,
    janiceUrl,
    items: quoteItems,
    totalJbv,
    totalOfferValue,
    blendedPercent,
    locationId,
    locationName: location.name,
    pickupFee,
    netTotalPrice,
    status: "pending_contract",
    expiresAt,
  });

  return {
    ok: true,
    referenceId,
    janiceUrl,
    items: quoteItems,
    totalJbv,
    totalOfferValue,
    blendedPercent,
    pickupFee,
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
  volume: number,
  rejectReason: string,
): IBuybackQuoteItem {
  return {
    typeId,
    name,
    categoryName,
    quantity,
    jbvPerUnit,
    totalJbv,
    volume,
    percentOffered: 0,
    offerValue: 0,
    accepted: false,
    rejectReason,
  };
}
