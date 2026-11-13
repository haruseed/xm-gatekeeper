// Read-only candidate validation; deliberately refuses implicit schema upgrades/downgrades.
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { loadConfig } from '@guard/core';
import { MIGRATIONS } from '@guard/database';
import { LocalAssetStore } from '@guard/assets';
import { BoardBank } from '../apps/bot/src/board-bank';

const config = loadConfig(process.env);
const app = process.argv[2];
if (!app || config.assetsDir !== join(app, 'assets')) throw new Error('release deployment requires ASSETS_DIR=<app>/assets');
const candidate = resolve(import.meta.dir, '..');
const assets = new LocalAssetStore(join(candidate, 'assets'));
new BoardBank(join(candidate, 'assets/board-bank'), assets);
const db = new Database(config.databasePath, { readonly: true });
try {
  const applied = db.query('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as { version: number; checksum: string }[];
  if (applied.length !== MIGRATIONS.length || MIGRATIONS.some((m, i) =>
    applied[i]?.version !== m.version || applied[i]?.checksum !== createHash('sha256').update(m.sql).digest('hex'))) {
    throw new Error('schema differs: use a separately reviewed migration procedure before this deployment');
  }
} finally { db.close(); }
console.log('candidate assets, configuration and schema verified');
