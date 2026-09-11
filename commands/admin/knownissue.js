// commands/admin/knownissue.js
//
// /known-issue sent-to-site <message_id> [channel] -- pulls a message
// (posted in a "Known Issues" channel, or wherever staff track these) and
// pushes it to the website's Known Issues page as an open issue.
//
// /known-issue resolved <message_id> -- marks a previously-sent issue as
// resolved. The site moves it from the Open section into the Resolved
// archive. Requires the issue to have actually been sent via
// sent-to-site first (looked up in data/knownIssues.json) so a typo'd
// message ID fails loudly instead of silently doing nothing.
//
// Both push to the site via a repository_dispatch event (see
// utils/siteKnownIssuesDispatcher.js) -- same mechanism the
// changelog/showcase/StreetCred bot features already use.
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const logger = require('../../utils/logger');
const knownIssuesState = require('../../utils/knownIssuesState');
const { dispatchKnownIssueToSite } = require('../../utils/siteKnownIssuesDispatcher');

// Strips Discord-specific markup that wouldn't mean anything on the
// website (raw mention/emoji syntax) down to plain, readable text.
function sanitizeContent(content) {
  return content
    .replace(/<a?:(\w+):\d+>/g, ':$1:')   // custom emoji -> :name:
    .replace(/<@!?\d+>/g, '@user')         // user mentions
    .replace(/<@&\d+>/g, '@role')          // role mentions
    .replace(/<#\d+>/g, '#channel')        // channel mentions
    .trim();
}

// First line (stripped of markdown bold/italics) becomes the title;
// everything after becomes the body. A single-line message just reuses
// a truncated version of itself as the title with the full line as the
// body too, so there's always something to show either way.
function splitTitleAndBody(content) {
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  if (lines.length === 0) return { title: 'Untitled issue', body: '' };

  const rawTitle = lines[0].replace(/[*_`~]/g, '').trim();
  const title = rawTitle.length > 100 ? `${rawTitle.slice(0, 97)}...` : rawTitle;
  const body = lines.slice(1).join('\n').trim() || content.trim();

  return { title, body };
}

async function resolveMessage(interaction) {
  const messageId = interaction.options.getString('message_id', true).trim();
  const channel = interaction.options.getChannel('channel') || interaction.channel;

  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) {
    await interaction.editReply(`Couldn't find a message with ID \`${messageId}\` in ${channel}. If it's in a different channel, pass the \`channel\` option.`);
    return null;
  }
  return { message, channel };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('known-issue')
    .setDescription('Manage Known Issues on the website (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('sent-to-site')
        .setDescription('Push a Discord message to the website as a known issue')
        .addStringOption(opt =>
          opt.setName('message_id').setDescription('The ID of the message describing the issue').setRequired(true)
        )
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel the message is in (defaults to this channel)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('resolved')
        .setDescription('Mark a known issue as resolved on the website')
        .addStringOption(opt =>
          opt.setName('message_id').setDescription('The ID of the original issue message').setRequired(true)
        )
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    knownIssuesState.loadState(logger);

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'sent-to-site') {
      const resolved = await resolveMessage(interaction);
      if (!resolved) return;
      const { message, channel } = resolved;

      let content = message.content;
      if (!content && message.embeds.length > 0) {
        const embed = message.embeds[0];
        content = [embed.title, embed.description].filter(Boolean).join('\n');
      }
      if (!content) {
        await interaction.editReply('That message has no text content or embed description to push.');
        return;
      }

      const { title, body } = splitTitleAndBody(sanitizeContent(content));
      const now = new Date().toISOString();

      const issue = {
        guildId: interaction.guildId,
        channelId: channel.id,
        title,
        description: body,
        messageUrl: message.url,
        postedBy: message.author?.tag || 'Unknown',
        postedAt: message.createdAt.toISOString(),
        status: 'open',
        sentAt: now,
        resolvedAt: null
      };

      knownIssuesState.set(message.id, issue, logger);

      const dispatched = await dispatchKnownIssueToSite({
        issue_id: message.id,
        status: 'open',
        title: issue.title,
        description: issue.description,
        message_url: issue.messageUrl,
        posted_by: issue.postedBy,
        posted_at: issue.postedAt
      });

      logger.info(`[KNOWN_ISSUE] Sent ${message.id} to site: "${title}"`);
      await interaction.editReply(
        dispatched
          ? `✅ Pushed **${title}** to the website's Known Issues page.`
          : `⚠️ Saved **${title}** locally, but the website push failed — check the bot logs.`
      );
      return;
    }

    if (subcommand === 'resolved') {
      const messageId = interaction.options.getString('message_id', true).trim();
      const issue = knownIssuesState.get(messageId);

      if (!issue) {
        await interaction.editReply(`No known issue on record for message ID \`${messageId}\`. Run \`/known-issue sent-to-site\` on it first.`);
        return;
      }

      if (issue.status === 'resolved') {
        await interaction.editReply(`**${issue.title}** is already marked resolved.`);
        return;
      }

      const now = new Date().toISOString();
      issue.status = 'resolved';
      issue.resolvedAt = now;
      knownIssuesState.set(messageId, issue, logger);

      const dispatched = await dispatchKnownIssueToSite({
        issue_id: messageId,
        status: 'resolved',
        title: issue.title,
        description: issue.description,
        message_url: issue.messageUrl,
        posted_by: issue.postedBy,
        posted_at: issue.postedAt,
        resolved_at: issue.resolvedAt
      });

      // Best-effort visual marker on the original message -- fine if the
      // bot can't react for some reason (message deleted, missing perms).
      try {
        const channel = await interaction.guild.channels.fetch(issue.channelId);
        const message = await channel.messages.fetch(messageId);
        await message.react('✅');
      } catch (err) {
        logger.warn(`[KNOWN_ISSUE] Could not react to resolved message ${messageId}: ${err.message}`);
      }

      logger.info(`[KNOWN_ISSUE] Marked ${messageId} resolved: "${issue.title}"`);
      await interaction.editReply(
        dispatched
          ? `✅ Marked **${issue.title}** resolved — moved to the archive on the website.`
          : `⚠️ Marked **${issue.title}** resolved locally, but the website push failed — check the bot logs.`
      );
    }
  }
};
