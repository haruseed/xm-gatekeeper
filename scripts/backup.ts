// Consistent snapshot with VACUUM INTO; keeps the newest seven. Run while the bot is stopped,
// or accept a brief write stall. Usage: bun --env-file=<env> scripts/backup.ts <backup-dir>
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const path = process.env.DATABASE_PATH;
const dir = process.argv[2];
if (!path) throw new Error('DATABASE_PATH is required');
if (!dir || !isAbsolute(dir)) throw new Error('usage: backup.ts <absolute-backup-dir>');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const target = join(dir, `guard-${stamp}.sqlite`);
const db = new Database(path);
db.exec('PRAGMA busy_timeout = 5000');
db.query('VACUUM INTO ?').run(target);
chmodSync(target, 0o600);
const check = new Database(target, { readonly: true });
const ok = (check.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check === 'ok';
check.close();
if (!ok) throw new Error('backup failed its integrity check');
db.query(`INSERT INTO runtime_state(key,value) VALUES ('last_backup',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(new Date().toISOString());
db.close();
const old = readdirSync(dir).filter((f) => /^guard-\d{8}T\d{6}\.sqlite$/.test(f)).sort().slice(0, -7);
for (const f of old) unlinkSync(join(dir, f));
console.log(`backup written: ${target}`);
