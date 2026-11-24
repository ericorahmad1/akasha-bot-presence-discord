import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  token: env.DISCORD_TOKEN,
  appId: env.DISCORD_APP_ID,
  guildId: env.GUILD_ID,
  channels: { employee: env.CH_STATUS, manage: env.CH_MANAGE, log: env.CH_LOG },
  roles: { employee: env.ROLE_EMPLOYEE, management: env.ROLE_MANAGEMENT, admin: env.ROLE_ADMIN },
  clockify: { apiKey: env.CLOCKIFY_API_KEY, workspaceId: env.CLOCKIFY_WORKSPACE_ID },
  enabled: bool(env.PRESENCE_ENABLED, false),
  dryRun: bool(env.DRY_RUN, true),
  policy: {
    sick: (env.POLICY_SICK || 'B').toUpperCase(),
    leave: (env.POLICY_LEAVE || 'A').toUpperCase(),
  },
  autoClockInOnClaim: bool(env.AUTO_CLOCKIN_ON_CLAIM, true),
  meetingDefaultMin: num(env.MEETING_DEFAULT_MIN, 30),
  lateGraceMin: num(env.LATE_GRACE_MIN, 15),
  mentionAutoReply: bool(env.MENTION_AUTOREPLY, true),
  mentionCooldownMin: num(env.MENTION_COOLDOWN_MIN, 60),
  mentionDeleteAfterMin: num(env.MENTION_DELETE_AFTER_MIN, 10),
  messageContentIntent: bool(env.MESSAGE_CONTENT_INTENT, false),
  claimPollSec: num(env.CLAIM_POLL_SEC, 60),
  dbPath: env.DB_PATH || './data/presence.db',
  backupDir: env.BACKUP_DIR || './data/backups',
};

export function assertDiscordConfig(c = config) {
  const missing = [];
  if (!c.token) missing.push('DISCORD_TOKEN');
  if (!c.guildId) missing.push('GUILD_ID');
  if (!c.channels.employee) missing.push('CH_STATUS');
  if (!c.channels.manage) missing.push('CH_MANAGE');
  if (!c.channels.log) missing.push('CH_LOG');
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')}`);
}
