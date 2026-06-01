import {
  ChatInputCommandInteraction,
  Colors,
  EmbedBuilder,
  AutocompleteInteraction,
} from "discord.js";
import { getConfig } from "../../lib/config";
import { Route } from "../../models/Routes";
import { parseIskInput } from "../../utils/discord-utils";

const VALID_TYPES = ["normal", "rush"] as const;
type ContractType = (typeof VALID_TYPES)[number];

export async function handleFreightCalculator(
  interaction: ChatInputCommandInteraction,
) {
  const pickup = interaction.options.getString("pickup");
  const destination = interaction.options.getString("destination");
  const rawVolume = interaction.options.getNumber("volume");
  const collateralInput = interaction.options.getString("collateral");
  const contractType = interaction.options.getString("type");

  if (!pickup || !destination) {
    await interaction.reply({
      content: "Pickup and destination are required.",
      ephemeral: true,
    });
    return;
  }

  const route = await Route.findOne({
    systems: { $all: [pickup, destination] },
  });

  if (!route) {
    await interaction.reply({
      content: "That route is not currently supported.",
      ephemeral: true,
    });
    return;
  }

  if (
    typeof rawVolume !== "number" ||
    Number.isNaN(rawVolume) ||
    rawVolume <= 0
  ) {
    await interaction.reply({
      content: "Volume must be a valid number and greater than 0.",
      ephemeral: true,
    });
    return;
  }

  if (rawVolume > route.terms.maxVolume) {
    await interaction.reply({
      content: `Volume exceeds the maximum allowed for this route (${route.terms.maxVolume.toLocaleString()} m³).`,
      ephemeral: true,
    });
    return;
  }

  if (!collateralInput) {
    await interaction.reply({
      content: "Collateral is required.",
      ephemeral: true,
    });
    return;
  }

  const collateral = parseIskInput(collateralInput);

  if (collateral === null || collateral < 0) {
    await interaction.reply({
      content:
        "Collateral must be a valid ISK amount, e.g. 10b, 500m, 10000000000",
      ephemeral: true,
    });
    return;
  }

  const { maxCollateral } = getConfig();

  if (collateral > maxCollateral) {
    await interaction.reply({
      content: `Max collateral exceeded. Max collateral per contract is ${maxCollateral.toLocaleString()} ISK`,
      ephemeral: true,
    });
    return;
  }

  if (!isValidType(contractType)) {
    await interaction.reply({
      content: "Type must be either normal or rush.",
      ephemeral: true,
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

  await interaction.reply({
    embeds: [embed],
    ephemeral: true,
  });
}

function isValidType(value: string | null): value is ContractType {
  return VALID_TYPES.includes(value as ContractType);
}

export async function handleFreightAutocomplete(
  interaction: AutocompleteInteraction,
) {
  console.log(
    "interaction type:",
    interaction.type,
    "isAutocomplete:",
    interaction.isAutocomplete(),
  );
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
    console.log("total routes:", routes.length);
    console.log("pickup:", pickup);
    const allDestinations = routes.flatMap((route) => route.systems);

    const connections = pickup
      ? routes
          .filter((route) => route.systems.includes(pickup))
          .flatMap((route) => route.systems.filter((s) => s !== pickup))
      : allDestinations;

    console.log("connections:", connections);

    const choices = [...new Set(connections)]
      .filter((system) => system.toLowerCase().includes(focusedValue))
      .slice(0, 25)
      .map((system) => ({ name: system, value: system }));

    await interaction.respond(choices);
    return;
  }

  await interaction.respond([]);
}
