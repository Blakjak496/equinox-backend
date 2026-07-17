const embedColors = {
  red: 0xed4245,
  green: 0x2ecc71,
  blue: 0x3498db,
  purple: 0x9b59b6,
  yellow: 0xf4900c,
  grey: 0x747f8d,
};

function getEmbedColor(
  isOverdue: boolean,
  status:
    | "outstanding"
    | "in_progress"
    | "finished_issuer"
    | "finished_contractor"
    | "finished"
    | "cancelled"
    | "rejected"
    | "failed"
    | "deleted"
    | "reversed"
    | null,
  isRush: boolean,
) {
  if (
    status === "finished" ||
    status === "finished_contractor" ||
    status === "finished_issuer"
  )
    return embedColors.green;
  if (status === "deleted" || status === "cancelled") return embedColors.grey;
  if (isOverdue) return embedColors.red;
  if (status === "in_progress") return embedColors.blue;
  if (isRush) return embedColors.purple;
  return embedColors.yellow;
}

export function buildContractNotificationPayload(
  contractId: number,
  discordMessageId: string | null,
  discordChannelType: "default" | "jita",
  isOverdue: boolean,
  overduePingedAt: Date | null,
  pickupLocation: string,
  dropoffLocation: string,
  volume: number,
  collateral: number,
  reward: number,
  status:
    | "outstanding"
    | "in_progress"
    | "finished_issuer"
    | "finished_contractor"
    | "finished"
    | "cancelled"
    | "rejected"
    | "failed"
    | "deleted"
    | "reversed"
    | null,
  acceptedByName: string,
  isRush: boolean,
  mentionRole?: "equinox" | "hauler" | null,
) {
  let roleId = null;
  if (mentionRole === "equinox") roleId = process.env.DISCORD_EQUINOX_ROLE_ID;
  if (mentionRole === "hauler") roleId = process.env.DISCORD_HAULER_ROLE_ID;
  return {
    content: mentionRole ? `<@&${roleId}>` : undefined,
    allowedMentions: mentionRole && roleId ? { roles: [roleId] } : undefined,
    embeds: [
      {
        title: "📦 Hauling Contract",
        color: getEmbedColor(isOverdue, status, isRush),
        fields: [
          {
            name: "Route",
            value: `${pickupLocation} → ${dropoffLocation}`,
            inline: false,
          },
          {
            name: "Volume",
            value: `${volume} m³`,
            inline: true,
          },
          {
            name: "Collateral",
            value: `${collateral} ISK`,
            inline: true,
          },
          {
            name: "Reward",
            value: `${reward} ISK`,
            inline: true,
          },
          {
            name: "Status",
            value: status || "Unknown",
            inline: true,
          },
          {
            name: "Accepted By",
            value: acceptedByName || "Unassigned",
            inline: true,
          },
          {
            name: "Rush",
            value: isRush ? "🚀 Yes" : "No",
            inline: true,
          },
        ],
        footer: {
          text: `Contract ID: ${contractId}`,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export function buildBuybackContractNotificationPayload(
  contractId: number,
  price: number,
  status: string | null,
  pickupLocation: string | null,
  acceptedByName: string,
  buybackQuoteId: string | null,
  buybackDiscrepancy: { level: string | null; reasons: string[] } | null,
) {
  const level = buybackDiscrepancy?.level ?? null;
  const color =
    level === "ok"
      ? embedColors.green
      : level === "fail"
        ? embedColors.red
        : level === "warning"
          ? embedColors.yellow
          : embedColors.grey;

  return {
    embeds: [
      {
        title: "💰 Buyback Contract",
        color,
        fields: [
          {
            name: "Reference",
            value: buybackQuoteId ?? "None found in title",
            inline: false,
          },
          {
            name: "Location",
            value: pickupLocation ?? "Unknown",
            inline: true,
          },
          {
            name: "Price",
            value: `${price.toLocaleString()} ISK`,
            inline: true,
          },
          {
            name: "Status",
            value: status || "Unknown",
            inline: true,
          },
          {
            name: "Match",
            value:
              level === "ok"
                ? "✅ Matches quote"
                : level
                  ? `⚠️ ${buybackDiscrepancy?.reasons.join(", ") || "Discrepancy"}`
                  : "—",
            inline: true,
          },
          {
            name: "Accepted By",
            value: acceptedByName || "Unassigned",
            inline: true,
          },
        ],
        footer: {
          text: `Contract ID: ${contractId}`,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// Fires at order-creation time, not contract-match time - unlike the
// buyback notification above, there's no contract yet. This is the ping
// telling the admin to go create one, titled with referenceId.
const BUY_ORDER_STATUS_DISPLAY: Record<
  "pending_contract" | "contract_created" | "completed" | "cancelled",
  { title: string; color: number; label: string; footer: string }
> = {
  pending_contract: {
    title: "🛒 New Purchase Stock Order",
    color: embedColors.blue,
    label: "Awaiting contract",
    footer:
      "Create an item_exchange contract to this character with the reference ID in the title",
  },
  contract_created: {
    title: "📦 Purchase Order - Contract Created",
    color: embedColors.yellow,
    label: "Contract created",
    footer: "Awaiting the buyer to accept the contract",
  },
  completed: {
    title: "✅ Purchase Order Completed",
    color: embedColors.green,
    label: "Completed",
    footer: "Contract accepted - order fulfilled",
  },
  cancelled: {
    title: "❌ Purchase Order Cancelled",
    color: embedColors.grey,
    label: "Cancelled",
    footer: "This order's stock reservation has been released",
  },
};

export function buildBuyOrderNotificationPayload(
  referenceId: string,
  customerCharacterName: string,
  items: { name: string; quantity: number; unitPrice: number }[],
  totalPrice: number,
  status: "pending_contract" | "contract_created" | "completed" | "cancelled",
  matchedContractId: number | null,
) {
  const display = BUY_ORDER_STATUS_DISPLAY[status];

  return {
    embeds: [
      {
        title: display.title,
        color: display.color,
        fields: [
          {
            name: "Reference",
            value: referenceId,
            inline: false,
          },
          {
            name: "Character",
            value: customerCharacterName,
            inline: true,
          },
          {
            name: "Total Price",
            value: `${totalPrice.toLocaleString()} ISK`,
            inline: true,
          },
          {
            name: "Status",
            value: display.label,
            inline: true,
          },
          ...(matchedContractId
            ? [
                {
                  name: "Matched Contract",
                  value: String(matchedContractId),
                  inline: true,
                },
              ]
            : []),
          {
            name: "Items",
            value: items
              .map((item) => `${item.quantity}x ${item.name}`)
              .join("\n"),
            inline: false,
          },
        ],
        footer: {
          text: display.footer,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export const parseIskInput = (input: string): number | null => {
  const value = input.trim().toLowerCase();

  const match = value.match(/^(\d+(?:\.\d+)?)([kmbt])?$/);
  if (!match) return null;

  const amount = Number(match[1]);
  const suffix = match[2];

  if (!Number.isFinite(amount)) return null;

  const multipliers: Record<string, number> = {
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000,
    t: 1_000_000_000_000,
  };

  const multiplier = suffix ? multipliers[suffix] : 1;
  const result = amount * multiplier;

  if (!Number.isFinite(result)) return null;

  return Math.round(result);
};
