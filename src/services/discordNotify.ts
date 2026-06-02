import { Contract, IContract } from "../models/Contract";

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
