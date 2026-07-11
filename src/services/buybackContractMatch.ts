import { esiGet } from "../lib/esiClient";
import { IContractValidation } from "../models/Contract";
import { BuybackQuote } from "../models/BuybackQuote";
import { EsiCorpContract } from "../types/types";

type EsiContractItem = {
  is_included: boolean;
  quantity: number;
  type_id: number;
};

export type BuybackMatchResult = {
  buybackQuoteId: string | null;
  buybackDiscrepancy: IContractValidation | null;
};

const REFERENCE_PATTERN = /NOXC-[0-9A-Z]{6}-[0-9A-Z]{6}/;

export async function matchBuybackContract(
  contract: EsiCorpContract,
  corporationId: number,
  token: string,
): Promise<BuybackMatchResult> {
  const referenceMatch = contract.title.match(REFERENCE_PATTERN);

  if (!referenceMatch) {
    return {
      buybackQuoteId: null,
      buybackDiscrepancy: {
        level: "warning",
        reasons: ["no_reference"],
        message: "No buyback reference found in the contract title",
      },
    };
  }

  const referenceId = referenceMatch[0];
  const quote = await BuybackQuote.findOne({ referenceId });

  if (!quote) {
    return {
      buybackQuoteId: null,
      buybackDiscrepancy: {
        level: "fail",
        reasons: ["quote_not_found"],
        message: `Quote ${referenceId} not found or already expired`,
      },
    };
  }

  const contractItems = await esiGet<EsiContractItem[]>(
    `https://esi.evetech.net/latest/corporations/${corporationId}/contracts/${contract.contract_id}/items/?datasource=tranquility`,
    token,
  );

  const includedQuantityByType = new Map<number, number>();
  for (const item of contractItems) {
    if (!item.is_included) continue;
    includedQuantityByType.set(
      item.type_id,
      (includedQuantityByType.get(item.type_id) ?? 0) + item.quantity,
    );
  }

  const quotedQuantityByType = new Map<number, number>();
  for (const item of quote.items) {
    if (!item.accepted) continue;
    quotedQuantityByType.set(
      item.typeId,
      (quotedQuantityByType.get(item.typeId) ?? 0) + item.quantity,
    );
  }

  const reasons: string[] = [];

  for (const [typeId, quotedQty] of quotedQuantityByType) {
    const contractQty = includedQuantityByType.get(typeId) ?? 0;
    if (contractQty < quotedQty) reasons.push(`missing_item:${typeId}`);
  }

  for (const [typeId, contractQty] of includedQuantityByType) {
    const quotedQty = quotedQuantityByType.get(typeId) ?? 0;
    if (contractQty > quotedQty) reasons.push(`extra_item:${typeId}`);
  }

  if (contract.price !== quote.netTotalPrice) {
    reasons.push("value_mismatch");
  }

  const ok = reasons.length === 0;

  await BuybackQuote.updateOne(
    { referenceId },
    {
      status: "matched",
      discrepancy: !ok,
      matchedContractId: contract.contract_id,
    },
  );

  return {
    buybackQuoteId: referenceId,
    buybackDiscrepancy: ok
      ? { level: "ok", reasons: [], message: null }
      : {
          level: "fail",
          reasons,
          message: "Contract contents or value don't match the quote",
        },
  };
}
