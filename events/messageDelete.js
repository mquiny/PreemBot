const fs = require('fs');
const path = require('path');
const auditLogger = require('../utils/auditLogger');
const logger = require('../utils/logger');
const { dispatchRemovalToSite } = require('../utils/siteContentRemovalDispatcher');

const SHOWCASE_SUBMISSIONS_PATH = path.join(__dirname, '..', 'data', 'showcaseSubmissions.json');
const FEEDBACK_SUBMISSIONS_PATH = path.join(__dirname, '..', 'data', 'feedbackSubmissions.json');

function loadSet(filePath) {
  try {
    return new Set(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return new Set();
  }
}

function removeFromSet(filePath, id) {
  const set = loadSet(filePath);
  if (!set.has(id)) return false;
  set.delete(id);
  fs.writeFileSync(filePath, JSON.stringify([...set], null, 2), 'utf8');
  return true;
}

// If a message that was ever featured on the site (showcase or feedback)
// gets deleted -- staff moderating it (e.g. NSFW content) or the original
// author taking their own post back, doesn't matter which -- scrub it from
// the site too, not just Discord. Checked against the LOCAL tracking files
// (cheap, no site round trip needed to know whether this ID was ever
// featured) instead of firing a dispatch for every deleted message in the
// guild. Also removes the id from the tracking file itself so it isn't
// permanently stuck "already featured" if the same content ever qualifies
// again later.
async function scrubIfFeatured(messageId) {
  if (removeFromSet(SHOWCASE_SUBMISSIONS_PATH, messageId)) {
    await dispatchRemovalToSite(messageId, 'showcase');
    return;
  }
  if (removeFromSet(FEEDBACK_SUBMISSIONS_PATH, messageId)) {
    await dispatchRemovalToSite(messageId, 'feedback');
  }
}

module.exports = {
  name: 'messageDelete',
  async execute(message, client) {
    // Runs unconditionally, before the author check below -- message.id is
    // always available even for a partial/uncached message, and a tracked
    // submission's id is all scrubIfFeatured needs (unlike audit logging,
    // which needs real author data and skips partials).
    try {
      await scrubIfFeatured(message.id);
    } catch (error) {
      logger.error('[removal] Error scrubbing featured content on delete:', error);
    }

    // Skip bot messages and system messages
    if (!message.author || message.author.bot) return;

    try {
      await auditLogger.logMessageDeleted(client, message);
    } catch (error) {
      logger.error('Error logging message delete event:', error);
    }
  }
};
