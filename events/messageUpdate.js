const fs = require('fs');
const path = require('path');
const auditLogger = require('../utils/auditLogger');
const logger = require('../utils/logger');
const { dispatchFeedbackToSite } = require('../utils/siteFeedbackDispatcher');
const { dispatchShowcaseToSite } = require('../utils/siteShowcaseDispatcher');
const { dispatchRemovalToSite } = require('../utils/siteContentRemovalDispatcher');
const { firstImageUrl } = require('../services/showcase/showcaseWatcher');

const SHOWCASE_SUBMISSIONS_PATH = path.join(__dirname, '..', 'data', 'showcaseSubmissions.json');
const FEEDBACK_SUBMISSIONS_PATH = path.join(__dirname, '..', 'data', 'feedbackSubmissions.json');

function isTracked(filePath, id) {
  try {
    return new Set(JSON.parse(fs.readFileSync(filePath, 'utf8'))).has(id);
  } catch {
    return false;
  }
}

function removeFromTracking(filePath, id) {
  let set;
  try {
    set = new Set(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return;
  }
  if (!set.has(id)) return;
  set.delete(id);
  fs.writeFileSync(filePath, JSON.stringify([...set], null, 2), 'utf8');
}

// If a message currently featured on the site gets edited, refresh the
// site to match instead of leaving it showing stale content. This matters
// most for feedback: sentiment can flip months after the fact ("solid
// collection" edited down to "actually pretty broken now"), and the site
// staying neutral means it reflects the CURRENT wording, not a snapshot
// frozen at whatever moment staff happened to feature it.
//
// Re-dispatches with the SAME submission_id on purpose -- both
// apply-feedback.js and apply-showcase.js treat a re-dispatch of an id
// that's already featured as an in-place update, not a duplicate.
async function refreshIfFeatured(newMessage) {
  const isShowcase = isTracked(SHOWCASE_SUBMISSIONS_PATH, newMessage.id);
  const isFeedback = !isShowcase && isTracked(FEEDBACK_SUBMISSIONS_PATH, newMessage.id);
  if (!isShowcase && !isFeedback) return;

  if (newMessage.partial) {
    try {
      newMessage = await newMessage.fetch();
    } catch (err) {
      logger.warn('[refresh] Could not fetch partial message for update:', err);
      return;
    }
  }

  if (isFeedback) {
    const text = newMessage.content?.trim();
    if (!text) {
      // Edited down to nothing left to quote -- no different from the
      // author deleting the post outright, from the site's perspective.
      removeFromTracking(FEEDBACK_SUBMISSIONS_PATH, newMessage.id);
      await dispatchRemovalToSite(newMessage.id, 'feedback');
      return;
    }

    await dispatchFeedbackToSite({
      submission_id: newMessage.id,
      message: text,
      username: newMessage.author?.tag || newMessage.author?.username || 'Unknown',
      avatar_url: newMessage.author?.displayAvatarURL?.({ size: 128 }) || undefined,
      channel: `#${newMessage.channel.name}`,
      posted_at: newMessage.createdAt.toISOString(),
      message_url: newMessage.url
    });
    return;
  }

  // Showcase: Discord edits can only REMOVE an attachment, never add a new
  // one -- if the image is gone now, there's nothing left to show, so
  // scrub it the same way a delete would rather than leave a stale image
  // with a caption that no longer matches its source message.
  const imageUrl = firstImageUrl(newMessage);
  if (!imageUrl) {
    removeFromTracking(SHOWCASE_SUBMISSIONS_PATH, newMessage.id);
    await dispatchRemovalToSite(newMessage.id, 'showcase');
    return;
  }

  await dispatchShowcaseToSite({
    submission_id: newMessage.id,
    image_url: imageUrl,
    username: newMessage.author?.tag || newMessage.author?.username || 'Unknown',
    channel: `#${newMessage.channel.name}`,
    posted_at: newMessage.createdAt.toISOString(),
    title: newMessage.content?.trim() || undefined,
    message_url: newMessage.url
  });
}

module.exports = {
  name: 'messageUpdate',
  async execute(oldMessage, newMessage, client) {
    // Runs unconditionally, before the author check below -- a tracked
    // submission's id is all refreshIfFeatured needs to decide whether
    // there's anything to do, and it fetches the full message itself if
    // only a partial one came through.
    try {
      await refreshIfFeatured(newMessage);
    } catch (error) {
      logger.error('[refresh] Error refreshing featured content on edit:', error);
    }

    // Skip bot messages and system messages
    if (!newMessage.author || newMessage.author.bot) return;

    try {
      await auditLogger.logMessageUpdated(client, oldMessage, newMessage);
    } catch (error) {
      logger.error('Error logging message update event:', error);
    }
  }
};
