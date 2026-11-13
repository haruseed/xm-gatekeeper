import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const directories = ['apps', 'packages', 'scripts', 'ops', 'assets', 'node_modules', 'docs'];
const files = ['package.json', 'bun.lock', 'ecosystem.config.json', 'tsconfig.json', 'README.md'];
const executable = (path: string, source: string) => writeFileSync(path, source, { mode: 0o755 });

for (const scenario of ['success', 'preflight-failure', 'backup-failure', 'partial-cutover', 'start-failure', 'health-failure', 'save-failure']) {
  test(`release rehearsal: ${scenario}`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'guard-release-test-'));
    try {
      const app = join(temp, 'app with spaces');
      const release = join(app, 'backups/releases/test');
      const candidate = join(release, 'candidate');
      const bin = join(temp, 'bin');
      mkdirSync(bin);
      for (const [root, version] of [[app, 'old'], [candidate, 'new']] as const) {
        mkdirSync(root, { recursive: true });
        for (const directory of directories) {
          mkdirSync(join(root, directory));
          writeFileSync(join(root, directory, 'version'), version);
        }
        for (const file of files) writeFileSync(join(root, file), version);
      }
      writeFileSync(join(app, '.env'), 'unchanged secret fixture');
      mkdirSync(join(app, 'data')); writeFileSync(join(app, 'data/guard.sqlite'), 'unchanged database fixture');
      mkdirSync(join(app, 'tmp')); writeFileSync(join(app, 'tmp/session'), 'unchanged session fixture');
      executable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
      executable(join(bin, 'mv'), `#!/bin/sh
if [ "$SCENARIO" = partial-cutover ] && [ "$1" = "$CANDIDATE/packages" ]; then exit 1; fi
exec /bin/mv "$@"
`);
      executable(join(bin, 'sudo'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in /usr/local/bin/pm2|/opt/bun/bin/bun) tool=$1; shift; break;; esac
  shift
done
if [ "$tool" = /usr/local/bin/pm2 ]; then
  command=$1
  version=$(cat "$APP/apps/version")
  echo "$command:$version" >> "$OPLOG"
  if [ "$command" = start ] && [ "$version" = new ] && [ "$SCENARIO" = start-failure ]; then exit 1; fi
  if [ "$command" = save ] && [ "$SCENARIO" = save-failure ]; then exit 1; fi
  [ "$command" != jlist ] || echo '[]'
  exit 0
fi
case "$2" in
  */preflight.ts) echo preflight >> "$OPLOG"; [ "$SCENARIO" != preflight-failure ];;
  */backup.ts) echo backup >> "$OPLOG"; [ "$SCENARIO" != backup-failure ];;
  */check-runtime.ts) cat >/dev/null; [ "$SCENARIO" != health-failure ];;
  *) exit 1;;
esac
`);
      const result = Bun.spawnSync(['sh', join(import.meta.dir, '../ops/apply-release.sh'), app, release], {
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, APP: app, CANDIDATE: candidate, OPLOG: join(temp, 'operations'), SCENARIO: scenario },
        stdout: 'pipe', stderr: 'pipe',
      });
      const version = scenario === 'success' ? 'new' : 'old';
      expect(result.exitCode).toBe(scenario === 'success' ? 0 : 1);
      for (const directory of directories) expect(readFileSync(join(app, directory, 'version'), 'utf8')).toBe(version);
      for (const file of files) expect(readFileSync(join(app, file), 'utf8')).toBe(version);
      expect(readFileSync(join(app, '.env'), 'utf8')).toBe('unchanged secret fixture');
      expect(readFileSync(join(app, 'data/guard.sqlite'), 'utf8')).toBe('unchanged database fixture');
      expect(readFileSync(join(app, 'tmp/session'), 'utf8')).toBe('unchanged session fixture');
      expect(existsSync(join(app, 'backups/.deploy-lock'))).toBe(false);
      const operations = readFileSync(join(temp, 'operations'), 'utf8');
      if (scenario === 'preflight-failure') {
        expect(operations.trim()).toBe('preflight');
        return;
      }
      expect(operations.indexOf('backup')).toBeGreaterThan(operations.indexOf('stop:old'));
      if (scenario !== 'success') expect(operations.trim().endsWith('start:old')).toBe(true);
      else expect(readFileSync(join(release, 'previous/apps/version'), 'utf8')).toBe('old');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}
