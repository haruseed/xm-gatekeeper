import { expect, test } from 'bun:test';
import { TgError } from '../apps/bot/src/telegram';
import { GROUP, enrol, harness } from './helpers';

function setup() {
  const h = harness({ cap: true });
  enrol(h);
  const result = h.store.recordJoin({ updateId: 987, chatId: GROUP, userId: 5001,
    contactChatId: 5001, requestDate: h.clock.now(), now: h.clock.now(), kind: 'member' });
  if (result.kind !== 'created') throw Error('fixture admission failed');
  const ticket = h.store.issueCapTicket(result.request.id, 5001, h.clock.now())!;
  h.store.completeCap(ticket, h.clock.now(), 'en', 200);
  for (const id of [10, 11, 12]) h.store.trackCapMessage(result.request.id, 5001, id);
  return h;
}

test('one transient Cap deletion failure delays only that message and cleanup continues', async () => {
  const h = setup();
  const calls: number[] = [];
  h.tg.deleteMessage = async (_chat, id) => {
    calls.push(id);
    if (id === 11 && calls.filter(x => x === 11).length === 1) throw new TgError('network', 'offline');
  };
  await h.v.cleanupCapMessages();
  expect(calls).toEqual([10, 11, 12]);
  expect(h.store.capMessagesToDelete(h.clock.now())).toEqual([]);
  h.clock.advance(29_999);
  await h.v.cleanupCapMessages();
  expect(calls).toHaveLength(3);
  h.clock.advance(1);
  await h.v.cleanupCapMessages();
  expect(calls).toEqual([10, 11, 12, 11]);
  expect(h.store.capMessagesToDelete(h.clock.now())).toEqual([]);
  expect(h.tg.unrestricted).toHaveLength(0);
});

test('permanent Telegram deletion failures finish cleanup without changing admission', async () => {
  const h = setup();
  const before = h.store.liveRequest(GROUP, 5001);
  h.tg.deleteMessage = async (_chat, id) => {
    if (id === 10) throw new TgError('bad_request', 'message missing');
    if (id === 11) throw new TgError('forbidden', 'bot removed');
  };
  await h.v.cleanupCapMessages();
  expect(h.store.capMessagesToDelete(h.clock.now())).toEqual([]);
  expect(h.store.liveRequest(GROUP, 5001)).toEqual(before);
  expect(h.tg.unrestricted).toHaveLength(0);
});

test('failed cleanup bookkeeping propagates and leaves the message available for recovery', async () => {
  const h = setup();
  h.store.db.exec("CREATE TEMP TRIGGER reject_cleanup BEFORE DELETE ON cap_messages BEGIN SELECT RAISE(ABORT,'cleanup storage unavailable'); END;");
  await expect(h.v.cleanupCapMessages()).rejects.toThrow('cleanup storage unavailable');
  expect(h.tg.deleted).toEqual([10]);
  expect(h.store.capMessagesToDelete(h.clock.now())).toHaveLength(3);
  h.store.db.exec('DROP TRIGGER reject_cleanup');
  // Telegram may report an already deleted message on the recovery attempt.
  h.tg.deleteMessage = async (_chat, id) => {
    if (id === 10) throw new TgError('bad_request', 'already deleted');
    h.tg.deleted.push(id);
  };
  await h.v.cleanupCapMessages();
  expect(h.store.capMessagesToDelete(h.clock.now())).toEqual([]);
  expect(h.tg.deleted).toEqual([10, 11, 12]);
});
