import {
  ChatInputCommandInteraction,
  Colors,
  EmbedBuilder,
  AutocompleteInteraction,
  MessageFlags,
} from "discord.js";
import { getConfig } from "../../lib/config";
import { Route } from "../../models/Routes";
import { parseIskInput } from "../../utils/discord-utils";

const VALID_TYPES = ["normal", "rush"] as const;
type ContractType = (typeof VALID_TYPES)[number];

export async function handleFreightCalculator(
  interaction: ChatInputCommandInteraction,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const pickup = interaction.options.getString("pickup");
  const destination = interaction.options.getString("destination");
  const rawVolume = interaction.options.getNumber("volume");
  const collateralInput = interaction.options.getString("collateral");
  const contractType = interaction.options.getString("type");

  if (!pickup || !destination) {
    await interaction.editReply({
      content: "Pickup and destination are required.",
    });
    return;
  }

  const route = await Route.findOne({
    systems: { $all: [pickup, destination] },
  });

  if (!route) {
    await interaction.editReply({
      content: "That route is not currently supported.",
    });
    return;
  }

  if (
    typeof rawVolume !== "number" ||
    Number.isNaN(rawVolume) ||
    rawVolume <= 0
  ) {
    await interaction.editReply({
      content: "Volume must be a valid number and greater than 0.",
    });
    return;
  }

  if (rawVolume > route.terms.maxVolume) {
    await interaction.editReply({
      content: `Volume exceeds the maximum allowed for this route (${route.terms.maxVolume.toLocaleString()} m³).`,
    });
    return;
  }

  if (!collateralInput) {
    await interaction.editReply({
      content: "Collateral is required.",
    });
    return;
  }

  const collateral = parseIskInput(collateralInput);

  if (collateral === null || collateral < 0) {
    await interaction.editReply({
      content:
        "Collateral must be a valid ISK amount, e.g. 10b, 500m, 10000000000",
    });
    return;
  }

  const { maxCollateral } = getConfig();

  if (collateral > maxCollateral) {
    await interaction.editReply({
      content: `Max collateral exceeded. Max collateral per contract is ${maxCollateral.toLocaleString()} ISK`,
    });
    return;
  }

  if (!isValidType(contractType)) {
    await interaction.editReply({
      content: "Type must be either normal or rush.",
    });
    return;
  }

  const volume = Math.ceil(rawVolume);
  const rush = contractType === "rush";

  const routeLabel = `${pickup} → ${destination}`;
  const expiration = "2 weeks";
  const daysToComplete = "7 days";

  let collateralFee = collateral * (route.terms.collateralFeePercent / 100);
  collateralFee = Math.ceil((collateralFee + Number.EPSILON) * 100) / 100;

  const rushFee = rush ? route.terms.rushPrice : 0;
  const rateTotal = route.terms.rate * volume;
  const baseReward = Math.max(rateTotal + collateralFee, route.terms.minReward);
  const total = baseReward + rushFee;

  const rewardBreakdown = [
    `Rate\n${route.terms.rate.toLocaleString()} ISK/m³ x ${volume.toLocaleString()} = ${rateTotal.toLocaleString()}`,
    `Min.Reward\n${route.terms.minReward.toLocaleString()} ISK`,
    `Collateral Fee\n${collateralFee.toLocaleString()} ISK (${route.terms.collateralFeePercent}%)`,
    `Rush fee\n${rush ? `${rushFee.toLocaleString()} ISK` : "N/A"}`,
    `**Total**\n${total.toLocaleString()} ISK`,
  ].join("\n\n");

  const dateNow = new Date();
  const timeLabel = `${String(dateNow.getHours()).padStart(2, "0")}:${String(dateNow.getMinutes()).padStart(2, "0")}`;

  const embed = new EmbedBuilder()
    .setTitle("Freight Calculator")
    .setDescription(routeLabel)
    .setColor(Colors.Orange)
    .addFields(
      {
        name: "Important",
        value: "• No containers.\n• No fitted ships.",
        inline: false,
      },
      {
        name: "Courier to",
        value: "Equinox Galactic",
        inline: false,
      },
      { name: "Route", value: routeLabel, inline: true },
      { name: "Volume", value: `${volume.toLocaleString()} m³`, inline: true },
      {
        name: "Collateral",
        value: `${collateral.toLocaleString()} ISK`,
        inline: true,
      },
      { name: "Expiration", value: expiration, inline: true },
      { name: "Days to complete", value: daysToComplete, inline: true },
      { name: "Type", value: contractType, inline: true },
      {
        name: "Contract Description",
        value: rush ? "Rush" : "N/A",
        inline: false,
      },
      { name: "Reward", value: rewardBreakdown, inline: true },
    )
    .setFooter({ text: `Equinox Galactic - ${timeLabel}` });

  await interaction.editReply({
    embeds: [embed],
  });
}

function isValidType(value: string | null): value is ContractType {
  return VALID_TYPES.includes(value as ContractType);
}

export async function handleFreightAutocomplete(
  interaction: AutocompleteInteraction,
) {
  const focused = interaction.options.getFocused(true);
  const pickup = interaction.options.getString("pickup");
  const focusedValue = String(focused.value ?? "").toLowerCase();

  if (focused.name === "pickup") {
    const routes = await Route.find({});
    const systems = [...new Set(routes.flatMap((route) => route.systems))]
      .filter((system) => system.toLowerCase().includes(focusedValue))
      .slice(0, 25)
      .map((system) => ({ name: system, value: system }));

    await interaction.respond(systems);
    return;
  }

  if (focused.name === "destination") {
    const routes = await Route.find({});
    const allDestinations = routes.flatMap((route) => route.systems);

    const connections = pickup
      ? routes
          .filter((route) => route.systems.includes(pickup))
          .flatMap((route) => route.systems.filter((s) => s !== pickup))
      : allDestinations;

    const choices = [...new Set(connections)]
      .filter((system) => system.toLowerCase().includes(focusedValue))
      .slice(0, 25)
      .map((system) => ({ name: system, value: system }));

    await interaction.respond(choices);
    return;
  }

  await interaction.respond([]);
}
