import express from "express";
import dotenv from "dotenv";
import { initConfig } from "../lib/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  TextChannel,
} from "discord.js";
import { connectDB } from "../lib/db";
import {
  buildContractNotificationPayload,
  buildBuybackContractNotificationPayload,
  buildBuyOrderNotificationPayload,
} from "../utils/discord-utils";
import {
  handleAppraisalModalSubmit,
  openAppraisalModal,
} from "./commands/appraisal";
import {
  handleFreightAutocomplete,
  handleFreightCalculator,
} from "./commands/freightCalculator";

dotenv.config();

const app = express();
const PORT = process.env.BOT_PORT || 8080;
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const equinoxRoleId = process.env.DISCORD_EQUINOX_ROLE_ID;
const haulerRoleId = process.env.DISCORD_HAULER_ROLE_ID;

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

async function start() {
  await connectDB();
  await initConfig();
  await client.login(TOKEN);

  app.listen(PORT, () => {
    console.log(`Bot listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Equinox bot logged in as ${readyClient.user.tag}`);
});

app.post("/notify/contract", async (req, res) => {
  const contractData = { ...req.body };
  const discordChannelId =
    contractData.discordChannelType === "jita"
      ? process.env.DISCORD_JITA_CHANNEL_ID
      : process.env.DISCORD_DEFAULT_CONTRACTS_CHANNEL_ID;

  if (!discordChannelId)
    throw new Error("Unable to get discord channel ID to send notification");

  const channel = (await client.channels.fetch(
    discordChannelId!,
  )) as TextChannel;

  const payload = buildContractNotificationPayload(
    contractData.contractId,
    contractData.discordMessageId,
    contractData.discordChannelType,
    contractData.isOverdue,
    contractData.overduePingedAt,
    contractData.pickupLocation,
    contractData.dropoffLocation,
    contractData.volume,
    contractData.collateral,
    contractData.reward,
    contractData.status,
    contractData.acceptedByName,
    contractData.isRush,
    contractData.isRush ? "hauler" : null,
  );

  const message = await channel.send({
    content: payload.content,
    allowedMentions: payload.allowedMentions,
    embeds: payload.embeds,
  });

  res.json({ ok: true, messageId: message.id });
});

app.patch("/notify/contract", async (req, res) => {
  const contractData = { ...req.body };
  const discordChannelId =
    contractData.discordChannelType === "jita"
      ? process.env.DISCORD_JITA_CHANNEL_ID
      : process.env.DISCORD_DEFAULT_CONTRACTS_CHANNEL_ID;

  if (!discordChannelId)
    throw new Error("Unable to get discord channel ID to send notification");

  const channel = (await client.channels.fetch(
    discordChannelId!,
  )) as TextChannel;

  const message = await channel.messages.fetch(contractData.discordMessageId);

  const payload = buildContractNotificationPayload(
    contractData.contractId,
    contractData.discordMessageId,
    contractData.discordChannelType,
    contractData.isOverdue,
    contractData.overduePingedAt,
    contractData.pickupLocation,
    contractData.dropoffLocation,
    contractData.volume,
    contractData.collateral,
    contractData.reward,
    contractData.status,
    contractData.acceptedByName,
    contractData.isRush,
    contractData.isRush ? "hauler" : null,
  );

  await message.edit({
    content: payload.content,
    allowedMentions: payload.allowedMentions,
    embeds: payload.embeds,
  });

  res.json({ ok: true });
});

app.post("/notify/buyback-contract", async (req, res) => {
  const data = { ...req.body };
  const discordChannelId = process.env.DISCORD_BUYBACK_CHANNEL_ID;

  if (!discordChannelId)
    throw new Error(
      "DISCORD_BUYBACK_CHANNEL_ID not set - unable to send buyback contract notification",
    );

  const channel = (await client.channels.fetch(
    discordChannelId,
  )) as TextChannel;

  const payload = buildBuybackContractNotificationPayload(
    data.contractId,
    data.price,
    data.status,
    data.pickupLocation,
    data.acceptedByName,
    data.buybackQuoteId,
    data.buybackDiscrepancy,
  );

  const message = await channel.send({ embeds: payload.embeds });

  res.json({ ok: true, messageId: message.id });
});

app.patch("/notify/buyback-contract", async (req, res) => {
  const data = { ...req.body };
  const discordChannelId = process.env.DISCORD_BUYBACK_CHANNEL_ID;

  if (!discordChannelId)
    throw new Error(
      "DISCORD_BUYBACK_CHANNEL_ID not set - unable to update buyback contract notification",
    );

  const channel = (await client.channels.fetch(
    discordChannelId,
  )) as TextChannel;

  const message = await channel.messages.fetch(data.discordMessageId);

  const payload = buildBuybackContractNotificationPayload(
    data.contractId,
    data.price,
    data.status,
    data.pickupLocation,
    data.acceptedByName,
    data.buybackQuoteId,
    data.buybackDiscrepancy,
  );

  await message.edit({ embeds: payload.embeds });

  res.json({ ok: true });
});

app.post("/notify/buy-order", async (req, res) => {
  const data = { ...req.body };
  const discordChannelId = process.env.DISCORD_PURCHASE_CHANNEL_ID;

  if (!discordChannelId)
    throw new Error(
      "DISCORD_PURCHASE_CHANNEL_ID not set - unable to send purchase order notification",
    );

  const channel = (await client.channels.fetch(
    discordChannelId,
  )) as TextChannel;

  const payload = buildBuyOrderNotificationPayload(
    data.referenceId,
    data.customerCharacterName,
    data.items,
    data.totalPrice,
    data.status,
    data.matchedContractId,
  );

  const message = await channel.send({ embeds: payload.embeds });

  res.json({ ok: true, messageId: message.id });
});

app.patch("/notify/buy-order", async (req, res) => {
  const data = { ...req.body };
  const discordChannelId = process.env.DISCORD_PURCHASE_CHANNEL_ID;

  if (!discordChannelId)
    throw new Error(
      "DISCORD_PURCHASE_CHANNEL_ID not set - unable to send purchase order notification",
    );

  const channel = (await client.channels.fetch(
    discordChannelId,
  )) as TextChannel;

  const message = await channel.messages.fetch(data.discordMessageId);

  const payload = buildBuyOrderNotificationPayload(
    data.referenceId,
    data.customerCharacterName,
    data.items,
    data.totalPrice,
    data.status,
    data.matchedContractId,
  );

  await message.edit({ embeds: payload.embeds });

  res.json({ ok: true });
});

app.post("/notify/contract/ping", async (req, res) => {
  if (!equinoxRoleId || !haulerRoleId)
    throw new Error("One or more role IDs not set");

  const data = { ...req.body };
  const discordChannelId =
    data.discordChannelType === "jita"
      ? process.env.DISCORD_JITA_CHANNEL_ID
      : process.env.DISCORD_DEFAULT_CONTRACTS_CHANNEL_ID;

  if (!discordChannelId)
    throw new Error("Unable to get discord channel ID to send notification");

  const channel = (await client.channels.fetch(
    discordChannelId,
  )) as TextChannel;

  const message = await channel.messages.fetch(data.discordMessageId);

  await message.reply({
    content: `${equinoxRoleId ? "<@&" + equinoxRoleId + ">" : ""} ${haulerRoleId ? "<@&" + haulerRoleId + ">" : ""}`,
    allowedMentions: { roles: [equinoxRoleId, haulerRoleId] },
  });

  res.json({ ok: true });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "appraisal") {
      await openAppraisalModal(interaction);
      return;
    }
    if (interaction.commandName === "freight_calculator") {
      await handleFreightCalculator(interaction);
      return;
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === "appraisal_modal") {
      await handleAppraisalModalSubmit(interaction);
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    if (interaction.commandName === "freight_calculator") {
      await handleFreightAutocomplete(interaction);
    }
    return;
  }
});
