import { expect, test } from 'bun:test';
import { GROUP, OWNER, enrol, harness } from './helpers';

test('username refresh, ambiguity and expiry retain the original privacy boundaries', () => {
  const h = harness();
  const now = h.clock.now();
  h.store.rememberUsername(5001, 'AgentOne', now);
  expect(h.store.userIdForUsername('AGENTONE', now)).toBe(5001);
  h.store.rememberUsername(5001, 'agentone', now + 1000);
  expect(JSON.parse(h.store.getState('username:5001')!)).toEqual({ username: 'agentone', seenAt: now });
  h.store.rememberUsername(5002, 'AgentOne', now);
  expect(h.store.userIdForUsername('agentone', now)).toBeUndefined();
  h.store.rememberUsername(5002, undefined, now + 1000);
  expect(h.store.userIdForUsername('agentone', now + 1000)).toBe(5001);
  h.store.rememberUsername(5001, 'NewName', now + 2000);
  expect(h.store.userIdForUsername('agentone', now + 2000)).toBeUndefined();
  expect(h.store.userIdForUsername('newname', now + 2000 + 30 * 86_400_000)).toBeUndefined();
});

test('username retention stays bounded and never deletes other runtime namespaces', () => {
  const h = harness();
  h.store.rememberUsername(5001, 'one', h.clock.now());
  h.store.rememberUsername(5002, 'two', h.clock.now());
  h.store.setState('custom:setting', 'keep');
  h.clock.advance(30 * 86_400_000);
  h.store.purge(h.clock.now(), 1);
  expect([h.store.getState('username:5001'), h.store.getState('username:5002')].filter(Boolean)).toHaveLength(1);
  h.store.purge(h.clock.now(), 1);
  expect(h.store.getState('username:5001')).toBeUndefined();
  expect(h.store.getState('username:5002')).toBeUndefined();
  expect(h.store.getState('custom:setting')).toBe('keep');
});

test('photo cache isolates bot identities and participates in outer rollback', () => {
  const h = harness();
  h.store.cachePut(1, 'same-bytes', 'bot-one', null, h.clock.now());
  h.store.cachePut(2, 'same-bytes', 'bot-two', null, h.clock.now());
  expect(h.store.cacheGet(1, 'same-bytes', h.clock.now())).toBe('bot-one');
  expect(h.store.cacheGet(2, 'same-bytes', h.clock.now())).toBe('bot-two');
  expect(() => h.store.db.transaction(() => {
    h.store.cacheRemove(1, 'same-bytes');
    h.store.setState('failed-transaction', 'value');
    throw new Error('rollback');
  }).immediate()).toThrow('rollback');
  expect(h.store.cacheGet(1, 'same-bytes', h.clock.now())).toBe('bot-one');
  expect(h.store.getState('failed-transaction')).toBeUndefined();
  h.store.cacheRemove(1, 'same-bytes');
  expect(h.store.cacheGet(2, 'same-bytes', h.clock.now())).toBe('bot-two');
});
