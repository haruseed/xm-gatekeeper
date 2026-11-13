import { expect, test } from 'bun:test';
import { POLICY } from '@guard/core';
import type { OutboxRepository, OutboxRow } from '@guard/database';
import { OutboxDispatcher, DeferredWork } from '../apps/bot/src/outbox-dispatcher';
import { TgError } from '../apps/bot/src/telegram';

const row = (id: string, request = id, attempts = 0): OutboxRow => ({
  id, request_id: request, request_revision: 1, dedupe_key: id, kind: 'prepare_round', payload_json: '{}',
  state: 'pending', attempts, next_attempt_at: 0, lease_until: null, last_error_code: null, created_at: 0,
});
function fixture(rows: OutboxRow[]) {
  let claims = 0;
  const done: string[] = [], failed: string[] = [];
  const retries: [string, string, number, boolean][] = [];
  const store: OutboxRepository = {
    claimOutbox: () => ++claims === 1 ? rows : [],
    completeOutbox: id => { done.push(id); },
    retryOutbox: (...args) => { retries.push(args); },
    failOutbox: (id, _code, applyFailure) => { failed.push(id); applyFailure?.(); },
    outboxStats: () => ({ pending: 0, oldestAgeMs: 0 }),
  };
  return { store, done, failed, retries, claims: () => claims, clock: { now: () => 10000 }, rng: { int: () => 0 } };
}

test('four workers overlap independent requests but keep each claimed request sequential', async () => {
  const h = fixture([row('a1','a'), row('a2','a'), row('b'), row('c'), row('d'), row('e')]);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const active = new Set<string>(), events: string[] = [];
  let peak = 0;
  const dispatcher = new OutboxDispatcher({ ...h, onFailed: () => {}, execute: async work => {
    const key = work.request_id!;
    expect(active.has(key)).toBe(false);
    active.add(key); peak = Math.max(peak, active.size);
    events.push(`start:${work.id}`);
    if (active.size === 4) entered.resolve();
    await release.promise;
    events.push(`end:${work.id}`);
    active.delete(key);
  } });
  const draining = dispatcher.drain();
  await entered.promise;
  await dispatcher.drain();
  expect(h.claims()).toBe(1);
  release.resolve(); await draining;
  expect(peak).toBe(4);
  expect(events.indexOf('end:a1')).toBeLessThan(events.indexOf('start:a2'));
  expect(h.done.sort()).toEqual(['a1','a2','b','c','d','e']);
});

test('persistence failure waits for sibling workers before releasing the drain lock', async () => {
  const h = fixture([row('failed'), row('slow')]);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const storageError = new Error('SQLite write failed');
  h.store.failOutbox = () => { throw storageError; };
  const dispatcher = new OutboxDispatcher({ ...h, onFailed: () => {}, execute: async work => {
    if (work.id === 'failed') throw new TgError('bad_request','invalid operation');
    entered.resolve(); await release.promise;
  } });
  const result = dispatcher.drain().catch(error => error);
  await entered.promise;
  await Promise.resolve();
  await dispatcher.drain();
  expect(h.claims()).toBe(1);
  release.resolve();
  expect(await result).toBe(storageError);
  expect(h.done).toEqual(['slow']);
  await dispatcher.drain();
  expect(h.claims()).toBe(2);
});

test('deferred work, Telegram rate limits and failed network attempts keep distinct retry accounting', async () => {
  const h = fixture([row('defer'), row('rate'), row('network'), row('exhausted','exhausted',POLICY.outboxMaxAttempts-1)]);
  const failures: string[] = [];
  await new OutboxDispatcher({ ...h, onFailed: work => { failures.push(work.id); }, execute: async work => {
    if (work.id === 'defer') throw new DeferredWork(2000);
    if (work.id === 'rate') throw new TgError('rate','limited',5000);
    throw new TgError('network','offline');
  } }).drain();
  expect(h.retries).toEqual([
    ['defer','deferred',12000,false], ['rate','rate_limited',15000,false], ['network','network',11000,true],
  ]);
  expect(h.failed).toEqual(['exhausted']);
  expect(failures).toEqual(['exhausted']);
});

test('nested drain calls return without deadlocking the executing workflow', async () => {
  const h = fixture([row('nested')]);
  const dispatcher = new OutboxDispatcher({ ...h, onFailed: () => {}, execute: async () => { await dispatcher.drain(); } });
  await dispatcher.drain();
  expect(h.done).toEqual(['nested']);
});

for (const attempts of [0, POLICY.outboxMaxAttempts - 1]) {
  test(`completion write failure does not spend retries or fail a successful operation at attempt ${attempts}`, async () => {
    const h = fixture([row('sent', 'request', attempts)]);
    const error = new Error('completion unavailable');
    h.store.completeOutbox = () => { throw error; };
    let executed = 0, failures = 0;
    const dispatcher = new OutboxDispatcher({ ...h,
      execute: async () => { executed++; }, onFailed: () => { failures++; },
    });
    await expect(dispatcher.drain()).rejects.toBe(error);
    expect(executed).toBe(1);
    expect(h.retries).toEqual([]);
    expect(h.failed).toEqual([]);
    expect(failures).toBe(0);
  });
}
