import {test,expect} from 'bun:test';
import {harness,enrol,GROUP,OWNER,boardTokens} from './helpers';
import {TgError} from '../apps/bot/src/telegram';
async function setup() {
 const h=harness({cap:true,autoRemoveFailed:true});enrol(h,GROUP,OWNER,{requestLifetimeMin:1,challengeTimeoutSec:60,attempts:1});
 await h.v.onMemberJoined(GROUP,5001,true,5001,h.clock.now());
 return {...h,request:h.store.liveRequest(GROUP,5001)!};
}
async function picture(h:Awaited<ReturnType<typeof setup>>) {
 const ticket=h.store.issueCapTicket(h.request.id,5001,h.clock.now())!;
 expect(h.store.completeCap(ticket,h.clock.now(),'en',200)).toBe(true);
 await h.v.drainOutbox();
}
test('delivered Cap timeout queues one removal and preserves the failure reason',async()=>{
 const h=await setup();h.clock.advance(60_000);await h.v.tick();await h.v.tick();
 expect(h.tg.kicked).toEqual([[GROUP,5001]]);
 expect(h.store.getRequest(h.request.id)).toMatchObject({state:'declined',reason_code:'expired'});
 expect(h.tg.unrestricted).toHaveLength(0);
});
test('wrong answer exhaustion removes a member without waiting for the scheduler',async()=>{
 const h=await setup();await picture(h);
 const result=h.v.answer(5001,GROUP,boardTokens(h,5001,GROUP).wrong);
 await h.v.afterAnswer(result,GROUP);
 expect(h.tg.kicked).toEqual([[GROUP,5001]]);
 expect(h.store.getRequest(h.request.id)?.reason_code).toBe('attempts_exhausted');
});
test('delivered picture timeout removes the member',async()=>{
 const h=await setup();await picture(h);h.clock.advance(60_000);await h.v.tick();
 expect(h.tg.kicked).toEqual([[GROUP,5001]]);
});
test('a delivered join-request Cap prompt expires into a Telegram decline',async()=>{
 const h=harness({cap:true,autoRemoveFailed:true});enrol(h,GROUP,OWNER,{requestLifetimeMin:1});
 await h.v.onJoin({updateId:987,chatId:GROUP,userId:5001,contactChatId:5001,requestedAt:h.clock.now()});await h.v.drainOutbox();
 const r=h.store.liveRequest(GROUP,5001)!;h.clock.advance(60_000);await h.v.tick();
 expect(h.tg.declined).toEqual([[GROUP,5001]]);expect(h.store.getRequest(r.id)?.state).toBe('declined');
});
for(const reason of ['help','busy','undelivered','late','raid'])test(`${reason} remains in review without automatic removal`,async()=>{
 const h=await setup();
 if(reason==='help')h.store.toReview(h.request.id,5001,'help_requested',h.clock.now());
 if(reason==='busy')h.store.noteVerificationServiceIssue(h.clock.now());
 if(reason==='undelivered')h.store.setPromptMessage(h.request.id,null);
 if(reason==='raid')h.store.setRaid(GROUP,true,OWNER,'test',h.clock.now());
 h.clock.advance(reason==='late'?91_000:60_000);await h.v.tick();
 expect(h.tg.kicked).toHaveLength(0);expect(h.tg.unrestricted).toHaveLength(0);
 expect(h.store.getRequest(h.request.id)?.state).toBe('manual_review');
});
test('a picture still preparing at expiry is not a user failure',async()=>{
 const h=await setup();const ticket=h.store.issueCapTicket(h.request.id,5001,h.clock.now())!;
 h.store.completeCap(ticket,h.clock.now(),'en',200);h.clock.advance(60_000);await h.v.tick();
 expect(h.tg.kicked).toHaveLength(0);expect(h.store.getRequest(h.request.id)?.state).toBe('manual_review');
});
test('automatic decisions survive restart and respect a newly paused guard',async()=>{
 const h=await setup();h.clock.advance(60_000);h.store.expireRequests(h.clock.now(),50);
 expect(h.store.getRequest(h.request.id)?.state).toBe('decline_pending');h.store.db.close();
 const restarted=harness({cap:true,autoRemoveFailed:true,dbPath:h.dbPath});
 restarted.clock.advance(h.clock.now()-restarted.clock.now());
 restarted.store.setEnabled(GROUP,false,OWNER,'test',restarted.clock.now());await restarted.v.drainOutbox();
 expect(restarted.tg.kicked).toHaveLength(0);expect(restarted.store.getRequest(h.request.id)?.state).toBe('manual_review');
});
test('failure while recording an automatic decision rolls back without queuing a kick',async()=>{
 const h=await setup();h.clock.advance(60_000);
 h.store.db.exec("CREATE TEMP TRIGGER reject_auto BEFORE INSERT ON audit_events WHEN NEW.action='automatic_decline' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
 expect(()=>h.store.expireRequests(h.clock.now(),50)).toThrow('audit unavailable');
 expect(h.store.getRequest(h.request.id)?.state).toBe('pending');await h.v.drainOutbox();expect(h.tg.kicked).toHaveLength(0);
});

test('recovered delivery problems still keep an expired check in review',async()=>{
 const h=await setup();await picture(h);
 h.store.db.query("UPDATE outbox SET last_error_code='network' WHERE request_id=? AND kind='prepare_round'").run(h.request.id);
 h.clock.advance(60_000);await h.v.tick();
 expect(h.tg.kicked).toHaveLength(0);expect(h.store.getRequest(h.request.id)?.state).toBe('manual_review');
});
test('a pending automatic removal resumes after restart',async()=>{
 const h=await setup();h.clock.advance(60_000);h.store.expireRequests(h.clock.now(),50);h.store.db.close();
 const restarted=harness({cap:true,autoRemoveFailed:true,dbPath:h.dbPath});restarted.clock.advance(h.clock.now()-restarted.clock.now());
 await restarted.v.drainOutbox();await restarted.v.drainOutbox();
 expect(restarted.tg.kicked).toEqual([[GROUP,5001]]);
});
