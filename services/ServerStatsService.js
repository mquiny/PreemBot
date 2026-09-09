// services/ServerStatsService.js
//
// Keeps a set of voice channels per guild in sync with live server stats:
// "Family Members" (total member count), "Boosters" (server boost count),
// and — when a collection slug is configured — "Mods" (distinct mod count
// in that collection's current revision) and "Revision" (its revision
// number). Opt-in per guild via STATS_CATEGORY_IDS, and STATS_COLLECTION_SLUGS
// for the mods/revision pair (see utils/guildConfig.js) -- a guild with no
// category configured is skipped entirely.
//
// The channels are created once, locked so nobody can actually join them
// (they're display-only counters, the standard pattern for these), under
// the configured category. Their IDs are persisted in
// data/serverStats.json so a restart reuses them instead of creating
// duplicates every time.
//
// Discord rate-limits channel name changes to 2 per 10 minutes per
// channel, so this only runs every 10 minutes, and skips the rename API
// call entirely when the target name hasn't actually changed since last
// time.
const { ChannelType } = require('discord.js');
const logger = require('../utils/logger');
const { getStatsCategoryId, getStatsCollectionSlug } = require('../utils/guildConfig');
const statsState = require('../utils/serverStatsState');
const { fetchRevision, processModFiles } = require('../utils/nexusApi');

class ServerStatsService {
  constructor() {
    this.updateIntervalMs = 10 * 60 * 1000; // 10 minutes
  }

  async start(client) {
    logger.info('[SERVER_STATS] Starting...');
    statsState.loadState(logger);

    await this.updateAllGuilds(client);

    setInterval(() => {
      this.updateAllGuilds(client).catch(err => {
        logger.error('[SERVER_STATS] Error during scheduled update:', err);
      });
    }, this.updateIntervalMs);
  }

  async updateAllGuilds(client) {
    for (const [guildId, guild] of client.guilds.cache) {
      try {
        await this.updateGuild(guild);
      } catch (err) {
        logger.error(`[SERVER_STATS] Error updating stats for guild ${guildId}: ${err.message}`);
      }
    }
  }

  async buildStatList(guild) {
    const stats = [
      { key: 'membersChannelId', name: `👨‍👩‍👧‍👦 Family Members: ${guild.memberCount.toLocaleString()}` },
      { key: 'boostersChannelId', name: `🚀 Boosters: ${(guild.premiumSubscriptionCount || 0).toLocaleString()}` },
    ];

    const collectionSlug = getStatsCollectionSlug(guild.id);
    if (!collectionSlug) return stats;

    try {
      const revisionData = await fetchRevision(
        collectionSlug,
        null,
        process.env.NEXUS_API_KEY,
        process.env.APP_NAME,
        process.env.APP_VERSION
      );

      const rawModFiles = revisionData.modFiles || [];
      const mods = processModFiles(rawModFiles);
      const distinctModCount = new Set(mods.map(m => m.id)).size;

      // Temporary diagnostic breakdown -- if distinctModCount doesn't
      // match the collection's own Nexus page count, this line shows
      // whether the gap is (a) processModFiles dropping entries with no
      // resolved file.mod (broken/removed file references) or (b) mods
      // genuinely appearing under multiple files that got deduped. Remove
      // once the mismatch reported 2026-09 is understood.
      const droppedNullMod = rawModFiles.length - mods.length;
      const duplicateFiles = mods.length - distinctModCount;
      logger.info(`[SERVER_STATS] ${collectionSlug} mod count breakdown: raw modFiles=${rawModFiles.length}, after dropping null file.mod=${mods.length} (dropped ${droppedNullMod}), distinct mods=${distinctModCount} (${duplicateFiles} duplicate file(s) collapsed)`);

      stats.push({ key: 'modsChannelId', name: `🧩 Mods: ${distinctModCount.toLocaleString()}` });
      stats.push({ key: 'revisionChannelId', name: `🔧 Revision: ${revisionData.revisionNumber}` });
    } catch (err) {
      logger.error(`[SERVER_STATS] Failed to fetch collection ${collectionSlug} for guild ${guild.id}: ${err.message}`);
    }

    return stats;
  }

  async updateGuild(guild) {
    const categoryId = getStatsCategoryId(guild.id);
    if (!categoryId) return; // not opted in for this guild

    const category = await guild.channels.fetch(categoryId).catch(() => null);
    if (!category) {
      logger.warn(`[SERVER_STATS] Category ${categoryId} not found in guild ${guild.id}`);
      return;
    }

    const stats = await this.buildStatList(guild);
    const saved = statsState.getGuildChannels(guild.id);

    for (let i = 0; i < stats.length; i++) {
      const stat = stats[i];

      let channel = saved[stat.key]
        ? await guild.channels.fetch(saved[stat.key]).catch(() => null)
        : null;

      if (!channel) {
        // Create the channel on its own first -- only needs Manage
        // Channels. Locking it (denying @everyone Connect) is a separate
        // step below: Discord only lets an actor set an overwrite for a
        // permission it itself currently holds at that location, so if
        // the bot's own effective Connect permission is denied there
        // (category-specific overrides, etc.) bundling the overwrite into
        // the create call fails the whole thing with "Missing
        // Permissions" and no channel gets created at all.
        channel = await guild.channels.create({
          name: stat.name,
          type: ChannelType.GuildVoice,
          parent: category.id,
          position: i,
        });
        statsState.setGuildChannel(guild.id, stat.key, channel.id, logger);
        logger.info(`[SERVER_STATS] Created "${stat.name}" channel (${channel.id}) in guild ${guild.id}`);

        try {
          await channel.permissionOverwrites.create(guild.roles.everyone, {
            Connect: false,
          });
        } catch (err) {
          logger.warn(`[SERVER_STATS] Created ${channel.id} but couldn't lock it against joining (bot likely lacks Connect permission itself in that category) -- it'll stay joinable until that's granted: ${err.message}`);
        }

        continue;
      }

      if (channel.name === stat.name) continue; // no change needed, skip the API call

      await channel.setName(stat.name, 'Server stats update');
      logger.info(`[SERVER_STATS] Updated channel in guild ${guild.id} to "${stat.name}"`);
    }
  }
}

module.exports = new ServerStatsService();
