const { EmbedBuilder } = require('discord.js');
const BaseTemplate = require('./BaseTemplate');

class NCRTemplate extends BaseTemplate {
  // Collection image URLs for thumbnails
  getCollectionImage(slug) {
    const images = {
      'buqwx3': 'https://media.nexusmods.com/9/0/t/med/902613fb-13f0-4608-b0eb-ca377a770b48.webp', // JPE Core

    };
    return images[slug] || null;
  }

  async generateHeaderEmbeds(revisionInfo) {
    const { collections, gameVersion } = revisionInfo;
    const embeds = [];

    let revisionTitle = `Revision `;
    if (collections.length === 1) {
      revisionTitle += `${collections[0].display}-${collections[0].newRev}`;
    } else {
      const parts = collections.map(c => `${c.display}-${c.newRev}`);
      revisionTitle += parts.join('/');
    }
    revisionTitle += ` - Game Version ${gameVersion}`;

    const headerEmbed = new EmbedBuilder()
      .setTitle(revisionTitle)
      .setDescription(
        "**⚠️ Important** - To clear out old version files, permanently delete all files in the Cyberpunk 2077\\r6\\cache folder with each new revision, verify the game files, then deploy mods from vortex.\n\n" +
        "Any issues with updating please refer to our website https://mquiny.github.io/Preem-Team/installation/\n\n" +
        "If you need further help ping <@&1543374108052426752>"
      )
      .setColor(this.getColor('header'));

    // Add thumbnail image for single collection
    if (collections.length === 1) {
      const collectionImage = this.getCollectionImage(collections[0].slug);
      if (collectionImage) {
        headerEmbed.setThumbnail(collectionImage);
      }
    }

    const updateEmbed = new EmbedBuilder()
      .setTitle("Updating collection")
      .setDescription(
        "**⚠️ Important** - For a quick guide on updating your collection, follow the guide on our website https://mquiny.github.io/Preem-Team/installation/\n\n" 
      )
      .setColor(this.getColor('warning'));

    embeds.push(headerEmbed, updateEmbed);
    return embeds;
  }
}

module.exports = NCRTemplate;
