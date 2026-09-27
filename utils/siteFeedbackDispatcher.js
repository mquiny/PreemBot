// utils/siteFeedbackDispatcher.js
//
// Fires a `repository_dispatch` event to the Preem-Team site repo when a
// staff member features a #feedback message as a testimonial, mirroring
// utils/siteShowcaseDispatcher.js. A GitHub Action there
// (.github/workflows/feedback-dispatch.yml) runs scripts/apply-feedback.js
// against the payload and pushes the result.
//
// Unlike showcase, there's no image to download and re-host: Discord
// avatar URLs (cdn.discordapp.com/avatars/...) aren't signed/expiring the
// way attachment/proxy URLs are, so the site can link one directly and
// keep working indefinitely.

const logger = require("./logger");

const SITE_OWNER = "mquiny";
const SITE_REPO = "Preem-Team";

/**
 * @param {object} payload
 * @param {string} payload.submission_id  Unique id for this testimonial —
 *   use the Discord message ID. The site script is idempotent on this:
 *   firing twice for the same id is a safe no-op, not a duplicate card.
 * @param {string} payload.message        The feedback text itself. Required
 *   — the site skips anything without one (e.g. an image-only message).
 * @param {string} payload.username       Display name / tag to credit.
 * @param {string} [payload.avatar_url]   Author's avatar URL, shown on the card.
 * @param {string} payload.channel        e.g. "#feedback".
 * @param {string} payload.posted_at      ISO date string of the original message.
 * @param {string} [payload.message_url]  Link back to the original Discord message.
 */
async function dispatchFeedbackToSite(payload) {
  const token = process.env.SITE_CHANGELOG_TOKEN; // same PAT already used for changelog/showcase dispatches — scoped to Contents: read/write on Preem-Team
  if (!token) {
    logger.warn("[feedback] SITE_CHANGELOG_TOKEN not set — skipping site dispatch");
    return;
  }
  if (!payload.message || !payload.username || !payload.submission_id) {
    logger.warn("[feedback] Missing required field(s) — skipping site dispatch", payload);
    return;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${SITE_OWNER}/${SITE_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        event_type: "feedback_submission",
        client_payload: payload
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(`[feedback] Site dispatch failed: ${res.status} ${text}`);
      return;
    }

    logger.info(`[feedback] Dispatched testimonial "${payload.submission_id}" to site`);
  } catch (err) {
    logger.warn("[feedback] Site dispatch threw:", err);
  }
}

module.exports = { dispatchFeedbackToSite };
