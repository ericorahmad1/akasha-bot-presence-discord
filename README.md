# presence-bot — Akasha team availability (Discord)

A Discord bot for Akasha's team availability: clock in/out, working status (Online, Partial, On-Meeting, Sick,
On-Leave, Offline), sick and leave requests with approval, reminders, automatic clock-out, daily and weekly recaps,
and a polite auto-reply when someone mentions a person who is not available.

**It runs beside meeting-bot and does not change it.** Claims made with meeting-bot's `/claim` are detected by
reading Clockify's running timers (read-only). presence-bot has its own Discord application, its own pm2 process
and its own SQLite file.

---

## Contents

1. [Overview](#overview)
2. [Requirements](#requirements)
3. [Quick start (local test)](#quick-start-local-test)
4. [Step 1: Discord setup](#step-1-discord-setup)
5. [Step 2: Clockify setup](#step-2-clockify-setup)
6. [Step 3: Configure `.env`](#step-3-configure-env)
7. [Step 4: Roster and holidays](#step-4-roster-and-holidays)
8. [Step 5: Deploy on the VPS](#step-5-deploy-on-the-vps)
9. [Step 6: Switch on in stages](#step-6-switch-on-in-stages)
10. [Day-to-day operations](#day-to-day-operations)
11. [Updating the bot](#updating-the-bot)
12. [Backup and restore](#backup-and-restore)
13. [How it works](#how-it-works)
14. [Commands](#commands)
15. [Schedule (WITA)](#schedule-wita)
16. [Code map](#code-map)
17. [Troubleshooting](#troubleshooting)
18. [Handover checklist](#handover-checklist)

---

## Overview

| Channel (category "Akasha Status Availability") | Used for | Who posts |
| --- | --- | --- |
| `#team-status` | Pinned status board + clock in/out/status posts | Bot only |
| `#team-status-manage` | Sick/leave cards with Approve/Reject buttons, claim-during-absence notes | Bot + management |
| `#team-status-log` | Audit trail, "not clocked in" list, daily and weekly recaps, heartbeat | Bot only |

| Role | Who | Can do |
| --- | --- | --- |
| Presence Employee | Interns + core team | Clock in/out, set status, report sick/leave, see own hours |
| Presence Management | Yuni, Ayu, Chris | Everything above + approve/reject absences, `/report-attendance`, see full status details |
| Presence Admin | Chris | Everything above + `/presence-admin` (fix sessions, set status, holidays, re-post board) |

> Who can clock in is decided by the **roster** (`roster.json` → database), not by the Discord role. The Employee
> role controls who can see `#team-status` and use the commands there.

---

## Requirements

| What | Version / note |
| --- | --- |
| Node.js | **22.13 or newer** (uses the built-in `node:sqlite`, so there is no native build). Check with `node -v` |
| npm | Comes with Node.js |
| pm2 | Already on the VPS for meeting-bot. Otherwise: `npm install -g pm2` |
| npm dependencies | Only `discord.js` |
| Discord | Admin access to the Akasha server + Discord Developer Portal |
| Clockify | A **workspace admin** API key (optional, but needed for claim detection and Clockify hours) |

The bot keeps all times in UTC and shows them in **WITA** (Asia/Makassar, UTC+8). The server time zone does not
matter, but `ecosystem.config.cjs` sets `TZ=Asia/Makassar` so pm2 log timestamps are in WITA too.

---

## Quick start (local test)

For testing on a laptop before the VPS (Windows, macOS or Linux):

```bash
cd presence-bot
npm install
npm test                                  # 12 logic tests, no Discord or Clockify needed
cp .env.example .env                      # Windows PowerShell: Copy-Item .env.example .env
# fill .env (see Step 3). Use a test server / test channels if possible.
cp roster.example.json roster.json        # then edit with real Discord IDs
npm run seed -- ./roster.json
npm run register                          # registers slash commands in GUILD_ID
npm start                                 # runs in the foreground; Ctrl+C to stop
```

On start the console shows:

```text
presence-bot logged in as Presence#1234 · enabled=true · dryRun=true · clockify=true
```

If `enabled=false`, the bot is online but every command answers "Presence bot is paused at the moment."

---

## Step 1: Discord setup

About 30 minutes, done once by a Discord server admin (Chris).

1. Open <https://discord.com/developers/applications> → **New Application** → name it "Presence"
   (a separate application from meeting-bot).
2. **General Information**: copy the **Application ID** → `DISCORD_APP_ID` in `.env`.
3. **Bot** tab → **Reset Token** → copy it → `DISCORD_TOKEN` in `.env`. Treat it like a password: never post it in
   chat or commit it to git.
4. **Privileged Gateway Intents**: none needed. Only turn on *Message Content Intent* if the mention auto-reply does
   not work in testing, and then also set `MESSAGE_CONTENT_INTENT=true`.
5. **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: View Channels, Send Messages, Read Message History, Embed Links, Pin Messages / Manage Messages
   - Open the generated URL and add the bot to the Akasha server.
6. In the Akasha server, create the roles **Presence Employee**, **Presence Management** and **Presence Admin**,
   and give them to the right people.
7. Create the category **Akasha Status Availability** with the three channels and these permissions:

| Channel | @everyone | Presence Employee | Presence Management | Presence bot |
| --- | --- | --- | --- | --- |
| #team-status | ✖ View | ✔ View, ✔ Use Application Commands, ✖ Send Messages | ✔ View | ✔ View, Send, Pin/Manage Messages |
| #team-status-manage | ✖ View | ✖ View | ✔ View, Send, Use Application Commands | ✔ View, Send |
| #team-status-log | ✖ View | ✖ View | ✔ View, ✖ Send | ✔ View, Send |

8. Turn on **Developer Mode** (User Settings → Advanced). Right-click to **Copy ID** for:
   - the server → `GUILD_ID`
   - the three channels → `CH_STATUS`, `CH_MANAGE`, `CH_LOG`
   - the three roles (Server Settings → Roles) → `ROLE_EMPLOYEE`, `ROLE_MANAGEMENT`, `ROLE_ADMIN`
   - each team member (right-click the user) → `discord_id` in `roster.json`

---

## Step 2: Clockify setup

Clockify is optional. Without it the bot still works, but claim detection, Clockify hours in `/myhours` and the
weekly recap, and "last activity" for auto clock-out are turned off (`clockify=false` in the start-up log).

1. Log in to Clockify as a **workspace admin** → Profile settings → **API** → generate a key →
   `CLOCKIFY_API_KEY`. An admin key is needed to see everyone's running timer.
2. Workspace ID → `CLOCKIFY_WORKSPACE_ID`. It is in the URL of the workspace settings page, or:
   ```bash
   curl -H "X-Api-Key: $CLOCKIFY_API_KEY" https://api.clockify.me/api/v1/workspaces
   ```
3. Each person's Clockify user ID → `clockify_user_id` in `roster.json` (Clockify → Team, or):
   ```bash
   curl -H "X-Api-Key: $CLOCKIFY_API_KEY" https://api.clockify.me/api/v1/workspaces/<WORKSPACE_ID>/users
   ```

The bot only **reads** Clockify. It never starts, stops or edits timers.

---

## Step 3: Configure `.env`

Copy `.env.example` to `.env` and fill it in. `.env` is in `.gitignore`; keep it only on the server.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | ✔ | — | Bot token (Developer Portal → Bot) |
| `DISCORD_APP_ID` | ✔ (for `npm run register`) | — | Application ID |
| `GUILD_ID` | ✔ | — | Akasha server ID |
| `CH_STATUS` | ✔ | — | `#team-status` channel ID |
| `CH_MANAGE` | ✔ | — | `#team-status-manage` channel ID |
| `CH_LOG` | ✔ | — | `#team-status-log` channel ID |
| `ROLE_EMPLOYEE` | | — | Presence Employee role ID |
| `ROLE_MANAGEMENT` | ✔ in practice | — | Presence Management role ID (approvals, `/report-attendance`) |
| `ROLE_ADMIN` | ✔ in practice | — | Presence Admin role ID (`/presence-admin`) |
| `CLOCKIFY_API_KEY` | | — | Workspace admin API key. Empty = Clockify features off |
| `CLOCKIFY_WORKSPACE_ID` | | — | Clockify workspace ID |
| `PRESENCE_ENABLED` | | `false` | **Kill switch.** `false` = commands answer "paused" and no jobs run |
| `DRY_RUN` | | `true` | `true` = posts start with `[TEST]` and DMs are written to `#team-status-log` instead |
| `POLICY_SICK` | | `B` | `A` = needs approval, `B` = self-declared, management is notified |
| `POLICY_LEAVE` | | `A` | Same choices as above, for leave |
| `AUTO_CLOCKIN_ON_CLAIM` | | `true` | A `/claim` while offline clocks the person in automatically (flagged) |
| `MEETING_DEFAULT_MIN` | | `30` | Default On-Meeting length in minutes |
| `LATE_GRACE_MIN` | | `15` | Grace minutes after start time |
| `MENTION_AUTOREPLY` | | `true` | Auto-reply when an unavailable person is mentioned |
| `MENTION_COOLDOWN_MIN` | | `60` | At most one auto-reply per person per channel in this many minutes |
| `MENTION_DELETE_AFTER_MIN` | | `10` | Delete the auto-reply after N minutes (`0` = keep it) |
| `MESSAGE_CONTENT_INTENT` | | `false` | Only `true` if the mention auto-reply never fires (enable the intent in the Portal too) |
| `CLAIM_POLL_SEC` | | `60` | How often Clockify running timers are checked |
| `DB_PATH` | | `./data/presence.db` | SQLite database file |
| `BACKUP_DIR` | | `./data/backups` | Where nightly backups go |

The bot refuses to start if `DISCORD_TOKEN`, `GUILD_ID`, `CH_STATUS`, `CH_MANAGE` or `CH_LOG` is missing, and the
error names the missing ones.

---

## Step 4: Roster and holidays

### Roster (`roster.json`)

Copy `roster.example.json` to `roster.json`. One entry per person:

```json
{
  "discord_id": "111111111111111111",
  "name": "Erico",
  "team": "Tech Team",
  "kind": "intern",
  "clocks_in": true,
  "clockify_user_id": "paste-clockify-user-id",
  "work_start": "09:00",
  "work_end": "17:00",
  "work_days": "1,2,3,4,5"
}
```

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `discord_id` | ✔ | — | Discord user ID (17–20 digits, as a string) |
| `name` | ✔ | — | Name shown on posts and recaps |
| `team` | | `""` | Team shown next to the name |
| `kind` | | `core` | `intern`, `core` or `management` |
| `clocks_in` | | `true` | `false` = no clock-in, no reminders (e.g. management) |
| `clockify_user_id` | | `null` | Needed for claim detection and Clockify hours. Must be unique |
| `work_start` / `work_end` | | `09:00` / `17:00` | Working hours in WITA (`HH:MM`) |
| `work_days` | | `1,2,3,4,5` | `1` = Monday … `7` = Sunday |
| `active` | | `true` | `false` = person is ignored (use this when someone leaves) |

Load it into the database:

```bash
npm run seed -- ./roster.json
```

- Seeding is **insert or update**; it can be run again at any time and needs no restart.
- Removing a person from `roster.json` does **not** remove them from the database. To take someone off, set
  `"active": false` and seed again. Their history is kept.
- `roster.json` holds real IDs and is in `.gitignore`.

### Holidays (`holidays.json`)

No reminders and no "not clocked in" list on holidays. Copy `holidays.example.json` to `holidays.json`, list the
official national holidays, and load them:

```json
[
  { "date": "2026-12-25", "name": "Christmas Day" }
]
```

```bash
npm run holidays -- ./holidays.json
```

A single holiday can also be added from Discord with `/presence-admin holiday`.

---

## Step 5: Deploy on the VPS

Install it as a sibling folder of meeting-bot:

```bash
# 1. Get the code
cd /opt                                   # or wherever meeting-bot lives
git clone <repo-url> presence-bot          # or upload and unzip the folder
cd presence-bot
node -v                                   # must be 22.13 or newer

# 2. Install
npm install --omit=dev

# 3. Configure (keep PRESENCE_ENABLED=false and DRY_RUN=true for now)
cp .env.example .env && nano .env
chmod 600 .env

# 4. Load data
cp roster.example.json roster.json && nano roster.json
npm run seed -- ./roster.json
cp holidays.example.json holidays.json && nano holidays.json
npm run holidays -- ./holidays.json

# 5. Register slash commands in the Akasha server
npm run register                          # "Registered 8 commands: /clock-in, /clock-out, ..."

# 6. Test the logic
npm test

# 7. Start under pm2
pm2 start ecosystem.config.cjs
pm2 save                                  # remember it across reboots
pm2 logs Akashapresence-bot --lines 50
```

> **pm2 process name:** `ecosystem.config.cjs` names the process **`Akashapresence-bot`**. Use that name in every
> `pm2` command (`pm2 logs`, `pm2 restart`, `pm2 stop`). Run `pm2 ls` to see it next to meeting-bot.

If pm2 is not yet set to start on boot (meeting-bot normally already did this), run `pm2 startup` once and follow
the command it prints, then `pm2 save`.

### Check that it works

1. `pm2 ls` shows `Akashapresence-bot` as **online**.
2. `pm2 logs Akashapresence-bot` shows `presence-bot logged in as ... · enabled=... · dryRun=... · clockify=...`.
3. The bot shows as online in the member list.
4. Typing `/` in `#team-status` shows `/clock-in`, `/clock-out`, `/status`, and so on.
5. Once `PRESENCE_ENABLED=true`: `#team-status-log` gets "presence-bot started …" and `#team-status` gets the pinned
   status board.

---

## Step 6: Switch on in stages

| Stage | `.env` / roster | What happens |
| --- | --- | --- |
| T0 installed | `PRESENCE_ENABLED=false` | Bot online, commands answer "paused", no jobs run |
| T1 dry run | `PRESENCE_ENABLED=true`, `DRY_RUN=true` | Everything runs; posts start with `[TEST]`; DMs go to `#team-status-log` |
| T2–T4 pilot | roster = only the pilot people, `DRY_RUN=false` | Real posts and DMs for those people |
| Go-live | full roster | Everyone |
| Rollback | `PRESENCE_ENABLED=false` then `pm2 restart Akashapresence-bot` (or `pm2 stop Akashapresence-bot`) | Bot answers "paused"; meeting-bot is not affected |

After editing `.env`: `pm2 restart Akashapresence-bot`.
After editing `roster.json`: `npm run seed -- ./roster.json` (no restart needed).

**Go-live checklist**

- [ ] All three channels exist with the permissions from Step 1
- [ ] Roles given to the right people
- [ ] Roster has everyone, with correct working hours and Clockify IDs
- [ ] Holidays for the year are loaded
- [ ] Dry run checked: board pinned, reminders show up in `#team-status-log`, sick/leave cards show Approve/Reject
- [ ] A test `/claim` in meeting-bot shows up in presence-bot within about a minute
- [ ] `DRY_RUN=false` and restarted

---

## Day-to-day operations

| Task | How |
| --- | --- |
| See if it is running | `pm2 ls`; there is also a heartbeat in `#team-status-log` every 6 hours |
| Live logs | `pm2 logs Akashapresence-bot` |
| Restart | `pm2 restart Akashapresence-bot` |
| Pause (kill switch) | `PRESENCE_ENABLED=false` in `.env`, then restart |
| Stop completely | `pm2 stop Akashapresence-bot` |
| Add / change a person | Edit `roster.json`, then `npm run seed -- ./roster.json` |
| Person leaves | Set `"active": false`, then seed |
| Add a holiday | `/presence-admin holiday` or `npm run holidays -- ./holidays.json` |
| Correct clock-in/out times | `/presence-admin fix-session` |
| Correct someone's status | `/presence-admin set-status` |
| Board missing or not pinned | `/presence-admin board` |
| Change wording of messages | `src/format.js` (then restart) |

---

## Updating the bot

```bash
cd /opt/presence-bot
pm2 stop Akashapresence-bot
git pull                                  # or upload the new files (keep .env, roster.json and data/)
npm install --omit=dev
npm test
npm run register                          # only needed if src/discord/commands.js changed
pm2 start Akashapresence-bot              # or: pm2 restart Akashapresence-bot
pm2 logs Akashapresence-bot --lines 50
```

The database schema is created automatically on start (`CREATE TABLE IF NOT EXISTS`), so no migration step is
needed for the current version.

---

## Backup and restore

Automatic, every night at 02:00 WITA:

- `data/backups/presence-YYYY-MM-DD.db`: daily copy, the last **14** are kept.
- `data/backups/archive-YYYY-MM.db`: monthly archive on the 1st of each month.
- On the 1st of each month, closed sessions, events and absences older than **12 months** are deleted from the live
  database (they are still in the archives).

It is worth copying `data/backups/` off the VPS from time to time as well.

**Restore:**

```bash
cd /opt/presence-bot
pm2 stop Akashapresence-bot
mv data/presence.db data/presence.db.broken
rm -f data/presence.db-wal data/presence.db-shm
cp data/backups/presence-2026-11-23.db data/presence.db
pm2 start Akashapresence-bot
```

---

## How it works

**Statuses**

| Status | Meaning | Set by |
| --- | --- | --- |
| Online | Working, normal response | `/clock-in`, `/status set online`, a Clockify claim, end of a meeting |
| Partial | Working, slow response | `/status set partial` |
| On-Meeting | Do not disturb, ends by itself after N minutes | `/status set on-meeting [minutes]` |
| Sick | Absent | `/sick` (Policy B: right away; Policy A: after approval) |
| On-Leave | Absent | `/on-leave` (Policy A: after approval) |
| Offline | Not working | `/clock-out`, auto clock-out at 22:00, end of an absence |

**Main rules** (`src/rules.js`, unit-tested)

- Clock-in is blocked while someone is Sick or On-Leave.
- Partial / On-Meeting need an open session (clock in first).
- A Clockify claim never overrides Sick / On-Leave. It is flagged and management is notified instead.
- A claim while offline clocks the person in automatically if `AUTO_CLOCKIN_ON_CLAIM=true`.
- Clock-out without a clock-in is allowed and flagged.
- At 22:00 open sessions are closed and flagged "forgot clock out". The close time is the latest known activity
  (last status change or Clockify entry), or the scheduled `work_end` when nothing is known.

**Sick / leave flow**

- Policy **B** (default for sick): the status is set right away (or on the start date) and a note goes to
  `#team-status-manage`.
- Policy **A** (default for leave): a card with **Approve / Reject** buttons goes to `#team-status-manage`. Only
  management can press them. The person gets a DM with the decision.
- Absences start at 00:05 on their first day and end after their last day.

**Mention auto-reply**: when someone mentions a person who is Offline, Sick, On-Leave or On-Meeting, the bot replies
with their status and when they are expected back. It never pings anyone, has a 60-minute cooldown per person per
channel, deletes itself after 10 minutes, and stays silent in `#team-status-manage` and `#team-status-log`.

**DMs**: if a person has DMs closed, the bot mentions them in `#team-status` instead (only that person is pinged).

---

## Commands

| Command | Who | Where |
| --- | --- | --- |
| `/clock-in [note]`, `/clock-out` | Employees | `#team-status` only |
| `/status set online/partial/on-meeting [minutes]` | Employees | any channel |
| `/status check @user` | Everyone | any channel (private answer) |
| `/sick [from] [to] [note]`, `/on-leave from to [note]` | Everyone | any channel |
| `/myhours [today/week/month]` | Everyone | any channel (private) |
| `/report-attendance` | Management | any channel (private) |
| `/presence-admin fix-session / set-status / holiday / board` | Admin | `#team-status-manage` |

Dates are `YYYY-MM-DD`, times are `HH:MM` in WITA, notes are at most 80 characters. Command answers are private
(only the person who used the command sees them).

---

## Schedule (WITA)

| When | Job |
| --- | --- |
| Every 20 s | End expired On-Meeting statuses |
| Every 60 s (`CLAIM_POLL_SEC`) | Check Clockify running timers for new claims |
| Start − 15 min | DM reminder to clock in |
| Start + 15 min | "Not clocked in yet" list in `#team-status-log` |
| End − 15 min | DM reminder to update Asana and clock out |
| 00:05 | Start / end approved absences |
| 21:00 | Daily recap in `#team-status-log` |
| 22:00 | Auto clock-out for open sessions (flagged) |
| Monday 09:00 | Weekly recap (with Clockify totals) |
| 02:00 | Backup (see [Backup and restore](#backup-and-restore)) |
| Every 6 h | Heartbeat in `#team-status-log` |

Weekends (days not in `work_days`), holidays and people on sick/leave get no reminders. Each job runs at most once
per day, even after a restart.

---

## Code map

```text
src/index.js                 start-up, wiring
src/config.js                reads .env
src/rules.js                 status state machine (pure, unit-tested)
src/service.js               all business logic (clock, status, claim, absences, recaps)
src/format.js                every user-facing sentence (edit wording here)
src/time.js                  WITA helpers
src/db.js                    SQLite schema + queries (data/presence.db)
src/clockify.js              read-only Clockify client
src/scheduler.js             reminders, auto-close, recaps, backups, claim poller
src/discord/commands.js      slash command definitions
src/discord/interactions.js  command + button handling, role checks
src/discord/mention.js       auto-reply on mentions (60-min cooldown, never pings)
src/discord/out.js           posting, DM fallback, pinned board
scripts/register-commands.js registers slash commands   (npm run register)
scripts/seed-roster.js       loads roster.json           (npm run seed)
scripts/add-holidays.js      loads holidays.json         (npm run holidays)
test/presence.test.js        logic tests                 (npm test)
ecosystem.config.cjs         pm2 config (process name: Akashapresence-bot)
```

Files that are **not** in git (see `.gitignore`): `.env`, `roster.json`, `data/` (database and backups),
`node_modules/`.

---

## Troubleshooting

| Problem | Cause / fix |
| --- | --- |
| "The application did not respond" | Bot is down → `pm2 ls`, `pm2 logs Akashapresence-bot` |
| "Presence bot is paused at the moment" | `PRESENCE_ENABLED=false` → set `true` and restart |
| Bot does not start, "Missing in .env: …" | Fill the variables it names |
| `node:sqlite` error / "No such built-in module" | Node.js is older than 22.13 → upgrade Node |
| Commands missing in Discord | Run `npm run register` again; check `DISCORD_APP_ID` and `GUILD_ID`; restart the Discord app |
| "You are not on the presence roster yet" | Person is not in `roster.json` (or `active: false`) → add and seed |
| "Please use /clock-in in #team-status" | Clock commands only work in `#team-status` (check `CH_STATUS`) |
| "Only management / the presence admin can use this command" | Give the right role; check `ROLE_MANAGEMENT` / `ROLE_ADMIN` |
| Board not pinned | Give the bot Pin Messages / Manage Messages in `#team-status`, then `/presence-admin board` |
| Claims not detected | Clockify key must belong to a workspace admin; person needs `clockify_user_id` in the roster; start-up log must say `clockify=true` |
| Mention auto-reply silent | Set `MESSAGE_CONTENT_INTENT=true` and enable the Message Content intent in the Developer Portal |
| Posts start with `[TEST]` / DMs not arriving | `DRY_RUN=true` → set `false` and restart |
| Wrong clock-in/out times | `/presence-admin fix-session` |

---

## Handover checklist

For handing the bot over to the Lead / whoever runs it:

- [ ] Access to the repo (or the latest zip of the folder)
- [ ] Access to the Discord Developer Portal application "Presence" (add them as a team member there)
- [ ] SSH access to the VPS and the folder path (e.g. `/opt/presence-bot`)
- [ ] Where `.env` lives on the VPS. Tokens and keys are only there, never in chat or git
- [ ] Who owns the Clockify admin API key, and what to do if that person leaves (new key → `.env` → restart)
- [ ] Current stage (T1 dry run / pilot / go-live) and the current `POLICY_SICK` / `POLICY_LEAVE` choice
- [ ] Who updates `roster.json` when people join or leave, and the yearly holiday list
- [ ] The rollback step: `PRESENCE_ENABLED=false` + `pm2 restart Akashapresence-bot`
