import { BuybackCategory, IBuybackCategory } from "../models/BuybackCategory";
import { BuybackItem, IBuybackItem } from "../models/BuybackItem";
import { BuybackQuote, IBuybackQuoteItem } from "../models/BuybackQuote";
import { generateReferenceId } from "../utils/reference-id";
import { runJaniceAppraisal } from "./janiceAppraisal";

const CAP_ISK = 20_000_000_000;
const QUOTE_TTL_DAYS = 30;

export type BuybackQuoteResult =
  | {
      ok: true;
      referenceId: string;
      items: IBuybackQuoteItem[];
      totalJbv: number;
      totalOfferValue: number;
      blendedPercent: number;
    }
  | {
      ok: false;
      reason: "cap_exceeded";
      totalOfferValue: number;
    };

export async function buildBuybackQuote(
  itemsText: string,
): Promise<BuybackQuoteResult> {
  const appraisal = await runJaniceAppraisal(itemsText, "buy");

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

  const quoteItems: IBuybackQuoteItem[] = appraisal.items.map((janiceItem) => {
    const typeId = janiceItem.itemType.eid;
    const name = janiceItem.itemType.name;
    const quantity = janiceItem.amount;
    const jbvPerUnit = janiceItem.immediatePrices.buyPrice;
    const totalJbv = jbvPerUnit * quantity;

    const buybackItem = itemByTypeId.get(typeId);
    if (!buybackItem) {
      return rejected(typeId, name, "Unknown", quantity, jbvPerUnit, totalJbv, "Item not recognised");
    }

    const category = categoryById.get(String(buybackItem.categoryId));
    const categoryName = category?.name ?? "Uncategorised";

    if (jbvPerUnit <= 0) {
      return rejected(typeId, name, categoryName, quantity, jbvPerUnit, totalJbv, "No buy value");
    }

    const accepted = buybackItem.accepted ?? category?.accepted ?? false;
    if (!accepted) {
      return rejected(typeId, name, categoryName, quantity, jbvPerUnit, totalJbv, "Not currently accepted");
    }

    const percentOffered = buybackItem.rateOverride ?? category?.percentOffered ?? 0;
    const offerValue = totalJbv * (percentOffered / 100);

    return {
      typeId,
      name,
      categoryName,
      quantity,
      jbvPerUnit,
      totalJbv,
      percentOffered,
      offerValue,
      accepted: true,
      rejectReason: null,
    };
  });

  const totalJbv = quoteItems.reduce((sum, item) => sum + item.totalJbv, 0);
  const totalOfferValue = quoteItems.reduce(
    (sum, item) => sum + item.offerValue,
    0,
  );
  const blendedPercent = totalJbv > 0 ? (totalOfferValue / totalJbv) * 100 : 0;

  if (totalOfferValue > CAP_ISK) {
    return { ok: false, reason: "cap_exceeded", totalOfferValue };
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
