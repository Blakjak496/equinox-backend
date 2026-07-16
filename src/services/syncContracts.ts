import { getAccessToken } from "../lib/esiClient";
import { ICharacter } from "../models/Character";
import { Contract, IContractValidation } from "../models/Contract";
import { ICorporation } from "../models/Corporation";
import { EsiAuth } from "../models/EsiAuth";
import { IStation } from "../models/Station";
import { Stats } from "../models/Stats";
import { IStructure } from "../models/Structure";
import { EsiCorpContract } from "../types/types";
import { getOrFetchCharacter } from "../utils/character-utils";
import { getAvgCompletionSeconds } from "../utils/contract-utils";
import { getOrFetchCorporation } from "../utils/corporation-utils";
import { validateContract } from "../utils/general-utils";
import { getOrFetchStructure } from "../utils/structure-utils";
import {
  notifyContractUpdate,
  notifyNewContract,
  notifyNewBuybackContract,
  pingOverdue,
} from "./discordNotify";
import { matchBuybackContract, matchBuyOrderContract } from "./buybackContractMatch";
import { BuyOrder } from "../models/BuyOrder";

const BUY_ORDER_RELEASE_STATUSES = [
  "cancelled",
  "rejected",
  "deleted",
  "reversed",
  "failed",
];

let syncRunning: boolean = false;

function parseHeaderNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getEsiLimitInfo(headers: Headers) {
  return {
    remain: parseHeaderNumber(headers.get("x-esi-error-limit-remain")),
    reset: parseHeaderNumber(headers.get("x-esi-error-limit-reset")),
  };
}

export async function syncContracts(): Promise<void> {
  if (syncRunning) return;

  syncRunning = true;

  try {
    const token = await getAccessToken();
    const auth = await EsiAuth.findOne();
    const corporationId = Number(auth!.corporationId);

    const contractsUrl = `https://esi.evetech.net/latest/corporations/${corporationId}/contracts/?datasource=tranquility`;

    const contractsRes = await fetch(contractsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "EquinoxGalactic Admin (corp contracts sync)",
      },
    });

    const esiLimit = getEsiLimitInfo(contractsRes.headers);

    console.log(
      "ESI budget",
      `remain=${esiLimit.remain ?? "unknown"}`,
      `reset=${esiLimit.reset ?? "unknown"}`,
    );

    const esiBudgetLow =
      esiLimit.remain !== null &&
      esiLimit.reset !== null &&
      esiLimit.remain <= 15;

    if (esiBudgetLow) {
      console.warn(
        `ESI error budget low, skipping optional enrichment for this run: remain=${esiLimit.remain} reset=${esiLimit.reset}`,
      );
    }

    const contractsText = await contractsRes.text();

    if (!contractsRes.ok) {
      throw new Error(
        `ESI corp contracts failed ${contractsRes.status}: ${contractsText}`,
      );
    }

    const allContracts = JSON.parse(contractsText) as EsiCorpContract[];
    const courierContracts = allContracts.filter((contract) => {
      return (
        contract.type === "courier" && contract.assignee_id === corporationId
      );
    });

    const itemExchangeContracts = allContracts.filter((contract) => {
      return (
        contract.type === "item_exchange" &&
        contract.assignee_id === corporationId
      );
    });

    // Purchase Stock's contracts run the opposite direction from buyback -
    // the corp is issuer (selling out), not assignee/recipient.
    const outgoingItemExchangeContracts = allContracts.filter((contract) => {
      return (
        contract.type === "item_exchange" &&
        contract.issuer_corporation_id === corporationId
      );
    });

    const outstandingCount = courierContracts.filter(
      (contract) => contract.status === "outstanding",
    ).length;

    const inProgressCount = courierContracts.filter(
      (contract) => contract.status === "in_progress",
    ).length;

    const avgCompletionSeconds7d = getAvgCompletionSeconds(courierContracts);

    await Stats.findOneAndUpdate(
      {},
      {
        avgCompletionSeconds7d,
        inProgressCount,
        outstandingCount,
      },
      {
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );

    const contractIds = courierContracts.map(
      (contract) => contract.contract_id,
    );
    const existingContracts = await Contract.find({
      contractId: { $in: contractIds },
    });

    const writePlan: Array<{
      esiContract: EsiCorpContract;
      existingContract: (typeof existingContracts)[0] | undefined;
    }> = [];

    let newCompleted = 0;
    let newRevenue = 0;

    for (let i = 0; i < courierContracts.length; i++) {
      const esiContract: EsiCorpContract = courierContracts[i];
      const existingContract = existingContracts.find(
        (contract) => Number(contract.contractId) === esiContract.contract_id,
      );

      const isNewContract = !existingContract;
      const statusChanged =
        !isNewContract && esiContract.status !== existingContract.status;

      if (statusChanged && esiContract.status === "finished") {
        newCompleted++;
        newRevenue += esiContract.reward;
      }

      const threeDaysMs = 259200000;
      const isOverdue =
        Date.now() - new Date(esiContract.date_issued).getTime() > threeDaysMs;

      if (
        isNewContract ||
        statusChanged ||
        (isOverdue && !existingContract?.isOverdue)
      ) {
        writePlan.push({ esiContract, existingContract });
      }
    }

    await Stats.findOneAndUpdate(
      {},
      { $inc: { completedTotal: newCompleted, revenueLifetime: newRevenue } },
    );

    const locationIds: number[] = [];
    writePlan.forEach((contract) => {
      const startLocationId = contract.esiContract.start_location_id;
      const endLocationId = contract.esiContract.end_location_id;
      if (!locationIds.includes(startLocationId))
        locationIds.push(startLocationId);
      if (!locationIds.includes(endLocationId)) locationIds.push(endLocationId);
    });

    const structuresAndStations: (IStructure | IStation | null)[] = esiBudgetLow
      ? []
      : await Promise.all(
          locationIds.map((id) => getOrFetchStructure(id, token)),
        );

    const structureMap = new Map<number, IStructure | IStation | null>();
    locationIds.forEach((id, index) => {
      structureMap.set(id, structuresAndStations[index] ?? null);
    });

    for (const plan of writePlan) {
      const pickupStructure = structureMap.get(
        plan.esiContract.start_location_id,
      );
      const dropoffStructure = structureMap.get(
        plan.esiContract.end_location_id,
      );

      const threeDaysMs = 259200000;
      const isOverdue =
        Date.now() - new Date(plan.esiContract.date_issued).getTime() >
        threeDaysMs;

      const isRush = plan.esiContract.title.toLowerCase() === "rush";
      const validation: IContractValidation =
        !pickupStructure || !dropoffStructure
          ? {
              level: "fail",
              reasons: ["Unable to validate"],
              message: "Pickup or Dropoff locations are missing",
            }
          : await validateContract(
              [pickupStructure.systemName!, dropoffStructure.systemName!],
              plan.esiContract.volume,
              plan.esiContract.collateral,
              plan.esiContract.reward,
            );

      const issuerId = plan.esiContract.issuer_id;
      const issuerCorpId = plan.esiContract.issuer_corporation_id;
      const acceptorId = plan.esiContract.acceptor_id;

      const issuer: ICharacter | null = await getOrFetchCharacter(issuerId);
      if (issuer && issuer.corporationId !== issuerCorpId)
        await getOrFetchCharacter(issuer.characterId, true);

      const issuerCorp: ICorporation | null =
        await getOrFetchCorporation(issuerCorpId);

      let acceptor: ICharacter | ICorporation | null;
      if (acceptorId) {
        acceptor = await getOrFetchCharacter(acceptorId);
        if (!acceptor) acceptor = await getOrFetchCorporation(acceptorId);
      } else acceptor = null;

      const discordChannelType =
        pickupStructure?.systemName?.toLowerCase().includes("jita") ||
        dropoffStructure?.systemName?.toLowerCase().includes("jita")
          ? "jita"
          : "default";

      const updatedContract = await Contract.findOneAndUpdate(
        { contractId: plan.esiContract.contract_id },
        {
          contractId: plan.esiContract.contract_id,
          type: plan.esiContract.type,
          status: plan.esiContract.status,
          dateIssued: plan.esiContract.date_issued,
          dateExpired: plan.esiContract.date_expired,
          dateAccepted: plan.esiContract.date_accepted,
          dateCompleted: plan.esiContract.date_completed,
          title: plan.esiContract.title,
          volume: plan.esiContract.volume,
          reward: plan.esiContract.reward,
          collateral: plan.esiContract.collateral,
          price: plan.esiContract.price,
          buyout: plan.esiContract.buyout,
          issuerId: plan.esiContract.issuer_id,
          issuerCorporationId: plan.esiContract.issuer_corporation_id,
          assigneeId: plan.esiContract.assignee_id,
          acceptorId: plan.esiContract.acceptor_id,
          acceptedByName: acceptor ? acceptor.name : null,
          availability: plan.esiContract.availability,
          forCorporation: plan.esiContract.for_corporation,
          daysToComplete: plan.esiContract.days_to_complete,
          startLocationId: plan.esiContract.start_location_id,
          endLocationId: plan.esiContract.end_location_id,
          isRush,
          isOverdue,
          pickupStructure,
          dropoffStructure,
          validation,
          discordChannelType,
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );

      if (!plan.existingContract) {
        let newContract;
        try {
          newContract = await notifyNewContract(updatedContract);
        } catch (err) {
          console.log(
            "Something went wrong while sending the new contract notification: ",
            err,
          );
        }
        if (isOverdue && newContract) {
          try {
            await pingOverdue(
              newContract!.contractId,
              newContract!.discordMessageId,
              newContract!.discordChannelType,
            );
          } catch (err) {
            console.log(
              "Something went wrong while sending the overdue ping: ",
              err,
            );
          }
        }
      } else {
        if (
          plan.existingContract.status !== updatedContract.status ||
          (isOverdue && !plan.existingContract.isOverdue)
        ) {
          try {
            await notifyContractUpdate(updatedContract);
          } catch (err) {
            console.log(
              "Something went wrong while updating the discord notification: ",
              err,
            );
          }
        }
        if (
          !plan.existingContract.overduePingedAt &&
          isOverdue &&
          plan.esiContract.status === "outstanding"
        ) {
          try {
            await pingOverdue(
              plan.existingContract.contractId,
              plan.existingContract.discordMessageId,
              plan.existingContract.discordChannelType,
            );
          } catch (err) {
            console.log(
              "Something went wrong while sending the overdue ping: ",
              err,
            );
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    const existingItemExchangeContracts = await Contract.find({
      contractId: {
        $in: itemExchangeContracts.map((contract) => contract.contract_id),
      },
    });

    for (const esiContract of itemExchangeContracts) {
      const existingContract = existingItemExchangeContracts.find(
        (contract) => Number(contract.contractId) === esiContract.contract_id,
      );

      const isNewContract = !existingContract;
      const statusChanged =
        !isNewContract && esiContract.status !== existingContract.status;

      if (!isNewContract && !statusChanged) continue;

      const pickupStructure = esiBudgetLow
        ? null
        : await getOrFetchStructure(esiContract.start_location_id, token);

      const discordChannelType =
        pickupStructure?.systemName?.toLowerCase().includes("jita") ?? false
          ? "jita"
          : "default";

      let buybackQuoteId: string | null = null;
      let buybackDiscrepancy: IContractValidation | null = null;
      try {
        const match = await matchBuybackContract(
          esiContract,
          corporationId,
          token,
        );
        buybackQuoteId = match.buybackQuoteId;
        buybackDiscrepancy = match.buybackDiscrepancy;
      } catch (err) {
        console.log(
          "Something went wrong while matching a buyback contract: ",
          err,
        );
        buybackDiscrepancy = {
          level: "warning",
          reasons: ["match_error"],
          message: "Could not verify this contract against a stored quote",
        };
      }

      const issuerId = esiContract.issuer_id;
      const issuerCorpId = esiContract.issuer_corporation_id;
      const acceptorId = esiContract.acceptor_id;

      // Warms the character/corp caches used elsewhere in the app -
      // acceptedByName below is the only value from these used directly here.
      const issuer: ICharacter | null = await getOrFetchCharacter(issuerId);
      if (issuer && issuer.corporationId !== issuerCorpId)
        await getOrFetchCharacter(issuer.characterId, true);
      await getOrFetchCorporation(issuerCorpId);

      let acceptor: ICharacter | ICorporation | null;
      if (acceptorId) {
        acceptor = await getOrFetchCharacter(acceptorId);
        if (!acceptor) acceptor = await getOrFetchCorporation(acceptorId);
      } else acceptor = null;

      const updatedContract = await Contract.findOneAndUpdate(
        { contractId: esiContract.contract_id },
        {
          contractId: esiContract.contract_id,
          type: esiContract.type,
          status: esiContract.status,
          dateIssued: esiContract.date_issued,
          dateExpired: esiContract.date_expired,
          dateAccepted: esiContract.date_accepted,
          dateCompleted: esiContract.date_completed,
          title: esiContract.title,
          volume: esiContract.volume,
          price: esiContract.price,
          issuerId: esiContract.issuer_id,
          issuerCorporationId: esiContract.issuer_corporation_id,
          assigneeId: esiContract.assignee_id,
          acceptorId: esiContract.acceptor_id,
          acceptedByName: acceptor ? acceptor.name : null,
          availability: esiContract.availability,
          forCorporation: esiContract.for_corporation,
          startLocationId: esiContract.start_location_id,
          endLocationId: esiContract.end_location_id,
          pickupStructure,
          discordChannelType,
          buybackQuoteId,
          buybackDiscrepancy,
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );

      if (isNewContract) {
        try {
          await notifyNewBuybackContract(updatedContract);
        } catch (err) {
          console.log(
            "Something went wrong while sending the new buyback contract notification: ",
            err,
          );
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    const existingOutgoingContracts = await Contract.find({
      contractId: {
        $in: outgoingItemExchangeContracts.map((contract) => contract.contract_id),
      },
    });

    for (const esiContract of outgoingItemExchangeContracts) {
      const existingContract = existingOutgoingContracts.find(
        (contract) => Number(contract.contractId) === esiContract.contract_id,
      );

      const isNewContract = !existingContract;
      const statusChanged =
        !isNewContract && esiContract.status !== existingContract.status;

      if (!isNewContract && !statusChanged) continue;

      const pickupStructure = esiBudgetLow
        ? null
        : await getOrFetchStructure(esiContract.start_location_id, token);

      const discordChannelType =
        pickupStructure?.systemName?.toLowerCase().includes("jita") ?? false
          ? "jita"
          : "default";

      // Only re-match on first sighting or if a prior attempt never linked a
      // buy order - once linked, later status changes (finished/cancelled)
      // are handled below without re-parsing the title every time.
      let buyOrderId: string | null = existingContract?.buyOrderId ?? null;
      let buyOrderDiscrepancy: IContractValidation | null =
        existingContract?.buyOrderDiscrepancy ?? null;

      if (isNewContract || !buyOrderId) {
        try {
          const match = await matchBuyOrderContract(
            esiContract,
            corporationId,
            token,
          );
          buyOrderId = match.buyOrderId;
          buyOrderDiscrepancy = match.buyOrderDiscrepancy;
        } catch (err) {
          console.log(
            "Something went wrong while matching a buy order contract: ",
            err,
          );
          buyOrderDiscrepancy = {
            level: "warning",
            reasons: ["match_error"],
            message: "Could not verify this contract against a stored buy order",
          };
        }
      }

      const issuerId = esiContract.issuer_id;
      const issuerCorpId = esiContract.issuer_corporation_id;
      const acceptorId = esiContract.acceptor_id;

      const issuer: ICharacter | null = await getOrFetchCharacter(issuerId);
      if (issuer && issuer.corporationId !== issuerCorpId)
        await getOrFetchCharacter(issuer.characterId, true);
      await getOrFetchCorporation(issuerCorpId);

      let acceptor: ICharacter | ICorporation | null;
      if (acceptorId) {
        acceptor = await getOrFetchCharacter(acceptorId);
        if (!acceptor) acceptor = await getOrFetchCorporation(acceptorId);
      } else acceptor = null;

      await Contract.findOneAndUpdate(
        { contractId: esiContract.contract_id },
        {
          contractId: esiContract.contract_id,
          type: esiContract.type,
          status: esiContract.status,
          dateIssued: esiContract.date_issued,
          dateExpired: esiContract.date_expired,
          dateAccepted: esiContract.date_accepted,
          dateCompleted: esiContract.date_completed,
          title: esiContract.title,
          volume: esiContract.volume,
          price: esiContract.price,
          issuerId: esiContract.issuer_id,
          issuerCorporationId: esiContract.issuer_corporation_id,
          assigneeId: esiContract.assignee_id,
          acceptorId: esiContract.acceptor_id,
          acceptedByName: acceptor ? acceptor.name : null,
          availability: esiContract.availability,
          forCorporation: esiContract.for_corporation,
          startLocationId: esiContract.start_location_id,
          endLocationId: esiContract.end_location_id,
          pickupStructure,
          discordChannelType,
          buyOrderId,
          buyOrderDiscrepancy,
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );

      // A completed order's stock must never be released back to available
      // (see BuybackItem.quantityOnHand doc comment) - only cancellation-like
      // terminal states free the reservation.
      if (buyOrderId) {
        if (esiContract.status === "finished") {
          await BuyOrder.updateOne(
            { referenceId: buyOrderId, status: { $ne: "completed" } },
            { status: "completed", completedAt: new Date(), matchedContractId: esiContract.contract_id },
          );
        } else if (
          esiContract.status &&
          BUY_ORDER_RELEASE_STATUSES.includes(esiContract.status)
        ) {
          await BuyOrder.updateOne(
            { referenceId: buyOrderId, status: { $ne: "completed" } },
            { status: "cancelled" },
          );
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } catch (err) {
    console.error("syncContracts error:", err);
  } finally {
    syncRunning = false;
  }
}
