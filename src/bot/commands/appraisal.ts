import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  Colors,
  EmbedBuilder,
  ModalActionRowComponentBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  buildJaniceUrl,
  runJaniceAppraisal,
} from "../../services/janiceAppraisal";

export async function openAppraisalModal(
  interaction: ChatInputCommandInteraction,
) {
  const modal = new ModalBuilder()
    .setCustomId("appraisal_modal")
    .setTitle("Janice Appraisal");

  const itemsInput = new TextInputBuilder()
    .setCustomId("items")
    .setLabel("Paste items to appraise")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(1)
    .setMaxLength(4000)
    .setPlaceholder(
      "Paste your item list here.\n\nExample:\nTritanium 10000\nPlex 1",
    )
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
      itemsInput,
    ),
  );

  await interaction.showModal(modal);
}

export async function handleAppraisalModalSubmit(
  interaction: ModalSubmitInteraction,
) {
  const items = interaction.fields.getTextInputValue("items")?.trim();

  if (!items) {
    await interaction.reply({
      content: "No items were provided.",
      ephemeral: true,
    });
    return;
  }

  try {
    const appraisal = await runJaniceAppraisal(items);
    const sellPrice = appraisal.effectivePrices.totalSellPrice;
    const volume = appraisal.totalPackagedVolume;
    const reference = appraisal.code;
    const janiceUrl = buildJaniceUrl(reference);

    const embed = new EmbedBuilder()
      .setTitle("Janice Appraisal")
      .setColor(Colors.Orange)
      .addFields(
        {
          name: "Sell Price",
          value: `${Math.round(sellPrice).toLocaleString()} ISK`,
          inline: true,
        },
        {
          name: "Volume",
          value: `${volume.toLocaleString()} m³`,
          inline: true,
        },
        {
          name: "Reference",
          value: reference,
          inline: true,
        },
        {
          name: "View Appraisal",
          value: `[Open in Janice](${janiceUrl})`,
          inline: false,
        },
      )
      .setFooter({
        text: "Collateral should use sell price",
      });

    await interaction.reply({
      embeds: [embed],
      ephemeral: true,
    });
  } catch (error) {
    console.error("Appraisal failed:", error);

    await interaction.reply({
      content: "Appraisal failed.",
      ephemeral: true,
    });
  }
}
