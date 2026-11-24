// Loads holidays.json ([{ "date": "YYYY-MM-DD", "name": "..." }]). Usage: npm run holidays -- ./holidays.json
import fs from 'node:fs';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { isDateStr } from '../src/time.js';

const file = process.argv[2] || './holidays.json';
const list = JSON.parse(fs.readFileSync(file, 'utf8'));
const db = openDb(config.dbPath);
for (const h of list) {
  if (!isDateStr(h.date)) throw new Error(`Bad date: ${h.date}`);
  db.addHoliday(h.date, h.name);
}
console.log(`Holidays loaded: ${list.length}`);
