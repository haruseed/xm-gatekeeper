import { expect, test } from 'bun:test';
import { secureRng, tokenHash } from '@guard/core';
import { SqliteActionTokens } from '../packages/database/src/action-tokens';
import { harness } from './helpers';

const ACTOR = 1000;
const payload = { op: 'approve', chat: -1001, req: 'fixture', user: 5001 };

test('copied buttons do not consume the owner token; successful use is single-use', () => {
  const h = harness();
  const token = h.store.createActionToken(ACTOR, payload, h.clock.now() + 1000);
  const row = h.store.db.query('SELECT token_hash,payload_json FROM action_tokens').get() as { token_hash: string; payload_json: string };
  expect(row.token_hash).toBe(tokenHash(token));
  expect(row.token_hash).not.toBe(token);
  expect(h.store.consumeActionToken(token, 9999, h.clock.now())).toBeUndefined();
  expect(h.store.consumeActionToken(token, ACTOR, h.clock.now())).toEqual(payload);
  expect(h.store.consumeActionToken(token, ACTOR, h.clock.now())).toBeUndefined();
  const expired = h.store.createActionToken(ACTOR, payload, h.clock.now());
  expect(h.store.consumeActionToken(expired, ACTOR, h.clock.now())).toBeUndefined();
});

test('failed consume write and malformed payload leave the token unconsumed', () => {
  const h = harness();
  const token = h.store.createActionToken(ACTOR, payload, h.clock.now() + 1000);
  h.store.db.exec("CREATE TEMP TRIGGER reject_consume BEFORE UPDATE ON action_tokens BEGIN SELECT RAISE(ABORT,'write failed'); END;");
  expect(() => h.store.consumeActionToken(token, ACTOR, h.clock.now())).toThrow('write failed');
  h.store.db.exec('DROP TRIGGER reject_consume');
  h.store.db.query('UPDATE action_tokens SET payload_json=? WHERE token_hash=?').run('{', tokenHash(token));
  expect(() => h.store.consumeActionToken(token, ACTOR, h.clock.now())).toThrow();
  expect(h.store.db.query('SELECT consumed_at FROM action_tokens WHERE token_hash=?').get(tokenHash(token))).toEqual({ consumed_at: null });
  h.store.db.query('UPDATE action_tokens SET payload_json=? WHERE token_hash=?').run(JSON.stringify(payload), tokenHash(token));
  expect(h.store.consumeActionToken(token, ACTOR, h.clock.now())).toEqual(payload);
});

test('token creation and consumption join outer transactions without independent commits', () => {
  const h = harness();
  let rolledBackToken = '';
  expect(() => h.store.db.transaction(() => {
    rolledBackToken = h.store.createActionToken(ACTOR, payload, h.clock.now() + 1000);
    throw Error('abort creation');
  }).immediate()).toThrow('abort creation');
  expect(h.store.consumeActionToken(rolledBackToken, ACTOR, h.clock.now())).toBeUndefined();
  const token = h.store.createActionToken(ACTOR, payload, h.clock.now() + 1000);
  expect(() => h.store.db.transaction(() => {
    expect(h.store.consumeActionToken(token, ACTOR, h.clock.now())).toEqual(payload);
    throw Error('abort action');
  }).immediate()).toThrow('abort action');
  expect(h.store.consumeActionToken(token, ACTOR, h.clock.now())).toEqual(payload);
});

test('token retention is bounded, expiry-based and rolls back with surrounding maintenance', () => {
  const h = harness();
  const tokens = new SqliteActionTokens(h.store.db, secureRng);
  for (let i = 0; i < 4; i++) tokens.createActionToken(ACTOR, payload, h.clock.now());
  const live = tokens.createActionToken(ACTOR, payload, h.clock.now() + 1000);
  const count = () => (h.store.db.query('SELECT count(*) AS n FROM action_tokens').get() as { n: number }).n;
  expect(() => h.store.db.transaction(() => {
    tokens.purge(h.clock.now(), 2);
    expect(count()).toBe(3);
    throw Error('maintenance failed');
  }).immediate()).toThrow('maintenance failed');
  expect(count()).toBe(5);
  tokens.purge(h.clock.now(), 2);
  expect(count()).toBe(3);
  tokens.purge(h.clock.now(), 2);
  expect(count()).toBe(1);
  expect(tokens.consumeActionToken(live, ACTOR, h.clock.now())).toEqual(payload);
});
