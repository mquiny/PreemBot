// services/showcase/showcaseWatcher.js
//
// Watches #showcase for either 10 unique reactors (any emoji) or a staff
// member reacting with one of the configured staff emojis, and fires a
// site dispatch the moment a post qualifies.

const fs = require("fs");
const path = require("path");
const { dispatchShowcaseToSite } = require("../../utils/siteShowcaseDispatcher");
const { getModeratorRoleIds } = require("../../utils/guildConfig");
const logger = require("../../utils/logger");

const SHOWCASE_CHANNEL_ID = process.env.SHOWCASE_CHANNEL_ID;

// "Staff" here deliberately means the same moderatorRoles.json list used
// everywhere else in the bot (permissions.js, SpamDetector, etc.) rather
// than a separate role list of its own — this used to read its own
// SHOWCASE_STAFF_ROLE_ID env var, which for CPE's guild didn't include the
// Community Support role that moderatorRoles.json does, so a mod's staff
// react silently never triggered an instant feature. Single source of
// truth now: whoever the bot already treats as a moderator can
// instant-feature a showcase post.
function isStaffMember(member) {
  if (!member) return false;
  const staffRoleIds = getModeratorRoleIds(member.guild.id);
  return staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

const REACTION_THRESHOLD = parseInt(process.env.SHOWCASE_REACTION_THRESHOLD || "10", 10);

// One or more emojis that count as an instant staff feature — comma
// separated, so different custom emojis (or a mix of custom and unicode)
// can all trigger it, not just a single hardcoded ⭐. For a custom emoji,
// use its name without colons (e.g. "PEsamurai"), matching what
// reaction.emoji.name returns for it. Falls back to the legacy singular
// SHOWCASE_STAFF_EMOJI env var, then to ⭐, so existing deployments don't
// need to change anything to keep working.
const STAFF_EMOJIS = (process.env.SHOWCASE_STAFF_EMOJIS || process.env.SHOWCASE_STAFF_EMOJI || "⭐")
  .split(",")
  .map((emoji) => emoji.trim())
  .filter(Boolean);

const SUBMISSIONS_PATH = path.join(__dirname, "..", "..", "data", "showcaseSubmissions.json");

function loadSubmitted() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SUBMISSIONS_PATH, "utf8")));
  } catch {
    return new Set();
  }
}

function markSubmitted(messageId, submitted) {
  submitted.add(messageId);
  fs.writeFileSync(SUBMISSIONS_PATH, JSON.stringify([...submitted], null, 2), "utf8");
}

function firstImageUrl(message) {
  const attachment = message.attachments.find((a) => a.contentType?.startsWith("image/"));
  if (attachment) return attachment.url;
  const embed = message.embeds.find((e) => e.image?.url);
  return embed ? embed.image.url : null;
}

async function countUniqueReactors(message) {
  const uniqueUserIds = new Set();
  for (const reaction of message.reactions.cache.values()) {
    const users = await reaction.users.fetch();
    for (const user of users.values()) {
      if (!user.bot) uniqueUserIds.add(user.id);
    }
  }
  return uniqueUserIds.size;
}

async function tryFeature(message, submitted) {
  if (submitted.has(message.id)) return;

  const imageUrl = firstImageUrl(message);
  if (!imageUrl) return;

  const payload = {
    submission_id: message.id,
    image_url: imageUrl,
    username: message.author?.tag || message.author?.username || "Unknown",
    channel: `#${message.channel.name}`,
    posted_at: message.createdAt.toISOString(),
    title: message.content?.trim() || undefined,
    message_url: message.url
  };

  await dispatchShowcaseToSite(payload);
  markSubmitted(message.id, submitted);
  logger.info(`[showcase] Featured message ${message.id} from ${payload.username}`);
}

function initShowcaseWatcher(client) {
  if (!SHOWCASE_CHANNEL_ID) {
    logger.warn("[showcase] SHOWCASE_CHANNEL_ID not set — showcase watcher disabled");
    return;
  }

  const submitted = loadSubmitted();

  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      if (reaction.message.channelId !== SHOWCASE_CHANNEL_ID) return;
      if (user.bot) return;

      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      const message = reaction.message;
      if (submitted.has(message.id)) return;

      if (STAFF_EMOJIS.includes(reaction.emoji.name)) {
        const member = await message.guild.members.fetch(user.id).catch(() => null);
        if (isStaffMember(member)) {
          await tryFeature(message, submitted);
          return;
        }
      }

      const uniqueCount = await countUniqueReactors(message);
      if (uniqueCount >= REACTION_THRESHOLD) {
        await tryFeature(message, submitted);
      }
    } catch (err) {
      logger.warn("[showcase] Error handling reaction:", err);
    }
  });

  logger.info(`[showcase] Watching #${SHOWCASE_CHANNEL_ID} (threshold=${REACTION_THRESHOLD}, staff emojis=${STAFF_EMOJIS.join(",")}, staff roles=per-guild moderatorRoles.json)`);
}

module.exports = { initShowcaseWatcher };
