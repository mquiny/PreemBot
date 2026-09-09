// commands/admin/postembed.js
//
// Posts one or more rich embeds from an uploaded Discohook-style JSON
// export -- the same JSON you get from Discohook's "Export" or "Share
// Link" -> "Copy Editor Data" options. A file attachment is used rather
// than a text option since a real rules-page export (several embeds
// worth of fields/descriptions) easily blows past Discord's 6000-char
// limit for a single string option.
//
// Handles both export shapes Discohook produces:
//   - a single message:  { content, embeds: [...] }
//   - a full multi-message export: { messages: [ { data: { content, embeds } }, ... ] }
// and posts each message in sequence, in order, so a multi-embed rules
// page (one message per rule, matching how it originally looked)
// reposts exactly as it was.
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const axios = require('axios');
const logger = require('../../utils/logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('postembed')
    .setDescription('Post one or more embeds from a Discohook JSON export (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addAttachmentOption((option) =>
      option
        .setName('file')
        .setDescription('The exported .json file from Discohook')
        .setRequired(true)
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel to post in (defaults to this channel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const attachment = interaction.options.getAttachment('file', true);
    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

    if (!attachment.name || !attachment.name.toLowerCase().endsWith('.json')) {
      await interaction.editReply('That attachment needs to be a `.json` file.');
      return;
    }

    let raw;
    try {
      const res = await axios.get(attachment.url, { responseType: 'text', timeout: 10000 });
      raw = res.data;
    } catch (err) {
      logger.error(`[POSTEMBED] Failed to download attachment: ${err.message}`);
      await interaction.editReply('Could not download that attachment from Discord.');
      return;
    }

    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      await interaction.editReply(`That file isn't valid JSON: ${err.message}`);
      return;
    }

    const messagePayloads = Array.isArray(parsed.messages)
      ? parsed.messages.map((m) => m.data || m)
      : [parsed];

    let posted = 0;
    for (const payload of messagePayloads) {
      const sendData = {};
      if (payload.content) sendData.content = payload.content;
      if (Array.isArray(payload.embeds) && payload.embeds.length > 0) sendData.embeds = payload.embeds;

      if (!sendData.content && !sendData.embeds) continue; // nothing in this block to post

      try {
        await targetChannel.send(sendData);
        posted++;
      } catch (err) {
        logger.error(`[POSTEMBED] Failed sending message ${posted + 1}: ${err.message}`);
        await interaction.editReply(
          `Posted ${posted} message${posted !== 1 ? 's' : ''} before hitting an error on message ${posted + 1}: ${err.message}`
        );
        return;
      }

      // Small pacing gap between messages -- a rules page with several
      // embeds posting back-to-back with zero delay is more likely to
      // trip Discord's per-channel rate limit than posting one every
      // few hundred ms.
      if (messagePayloads.length > 1) await sleep(400);
    }

    if (posted === 0) {
      await interaction.editReply('That file parsed fine, but had no `content` or `embeds` to post.');
      return;
    }

    await interaction.editReply(`✅ Posted ${posted} message${posted !== 1 ? 's' : ''} to ${targetChannel}.`);
  }
};
