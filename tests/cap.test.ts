import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { generateChallenge } from 'capjs-core';
import sharp from 'sharp';
import { capHandler, telegramUser } from '../apps/bot/src/cap';
import { generateRound, composeBoard } from '@guard/captcha';
import { LocalAssetStore } from '@guard/assets';
import { secureRng, type Config } from '@guard/core';
import { ASSETS_DIR, GROUP, OWNER, T0, harness, enrol, boardTokens, answer, join_ } from './helpers';

const USER=5001, BOT_TOKEN='123456:'+'a'.repeat(40);
function signed(userId=USER, time=T0, token=BOT_TOKEN, startParam?:string) {
  const p = new URLSearchParams({auth_date:String(Math.floor(time/1000)),user:JSON.stringify({id:userId,first_name:'Test'}),query_id:'test'});
  if(startParam)p.set('start_param',startParam);
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  const data=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  p.set('hash',createHmac('sha256',secret).update(data).digest('hex'));
  return p.toString();
}
function setup() {const h=harness({cap:true});enrol(h);return h;}
async function member(h:ReturnType<typeof setup>) {
  await h.v.onMemberJoined(GROUP,USER,true,1,h.clock.now());
  return h.store.liveRequest(GROUP,USER)!;
}
function pass(h:ReturnType<typeof setup>, requestId:string) {
  const ticket=h.store.issueCapTicket(requestId,USER,h.clock.now())!;
  expect(h.store.completeCap(ticket,h.clock.now(),'en',200)).toBe(true);
  return ticket;
}

describe('Cap before one picture',()=>{
 test('Main Mini App links launch directly from the group when enabled',async()=>{
  const h=harness({cap:true,groupLaunch:true});enrol(h);const r=await member(h);
  expect(h.tg.prompts[0]!.markup.inline_keyboard[0]![0]).toEqual({text:'Verify',url:`https://t.me/guard_test_bot?startapp=cap_${r.id}&mode=compact`});
  expect(h.tg.messages).toHaveLength(0);expect(h.tg.photos).toHaveLength(0);
 });
 test('only fresh, untampered Telegram initData identifies the user',()=>{
  expect(telegramUser(signed(),BOT_TOKEN,T0)).toBe(USER);
  expect(telegramUser(signed(),BOT_TOKEN,T0+601_000)).toBeUndefined();
  expect(telegramUser(signed(USER,T0+60_000),BOT_TOKEN,T0)).toBeUndefined();
  expect(telegramUser(signed(OWNER).replace('1000','5001'),BOT_TOKEN,T0)).toBeUndefined();
  expect(telegramUser(signed(USER,T0,'wrong'),BOT_TOKEN,T0)).toBeUndefined();
  expect(telegramUser(signed()+'&user=%7B%22id%22%3A5001%7D',BOT_TOKEN,T0)).toBeUndefined();
 });
 test('a muted member gets no picture before Cap, then exactly six choices and one correct answer unmutes',async()=>{
  const h=setup(), r=await member(h);
  expect(h.tg.restricted).toEqual([[GROUP,USER]]);
  expect(h.tg.photos).toHaveLength(0);
  expect(h.tg.prompts[0]!.markup.inline_keyboard[0]![0]).toHaveProperty('url');
  expect(h.store.beginAttempt({requestId:r.id,actorId:USER,locale:'en',now:h.clock.now(),maxActiveSessions:200})).toEqual({ok:false,reason:'cap_required'});
  await h.v.onStart(USER,USER,'cap_'+r.id);
  expect(h.tg.messages.at(-1)!.markup!.inline_keyboard[0]![0]).toHaveProperty('web_app');
  const ticket=pass(h,r.id);
  expect(h.store.completeCap(ticket,h.clock.now(),'en',200)).toBe(false);
  await h.v.drainOutbox();
  expect(h.tg.photos).toHaveLength(1);
  const board=boardTokens(h,USER,GROUP);
  expect(board.all).toHaveLength(6);
  expect(board.caption).toContain('Round 1 of 1');
  expect(h.tg.unrestricted).toHaveLength(0);
  expect(await answer(h,USER,board.correct,GROUP)).toBe('approval-queued');
  expect(h.tg.unrestricted).toEqual([[GROUP,USER]]);
 });
 test('question changes preserve attempt and expiry, reject other users and replays, and stop after three',async()=>{
  const h=setup(),r=await member(h);pass(h,r.id);await h.v.drainOutbox();
  const session=()=>h.store.db.query('SELECT * FROM sessions WHERE request_id=?').get(r.id) as any;
  const original=session();
  const targets=new Set([JSON.parse(original.question_json).itemId]);
  const attempts=()=>h.store.db.query('SELECT COUNT(*) AS n FROM attempts').get() as {n:number};
  const count=attempts().n;
  for(let i=0;i<3;i++){
   const board=boardTokens(h,USER,GROUP);
   const button=h.tg.photos.at(-1)!.markup.inline_keyboard.flat().find(b=>'callback_data' in b && b.callback_data.startsWith('s:'))!;
   if(!('callback_data' in button))throw Error('missing skip button');
   const token=button.callback_data.slice(2);
   expect(h.v.answer(OWNER,GROUP,token,true).result).toBe('stale');
   expect(h.v.answer(USER,USER,token,true).result).toBe('stale');
   const result=h.v.answer(USER,GROUP,token,true);
   expect(result.result).toBe('next-round');
   expect(h.v.answer(USER,GROUP,token,true).result).toBe('stale');
   expect(h.v.answer(USER,GROUP,board.correct).result).toBe('stale');
   await h.v.afterAnswer(result,GROUP);
   const current=session();
   expect(current.id).toBe(original.id);expect(current.round_no).toBe(1);
   expect(current.expires_at).toBe(original.expires_at);expect(attempts().n).toBe(count);
   expect(h.store.capPassed(r.id)).toBe(true);expect(h.tg.unrestricted).toHaveLength(0);
   const target=JSON.parse(current.question_json).itemId;
   expect(targets.has(target)).toBe(false);targets.add(target);
  }
  const board=boardTokens(h,USER,GROUP);
  expect(h.v.answer(USER,GROUP,board.correct,true).result).toBe('skip-limit');
  expect(await answer(h,USER,board.correct,GROUP)).toBe('approval-queued');
  expect(h.tg.unrestricted).toEqual([[GROUP,USER]]);
 });
 test('join requests stay outside until both checks pass',async()=>{
  const h=setup();await join_(h,USER);
  const r=h.store.liveRequest(GROUP,USER)!;
  expect(h.tg.photos).toHaveLength(0);
  pass(h,r.id);await h.v.drainOutbox();
  expect(h.tg.approved).toHaveLength(0);
  await answer(h,USER,boardTokens(h,USER).correct);
  expect(h.tg.approved).toEqual([[GROUP,USER]]);
 });
 test('wrong picture retries remain six-choice; exhaustion still goes to review',async()=>{
  const h=setup(),r=await member(h);pass(h,r.id);await h.v.drainOutbox();
  await answer(h,USER,boardTokens(h,USER,GROUP).wrong,GROUP);
  expect(boardTokens(h,USER,GROUP).all).toHaveLength(6);
  await answer(h,USER,boardTokens(h,USER,GROUP).wrong,GROUP);
  expect(h.store.getRequest(r.id)!.state).toBe('manual_review');
  expect(h.tg.unrestricted).toHaveLength(0);
 });
 test('tickets cannot cross accounts, revive expired requests, bypass raid mode, or replay a nonce',async()=>{
  const h=setup(),r=await member(h);
  expect(h.store.issueCapTicket(r.id,OWNER,h.clock.now())).toBeUndefined();
  const tk=h.store.issueCapTicket(r.id,USER,h.clock.now())!;
  expect(h.store.takeCapChallenge(tk,h.clock.now())).toBe(true);
  expect(h.store.takeCapChallenge(tk,h.clock.now())).toBe(false);
  expect(h.store.consumeCapNonce('nonce',60_000,h.clock.now())).toBe(true);
  expect(h.store.consumeCapNonce('nonce',60_000,h.clock.now())).toBe(false);
  h.store.setRaid(GROUP,true,OWNER,'test',h.clock.now());
  expect(h.store.completeCap(tk,h.clock.now(),'en',200)).toBe(false);
  h.store.setRaid(GROUP,false,OWNER,'test',h.clock.now());
  h.clock.advance(601_000);
  expect(h.store.completeCap(tk,h.clock.now(),'en',200)).toBe(false);
 });
 test('Cap result and queued picture survive reopening the database',async()=>{
  const h=setup(),r=await member(h);pass(h,r.id);
  h.store.db.close();
  const restarted=harness({cap:true,dbPath:h.dbPath});
  expect(restarted.store.capPassed(r.id)).toBe(true);
  await restarted.v.drainOutbox();
  expect(restarted.tg.photos).toHaveLength(1);
 });
 test('private Cap prompts are deleted only after success, without deleting the picture',async()=>{
  const h=setup(),r=await member(h);
  await h.v.onStart(USER,USER,'cap_'+r.id);
  const prompts=h.store.db.query('SELECT message_id FROM cap_messages').all() as {message_id:number}[];
  expect(prompts).toHaveLength(1);
  await h.v.cleanupCapMessages();expect(h.tg.deleted).not.toContain(prompts[0]!.message_id);
  pass(h,r.id);await h.v.drainOutbox();await h.v.cleanupCapMessages();
  expect(h.tg.deleted).toContain(prompts[0]!.message_id);
  expect(h.tg.deleted).not.toContain(h.tg.photos[0]!.id);
  expect(h.store.db.query('SELECT * FROM cap_messages').all()).toHaveLength(0);
 });
 test('admin retry resets an unfinished exhausted Cap check',async()=>{
  const h=setup(),r=await member(h);
  const ticket=h.store.issueCapTicket(r.id,USER,h.clock.now())!;
  for(let i=0;i<10;i++){expect(h.store.takeCapChallenge(ticket,h.clock.now())).toBe(true);h.clock.advance(3001);}
  expect(h.store.takeCapChallenge(ticket,h.clock.now())).toBe(false);
  h.store.toReview(r.id,USER,'help_requested',h.clock.now());
  h.store.grantRetry(r.id,GROUP,OWNER,h.clock.now());
  expect(h.store.capTicket(ticket,h.clock.now())).toBeUndefined();
  const next=h.store.issueCapTicket(r.id,USER,h.clock.now())!;
  expect(h.store.takeCapChallenge(next,h.clock.now())).toBe(true);
 });
 test('a delayed Cap result cannot revive a user who has left',async()=>{
  const h=setup(),r=await member(h),ticket=h.store.issueCapTicket(r.id,USER,h.clock.now())!;
  await h.v.onMemberLeft(GROUP,USER);
  expect(h.store.completeCap(ticket,h.clock.now(),'en',200)).toBe(false);
  expect(h.tg.photos).toHaveLength(0);
 });
 test('preprocessed board has six unique images and supports identification and function questions',async()=>{
  const assets=new LocalAssetStore(ASSETS_DIR);
  for(let i=0;i<20;i++) {
   const round=generateRound(assets.approvedIds(),secureRng,[]);
   expect(new Set(round.itemIds).size).toBe(6);expect(['identify','function']).toContain(round.question.kind);
  }
  const round=generateRound(assets.approvedIds(),secureRng,[]);
  const bytes=await composeBoard(await Promise.all(round.itemIds.map(id=>assets.readApprovedAsset(id))),secureRng);
  const meta=await sharp(bytes).metadata();expect([meta.width,meta.height]).toEqual([900,600]);
 });
 test('HTTP routes serve local assets, authenticate ownership, reject invalid solutions, and bind scope',async()=>{
  const h=setup(),r=await member(h);
  const config:Config={botToken:BOT_TOKEN,databasePath:h.dbPath,assetsDir:ASSETS_DIR,boardTempDir:h.boardDir,maxActiveSessions:200,maxOutboxPending:500,maxRenderQueue:20,logLevel:'error',cap:{publicUrl:'https://guard.example/guard/verify',secret:'x'.repeat(32)}};
  const handler=capHandler(config,h.store,h.v,h.clock);
  const post=(path:string,body:unknown,tk?:string)=>new Request(config.cap!.publicUrl+path,{method:'POST',headers:{origin:'https://guard.example','Content-Type':'application/json',...(tk?{Authorization:'Bearer '+tk}:{})},body:JSON.stringify(body)});
  for(const path of ['','/widget.js','/hashwx.wasm','/pako.js']) {
   const response=await handler(new Request(config.cap!.publicUrl+path));expect(response!.status).toBe(200);expect((await response!.arrayBuffer()).byteLength).toBeGreaterThan(100);
  }
  expect((await handler(post('/session',{initData:signed(OWNER),requestId:r.id})))!.status).toBe(403);
  expect((await handler(post('/session',{initData:signed(USER,T0,BOT_TOKEN,'cap_wrong'),requestId:r.id})))!.status).toBe(403);
  expect((await handler(post('/session',{initData:signed(USER,T0,BOT_TOKEN,'cap_'+r.id),requestId:r.id})))!.status).toBe(200);
  const session=await (await handler(post('/session',{initData:signed(),requestId:r.id})))!.json();
  const challenge=await handler(post('/api/challenge',{},session.ticket));
  expect(challenge!.status).toBe(200);const data=await challenge!.json();expect(data.challenges.map((c:any)=>c.protocol)).toContain('instrumentation');
  const invalid=await handler(post('/api/redeem',{token:data.token,solutions:[]},session.ticket));expect(invalid!.status).toBe(400);expect(h.store.capPassed(r.id)).toBe(false);
  // Inject only the crypto result to exercise successful HTTP completion and replay handling.
  const success=capHandler(config,h.store,h.v,h.clock,{generateChallenge,validateChallenge:async(_secret,_body,opts)=>{
   expect(opts!.scope).toBe(session.ticket);
   return {success:true,token:'verified',expires:T0+1000,scope:session.ticket,riskFlags:[]};
  }});
  const complete=()=>success(post('/api/redeem',{token:'proof',solutions:[]},session.ticket));
  const completed=(await complete())!;expect(completed.status).toBe(200);
  expect(['waiting','ready']).toContain((await completed.json()).state);
  for(let i=0;i<500 && !h.tg.photos.length;i++) await Bun.sleep(10);
  const status=await success(post('/status',{initData:signed(),requestId:r.id}));
  expect((await status!.json()).returnUrl).toBe(`https://t.me/c/${String(GROUP).slice(4)}/${h.tg.photos[0]!.id}`);
  expect((await complete())!.status).toBe(403);
  expect(h.tg.photos).toHaveLength(1);expect(h.tg.unrestricted).toHaveLength(0);
 });
});
