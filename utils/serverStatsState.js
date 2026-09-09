/**
 * Persistent storage of the voice channel IDs the bot creates for the
 * live member/booster stats display, per guild -- so a restart reuses
 * the same channels instead of creating duplicates every time.
 *
 * Structure:
 * {
 *   "<guildId>": {
 *     "membersChannelId": "...",
 *     "boostersChannelId": "..."
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'serverStats.json');

let state = {};

function loadState(logger) {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      logger?.info?.('[serverStatsState] Loaded state file');
    } else {
      state = {};
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      logger?.info?.('[serverStatsState] Created new state file');
    }
  } catch (e) {
    logger?.error?.(`[serverStatsState] Failed to load state: ${e.message}`);
    state = {};
  }
}

function saveState(logger) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    logger?.error?.(`[serverStatsState] Failed to save state: ${e.message}`);
  }
}

function getGuildChannels(guildId) {
  return state[guildId] || {};
}

function setGuildChannel(guildId, key, channelId, logger) {
  if (!state[guildId]) state[guildId] = {};
  state[guildId][key] = channelId;
  saveState(logger);
}

module.exports = {
  loadState,
  getGuildChannels,
  setGuildChannel,
};
