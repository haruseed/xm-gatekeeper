import { expect, test } from 'bun:test';
import { SqliteUserPreferences } from '../packages/database/src/user-preferences';
import { GROUP, OWNER, enrol, harness, join_ } from './helpers';

const USER = 5001;

test('locale and admin context never imply private-chat consent, and updates preserve independent preferences', () => {
  const h = harness();
  h.store.setLocale(USER, 'zh-TW', h.clock.now());
  h.store.setAdminContext(USER, GROUP, h.clock.now());
  expect(h.store.getPrefs(USER)?.explicit_dm_chat_id).toBeNull();
  h.store.recordExplicitStart(USER, USER, h.clock.now());
  h.clock.advance(1000);
  h.store.setLocale(USER, 'en', h.clock.now());
  expect(h.store.getPrefs(USER)).toEqual({ user_id: USER, locale: 'en', explicit_dm_chat_id: USER,
    admin_chat_id: GROUP, last_seen_at: h.clock.now() });
  enrol(h);
  h.store.removeGroup(GROUP, OWNER, h.clock.now());
  expect(h.store.getPrefs(USER)).toMatchObject({ locale: 'en', explicit_dm_chat_id: USER, admin_chat_id: null });
});

test('failed active-session language update rolls back preference and last-seen changes', async () => {
  const h = harness();
  enrol(h);
  await join_(h, USER);
  h.store.setLocale(USER, 'en', h.clock.now());
  const request = h.store.liveRequestsForUser(USER)[0]!;
  const before = h.store.getPrefs(USER);
  const session = h.store.liveSession(request.id)!;
  h.clock.advance(1000);
  h.store.db.exec("CREATE TEMP TRIGGER reject_locale BEFORE UPDATE OF locale ON sessions BEGIN SELECT RAISE(ABORT,'session write failed'); END;");
  expect(() => h.store.setLocale(USER, 'zh-TW', h.clock.now())).toThrow('session write failed');
  expect(h.store.getPrefs(USER)).toEqual(before);
  expect(h.store.getSession(session.id)).toEqual(session);
  h.store.db.exec('DROP TRIGGER reject_locale');
  h.store.setLocale(USER, 'zh-TW', h.clock.now());
  expect(h.store.getSession(session.id)).toEqual({ ...session, locale: 'zh-TW' });
  expect(h.store.getPrefs(USER)?.locale).toBe('zh-TW');
});

test('preference retention is bounded at 90 days and rolls back with maintenance', () => {
  const h = harness();
  const storage = new SqliteUserPreferences(h.store.db);
  const cutoff = h.clock.now() - 90 * 86_400_000;
  for (const user of [1, 2, 3]) h.store.setLocale(user, 'en', cutoff);
  h.store.recordExplicitStart(4, 4, cutoff + 1);
  expect(() => h.store.db.transaction(() => {
    storage.purge(h.clock.now(), 2);
    throw Error('maintenance failed');
  }).immediate()).toThrow('maintenance failed');
  for (const user of [1, 2, 3, 4]) expect(h.store.getPrefs(user)).toBeDefined();
  storage.purge(h.clock.now(), 2);
  expect([1, 2, 3].filter(user => h.store.getPrefs(user))).toHaveLength(1);
  storage.purge(h.clock.now(), 2);
  for (const user of [1, 2, 3]) expect(h.store.getPrefs(user)).toBeUndefined();
  expect(h.store.getPrefs(4)?.explicit_dm_chat_id).toBe(4);
});
