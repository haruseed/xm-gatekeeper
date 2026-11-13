import { expect, test } from 'bun:test';
import { secureRng } from '@guard/core';
import { SqliteOutbox } from '../packages/database/src/outbox';
import { OutboxDispatcher } from '../apps/bot/src/outbox-dispatcher';
import { harness } from './helpers';

test('a successful operation with failed acknowledgement stays leased and replays after lease expiry', async () => {
  const h = harness();
  const queue = new SqliteOutbox(h.store.db, secureRng);
  queue.enqueue({dedupeKey:'recovery',requestId:null,revision:null,kind:'fixture',payload:{},now:h.clock.now()});
  h.store.db.exec("CREATE TEMP TRIGGER reject_completion BEFORE UPDATE OF state ON outbox WHEN NEW.state='done' BEGIN SELECT RAISE(ABORT,'ack unavailable'); END;");
  let executions = 0, failures = 0;
  const dispatcher = new OutboxDispatcher({store:h.store,clock:h.clock,rng:secureRng,
    execute:async()=>{executions++;},onFailed:()=>{failures++;}});
  await expect(dispatcher.drain()).rejects.toThrow('ack unavailable');
  const state = () => h.store.db.query('SELECT state,attempts,lease_until,last_error_code FROM outbox').get();
  expect(state()).toEqual({state:'pending',attempts:0,lease_until:h.clock.now()+60000,last_error_code:null});
  h.store.db.exec('DROP TRIGGER reject_completion');
  h.clock.advance(59999);
  await dispatcher.drain();
  expect(executions).toBe(1);
  h.clock.advance(1);
  await dispatcher.drain();
  expect(executions).toBe(2); // durable delivery is at-least-once; operation handlers must tolerate replay
  expect(failures).toBe(0);
  expect((state() as {state:string}).state).toBe('done');
});
