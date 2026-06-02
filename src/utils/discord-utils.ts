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
  if (isOverdue) return embedColors.red;
  if (
    status === "finished" ||
    status === "finished_contractor" ||
    status === "finished_issuer"
  )
    return embedColors.green;
  if (status === "in_progress") return embedColors.blue;
  if (status === "deleted") return embedColors.grey;
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
    content: mentionRole ? `<@${roleId}>` : undefined,
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
