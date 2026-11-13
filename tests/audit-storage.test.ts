import { expect, test } from 'bun:test';
import { SqliteAudit } from '../packages/database/src/audit';
import { GROUP, harness } from './helpers';

test('audit listing stays group-scoped, newest-first and bounded', () => {
  const h = harness();
  h.store.audit(GROUP, 1, 2, 'first', 'test', h.clock.now(), 'request-a');
  h.store.audit(-2002, 1, 2, 'other', 'test', h.clock.now());
  h.store.audit(GROUP, null, null, 'second', 'test', h.clock.now());
  h.store.audit(GROUP, 3, 4, 'third', 'test', h.clock.now());
  expect(h.store.listAudit(GROUP, 2).map(row => row.action)).toEqual(['third', 'second']);
  expect(h.store.listAudit(-2002, 10).map(row => row.action)).toEqual(['other']);
  expect(h.store.listAudit(GROUP, 0)).toEqual([]);
});

test('skip accounting is request-specific and rolls back with the surrounding workflow', () => {
  const h = harness();
  const audit = new SqliteAudit(h.store.db);
  h.store.audit(GROUP, 1, 1, 'question_skipped', 'test', h.clock.now(), 'request-a');
  h.store.audit(GROUP, 2, 2, 'question_skipped', 'test', h.clock.now(), 'request-b');
  h.store.audit(GROUP, 1, 1, 'other', 'test', h.clock.now(), 'request-a');
  expect(audit.questionSkips('request-a')).toBe(1);
  expect(() => h.store.db.transaction(() => {
    h.store.audit(GROUP, 1, 1, 'question_skipped', 'test', h.clock.now(), 'request-a');
    expect(audit.questionSkips('request-a')).toBe(2);
    throw Error('workflow failed');
  }).immediate()).toThrow('workflow failed');
  expect(audit.questionSkips('request-a')).toBe(1);
  expect(audit.questionSkips('request-b')).toBe(1);
  expect(audit.questionSkips('unknown')).toBe(0);
});

test('audit retention is bounded, includes the cutoff and remains part of outer maintenance', () => {
  const h = harness();
  const audit = new SqliteAudit(h.store.db);
  const now = h.clock.now();
  for (let i = 0; i < 3; i++) h.store.audit(GROUP, null, null, 'old', 'test', now);
  h.store.audit(GROUP, null, null, 'new', 'test', now + 1);
  h.store.audit(-2002, null, null, 'other', 'test', now);
  h.store.audit(null, null, null, 'global', 'test', now);
  expect(() => h.store.db.transaction(() => {
    audit.purgeGroup(GROUP, now, 2);
    throw Error('maintenance failed');
  }).immediate()).toThrow('maintenance failed');
  expect(h.store.listAudit(GROUP, 10)).toHaveLength(4);
  audit.purgeGroup(GROUP, now, 2);
  expect(h.store.listAudit(GROUP, 10)).toHaveLength(2);
  expect(h.store.listAudit(-2002, 10)).toHaveLength(1);
  audit.purge(now, 2);
  expect((h.store.db.query('SELECT count(*) AS n FROM audit_events WHERE created_at<=?').get(now) as {n:number}).n).toBe(1);
  audit.purge(now, 2);
  expect(h.store.listAudit(GROUP, 10).map(row => row.action)).toEqual(['new']);
  expect(h.store.db.query('SELECT count(*) AS n FROM audit_events').get()).toEqual({n:1});
});
