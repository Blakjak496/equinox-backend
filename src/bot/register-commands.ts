import { REST, Routes, SlashCommandBuilder } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;

async function main() {
  if (!applicationId) {
    throw new Error("Missing DISCORD_APPLICATION_ID");
  }

  if (!guildId) {
    throw new Error("Missing DISCORD_GUILD_ID");
  }

  if (!botToken) {
    throw new Error("Missing DISCORD_BOT_TOKEN");
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("freight_calculator")
      .setDescription("Calculate a hauling quote")
      .addStringOption((option) =>
        option
          .setName("pickup")
          .setDescription("Pickup system")
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName("destination")
          .setDescription("Destination system")
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addNumberOption((option) =>
        option
          .setName("volume")
          .setDescription("Volume in m3")
          .setRequired(true)
          .setMinValue(0.0001),
      )
      .addStringOption((option) =>
        option
          .setName("collateral")
          .setDescription("Collateral in ISK (e.g 10b or 10000000000)")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("type")
          .setDescription("Contract type")
          .setRequired(true)
          .addChoices(
            { name: "normal", value: "normal" },
            { name: "rush", value: "rush" },
          ),
      )
      .addStringOption((option) =>
        option
          .setName("code")
          .setDescription("Discount code")
          .setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("appraisal")
      .setDescription("Appraise items via Janice"),
    // new SlashCommandBuilder()
    //   .setName("register")
    //   .setDescription("Register your EVE character with the bot"),
    // new SlashCommandBuilder()
    //   .setName("shopping_service")
    //   .setDescription("Create a shopping service order"),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(botToken);

  const body = (await rest.put(
    Routes.applicationGuildCommands(applicationId, guildId),
    { body: commands },
  )) as Array<{ name: string }>;

  console.log(
    "Registered commands:",
    body.map((command) => command.name).join(", "),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
