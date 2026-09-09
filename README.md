# PreemBot

<p align="center">
  <img src="assets/preem-edition-banner.png" alt="Preem Edition" style="max-width: 100%; height: auto;">
</p>

The Discord bot behind the **Preem Team** Cyberpunk 2077 collection —
moderation, anti-spam, community leaderboards, automated changelogs, and a
handful of features that keep the [preemteam.com](https://preemteam.com)
website in sync with what's happening in Discord.

---

## 🚀 Quickstart

```sh
# Clone and install
git clone https://github.com/mquiny/PreemBot.git
cd PreemBot
npm install

# Copy and edit environment config
cp .env.example .env
# (edit .env with your secrets)

# Run the bot
npm start
```

---

## ✨ Features

### ⚖️ Moderation
- `/warn`, `/warnings`, `/clearwarnings` — per-guild warning system with persistent storage
- `/timeout` — timeout a user for a specified duration with a logged reason
- `/slowmode` — set or clear slowmode on the current channel
- `/mediachannels` — enforce image/media-only posting in designated channels

### 🛡️ Anti-Spam
A multi-rule detection engine (`/antispam` to configure), all scoped per guild:
- **Multi-channel spam** — the same message posted across several channels in a short window
- **Rapid posting** — too many messages too fast
- **Image spam** — a burst of images in a short window
- **Channel carpet-bomb** — posting in several *specific watched* channels back to back
- **New account risk** — flags accounts under a configurable age, combined with another trigger
- **Suspicious pattern matching** — catches a single scam/phishing message in one channel (the case none of the behavioral rules above cover) by matching known scam phrases; deliberately **delete-only** with no automatic timeout, since a keyword match is far more likely to be a false positive than a behavioral one — it deletes the message and flags it for a moderator to action, nothing more
- High-confidence detections auto-timeout + auto-delete and post a mod alert embed with Confirm / False Positive / Ban / Adjust Timeout buttons; lower-confidence ones are flagged for review only
- Configurable per-guild whitelist (moderator roles auto-whitelisted)

### 📋 Audit Logging
- `/auditlog` — toggle individual event types, set the log channel, check status
- Tracks bans, kicks, joins/leaves, timeouts, role/nickname changes, message edits/deletions, channel and thread changes
- Anti-loop protection so the audit channel doesn't log itself

### 📊 Revision Tracking & Changelogs
- Polls NexusMods for collection updates and generates changelogs between revisions (added/updated/removed mods)
- `/changelog` to post manually, `/changelog-config` to configure per-guild
- `/convertembed` — converts a posted changelog embed into Nexus-ready Markdown for cross-posting
- Automatically dispatches new changelog entries to the website's [Changelog page](https://preemteam.com/changelog/)

### 🏆 StreetCred
- `/streetcred` — a community activity leaderboard with configurable ranks/system name per guild
- Daily snapshot automatically syncs to the site's [StreetCred Leaderboard](https://preemteam.com/team/streetcred/), with a staff/non-staff filter

### 🩺 Collection Health
- Hourly automated sweep checking every mod in a tracked collection against its current Nexus listing, paced to stay well under Nexus's API rate limit even for collections with 900+ mods
- Flags mods that are outdated (comparing actual bundled file versions, not the often-stale mod-page "Version" field) or no longer published
- Posts one standing report per collection that's edited in place — no repeat spam when nothing's changed since the last sweep

### 🔔 Auto-Responder
- `/autoresponder` (mod only) — add/edit/delete/list trigger-based auto-responses, with wildcard matching and per-channel restrictions
- Automatically syncs the full current list to the website's [Quick Commands](https://preemteam.com/troubleshooting/quick_commands/) page

### 📸 SnapMaster / SnapSmith
- Tracks monthly photomode/showcase submissions in a configured showcase channel, with `/snapmaster-check` and `/snapmaster-stats` to see standings and `/snapmaster-announce` for monthly recap posts
- SnapSmith grants a recognition role to members who've kept up a strong showcase presence, with `/snapsmith-admin` for management

### 📊 Server Stats
- Auto-creates and maintains a set of locked, display-only voice channels per guild: **Family Members** (total member count), **Boosters** (server boost count), and — when a collection is configured — **Mods** (distinct mod count in the collection's current revision) and **Revision** (its revision number)
- Kept up to date every 10 minutes
- Opt-in per guild via `STATS_CATEGORY_IDS` (and `STATS_COLLECTION_SLUGS` for the Mods/Revision pair) — a guild with no category configured gets no stat channels at all

### 📈 Utility & Admin
- `/analytics` — server activity analytics (mod/admin only)
- `/servers` — list every server the bot is currently in
- `/diagnostics` — diagnostic tools for troubleshooting the bot itself
- `/ncrbotmsg` — post a multi-line message as the bot via a modal (admin only)
- `/postembed` — post one or more rich embeds from a Discohook JSON export, straight from an attached `.json` file (admin only)

---

## 📁 Directory Structure

```
PreemBot/
  commands/                       # Slash command handlers, grouped by category
  config/                         # Static + per-guild config (spam rules, roles, collections, etc.)
  data/                           # Persistent runtime data (warnings, spam stats, snapmaster, etc.)
  events/                         # Discord event handlers (messageCreate, interactionCreate, audit events, etc.)
  handlers/                       # Interaction routing (buttons, modals, commands)
  services/                       # High-level logic
    ├── changelog/                # Changelog generation with per-collection templates
    ├── spam/                     # Anti-spam engine (SpamDetector, SpamActionHandler, rules/)
    ├── CollectionHealthService.js
    ├── StreetCredService.js / StreetCredSiteSnapshot.js
    ├── ModerationService.js
    └── RevisionMonitor.js
  utils/                          # Helpers (logger, guildConfig, site dispatchers, permissions, etc.)
  index.js                        # Bot entry point
  deploy-commands.js              # Slash command registration
  .env.example                    # Environment variable template
```

---

## ⚙️ Environment Variables

All configuration is managed through `.env`. **Never commit your real `.env` file — use `.env.example` as a template.**

| Variable                        | Required | Description                                                    |
|----------------------------------|----------|------------------------------------------------------------------|
| `DISCORD_TOKEN`                 | ✅       | Discord bot token                                                |
| `CLIENT_ID`                     | ✅       | Discord Application Client ID (for `deploy-commands.js`)         |
| `NEXUS_API_KEY`                 | ✅       | NexusMods API key for revision polling & collection health       |
| `APP_NAME` / `APP_VERSION`      | ❌       | Application headers for Nexus API requests                       |
| `AUTO_SYNC_COMMANDS`            | ❌       | Auto-sync slash commands on startup (default: false)              |
| `GUILD_IDS`                     | ❌       | Comma-separated guild IDs slash commands are registered to        |
| `GUILD_ID`                      | ❌       | Legacy single guild ID, used only if `GUILD_IDS` is unset          |
| `SHOWCASE_CHANNEL_IDS`          | ❌       | Per-guild showcase channel map (`guildId:channelId,...`)          |
| `BOT_SPAM_CHANNEL_IDS`          | ❌       | Per-guild StreetCred/announcement channel map                     |
| `COLLECTION_HEALTH_CHANNEL_IDS` | ❌       | Per-guild collection health report channel map                    |
| `STATS_CATEGORY_IDS`            | ❌       | Per-guild category to create the stat voice channels under                |
| `STATS_COLLECTION_SLUGS`        | ❌       | Per-guild collection slug for the Mods/Revision stat channels             |
| `LOG_LEVEL`                     | ❌       | Winston log level (default: info)                                 |

See `.env.example` for the full template.

---

## 🚀 Deployment

- **Deploy slash commands:** `node deploy-commands.js` (or set `AUTO_SYNC_COMMANDS=true` to do it automatically on every startup)
- Hosted on Cybrancee, pulling from the `main` branch of this repo on restart

---

## 🔒 Security Notes

- Never commit a real `.env` file or any secrets
- Only grant the bot the minimum Discord permissions it needs
- Keep dependencies up to date (`npm audit`)

---

## 💬 Support

Join the [Preem Team Discord](https://discord.gg/QvYzYZFmnE) for questions or support.

---

## 📝 License

MIT
