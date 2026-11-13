import { expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, applySetting, parseSettings } from '@guard/core';
import { GROUP, OWNER, answer, boardTokens, enrol, harness } from './helpers';
import { SETTING_MENU } from '../apps/bot/src/admin/settings-menu';

async function setup() {
  const h=harness({cap:true});enrol(h,GROUP,OWNER,{requestLifetimeMin:1,challengeTimeoutSec:60});
  await h.v.onMemberJoined(GROUP,5001,true,999,h.clock.now());
  const request=h.store.liveRequest(GROUP,5001)!;
  const ticket=h.store.issueCapTicket(request.id,5001,h.clock.now())!;
  return {...h,request,ticket};
}
async function pass(h:Awaited<ReturnType<typeof setup>>) {
  expect(h.store.completeCap(h.ticket,h.clock.now(),'en',200)).toBe(true);
  await h.v.drainOutbox();
}

test('new groups have one minute for Cap and a separate minute for pictures',()=>{
 const h=harness();
 const group=h.store.enrolGroup(GROUP,OWNER,DEFAULT_SETTINGS,h.clock.now());
 expect(h.store.settingsOf(group)).toMatchObject({requestLifetimeMin:1,challengeTimeoutSec:60});
 expect(applySetting(DEFAULT_SETTINGS,'requestLifetimeMin','1').ok).toBe(true);
 expect(applySetting(DEFAULT_SETTINGS,'requestLifetimeMin','0').ok).toBe(false);
 expect(applySetting(DEFAULT_SETTINGS,'challengeTimeoutSec','60').ok).toBe(true);
 expect(SETTING_MENU.find(x=>x.key==='requestLifetimeMin')?.label).toBe('Time for Cap');
 expect(SETTING_MENU.find(x=>x.key==='challengeTimeoutSec')?.label).toBe('Time for picture stage');
});

test('Cap taking 45 seconds starts a fresh 60-second picture window',async()=>{
 const h=await setup();h.clock.advance(45000);await pass(h);
 const session=h.store.liveSession(h.request.id)!;
 expect(session.expires_at).toBe(h.request.deadline_at+45000);
 expect(session.expires_at-h.clock.now()).toBe(60000);
 const tokens=boardTokens(h,5001,GROUP);h.clock.advance(59999);
 expect(await answer(h,5001,tokens.correct,GROUP)).toBe('approval-queued');
 expect(h.tg.unrestricted).toEqual([[GROUP,5001]]);
});

test('exact picture deadline rejects an old picture and moves to review without another timeout retry',async()=>{
 const h=await setup();await pass(h);const token=boardTokens(h,5001,GROUP).correct;
 h.clock.advance(60000);
 expect(h.v.answer(5001,GROUP,token).result).toBe('stale');
 await h.v.tick();expect(h.store.getRequest(h.request.id)?.state).toBe('manual_review');
 expect(h.tg.unrestricted).toHaveLength(0);
 expect(h.store.beginAttempt({requestId:h.request.id,actorId:5001,locale:'en',now:h.clock.now(),maxActiveSessions:200}).ok).toBe(false);
});

test('a late wrong answer, retry, skip and language resend keep the picture deadline',async()=>{
 const h=await setup();h.clock.advance(45000);await pass(h);
 const pictureDeadline=h.store.getRequest(h.request.id)!.deadline_at;h.clock.advance(40000);
 expect(await answer(h,5001,boardTokens(h,5001,GROUP).wrong,GROUP)).toBe('wrong');
 const retried=h.store.liveSession(h.request.id)!;expect(retried.expires_at).toBe(pictureDeadline);
 h.clock.advance(15000);const token=boardTokens(h,5001,GROUP).all[0]!;
 const skipped=h.v.answer(5001,GROUP,token,true);expect(skipped.result).toBe('next-round');
 await h.v.afterAnswer(skipped,GROUP);
 await h.v.onGroupLanguage(5001,GROUP,'zh-TW');
 expect(h.store.liveSession(h.request.id)?.expires_at).toBe(pictureDeadline);
 expect(h.store.getRequest(h.request.id)?.deadline_at).toBe(pictureDeadline);
});

test('Cap cannot pass at its own deadline even if no picture has started',async()=>{
 const h=await setup();h.clock.advance(60000);
 expect(h.store.completeCap(h.ticket,h.clock.now(),'en',200)).toBe(false);
 await h.v.tick();expect(h.store.getRequest(h.request.id)?.state).toBe('manual_review');
 expect(h.tg.photos).toHaveLength(0);expect(h.tg.unrestricted).toHaveLength(0);
});

test('operational policy update changes every group, preserves retry settings and clips existing checks',async()=>{
 const h=await setup();h.clock.advance(20000);await pass(h);
 // Simulate a pre-release long-lived check and a separate group with different retry policy.
 const second=-2002;enrol(h,second,OWNER,{requestLifetimeMin:10,attempts:3});
 const deadline=h.clock.now()+600000;
 h.store.db.query('UPDATE join_requests SET deadline_at=? WHERE id=?').run(deadline,h.request.id);
 h.store.db.query('UPDATE sessions SET expires_at=? WHERE request_id=?').run(deadline,h.request.id);
 const backup=h.dbPath+'.groups.json';
 const {join}=await import('node:path');
 const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'../scripts/set-verification-stages.ts'),backup],{
  env:{BOT_TOKEN:'999:'+ 'x'.repeat(40),DATABASE_PATH:h.dbPath,ASSETS_DIR:join(import.meta.dir,'../assets'),BOARD_TEMP_DIR:h.boardDir},stdout:'pipe',stderr:'pipe',
 });
 expect(result.exitCode).toBe(0);
 for(const group of h.store.listGroups())expect(h.store.settingsOf(group)).toMatchObject({requestLifetimeMin:1,challengeTimeoutSec:60});
 expect(h.store.settingsOf(h.store.getGroup(second)!).attempts).toBe(3);
 expect(h.store.getRequest(h.request.id)?.deadline_at).toBe(h.request.request_date+80000);
 expect(h.store.liveSession(h.request.id)?.expires_at).toBe(h.request.request_date+80000);
 const original=JSON.parse(await Bun.file(backup).text()) as {chat_id:number;settings_json:string}[];
 expect(JSON.parse(original.find(g=>g.chat_id===second)!.settings_json).requestLifetimeMin).toBe(10);
});
