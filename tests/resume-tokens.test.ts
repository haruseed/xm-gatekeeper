import { expect, test } from 'bun:test';
import { LIVE_REQUEST_STATES, secureRng, tokenHash, type RequestState } from '@guard/core';
import { SqliteResumeTokens } from '../packages/database/src/resume-tokens';
import { GROUP, enrol, harness } from './helpers';

function setup() {
  const h = harness(); enrol(h);
  const input = { updateId: 901, chatId: GROUP, userId: 5001, contactChatId: 5001, requestDate: h.clock.now(), now: h.clock.now() };
  const result = h.store.recordJoin(input);
  if (result.kind !== 'created') throw Error('fixture admission failed');
  const token = h.store.createResumeToken(result.request.id, h.clock.now() + 1000);
  return { ...h, input, request: result.request, token };
}

test('resume links remain reusable, owner-bound and invalid at the exact expiry', () => {
  const h = setup();
  expect(h.store.db.query('SELECT token_hash FROM resume_tokens').get()).toEqual({token_hash:tokenHash(h.token)});
  expect(h.store.resolveResumeToken(h.token, 7777, h.clock.now())).toBeUndefined();
  for (let i = 0; i < 2; i++) expect(h.store.resolveResumeToken(h.token, 5001, h.clock.now())?.id).toBe(h.request.id);
  expect(h.store.resolveResumeToken(h.token, 5001, h.clock.now()+999)?.id).toBe(h.request.id);
  expect(h.store.resolveResumeToken(h.token, 5001, h.clock.now()+1000)).toBeUndefined();
});

test('resume links resolve only unresolved request states without advancing them', () => {
  const h = setup();
  const closed: RequestState[] = ['approved','decline_pending','declined','expired','superseded','external_resolution'];
  for (const state of [...LIVE_REQUEST_STATES, ...closed]) {
    h.store.db.query('UPDATE join_requests SET state=? WHERE id=?').run(state,h.request.id);
    expect(h.store.resolveResumeToken(h.token, 5001, h.clock.now())?.state).toBe(LIVE_REQUEST_STATES.includes(state) ? state : undefined);
    expect(h.store.getRequest(h.request.id)?.state).toBe(state);
  }
});

test('superseding admission revokes old links atomically, including rollback on failed insertion', () => {
  const h = setup();
  const next = {...h.input,updateId:902,requestDate:h.clock.now()+1,now:h.clock.now()+1};
  h.store.db.exec("CREATE TEMP TRIGGER reject_new_request BEFORE INSERT ON join_requests BEGIN SELECT RAISE(ABORT,'admission failed'); END;");
  expect(()=>h.store.recordJoin(next)).toThrow('admission failed');
  expect(h.store.resolveResumeToken(h.token,5001,h.clock.now())?.id).toBe(h.request.id);
  h.store.db.exec('DROP TRIGGER reject_new_request');
  expect(h.store.recordJoin(next).kind).toBe('created');
  expect(h.store.resolveResumeToken(h.token,5001,h.clock.now())).toBeUndefined();
  expect(h.store.db.query('SELECT count(*) AS n FROM resume_tokens').get()).toEqual({n:0});
});

test('resume cleanup is bounded and only removes expired links', () => {
  const h = setup(); const tokens = new SqliteResumeTokens(h.store.db,secureRng);
  for(let i=0;i<3;i++) tokens.create(h.request.id,h.clock.now());
  tokens.purge(h.clock.now(),2);
  expect(h.store.db.query('SELECT count(*) AS n FROM resume_tokens').get()).toEqual({n:2});
  tokens.purge(h.clock.now(),2);
  expect(h.store.db.query('SELECT count(*) AS n FROM resume_tokens').get()).toEqual({n:1});
  expect(h.store.resolveResumeToken(h.token,5001,h.clock.now())?.id).toBe(h.request.id);
});
