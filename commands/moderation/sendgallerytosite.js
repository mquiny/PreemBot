const {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  PermissionFlagsBits,
  MessageFlags
} = require('discord.js');
const { featureMessage } = require('../../services/showcase/showcaseWatcher');
const logger = require('../../utils/logger');

// Right-click a message in #gallery -> Apps -> "Send Gallery to Site" for
// an instant feature, same effect as a staff ⭐ react but as a command --
// see services/showcase/showcaseWatcher.js for the shared dedupe/dispatch
// logic (featureMessage), reused here instead of duplicated.
//
// Restricted to the showcase channel itself: same reasoning as
// featuretestimonial.js's FEEDBACK_CHANNEL_ID check -- reuses the
// watcher's own SHOWCASE_CHANNEL_ID env var since it's literally the same
// channel, rather than introducing a second source of truth for it.
const SHOWCASE_CHANNEL_ID = process.env.SHOWCASE_CHANNEL_ID;

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Send Gallery to Site')
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    if (!SHOWCASE_CHANNEL_ID) {
      await interaction.reply({
        content: '❌ SHOWCASE_CHANNEL_ID is not configured -- ask an admin to set it.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.channelId !== SHOWCASE_CHANNEL_ID) {
      await interaction.reply({
        content: `❌ This can only be used on messages in <#${SHOWCASE_CHANNEL_ID}>.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const message = interaction.targetMessage;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const result = await featureMessage(message);

    if (!result.success && result.reason === 'already_featured') {
      await interaction.editReply({ content: '⚠️ That post has already been featured on the site.' });
      return;
    }
    if (!result.success && result.reason === 'no_image') {
      await interaction.editReply({ content: '❌ That message has no image to feature.' });
      return;
    }

    const username = message.author?.tag || message.author?.username || 'Unknown';
    logger.info(`[showcase] ${interaction.user.tag} instant-featured message ${message.id} from ${username}`);

    await interaction.editReply({
      content: `✅ Featured ${username}'s post on the site's Showcase page.`
    });
  }
};
