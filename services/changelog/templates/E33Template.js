const { EmbedBuilder } = require('discord.js');
const BaseTemplate = require('./BaseTemplate');

class E33Template extends BaseTemplate {
  async generateHeaderEmbeds(revisionInfo) {
    const { collections, gameVersion } = revisionInfo;
    const embeds = [];

    const newRev = collections[0].newRev;

    const headerEmbed = new EmbedBuilder()
      .setTitle(`Revision ${newRev} - Game Version ${gameVersion}`)
      .setDescription(
        "**⚠️ Important** - Don't forget to install new revisions to a separate profile, and remove old mods to prevent conflicts.\n\n" +
        "Any issues with updating please refer to our website https://mquiny.github.io/Preem-Team/installation/\n\n" +
        "If you need further help ping a <@&1543374108052426752>."
      )
      .setColor(this.getColor('header'));

    const updateEmbed = new EmbedBuilder()
      .setTitle("Updating collection")
      .setDescription(
        "Check our website for an update guide https://mquiny.github.io/Preem-Team/installation>\n\n"
      )
      .setColor(this.getColor('warning'));

    embeds.push(headerEmbed, updateEmbed);
    return embeds;
  }
}

module.exports = E33Template;
