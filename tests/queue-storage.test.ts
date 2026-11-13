import { expect, test } from 'bun:test';
import { secureRng } from '@guard/core';
import { SqliteOutbox } from '../packages/database/src/outbox';
import { harness, enrol, GROUP } from './helpers';

test('failed inbox insertion or offset write rolls back the whole intake batch', () => {
  const h = harness();
  h.store.storeBatchAndAdvance([{ update_id: 1, payload: {} }], h.clock.now());
  h.store.db.exec(`CREATE TEMP TRIGGER reject_offset BEFORE UPDATE ON runtime_state
    WHEN NEW.key='poll_offset' BEGIN SELECT RAISE(ABORT,'offset unavailable'); END;`);
  expect(() => h.store.storeBatchAndAdvance([{ update_id: 2, payload: {} }, { update_id: 3, payload: null }], h.clock.now())).toThrow('offset unavailable');
  expect(h.store.nextOffset()).toBe(2);
  expect(h.store.claimInbox(h.clock.now(), 20).map(r => r.update_id)).toEqual([1]);
  h.store.db.exec('DROP TRIGGER reject_offset');
  h.store.db.exec(`CREATE TEMP TRIGGER reject_second_update BEFORE INSERT ON inbox
    WHEN NEW.update_id=3 BEGIN SELECT RAISE(ABORT,'inbox unavailable'); END;`);
  expect(() => h.store.storeBatchAndAdvance([{ update_id: 2, payload: {} }, { update_id: 3, payload: {} }], h.clock.now())).toThrow('inbox unavailable');
  expect(h.store.nextOffset()).toBe(2);
  expect(h.store.claimInbox(h.clock.now(), 20).map(r => r.update_id)).toEqual([1]);
});

test('outbox insert failure rolls back the applicant and audit event together', () => {
  const h = harness(); enrol(h);
  h.store.db.exec("CREATE TEMP TRIGGER reject_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END;");
  const input = { updateId: 99, chatId: GROUP, userId: 5001, contactChatId: 5001, requestDate: h.clock.now(), now: h.clock.now() };
  expect(() => h.store.recordJoin(input)).toThrow('outbox unavailable');
  expect(h.store.liveRequest(GROUP, 5001)).toBeUndefined();
  expect(h.store.listAudit(GROUP, 20).some(row => row.action === 'join_request')).toBe(false);
  h.store.db.exec('DROP TRIGGER reject_outbox');
  expect(h.store.recordJoin(input).kind).toBe('created');
  expect(h.store.outboxStats(h.clock.now()).pending).toBe(1);
});

test('outbox deduplication, priority and lease recovery survive repository extraction', () => {
  const h = harness();
  const outbox = new SqliteOutbox(h.store.db, secureRng);
  const work = (dedupeKey: string, kind: string) => ({ dedupeKey, kind, requestId: null, revision: null, payload: {}, now: h.clock.now() });
  outbox.enqueue(work('picture', 'prepare_round'));
  outbox.enqueue(work('approval', 'approve'));
  outbox.enqueue(work('approval', 'approve'));
  expect(outbox.outboxStats(h.clock.now()).pending).toBe(2);
  const first = h.store.claimOutbox(h.clock.now(), 1, 60000);
  expect(first[0]!.kind).toBe('approve');
  const second = h.store.claimOutbox(h.clock.now(), 10, 60000);
  expect(second.map(row => row.kind)).toEqual(['prepare_round']);
  expect(h.store.claimOutbox(h.clock.now() + 59999, 10, 60000)).toHaveLength(0);
  expect(h.store.claimOutbox(h.clock.now() + 60000, 10, 60000)).toHaveLength(2);
});

test('lease updates are atomic and quarantine work survives request cancellation', () => {
  const h = harness(); enrol(h);
  const result = h.store.recordJoin({ updateId: 1, chatId: GROUP, userId: 5001, contactChatId: 5001, requestDate: h.clock.now(), now: h.clock.now(), kind: 'member' });
  if (result.kind !== 'created') throw new Error('fixture admission failed');
  const outbox = new SqliteOutbox(h.store.db, secureRng);
  outbox.enqueue({ dedupeKey: 'extra', requestId: result.request.id, revision: null, kind: 'prepare_round', payload: {}, now: h.clock.now() });
  h.store.db.exec("CREATE TEMP TRIGGER reject_picture_lease BEFORE UPDATE OF lease_until ON outbox WHEN NEW.kind='prepare_round' BEGIN SELECT RAISE(ABORT,'lease unavailable'); END;");
  expect(() => h.store.claimOutbox(h.clock.now(), 10, 60000)).toThrow('lease unavailable');
  expect(h.store.db.query('SELECT COUNT(*) AS n FROM outbox WHERE lease_until IS NOT NULL').get()).toEqual({ n: 0 });
  h.store.db.exec('DROP TRIGGER reject_picture_lease');
  outbox.cancelRequest(result.request.id);
  expect(h.store.claimOutbox(h.clock.now(), 10, 60000).map(row => row.kind)).toEqual(['quarantine']);
});
