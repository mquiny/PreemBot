// services/RevisionMonitor.js
const logger = require('../utils/logger');
const { fetchRevision, processModFiles, computeDiff } = require('../utils/nexusApi');

const revisionState = require('../utils/revisionState');
const guildConfigManager = require('../config/guildConfigManager');
const changelogGenerator = require('./changelog/ChangelogGenerator');
const collectionHealthService = require('./CollectionHealthService');
const { getGuildChannelId } = require('../utils/guildConfig');

// Delay helper
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class RevisionMonitor {
  constructor() {
    this.pollInterval = 15 * 60 * 1000; // 15 minutes
    this.pendingUpdates = new Map(); // Map<guildId_groupName, Array<updateInfo>>
    this.combineTimers = new Map(); // Map<guildId_groupName, timeoutId>
  }

  async start(client) {
    logger.info('[REVISION_MONITOR] Starting...');

    revisionState.loadState(logger);

    // Poll immediately
    await this.checkAllGuilds(client);

    // Then poll every 15 minutes
    setInterval(async () => {
      await this.checkAllGuilds(client);
    }, this.pollInterval);
  }

  async checkAllGuilds(client) {
    logger.debug('[REVISION_MONITOR] Checking all guilds...');

    // Tracks error messages seen this sweep so a single outage (e.g. Nexus
    // API downtime) doesn't get logged once per collection that hits it.
    this.sweepErrorCounts = new Map();

    const guilds = client.guilds.cache;

    for (const [guildId, guild] of guilds) {
      try {
        await this.checkGuildCollections(client, guildId);
      } catch (error) {
        logger.error(`[REVISION_MONITOR] Error checking guild ${guildId}:`, error);
      }
    }

    for (const [message, count] of this.sweepErrorCounts) {
      if (count > 1) {
        logger.warn(`[REVISION_MONITOR] "${message}" occurred ${count} times this sweep (repeats suppressed above)`);
      }
    }
  }

  async checkGuildCollections(client, guildId) {
    const guildConfig = guildConfigManager.loadGuildConfig(guildId);

    if (!guildConfig.collections || guildConfig.collections.length === 0) {
      logger.warn(`[REVISION_MONITOR] Guild ${guildId} has no collections configured`);
      return;
    }

    logger.debug(`[REVISION_MONITOR] Checking ${guildConfig.collections.length} collections for guild ${guildId}`);

    for (const collection of guildConfig.collections) {
      try {
        await this.checkCollection(client, guildId, collection);
      } catch (error) {
        this.logCollectionError(guildId, collection, error);
      }
    }
  }

  // First occurrence of a given error message in this sweep logs normally;
  // further collections hitting the exact same error (e.g. a Nexus API
  // outage affecting every collection at once) get a quiet debug line
  // instead, with the suppressed count surfaced once at the end of the sweep.
  logCollectionError(guildId, collection, error) {
    const message = error.message;
    const count = (this.sweepErrorCounts?.get(message) || 0) + 1;
    this.sweepErrorCounts?.set(message, count);

    if (count === 1) {
      logger.error(`[REVISION_MONITOR] Error checking ${collection.display} in guild ${guildId}: ${message}`);
    } else {
      logger.debug(`[REVISION_MONITOR] Error checking ${collection.display} in guild ${guildId}: ${message} (repeat #${count}, suppressed)`);
    }
  }

  async checkCollection(client, guildId, collection) {
    const { slug, display } = collection;

    const revisionData = await fetchRevision(
      slug,
      null,
      process.env.NEXUS_API_KEY,
      process.env.APP_NAME,
      process.env.APP_VERSION
    );

    const currentRevision = revisionData.revisionNumber;
    const previousRevision = revisionState.getCollectionRevision(guildId, slug);

    if (!previousRevision || currentRevision > previousRevision) {
      logger.info(`[REVISION_MONITOR] New revision in guild ${guildId}: ${display} (${previousRevision} → ${currentRevision})`);

      const newMods = processModFiles(revisionData.modFiles);
      let oldMods = [];

      if (previousRevision) {
        const oldRevisionData = await fetchRevision(
          slug,
          previousRevision,
          process.env.NEXUS_API_KEY,
          process.env.APP_NAME,
          process.env.APP_VERSION
        );
        oldMods = processModFiles(oldRevisionData.modFiles);
      }

      const diffs = computeDiff(oldMods, newMods);

      revisionState.setCollectionRevision(guildId, slug, currentRevision, logger);

      // A collection-health sweep snapshots the mod list once at the
      // start and grinds through it in hourly batches for up to ~25
      // hours (see CollectionHealthService.SWEEP_HOURS) -- if one was
      // already in progress when this new revision landed, it would
      // otherwise keep reporting against the now-stale pre-revision mod
      // list for the rest of that sweep. Reset it here so the very next
      // hourly batch starts a fresh sweep against the new revision
      // immediately, instead of waiting up to a day for it to catch up
      // on its own.
      collectionHealthService.resetSweep(guildId, slug);
      logger.info(`[REVISION_MONITOR] Reset collection-health sweep for ${display} in guild ${guildId} (revision changed)`);

      // Immediately reflect the restart on the standing report too --
      // otherwise it silently sits on now-stale results for up to a day
      // until the fresh sweep finishes, giving no sign the bot actually
      // noticed the revision change.
      const healthChannelId = getGuildChannelId(guildId, 'collectionHealth');
      await collectionHealthService.postSweepRestartedNotice(client, guildId, slug, display, healthChannelId).catch((err) => {
        logger.warn(`[REVISION_MONITOR] Failed to post sweep-restarted notice for ${display} in guild ${guildId}: ${err.message}`);
      });

      await this.queueUpdate(client, guildId, collection, {
        oldRev: previousRevision || 0,
        newRev: currentRevision,
        diffs
      });
    }
  }

  queueUpdate(client, guildId, collection, updateData) {
    const guildConfig = guildConfigManager.loadGuildConfig(guildId);
    const groupConfig = guildConfigManager.getGroupForCollection(guildId, collection.slug);

    if (!groupConfig) {
      logger.warn(`[REVISION_MONITOR] No group found for ${collection.display} in guild ${guildId}`);
      return;
    }

    const key = `${guildId}_${groupConfig.name}`;

    if (!this.pendingUpdates.has(key)) {
      this.pendingUpdates.set(key, []);
    }

    const updateInfo = { collection, updateData };
    this.pendingUpdates.get(key).push(updateInfo);

    logger.info(`[REVISION_MONITOR] Queued update for ${collection.display} in guild ${guildId}, group ${groupConfig.name}`);

    if (this.combineTimers.has(key)) {
      clearTimeout(this.combineTimers.get(key));
    }

    if (groupConfig.combined) {
      const timer = setTimeout(() => {
        this.processPendingGroup(client, guildId, groupConfig.name);
      }, guildConfig.combineWindowMs || 5000);

      this.combineTimers.set(key, timer);
    } else {
      setImmediate(() => {
        this.processPendingGroup(client, guildId, groupConfig.name);
      });
    }
  }

  async processPendingGroup(client, guildId, groupName) {
    const key = `${guildId}_${groupName}`;

    if (this.combineTimers.has(key)) {
      clearTimeout(this.combineTimers.get(key));
      this.combineTimers.delete(key);
    }

    const pendingUpdates = this.pendingUpdates.get(key);
    if (!pendingUpdates || pendingUpdates.length === 0) {
      logger.warn(`[REVISION_MONITOR] No pending updates for group ${groupName} in guild ${guildId}`);
      return;
    }

    this.pendingUpdates.delete(key);

    const guildConfig = guildConfigManager.loadGuildConfig(guildId);
    const groupConfig = guildConfig.groups.find(g => g.name === groupName);

    if (!groupConfig) {
      logger.error(`[REVISION_MONITOR] Group config not found for ${groupName} in guild ${guildId}`);
      return;
    }

    logger.info(`[REVISION_MONITOR] Processing ${pendingUpdates.length} updates for group ${groupName} in guild ${guildId}`);

    pendingUpdates.sort((a, b) => {
      const priorityA = a.collection.priority || 0;
      const priorityB = b.collection.priority || 0;
      return priorityA - priorityB;
    });

    for (const update of pendingUpdates) {
      const { collection, updateData } = update;

      const revisionData = {
        collections: [
          {
            slug: collection.slug,
            display: collection.display,
            oldRev: updateData.oldRev,
            newRev: updateData.newRev
          }
        ],
        diffs: updateData.diffs
      };

      await changelogGenerator.sendChangelog(client, guildId, groupConfig, revisionData);

      await wait(15000);
    }
  }
}

module.exports = new RevisionMonitor();
