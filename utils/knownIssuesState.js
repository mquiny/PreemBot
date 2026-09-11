/**
 * Persistent storage of known issues pushed to the website via
 * /known-issue, keyed by the Discord message ID they were sourced from.
 *
 * This is the source of truth /known-issue resolved checks against --
 * you can only resolve an issue that was actually sent to the site first,
 * so a typo'd message ID gets a clear error instead of silently no-op'ing.
 *
 * Structure:
 * {
 *   "<messageId>": {
 *     "guildId": "...",
 *     "channelId": "...",
 *     "title": "...",
 *     "description": "...",
 *     "messageUrl": "...",
 *     "postedBy": "...",
 *     "postedAt": "2026-09-11T12:00:00.000Z",
 *     "status": "open" | "resolved",
 *     "sentAt": "2026-09-11T12:00:00.000Z",
 *     "resolvedAt": null | "2026-09-12T09:00:00.000Z"
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'knownIssues.json');

let state = {};

function loadState(logger) {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      logger?.info?.('[knownIssuesState] Loaded state file');
    } else {
      state = {};
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      logger?.info?.('[knownIssuesState] Created new state file');
    }
  } catch (e) {
    logger?.error?.(`[knownIssuesState] Failed to load state: ${e.message}`);
    state = {};
  }
}

function saveState(logger) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    logger?.error?.(`[knownIssuesState] Failed to save state: ${e.message}`);
  }
}

function get(messageId) {
  return state[messageId] || null;
}

function set(messageId, issue, logger) {
  state[messageId] = issue;
  saveState(logger);
}

module.exports = {
  loadState,
  get,
  set,
};
