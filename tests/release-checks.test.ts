import { expect, test } from 'bun:test';
import { resolve, join } from 'node:path';
import { ASSETS_DIR, harness } from './helpers';

const root = resolve(import.meta.dir, '..');
function run(script: string, h: ReturnType<typeof harness>, stdin = '', args: string[] = []) {
  return Bun.spawnSync([process.execPath, join(root, 'ops', script), ...args], {
    cwd: root,
    env: { BOT_TOKEN: `999:${'x'.repeat(40)}`, DATABASE_PATH: h.dbPath, ASSETS_DIR, BOARD_TEMP_DIR: h.boardDir },
    stdin: Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe',
  });
}

test('release preflight accepts matching schema and rejects changed migration history without rewriting it', () => {
  const h = harness();
  expect(run('preflight.ts', h, '', [root]).exitCode).toBe(0);
  h.store.db.query("UPDATE schema_migrations SET checksum='tampered' WHERE version=1").run();
  expect(run('preflight.ts', h, '', [root]).exitCode).toBe(1);
  expect(h.store.db.query('SELECT checksum FROM schema_migrations WHERE version=1').get()).toEqual({ checksum: 'tampered' });
});

test('runtime check requires a current ready marker, not only an online PM2 process', () => {
  const h = harness();
  const now = Date.now();
  const pm2 = JSON.stringify([{ name: 'ingress-guard', pid: 12345, pm2_env: { status: 'online', pm_uptime: now - 5000 } }]);
  expect(run('check-runtime.ts', h, pm2).exitCode).toBe(1);
  for (const ready of [{ pid: 99999, startedAt: now }, { pid: 12345, startedAt: now - 100000 }, { pid: 12345 }]) {
    h.store.setState('runtime_ready', JSON.stringify(ready));
    expect(run('check-runtime.ts', h, pm2).exitCode).toBe(1);
  }
  h.store.setState('runtime_ready', JSON.stringify({ pid: 12345, startedAt: now }));
  expect(run('check-runtime.ts', h, pm2).exitCode).toBe(0);
});
