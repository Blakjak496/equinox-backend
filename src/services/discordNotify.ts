import { Contract, IContract } from "../models/Contract";
import { BuyOrder, IBuyOrder } from "../models/BuyOrder";

export async function notifyNewContract(
  contract: IContract,
): Promise<IContract | null> {
  const data = {
    contractId: contract.contractId,
    discordMessageId: contract.discordMessageId,
    discordChannelType: contract.discordChannelType,
    isOverdue: contract.isOverdue,
    overduePingedAt: contract.overduePingedAt,
    pickupLocation: contract.pickupStructure?.name ?? null,
    dropoffLocation: contract.dropoffStructure?.name ?? null,
    volume: contract.volume,
    collateral: contract.collateral,
    reward: contract.reward,
    status: contract.status,
    acceptedByName: contract.acceptedByName,
    isRush: contract.isRush,
  };

  const res = await fetch(
    `http://localhost:${process.env.BOT_PORT}/notify/contract`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    },
  );

  const text = await res.text();
  console.log("bot response body:", text);
  const json = JSON.parse(text) as { ok: boolean; messageId: string };

  if (!json.ok) throw new Error("Failed to ping new contract");

  const updatedContract = await Contract.findOneAndUpdate(
    { contractId: contract.contractId },
    { discordMessageId: json.messageId },
    { new: true },
  );

  return updatedContract;
}

export async function notifyContractUpdate(contract: IContract) {
  const data = {
    contractId: contract.contractId,
    discordMessageId: contract.discordMessageId,
    discordChannelType: contract.discordChannelType,
    isOverdue: contract.isOverdue,
    overduePingedAt: contract.overduePingedAt,
    pickupLocation: contract.pickupStructure?.name ?? null,
    dropoffLocation: contract.dropoffStructure?.name ?? null,
    volume: contract.volume,
    collateral: contract.collateral,
    reward: contract.reward,
    status: contract.status,
    acceptedByName: contract.acceptedByName,
    isRush: contract.isRush,
  };

  const res = await fetch(
    `http://localhost:${process.env.BOT_PORT}/notify/contract`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    },
  );

  const json = (await res.json()) as { ok: boolean };

  if (!json.ok) throw new Error("Failed to update discord message");
}

export async function notifyNewBuybackContract(
  contract: IContract,
): Promise<IContract | null> {
  const data = {
    contractId: contract.contractId,
    price: contract.price ?? 0,
    status: contract.status,
    pickupLocation: contract.pickupStructure?.name ?? null,
    acceptedByName: contract.acceptedByName,
    buybackQuoteId: contract.buybackQuoteId,
    buybackDiscrepancy: contract.buybackDiscrepancy,
  };

  const res = await fetch(
    `http://localhost:${process.env.BOT_PORT}/notify/buyback-contract`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );

  const text = await res.text();
  const json = JSON.parse(text) as { ok: boolean; messageId: string };

  if (!json.ok) throw new Error("Failed to ping new buyback contract");

  return Contract.findOneAndUpdate(
    { contractId: contract.contractId },
    { discordMessageId: json.messageId },
    { new: true },
  );
}

// Fires on every status transition after creation (contract accepted,
// completed, etc.) to edit the buyback contract's original Discord message
// in place - mirrors notifyContractUpdate above and notifyBuyOrderUpdate
// below. Without this, notifyNewBuybackContract only ever fires once (on
// first sync, while the contract is still "outstanding"), so the message
// would otherwise be permanently stuck showing that first-seen state.
export async function notifyBuybackContractUpdate(
  contract: IContract,
): Promise<void> {
  if (!contract.discordMessageId) {
    console.warn(
      `[discordNotify] buyback contract ${contract.contractId} has no discordMessageId - skipping status update ping`,
    );
    return;
  }

  const data = {
    contractId: contract.contractId,
    discordMessageId: contract.discordMessageId,
    price: contract.price ?? 0,
    status: contract.status,
    pickupLocation: contract.pickupStructure?.name ?? null,
    acceptedByName: contract.acceptedByName,
    buybackQuoteId: contract.buybackQuoteId,
    buybackDiscrepancy: contract.buybackDiscrepancy,
  };

  const res = await fetch(
    `http://localhost:${process.env.BOT_PORT}/notify/buyback-contract`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );

  const json = (await res.json()) as { ok: boolean };

  if (!json.ok) throw new Error("Failed to update buyback contract Discord message");
}

// Fires right after a BuyOrder is created (order-submission time, not
// contract-match time). Persists the resulting discordMessageId so later
// status transitions (contract matched/completed/cancelled, handled by
// notifyBuyOrderUpdate below) can edit this same message instead of it
// staying stuck looking like a brand new order forever.
export async function notifyNewBuyOrder(
  buyOrder: IBuyOrder,
): Promise<IBuyOrder | null> {
  const data = {
    referenceId: buyOrder.referenceId,
    customerCharacterName: buyOrder.customerCharacterName,
    items: buyOrder.items,
    totalPrice: buyOrder.totalPrice,
    status: buyOrder.status,
    matchedContractId: buyOrder.matchedContractId,
  };

  const res = await fetch(
    `http://localhost:${process.env.BOT_PORT}/notify/buy-order`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );

  const text = await res.text();
  const json = JSON.parse(text) as { ok: boolean; messageId: string };

  if (!json.ok) throw new Error("Failed to ping new buy order");

  return BuyOrder.findOneAndUpdate(
    { referenceId: buyOrder.referenceId },
    { discordMessageId: json.messageId },
    { new: true },
  );
}

// Fires on every status transition after creation (contract matched,
// completed, cancelled - including a manual admin override) to edit the
// order's original Discord message in place, so it always reflects current
// state instead of only ever showing "new order".
export async function notifyBuyOrderUpdate(buyOrder: IBuyOrder): Promise<void> {
  if (!buyOrder.discordMessageId) {
    console.warn(
      `[discordNotify] buy order ${buyOrder.referenceId} has no discordMessageId - skipping status update ping`,
    );
    return;
  }

  const data = {
    referenceId: buyOrder.referenceId,
    discordMessageId: buyOrder.discordMessageId,
    customerCharacterName: buyOrder.customerCharacterName,
    items: buyOrder.items,
    totalPrice: buyOrder.totalPrice,
    status: buyOrder.status,
    matchedContractId: buyOrder.matchedContractId,
  };

  const res = await fetch(
    `http://localhost:${process.env.BOT_PORT}/notify/buy-order`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );

  const json = (await res.json()) as { ok: boolean };

  if (!json.ok) throw new Error("Failed to update buy order Discord message");
}

export async function pingOverdue(
  contractId: number,
  discordMessageId: string | null,
  discordChannelType: "jita" | "default" | null,
) {
  if (!discordMessageId || !discordChannelType)
    throw new Error(
      "Missing message ID or channel type - unable to ping overdue",
    );
  const res = await fetch(
    `http://localhost:${process.env.BOT_PORT}/notify/contract/ping`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ discordMessageId, discordChannelType }),
    },
  );

  const json = (await res.json()) as { ok: boolean };

  if (json.ok) {
    await Contract.findOneAndUpdate(
      { contractId },
      { overduePingedAt: new Date() },
      {},
    );
  } else {
    throw new Error("Failed to ping overdue contract");
  }
}
