// Entry point: node src/index.js (run under pm2 as "presence-bot").
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config, assertDiscordConfig } from './config.js';
import { openDb } from './db.js';
import { Presence } from './service.js';
import { createClockify } from './clockify.js';
import { createScheduler } from './scheduler.js';
import { createOut, createBoard } from './discord/out.js';
import { createInteractionHandler } from './discord/interactions.js';
import { createMentionHandler } from './discord/mention.js';

assertDiscordConfig();

const intents = [GatewayIntentBits.Guilds];
if (config.mentionAutoReply) intents.push(GatewayIntentBits.GuildMessages);
if (config.messageContentIntent) intents.push(GatewayIntentBits.MessageContent);

const client = new Client({ intents });
const db = openDb(config.dbPath);
const clockify = createClockify(config.clockify);
const out = createOut(client, config);

let board = { schedule() {}, flush: async () => {}, repost: async () => {} };
const presence = new Presence({ db, out, config, onChange: () => board.schedule() });
board = createBoard({ client, config, db, render: () => presence.boardText() });
const scheduler = createScheduler({ presence, db, clockify, out, config });

client.once(Events.ClientReady, async (c) => {
  console.log(`presence-bot logged in as ${c.user.tag} · enabled=${config.enabled} · dryRun=${config.dryRun} · clockify=${clockify.enabled}`);
  if (!config.enabled) return;
  await out.log(`presence-bot started · ${new Date().toISOString()} · dryRun=${config.dryRun}`).catch((e) => console.error(e));
  await board.flush().catch((e) => console.error('board', e));
  scheduler.start();
  setInterval(() => out.log('heartbeat: presence-bot is running').catch(() => {}), 6 * 60 * 60 * 1000);
});

client.on(Events.InteractionCreate, createInteractionHandler({ presence, db, clockify, config, board }));
if (config.mentionAutoReply) client.on(Events.MessageCreate, createMentionHandler({ presence, config }));

function shutdown(sig) {
  console.log(`${sig} received, shutting down`);
  scheduler.stop();
  client.destroy().finally(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

client.login(config.token);
