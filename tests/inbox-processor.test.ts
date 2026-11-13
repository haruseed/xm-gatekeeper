import { expect, test } from 'bun:test';
import { POLICY } from '@guard/core';
import { InboxProcessor } from '../apps/bot/src/inbox-processor';
import { harness } from './helpers';

test('overlapping transport calls do not execute one persisted update twice', async () => {
  const h = harness();
  h.store.storeBatchAndAdvance([{ update_id: 1, payload: { update_id: 1 } }, { update_id: 2, payload: { update_id: 2 } }], h.clock.now());
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const calls: number[] = [];
  const processor = new InboxProcessor(h.store, h.clock, async update => {
    calls.push(update.update_id);
    if (update.update_id === 1) { entered.resolve(); await release.promise; }
  });
  const first = processor.process();
  await entered.promise;
  await processor.process();
  expect(calls).toEqual([1]);
  release.resolve(); await first;
  expect(calls).toEqual([1, 2]);
  expect(h.store.inboxStats(h.clock.now()).pending).toBe(0);
});

test('failed handlers retry after the delay and do not block later updates', async () => {
  const h = harness();
  h.store.storeBatchAndAdvance([{ update_id: 1, payload: { update_id: 1 } }, { update_id: 2, payload: { update_id: 2 } }], h.clock.now());
  const calls: number[] = [];
  let failed = false;
  const processor = new InboxProcessor(h.store, h.clock, async update => {
    calls.push(update.update_id);
    if (update.update_id === 1 && !failed) { failed = true; throw new Error('temporary failure'); }
  });
  await processor.process();
  expect(calls).toEqual([1, 2]);
  expect(h.store.inboxStats(h.clock.now()).pending).toBe(1);
  h.clock.advance(1999); await processor.process();
  expect(calls).toEqual([1, 2]);
  h.clock.advance(1); await processor.process();
  expect(calls).toEqual([1, 2, 1]);
  expect(h.store.inboxStats(h.clock.now()).pending).toBe(0);
});


for (const attempts of [0, POLICY.inboxMaxAttempts - 1]) {
  test(`failed acknowledgement preserves successful update and retry budget at attempt ${attempts}`, async () => {
    const h = harness();
    h.store.storeBatchAndAdvance([{ update_id: 10, payload: { update_id: 10 } }, { update_id: 11, payload: { update_id: 11 } }], h.clock.now());
    h.store.db.query('UPDATE inbox SET attempts=? WHERE update_id=10').run(attempts);
    const before = h.store.db.query('SELECT * FROM inbox WHERE update_id=10').get();
    h.store.db.exec("CREATE TEMP TRIGGER reject_ack BEFORE DELETE ON inbox WHEN OLD.update_id=10 BEGIN SELECT RAISE(ABORT,'inbox acknowledgement unavailable'); END;");
    const calls: number[] = [];
    const processor = new InboxProcessor(h.store, h.clock, async update => { calls.push(update.update_id); });
    await expect(processor.process()).rejects.toThrow('inbox acknowledgement unavailable');
    expect(calls).toEqual([10]);
    expect(h.store.db.query('SELECT * FROM inbox WHERE update_id=10').get()).toEqual(before);
    expect(h.store.inboxStats(h.clock.now()).failed).toBe(0);
    expect(h.store.nextOffset()).toBe(12); // intake persistence is independent of processing acknowledgement
    h.store.db.exec('DROP TRIGGER reject_ack');
    await processor.process();
    expect(calls).toEqual([10, 10, 11]); // replay is expected; processing is not exactly-once
    expect(h.store.inboxStats(h.clock.now()).pending).toBe(0);
  });
}
