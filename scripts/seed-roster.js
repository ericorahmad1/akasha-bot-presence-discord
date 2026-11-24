// Loads roster.json into the database (insert or update). Usage: npm run seed -- ./roster.json
import fs from 'node:fs';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { isHm } from '../src/time.js';

const file = process.argv[2] || './roster.json';
const roster = JSON.parse(fs.readFileSync(file, 'utf8'));
const db = openDb(config.dbPath);

let n = 0;
for (const u of roster) {
  if (!/^\d{17,20}$/.test(String(u.discord_id))) throw new Error(`Bad discord_id for ${u.name}`);
  if (u.work_start && !isHm(u.work_start)) throw new Error(`Bad work_start for ${u.name}`);
  if (u.work_end && !isHm(u.work_end)) throw new Error(`Bad work_end for ${u.name}`);
  db.upsertUser(u);
  n += 1;
}
console.log(`Roster loaded: ${n} people into ${config.dbPath}`);
