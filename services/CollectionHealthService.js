// services/CollectionHealthService.js
//
// Checks a tracked collection's bundled mod versions against each mod's
// current version on Nexus, spread across many small batches instead of
// one big sweep -- a collection can have 900+ mods, and checking every
// one individually against Nexus's REST API in a single run would blow
// through rate limits (~100 req/hour on a standard key). Instead this
// runs on an hourly cron (see events/ready.js), checking a slice of the
// collection's mod list each time, sized so a full sweep finishes in
// roughly a day regardless of collection size. Each mod costs two
// requests (status + file list, see fetchModStatus/fetchFileStatus) so
// batch sizing budgets for double the request count per mod checked.
//
// State persists to data/collectionHealth.json between runs, keyed by
// guild + collection slug, so progress survives a bot restart mid-sweep.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');

const STATE_PATH = path.join(__dirname, '..', 'data', 'collectionHealth.json');
const SWEEP_HOURS = 24;
const MIN_BATCH_SIZE = 5;
const REQUESTS_PER_MOD = 2; // status check + file list check
const MAX_REQUESTS_PER_HOUR = 80; // leaves headroom under Nexus's ~100/hr for other bot API calls
const MAX_BATCH_SIZE = Math.floor(MAX_REQUESTS_PER_HOUR / REQUESTS_PER_MOD);

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    logger.error(`[COLLECTION_HEALTH] Failed to parse state: ${err.message}`);
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function getSweep(state, guildId, slug) {
  if (!state[guildId]) state[guildId] = {};
  return state[guildId][slug] || null;
}

function setSweep(state, guildId, slug, sweep) {
  if (!state[guildId]) state[guildId] = {};
  state[guildId][slug] = sweep;
}

// Tracks the one standing report message per guild+collection, kept in a
// separate top-level bucket from the sweep-in-progress state above (which
// lives at state[guildId][slug] and gets wiped by resetSweep) so the
// report reference survives across sweeps. The caller (events/ready.js)
// uses this plus computeSignature() below to edit the same message in
// place across sweeps instead of posting a fresh one every time.
function getReportRef(guildId, slug) {
  const state = loadState();
  return (state.__reports && state.__reports[guildId] && state.__reports[guildId][slug]) || null;
}

// Merges rather than replaces, so a progress-only update (new
// channelId/messageId after editing the standing message mid-sweep)
// doesn't wipe out the last completed sweep's `results`/`totalMods` --
// those need to survive until the NEXT completed sweep replaces them,
// since they're what keeps the report's body populated while a new
// sweep is still running.
function setReportRef(guildId, slug, partialRef) {
  const state = loadState();
  if (!state.__reports) state.__reports = {};
  if (!state.__reports[guildId]) state.__reports[guildId] = {};
  const existing = state.__reports[guildId][slug] || {};
  state.__reports[guildId][slug] = { ...existing, ...partialRef };
  saveState(state);
}

// Same idea as getReportRef/setReportRef, but for the overflow
// continuation message -- kept separate so it can be created, edited, or
// deleted independently of the main report (e.g. this sweep has no
// overflow even though the last one did, so the old continuation message
// needs to disappear rather than linger with stale entries).
function getOverflowRef(guildId, slug) {
  const state = loadState();
  return (state.__overflow && state.__overflow[guildId] && state.__overflow[guildId][slug]) || null;
}

function setOverflowRef(guildId, slug, ref) {
  const state = loadState();
  if (!state.__overflow) state.__overflow = {};
  if (!state.__overflow[guildId]) state.__overflow[guildId] = {};
  state.__overflow[guildId][slug] = ref;
  saveState(state);
}

function clearOverflowRef(guildId, slug) {
  const state = loadState();
  if (state.__overflow && state.__overflow[guildId]) {
    delete state.__overflow[guildId][slug];
  }
  saveState(state);
}

// A stable fingerprint of "the stuff a reader would actually care about"
// -- which mods are outdated/unavailable, and at what version. Sweeps
// re-check every mod from scratch each time, so results order and
// healthy-mod entries can shuffle run to run without anything meaningful
// having changed; comparing full result arrays would treat that as a
// change and defeat the point of deduping reports.
function computeSignature(results) {
  return results
    .filter((r) => r.outdated || r.unavailable)
    .map((r) => `${r.modId}:${r.outdated ? r.latestVersion : ''}:${r.unavailable ? '1' : '0'}`)
    .sort()
    .join('|');
}

// Fetches a mod's publish status. Returns null (rather than throwing) on
// failure so one bad mod doesn't abort the whole batch -- the caller just
// skips it and it gets retried on the next sweep.
async function fetchModStatus(domainName, modId, apiKey, appName, appVersion) {
  const url = `https://api.nexusmods.com/v1/games/${domainName}/mods/${modId}.json`;
  try {
    const res = await axios.get(url, {
      headers: {
        apikey: apiKey,
        'Application-Name': appName,
        'Application-Version': appVersion
      },
      timeout: 10000
    });
    return res.data.status; // 'published', 'not_published', 'hidden', 'removed', ...
  } catch (err) {
    logger.warn(`[COLLECTION_HEALTH] Failed to fetch mod status ${domainName}/${modId}: ${err.message}`);
    return null;
  }
}

// Determines whether the bundled file is still current by checking the
// mod's actual file list, not the mod page's own "Version" field --
// authors set that field once and routinely never touch it again as new
// files go up, so comparing against it produces exactly the false
// positives this was rewritten to fix (a bundled file reading e.g.
// "2.1.0" against a mod-level version field stuck at "1"). A file is
// current if it's still present and not marked as an old/superseded
// version; if it's been superseded, file_updates gives the chain of
// replacement file IDs so we can walk forward to the actual latest file
// and report its real version.
async function fetchFileStatus(domainName, modId, bundledFileId, apiKey, appName, appVersion) {
  const url = `https://api.nexusmods.com/v1/games/${domainName}/mods/${modId}/files.json`;
  try {
    const res = await axios.get(url, {
      headers: {
        apikey: apiKey,
        'Application-Name': appName,
        'Application-Version': appVersion
      },
      timeout: 10000
    });

    const files = res.data.files || [];
    const byId = new Map(files.map((f) => [f.file_id, f]));
    const updates = res.data.file_updates || [];
    const nextFileId = new Map(updates.map((u) => [u.old_file_id, u.new_file_id]));

    let current = byId.get(bundledFileId);
    if (!current) {
      // Bundled file has dropped off the files list entirely (deleted,
      // or the mod itself was taken down) -- can't confirm a version,
      // so don't report an outdated status we can't back up.
      return null;
    }

    // Walk the replacement chain forward to whatever file actually
    // superseded ours, in case there have been several updates since.
    let seen = new Set();
    while (current.category_name === 'OLD_VERSION' && nextFileId.has(current.file_id) && !seen.has(current.file_id)) {
      seen.add(current.file_id);
      const next = byId.get(nextFileId.get(current.file_id));
      if (!next) break;
      current = next;
    }

    return {
      latestVersion: current.version,
      outdated: current.file_id !== bundledFileId
    };
  } catch (err) {
    logger.warn(`[COLLECTION_HEALTH] Failed to fetch file list ${domainName}/${modId}: ${err.message}`);
    return null;
  }
}

// Lets the caller skip fetching modFiles from Nexus when it wouldn't be
// used anyway -- only needed to start a brand new sweep.
function hasActiveSweep(guildId, slug) {
  const state = loadState();
  const sweep = getSweep(state, guildId, slug);
  return Boolean(sweep && (sweep.queue.length > 0 || sweep.totalMods > 0));
}

// Starts a fresh sweep from a collection's currently bundled mod list.
function startSweep(modFiles) {
  const queue = modFiles
    .filter((mf) => mf.file && mf.file.mod)
    .map((mf) => ({
      modId: mf.file.mod.modId,
      domainName: mf.file.mod.game.domainName,
      name: mf.file.mod.name,
      bundledFileId: mf.file.fileId,
      bundledVersion: mf.file.version
    }));

  return {
    queue,
    totalMods: queue.length,
    results: [],
    sweepStartedAt: new Date().toISOString()
  };
}

/**
 * Runs one batch of a guild+collection's health sweep. Starts a new sweep
 * automatically if none is in progress. Returns { done: false } if the
 * sweep isn't finished yet, or { done: true, results, totalMods } once
 * every mod in the collection has been checked -- caller is responsible
 * for posting/using the report and NOT calling this again until it wants
 * a fresh sweep to start (call resetSweep() first).
 *
 * @param {string} guildId
 * @param {string} slug            Collection slug.
 * @param {object[]} modFiles      Only needed to start a new sweep -- pass
 *   the latest collectionRevision's modFiles (e.g. from RevisionMonitor's
 *   existing fetchRevision call). Ignored if a sweep is already in progress.
 * @param {object} nexusCreds      { apiKey, appName, appVersion }
 */
async function runBatch(guildId, slug, modFiles, nexusCreds) {
  const state = loadState();
  let sweep = getSweep(state, guildId, slug);

  if (!sweep || sweep.queue.length === 0 && sweep.totalMods === 0) {
    sweep = startSweep(modFiles);
    setSweep(state, guildId, slug, sweep);
  }

  if (sweep.queue.length === 0) {
    // Sweep already fully checked but not yet collected by the caller.
    return { done: true, results: sweep.results, totalMods: sweep.totalMods };
  }

  const batchSize = Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.ceil(sweep.totalMods / SWEEP_HOURS)));
  const batch = sweep.queue.splice(0, batchSize);

  for (const mod of batch) {
    const status = await fetchModStatus(mod.domainName, mod.modId, nexusCreds.apiKey, nexusCreds.appName, nexusCreds.appVersion);
    if (status === null) continue; // couldn't check it this time, drop silently -- next full sweep will retry

    const unavailable = status !== 'published';
    let latestVersion = mod.bundledVersion;
    let outdated = false;

    if (!unavailable) {
      const fileStatus = await fetchFileStatus(mod.domainName, mod.modId, mod.bundledFileId, nexusCreds.apiKey, nexusCreds.appName, nexusCreds.appVersion);
      if (fileStatus) {
        latestVersion = fileStatus.latestVersion;
        outdated = fileStatus.outdated;
      }
      // fileStatus === null means the bundled file couldn't be matched
      // against the current files list -- leave it as not-outdated
      // rather than guessing; it'll be retried next sweep.
    }

    sweep.results.push({
      name: mod.name,
      modId: mod.modId,
      domainName: mod.domainName,
      bundledVersion: mod.bundledVersion,
      latestVersion,
      outdated,
      unavailable
    });
  }

  setSweep(state, guildId, slug, sweep);
  saveState(state);

  if (sweep.queue.length === 0) {
    return { done: true, results: sweep.results, totalMods: sweep.totalMods };
  }

  return { done: false, checkedSoFar: sweep.results.length, totalMods: sweep.totalMods };
}

// Clears a guild+collection's sweep so the next runBatch() call starts
// fresh -- call after consuming a { done: true } result.
function resetSweep(guildId, slug) {
  const state = loadState();
  if (state[guildId]) {
    delete state[guildId][slug];
  }
  saveState(state);
}

const formatOutdatedLine = (m) =>
  `[${m.name}](https://www.nexusmods.com/${m.domainName}/mods/${m.modId}) (${m.bundledVersion} → ${m.latestVersion})`;
const formatUnavailableLine = (m) =>
  `[${m.name}](https://www.nexusmods.com/${m.domainName}/mods/${m.modId})`;

// Formats a capped list of "Name (vBundled -> vLatest)" lines. Discord
// embed fields hard-cap at 1024 characters, and discord.js throws
// (AggregateError: "Received one or more errors") rather than truncating
// for you. Item count alone isn't enough to guarantee that: a collection
// revision that bumps a lot of mods at once can put more genuinely
// outdated mods in one field than ever before, and even 20 realistic
// "[Name](url) (v1 -> v2)" lines can run 2-3x past 1024 chars on their
// own -- confirmed the exact failure mode after a bulk revision update.
// So this budgets by actual character count too, not just item count --
// and, instead of silently dropping whatever didn't fit behind a mystery
// "+N more", returns those leftover mods so the caller can put them in an
// overflow continuation message instead of losing them.
function formatModList(mods, formatter, { itemCap = 20, charBudget = 950 } = {}) {
  const lines = [];
  let used = 0;

  for (const mod of mods) {
    if (lines.length >= itemCap) break;
    const line = formatter(mod);
    if (used + line.length + 1 > charBudget) break; // +1 for the joining newline
    lines.push(line);
    used += line.length + 1;
  }

  const overflowMods = mods.slice(lines.length);
  return { text: lines.join('\n') || 'None', overflowMods };
}

// Splits a mod list into 1024-char-safe text chunks, one per eventual
// embed field -- used for the overflow continuation message, which can
// itself need more than one field/embed if enough mods spilled over.
function chunkModList(mods, formatter, charBudget = 950) {
  const chunks = [];
  let current = [];
  let used = 0;

  for (const mod of mods) {
    const line = formatter(mod);
    if (used > 0 && used + line.length + 1 > charBudget) {
      chunks.push(current.join('\n'));
      current = [];
      used = 0;
    }
    current.push(line);
    used += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

/**
 * Builds the main report embed. `results` is always the last FULLY
 * completed sweep's data -- while a new sweep is running, that's
 * intentionally stale-but-labeled data rather than the new sweep's
 * partial results, since showing only the mods re-checked so far would
 * misrepresent the ones not yet re-checked this pass as healthy.
 *
 * @param {object} meta
 * @param {number} meta.checkedSoFar  Mods checked in the CURRENT sweep.
 * @param {number} meta.totalMods     Mods in the CURRENT (or, if
 *   justRestarted, the previous) sweep.
 * @param {boolean} [meta.complete]   True once the current sweep finished.
 * @param {boolean} [meta.firstSweep] True if there's no completed sweep
 *   yet at all (nothing to show in the body).
 * @param {boolean} [meta.justRestarted] True right when a revision change
 *   reset the sweep -- distinct wording from an ordinary in-progress tick.
 * @returns {{ embed: EmbedBuilder, overflow: { outdated: object[], unavailable: object[] } }}
 */
function buildHealthReportEmbed(collectionDisplay, results, meta = {}) {
  const { checkedSoFar = 0, totalMods = 0, complete = true, firstSweep = false, justRestarted = false } = meta;

  const embed = new EmbedBuilder()
    .setTitle(`🩺 Collection Health Report — ${collectionDisplay}`)
    .setTimestamp();

  const overflow = { outdated: [], unavailable: [] };

  if (firstSweep) {
    embed
      .setColor(0x5865f2)
      .setDescription('First health sweep in progress — results will appear here once it completes.');
  } else {
    const outdated = results.filter((r) => r.outdated && !r.unavailable);
    const unavailable = results.filter((r) => r.unavailable);
    const healthy = results.length - outdated.length - unavailable.length;

    embed
      .setColor(outdated.length + unavailable.length > 0 ? 0xffa52e : 0x78ffa0)
      .setDescription(
        `Checked **${results.length}** mods against their current Nexus listing.\n` +
        `✅ ${healthy} up to date · 🔄 ${outdated.length} outdated · ⚠️ ${unavailable.length} unavailable`
      );

    if (outdated.length > 0) {
      const { text, overflowMods } = formatModList(outdated, formatOutdatedLine);
      embed.addFields({ name: '🔄 Outdated (bundled → latest)', value: text });
      overflow.outdated = overflowMods;
    }

    if (unavailable.length > 0) {
      const { text, overflowMods } = formatModList(unavailable, formatUnavailableLine);
      embed.addFields({ name: '⚠️ No longer published on Nexus', value: text });
      overflow.unavailable = overflowMods;
    }

    const overflowCount = overflow.outdated.length + overflow.unavailable.length;
    if (overflowCount > 0) {
      embed.addFields({
        name: '📄 More',
        value: `${overflowCount} additional ${overflowCount === 1 ? 'entry' : 'entries'} continued in the message below.`
      });
    }
  }

  let footerText;
  if (justRestarted) {
    footerText = `🔄 Revision update detected — sweep restarted (0 checked so far; previous sweep covered ${totalMods} mods)`;
  } else if (firstSweep) {
    footerText = `First sweep in progress — ${checkedSoFar}/${totalMods} checked so far`;
  } else if (!complete) {
    footerText = `🔄 New sweep in progress — ${checkedSoFar}/${totalMods} checked so far (results above are from the previous sweep)`;
  } else {
    footerText = `✅ Full sweep complete — ${totalMods}/${totalMods} checked`;
  }
  embed.setFooter({ text: footerText });

  return { embed, overflow };
}

// Turns whatever didn't fit in the main report's fields into one or more
// continuation embeds -- grouped into a single message (Discord allows up
// to 10 embeds per message), covering realistic overflow sizes without
// needing multi-message pagination.
function buildOverflowEmbeds(collectionDisplay, overflowOutdated, overflowUnavailable) {
  const fields = [];

  const outdatedChunks = chunkModList(overflowOutdated, formatOutdatedLine);
  outdatedChunks.forEach((chunk, i) => {
    fields.push({
      name: outdatedChunks.length > 1 ? `🔄 Outdated, continued (${i + 1}/${outdatedChunks.length})` : '🔄 Outdated, continued',
      value: chunk
    });
  });

  const unavailableChunks = chunkModList(overflowUnavailable, formatUnavailableLine);
  unavailableChunks.forEach((chunk, i) => {
    fields.push({
      name: unavailableChunks.length > 1 ? `⚠️ Unavailable, continued (${i + 1}/${unavailableChunks.length})` : '⚠️ Unavailable, continued',
      value: chunk
    });
  });

  if (fields.length === 0) return [];

  const embeds = [];
  for (let i = 0; i < fields.length; i += 25) {
    // Discord embeds cap at 25 fields each.
    embeds.push(
      new EmbedBuilder()
        .setTitle(`🩺 Collection Health Report — ${collectionDisplay} (continued)`)
        .setColor(0xffa52e)
        .addFields(fields.slice(i, i + 25))
    );
  }

  if (embeds.length > 10) {
    logger.warn(`[COLLECTION_HEALTH] Overflow for ${collectionDisplay} needed ${embeds.length} embeds -- Discord caps a message at 10, truncating the rest.`);
    return embeds.slice(0, 10);
  }
  return embeds;
}

// Posts a fresh message or edits the existing tracked one in place.
// Shared by the normal hourly report update and RevisionMonitor's
// "sweep restarted" notice, so both go through the same fetch/edit/send
// logic instead of duplicating it. Returns the message id, or null if the
// channel couldn't be reached.
async function postOrEditReport(client, guildId, slug, reportChannelId, embed) {
  const channel = await client.channels.fetch(reportChannelId).catch(() => null);
  if (!channel) {
    logger.warn(`[COLLECTION_HEALTH] Report channel ${reportChannelId} not found for guild ${guildId}`);
    return null;
  }

  const ref = getReportRef(guildId, slug);
  const existingMessage = ref && ref.channelId === reportChannelId
    ? await channel.messages.fetch(ref.messageId).catch(() => null)
    : null;

  if (existingMessage) {
    await existingMessage.edit({ embeds: [embed] });
    return existingMessage.id;
  }

  const sent = await channel.send({ embeds: [embed] });
  return sent.id;
}

// Creates, updates, or retroactively removes the overflow continuation
// message so it always matches what the current report actually needs --
// a sweep with no overflow this time deletes a leftover one from before
// rather than leaving stale entries sitting there indefinitely.
async function syncOverflowMessage(client, guildId, slug, collectionDisplay, reportChannelId, overflow) {
  const hasOverflow = overflow.outdated.length > 0 || overflow.unavailable.length > 0;
  const existingRef = getOverflowRef(guildId, slug);

  if (!hasOverflow) {
    if (existingRef) {
      const channel = await client.channels.fetch(existingRef.channelId).catch(() => null);
      const msg = channel ? await channel.messages.fetch(existingRef.messageId).catch(() => null) : null;
      if (msg) await msg.delete().catch(() => {});
      clearOverflowRef(guildId, slug);
    }
    return;
  }

  const embeds = buildOverflowEmbeds(collectionDisplay, overflow.outdated, overflow.unavailable);
  const channel = await client.channels.fetch(reportChannelId).catch(() => null);
  if (!channel) {
    logger.warn(`[COLLECTION_HEALTH] Overflow channel ${reportChannelId} not found for guild ${guildId}`);
    return;
  }

  const existingMessage = existingRef && existingRef.channelId === reportChannelId
    ? await channel.messages.fetch(existingRef.messageId).catch(() => null)
    : null;

  if (existingMessage) {
    await existingMessage.edit({ embeds });
  } else {
    const sent = await channel.send({ embeds });
    setOverflowRef(guildId, slug, { channelId: reportChannelId, messageId: sent.id });
  }
}

// Called by RevisionMonitor the moment it detects a new collection
// revision -- posts/edits the standing report immediately so it's
// obvious the bot noticed and is re-checking, rather than silently
// sitting on now-stale results for up to a day until the new sweep
// finishes on its own.
async function postSweepRestartedNotice(client, guildId, slug, collectionDisplay, reportChannelId) {
  if (!reportChannelId) return; // guild isn't opted into collection health reports

  const ref = getReportRef(guildId, slug);
  const priorResults = ref ? ref.results || [] : [];
  const priorTotal = ref ? ref.totalMods || priorResults.length : 0;

  const { embed } = buildHealthReportEmbed(collectionDisplay, priorResults, {
    checkedSoFar: 0,
    totalMods: priorTotal,
    complete: false,
    firstSweep: !ref,
    justRestarted: true
  });

  const messageId = await postOrEditReport(client, guildId, slug, reportChannelId, embed);
  if (messageId) {
    setReportRef(guildId, slug, { channelId: reportChannelId, messageId });
  }
}

module.exports = {
  runBatch,
  resetSweep,
  buildHealthReportEmbed,
  buildOverflowEmbeds,
  postOrEditReport,
  syncOverflowMessage,
  postSweepRestartedNotice,
  hasActiveSweep,
  getReportRef,
  setReportRef,
  getOverflowRef,
  setOverflowRef,
  clearOverflowRef,
  computeSignature
};
