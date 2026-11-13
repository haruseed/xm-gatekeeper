import { expect, test } from 'bun:test';
import { SqliteRateLimits } from '../packages/database/src/rate-limits';
import { GROUP, OWNER, enrol, harness } from './helpers';

test('approval budget refills at the exact boundary, caps idle credit and isolates groups', () => {
  const h = harness();
  const now = h.clock.now();
  expect(h.store.takeApprovalBudget(GROUP, 2, now)).toBe(true);
  expect(h.store.takeApprovalBudget(GROUP, 2, now)).toBe(true);
  expect(h.store.takeApprovalBudget(GROUP, 2, now)).toBe(false);
  expect(h.store.takeApprovalBudget(-2002, 2, now)).toBe(true);
  expect(h.store.takeApprovalBudget(GROUP, 2, now + 29999)).toBe(false);
  expect(h.store.takeApprovalBudget(GROUP, 2, now + 30000)).toBe(true);
  expect(h.store.takeApprovalBudget(GROUP, 2, now + 600000)).toBe(true);
  expect(h.store.takeApprovalBudget(GROUP, 2, now + 600000)).toBe(true);
  expect(h.store.takeApprovalBudget(GROUP, 2, now + 600000)).toBe(false);
});

test('failed join transaction does not spend burst credit or leave raid mode enabled', () => {
  const h = harness(); enrol(h, GROUP, OWNER, { burstThreshold: 5 });
  const admit = (id: number) => h.store.recordJoin({ updateId: id, chatId: GROUP, userId: 5000 + id,
    contactChatId: 5000 + id, requestDate: h.clock.now(), now: h.clock.now() });
  for (let id = 1; id <= 5; id++) expect(admit(id).kind).toBe('created');
  const before = h.store.db.query('SELECT * FROM limits').all();
  h.store.db.exec("CREATE TEMP TRIGGER reject_join BEFORE INSERT ON join_requests BEGIN SELECT RAISE(ABORT,'join unavailable'); END;");
  expect(() => admit(6)).toThrow('join unavailable');
  expect(h.store.db.query('SELECT * FROM limits').all()).toEqual(before);
  expect(h.store.getGroup(GROUP)?.raid_mode).toBe(0);
  expect(h.store.listAudit(GROUP, 50).some(row => row.action === 'raid_on')).toBe(false);
  h.store.db.exec('DROP TRIGGER reject_join');
  expect(admit(6).kind).toBe('review');
  expect(h.store.getGroup(GROUP)?.raid_mode).toBe(1);
});

test('disabling raid resets only the group burst bucket and rolls back if audit fails', () => {
  const h = harness(); enrol(h);
  const limits = new SqliteRateLimits(h.store.db);
  h.store.db.transaction(() => {
    limits.take('burst', String(GROUP), 1, 1 / 60000, h.clock.now());
    limits.take('burst', '-2002', 1, 1 / 60000, h.clock.now());
  }).immediate();
  h.store.takeApprovalBudget(GROUP, 1, h.clock.now());
  h.store.setRaid(GROUP, true, OWNER, 'test', h.clock.now());
  const before = h.store.db.query('SELECT * FROM limits ORDER BY scope,bucket_key').all();
  h.store.db.exec("CREATE TEMP TRIGGER reject_raid_audit BEFORE INSERT ON audit_events WHEN NEW.action='raid_off' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  expect(() => h.store.setRaid(GROUP, false, OWNER, 'test', h.clock.now())).toThrow('audit unavailable');
  expect(h.store.db.query('SELECT * FROM limits ORDER BY scope,bucket_key').all()).toEqual(before);
  expect(h.store.getGroup(GROUP)?.raid_mode).toBe(1);
  h.store.db.exec('DROP TRIGGER reject_raid_audit');
  h.store.setRaid(GROUP, false, OWNER, 'test', h.clock.now());
  expect(h.store.db.query('SELECT scope,bucket_key FROM limits ORDER BY scope,bucket_key').all()).toEqual([
    { scope: 'approve', bucket_key: String(GROUP) }, { scope: 'burst', bucket_key: '-2002' },
  ]);
  expect(h.store.takeApprovalBudget(GROUP, 1, h.clock.now())).toBe(false);
});
