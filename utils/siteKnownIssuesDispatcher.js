// utils/siteKnownIssuesDispatcher.js
//
// Fires a `repository_dispatch` event to the Preem-Team site repo when a
// known issue is pushed via /known-issue sent-to-site or marked resolved
// via /known-issue resolved, mirroring utils/siteShowcaseDispatcher.js. A
// GitHub Action there (.github/workflows/known-issues-dispatch.yml) runs
// scripts/apply-known-issues.js against the payload and pushes the result.

const logger = require("./logger");

const SITE_OWNER = "mquiny";
const SITE_REPO = "Preem-Team";

/**
 * @param {object} payload
 * @param {string} payload.issue_id     Unique id for this issue -- the
 *   Discord message ID it was sourced from. The site script is idempotent
 *   on this: dispatching "open" twice for the same id is a safe no-op,
 *   and dispatching "resolved" moves the existing entry rather than
 *   duplicating it.
 * @param {string} payload.status       "open" or "resolved".
 * @param {string} payload.title        Short issue title (first line of
 *   the source message).
 * @param {string} payload.description  Full issue body.
 * @param {string} [payload.message_url] Link back to the original Discord
 *   message.
 * @param {string} [payload.posted_by]  Display name/tag to credit.
 * @param {string} [payload.posted_at]  ISO date string, when first sent.
 * @param {string} [payload.resolved_at] ISO date string, set only when
 *   status is "resolved".
 */
async function dispatchKnownIssueToSite(payload) {
  const token = process.env.SITE_CHANGELOG_TOKEN; // same PAT already used for changelog/showcase dispatches
  if (!token) {
    logger.warn("[known-issue] SITE_CHANGELOG_TOKEN not set — skipping site dispatch");
    return;
  }
  if (!payload.issue_id || !payload.status || !payload.title) {
    logger.warn("[known-issue] Missing required field(s) — skipping site dispatch", payload);
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
        event_type: "known_issue_update",
        client_payload: payload
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(`[known-issue] Site dispatch failed: ${res.status} ${text}`);
      return false;
    }

    logger.info(`[known-issue] Dispatched issue "${payload.issue_id}" (${payload.status}) to site`);
    return true;
  } catch (err) {
    logger.warn("[known-issue] Site dispatch threw:", err);
    return false;
  }
}

module.exports = { dispatchKnownIssueToSite };
