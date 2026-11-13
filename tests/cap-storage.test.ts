import { expect, test } from 'bun:test';
import { GROUP, enrol, harness } from './helpers';

function setup() {
  const h = harness({ cap: true });
  enrol(h);
  const result = h.store.recordJoin({ updateId: 321, chatId: GROUP, userId: 5001,
    contactChatId: 5001, requestDate: h.clock.now(), now: h.clock.now(), kind: 'member' });
  if (result.kind !== 'created') throw Error('fixture admission failed');
  const ticket = h.store.issueCapTicket(result.request.id, 5001, h.clock.now())!;
  return { ...h, request: result.request, ticket };
}

for (const failure of ['picture', 'audit'] as const) {
  test(`Cap pass, round and outbox roll back together on ${failure} write failure`, () => {
    const h = setup();
    const before = h.store.getRequest(h.request.id);
    const queueBefore = h.store.outboxStats(h.clock.now());
    const table = failure === 'picture' ? 'outbox' : 'audit_events';
    const condition = failure === 'picture' ? "NEW.kind='prepare_round'" : "NEW.action='cap_passed'";
    h.store.db.exec(`CREATE TEMP TRIGGER reject_cap BEFORE INSERT ON ${table}
      WHEN ${condition} BEGIN SELECT RAISE(ABORT,'injected Cap write failure'); END;`);
    expect(() => h.store.completeCap(h.ticket, h.clock.now(), 'en', 200)).toThrow('injected Cap write failure');
    expect(h.store.capPassed(h.request.id)).toBe(false);
    expect(h.store.capTicket(h.ticket, h.clock.now())?.id).toBe(h.request.id);
    expect(h.store.getRequest(h.request.id)).toEqual(before);
    expect(h.store.liveSession(h.request.id)).toBeUndefined();
    expect(h.store.outboxStats(h.clock.now())).toEqual(queueBefore);
    expect(h.store.listAudit(GROUP, 50).some(row => row.action === 'cap_passed')).toBe(false);
    h.store.db.exec('DROP TRIGGER reject_cap');
    expect(h.store.completeCap(h.ticket, h.clock.now(), 'en', 200)).toBe(true);
    expect(h.store.liveSession(h.request.id)?.state).toBe('preparing');
    expect(h.store.completeCap(h.ticket, h.clock.now(), 'en', 200)).toBe(false);
  });
}

test('ticket refresh invalidates the old ticket without resetting cooldown or challenge budget', () => {
  const h = setup();
  expect(h.store.takeCapChallenge(h.ticket, h.clock.now())).toBe(true);
  const refreshed = h.store.issueCapTicket(h.request.id, 5001, h.clock.now())!;
  expect(h.store.capTicket(h.ticket, h.clock.now())).toBeUndefined();
  expect(h.store.takeCapChallenge(refreshed, h.clock.now())).toBe(false);
  for (let i = 1; i < 10; i++) {
    h.clock.advance(3000);
    expect(h.store.takeCapChallenge(refreshed, h.clock.now())).toBe(true);
  }
  h.clock.advance(3000);
  const third = h.store.issueCapTicket(h.request.id, 5001, h.clock.now())!;
  expect(h.store.takeCapChallenge(third, h.clock.now())).toBe(false);
});

test('Cap private-message cleanup is pass-gated, bounded and retryable at the exact deadline', () => {
  const h = setup();
  for (let id = 1; id <= 30; id++) h.store.trackCapMessage(h.request.id, 5001, id);
  expect(h.store.capMessagesToDelete(h.clock.now())).toEqual([]);
  expect(h.store.completeCap(h.ticket, h.clock.now(), 'en', 200)).toBe(true);
  const first = h.store.capMessagesToDelete(h.clock.now());
  expect(first).toHaveLength(25);
  const retry = first[0]!;
  h.store.retryCapMessage(retry.chat_id, retry.message_id, h.clock.now());
  for (const message of h.store.capMessagesToDelete(h.clock.now())) h.store.finishCapMessage(message.chat_id, message.message_id);
  for (const message of h.store.capMessagesToDelete(h.clock.now())) h.store.finishCapMessage(message.chat_id, message.message_id);
  h.clock.advance(29_999);
  expect(h.store.capMessagesToDelete(h.clock.now())).toEqual([]);
  h.clock.advance(1);
  expect(h.store.capMessagesToDelete(h.clock.now())).toEqual([retry]);
  h.store.finishCapMessage(retry.chat_id, retry.message_id);
  expect(h.store.capMessagesToDelete(h.clock.now())).toEqual([]);
});

test('nonce replay protection lasts until its exact expiry and participates in outer transactions', () => {
  const h = setup();
  const now = h.clock.now();
  expect(h.store.consumeCapNonce('first', 1000, now)).toBe(true);
  expect(h.store.consumeCapNonce('first', 1000, now + 999)).toBe(false);
  expect(() => h.store.db.transaction(() => {
    expect(h.store.consumeCapNonce('second', 1000, now)).toBe(true);
    throw Error('rollback');
  }).immediate()).toThrow('rollback');
  expect(h.store.consumeCapNonce('second', 1000, now)).toBe(true);
  expect(h.store.consumeCapNonce('first', 1000, now + 1000)).toBe(true);
});
