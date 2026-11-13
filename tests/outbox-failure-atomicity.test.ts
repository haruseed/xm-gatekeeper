import { expect, test } from 'bun:test';
import { secureRng } from '@guard/core';
import { SqliteOutbox } from '../packages/database/src/outbox';
import { TgError } from '../apps/bot/src/telegram';
import { GROUP, enrol, harness, join_ } from './helpers';

test('failed manual-review audit rolls back outbox failure and permits recovery after the lease', async () => {
  const h=harness();enrol(h);
  h.tg.failNext('sendPhoto',new TgError('bad_request','rejected photo'),new TgError('bad_request','rejected photo'));
  h.store.db.exec("CREATE TEMP TRIGGER reject_review BEFORE INSERT ON audit_events WHEN NEW.action='request_manual_review' BEGIN SELECT RAISE(ABORT,'review audit unavailable'); END;");
  await expect(join_(h,5001)).rejects.toThrow('review audit unavailable');
  const request=h.store.liveRequest(GROUP,5001)!;
  expect(request.state).toBe('challenging');
  expect(h.store.liveSession(request.id)?.state).toBe('active');
  const work=()=>h.store.db.query("SELECT state,attempts,lease_until,last_error_code FROM outbox WHERE kind='prepare_round'").get();
  expect(work()).toEqual({state:'pending',attempts:0,lease_until:h.clock.now()+60000,last_error_code:null});
  expect(h.tg.approved).toHaveLength(0);
  h.store.db.exec('DROP TRIGGER reject_review');
  h.clock.advance(60000);
  await h.v.drainOutbox();
  expect(h.store.getRequest(request.id)?.state).toBe('manual_review');
  expect(h.store.getRequest(request.id)?.reason_code).toBe('send_failed_bad_request');
  expect(work()).toEqual({state:'failed',attempts:0,lease_until:null,last_error_code:'bad_request'});
});

test('failure-state write rejection never applies workflow failure policy', () => {
  const h=harness();
  const outbox=new SqliteOutbox(h.store.db,secureRng);
  outbox.enqueue({dedupeKey:'failure',requestId:null,revision:null,kind:'fixture',payload:{},now:h.clock.now()});
  const row=h.store.claimOutbox(h.clock.now(),1,60000)[0]!;
  h.store.db.exec("CREATE TEMP TRIGGER reject_failure BEFORE UPDATE OF state ON outbox WHEN NEW.state='failed' BEGIN SELECT RAISE(ABORT,'failure storage unavailable'); END;");
  let called=false;
  expect(()=>h.store.failOutbox(row.id,'bad_request',()=>{called=true;})).toThrow('failure storage unavailable');
  expect(called).toBe(false);
  expect(h.store.db.query('SELECT state,lease_until FROM outbox').get()).toEqual({state:'pending',lease_until:h.clock.now()+60000});
});
