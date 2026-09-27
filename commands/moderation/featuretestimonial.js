const fs = require('fs');
const path = require('path');
const {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  PermissionFlagsBits,
  MessageFlags
} = require('discord.js');
const { dispatchFeedbackToSite } = require('../../utils/siteFeedbackDispatcher');
const logger = require('../../utils/logger');

// Right-click a message -> Apps -> "Feature as Testimonial" to send it to
// the site's Feedback page (docs/feedback/index.md in the Preem-Team repo).
// Staff-gated via setDefaultMemberPermissions, same tier as /warn -- picking
// the message IS the approval step, there's no separate review queue.
//
// Tracked locally by message ID (mirrors data/showcaseSubmissions.json) so
// re-running the command on the same message gives a clear "already
// featured" reply instead of silently re-dispatching -- the site-side
// script is idempotent too, but this saves the round trip and is more
// honest feedback to the staff member who ran it.
const SUBMISSIONS_PATH = path.join(__dirname, '..', '..', 'data', 'feedbackSubmissions.json');

function loadSubmitted() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SUBMISSIONS_PATH, 'utf8')));
  } catch {
    return new Set();
  }
}

function markSubmitted(messageId, submitted) {
  submitted.add(messageId);
  fs.writeFileSync(SUBMISSIONS_PATH, JSON.stringify([...submitted], null, 2), 'utf8');
}

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Feature as Testimonial')
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const message = interaction.targetMessage;
    const submitted = loadSubmitted();

    if (submitted.has(message.id)) {
      await interaction.reply({
        content: '⚠️ That message has already been featured on the site.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const text = message.content?.trim();
    if (!text) {
      await interaction.reply({
        content: '❌ That message has no text content to feature (image-only messages, embeds, etc. aren\'t supported).',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const payload = {
      submission_id: message.id,
      message: text,
      username: message.author?.tag || message.author?.username || 'Unknown',
      avatar_url: message.author?.displayAvatarURL?.({ size: 128 }) || undefined,
      channel: `#${message.channel.name}`,
      posted_at: message.createdAt.toISOString(),
      message_url: message.url
    };

    await dispatchFeedbackToSite(payload);
    markSubmitted(message.id, submitted);

    logger.info(`[feedback] ${interaction.user.tag} featured message ${message.id} from ${payload.username}`);

    await interaction.editReply({
      content: `✅ Featured ${payload.username}'s message on the site's Feedback page.`
    });
  }
};
