// utils/siteContentRemovalDispatcher.js
//
// Fires a `repository_dispatch` event to the Preem-Team site repo when a
// previously-featured showcase/feedback message gets deleted from Discord
// -- by anyone, not just staff: the original poster deleting their own
// message is as much a "take this down" signal as a mod removing it for
// NSFW content. A GitHub Action there
// (.github/workflows/removal-dispatch.yml) runs scripts/apply-removal.js
// against the payload and pushes the result.

const logger = require("./logger");

const SITE_OWNER = "mquiny";
const SITE_REPO = "Preem-Team";

/**
 * @param {string} submissionId  The deleted message's ID.
 * @param {"showcase"|"feedback"} source  Which page it was featured on.
 */
async function dispatchRemovalToSite(submissionId, source) {
  const token = process.env.SITE_CHANGELOG_TOKEN; // same PAT already used for the other site dispatches
  if (!token) {
    logger.warn("[removal] SITE_CHANGELOG_TOKEN not set — skipping site dispatch");
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
        event_type: "content_removed",
        client_payload: { submission_id: submissionId, source }
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(`[removal] Site dispatch failed: ${res.status} ${text}`);
      return;
    }

    logger.info(`[removal] Dispatched removal of "${submissionId}" (${source}) to site`);
  } catch (err) {
    logger.warn("[removal] Site dispatch threw:", err);
  }
}

module.exports = { dispatchRemovalToSite };
