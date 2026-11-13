import { Bot } from 'grammy';
import { expect, test } from 'bun:test';
import { POLICY, secureRng } from '@guard/core';
import { isDatabaseError } from '@guard/database';
import { InboxProcessor } from '../apps/bot/src/inbox-processor';
import { OutboxDispatcher } from '../apps/bot/src/outbox-dispatcher';
import { SqliteOutbox } from '../packages/database/src/outbox';
import { GROUP, enrol, harness, join_ } from './helpers';

test('driver errors are identified by type rather than error wording', () => {
  const h = harness();
  expect(isDatabaseError(new Error('SQLiteError: SQLITE_BUSY'))).toBe(false);
  try { h.store.db.exec('SELECT * FROM missing_table'); }
  catch (error) { expect(isDatabaseError(error)).toBe(true); return; }
  throw Error('fixture did not fail');
});

test('a database error inside an inbox handler preserves its last retry and stops the pass', async () => {
  const h = harness();
  h.store.storeBatchAndAdvance([{update_id:1,payload:{update_id:1}}],h.clock.now());
  h.store.db.query('UPDATE inbox SET attempts=?').run(POLICY.inboxMaxAttempts-1);
  const before = h.store.db.query('SELECT * FROM inbox').get();
  h.store.db.exec("CREATE TEMP TRIGGER reject_state BEFORE INSERT ON runtime_state WHEN NEW.key='work' BEGIN SELECT RAISE(ABORT,'storage unavailable'); END;");
  const processor = new InboxProcessor(h.store,h.clock,async()=>{h.store.setState('work','done');});
  await expect(processor.process()).rejects.toThrow('storage unavailable');
  expect(h.store.db.query('SELECT * FROM inbox').get()).toEqual(before);
  h.store.db.exec('DROP TRIGGER reject_state');
  await processor.process();
  expect(h.store.getState('work')).toBe('done');
  expect(h.store.inboxStats(h.clock.now()).pending).toBe(0);
});

test('database errors inside outbox execution preserve retry budget and do not invoke failure policy', async () => {
  const h = harness();
  new SqliteOutbox(h.store.db,secureRng).enqueue({dedupeKey:'db',requestId:null,revision:null,kind:'fixture',payload:{},now:h.clock.now()});
  h.store.db.query('UPDATE outbox SET attempts=?').run(POLICY.outboxMaxAttempts-1);
  h.store.db.exec("CREATE TEMP TRIGGER reject_state BEFORE INSERT ON runtime_state WHEN NEW.key='work' BEGIN SELECT RAISE(ABORT,'storage unavailable'); END;");
  let failures=0;
  const dispatcher=new OutboxDispatcher({store:h.store,clock:h.clock,rng:secureRng,
    execute:async()=>{h.store.setState('work','done');},onFailed:()=>{failures++;}});
  await expect(dispatcher.drain()).rejects.toThrow('storage unavailable');
  expect(h.store.db.query('SELECT state,attempts,last_error_code FROM outbox').get())
    .toEqual({state:'pending',attempts:POLICY.outboxMaxAttempts-1,last_error_code:null});
  expect(failures).toBe(0);
  h.store.db.exec('DROP TRIGGER reject_state');
  h.clock.advance(60000);
  await dispatcher.drain();
  expect(h.store.getState('work')).toBe('done');
});

test('failed round activation remains preparing and recovers without render-failure review', async () => {
  const h=harness();enrol(h);
  h.store.db.exec("CREATE TEMP TRIGGER reject_round BEFORE UPDATE OF state ON sessions WHEN NEW.state='active' BEGIN SELECT RAISE(ABORT,'round storage unavailable'); END;");
  await expect(join_(h,5001)).rejects.toThrow('round storage unavailable');
  const request=h.store.liveRequest(GROUP,5001)!;
  expect(request.state).toBe('challenging');
  expect(h.store.liveSession(request.id)?.state).toBe('preparing');
  expect(h.tg.photos).toHaveLength(0);
  expect(h.store.listAudit(GROUP,50).some(row=>row.reason_code==='render_failed')).toBe(false);
  h.store.db.exec('DROP TRIGGER reject_round');
  h.clock.advance(60000);
  await h.v.drainOutbox();
  expect(h.store.liveSession(request.id)?.state).toBe('active');
  expect(h.tg.photos).toHaveLength(1);
  expect(h.tg.approved).toHaveLength(0);
});


test('grammY-wrapped database errors preserve inbox retry budget through the real handler boundary', async () => {
  const h=harness();
  const bot=new Bot('999:'+ 'x'.repeat(40), {botInfo:{id:999,is_bot:true,first_name:'fixture',username:'fixture_bot',can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false,can_connect_to_business:false,has_main_web_app:false,has_topics_enabled:false,allows_users_to_create_topics:false,can_manage_bots:false,supports_join_request_queries:false}});
  bot.on('message',()=>{h.store.setState('wrapped','done');});
  h.store.storeBatchAndAdvance([{update_id:10,payload:{update_id:10,message:{message_id:1,date:1,chat:{id:5001,type:'private',first_name:'fixture'},from:{id:5001,is_bot:false,first_name:'fixture'},text:'fixture'}}}],h.clock.now());
  h.store.db.query('UPDATE inbox SET attempts=?').run(POLICY.inboxMaxAttempts-1);
  const before=h.store.db.query('SELECT * FROM inbox').get();
  h.store.db.exec("CREATE TEMP TRIGGER reject_wrapped BEFORE INSERT ON runtime_state WHEN NEW.key='wrapped' BEGIN SELECT RAISE(ABORT,'wrapped storage unavailable'); END;");
  const processor=new InboxProcessor(h.store,h.clock,update=>bot.handleUpdate(update));
  await expect(processor.process()).rejects.toThrow('wrapped storage unavailable');
  expect(h.store.db.query('SELECT * FROM inbox').get()).toEqual(before);
  h.store.db.exec('DROP TRIGGER reject_wrapped');
  await processor.process();
  expect(h.store.getState('wrapped')).toBe('done');
  expect(h.store.inboxStats(h.clock.now()).pending).toBe(0);
});
