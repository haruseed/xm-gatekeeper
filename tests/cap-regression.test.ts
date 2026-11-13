import {BoardBank} from '../apps/bot/src/board-bank';
import {LocalAssetStore} from '@guard/assets';
import {join as pathJoin} from 'node:path';
import {test,expect} from 'bun:test';
import {createHmac} from 'node:crypto';
import {harness,enrol,GROUP,ASSETS_DIR,boardTokens} from './helpers';
import {capHandler,readCapBody} from '../apps/bot/src/cap';
const config=(h:ReturnType<typeof harness>)=>({botToken:'123456:'+'a'.repeat(40),databasePath:h.dbPath,assetsDir:ASSETS_DIR,boardTempDir:h.boardDir,maxActiveSessions:200,maxOutboxPending:500,maxRenderQueue:20,logLevel:'error' as const,cap:{publicUrl:'https://guard.example/guard/verify',secret:'x'.repeat(32)}});
async function join(h:ReturnType<typeof harness>,u:number) {await h.v.onMemberJoined(GROUP,u,true,u,h.clock.now());return h.store.liveRequest(GROUP,u)!;}
function auth(h:ReturnType<typeof harness>,u:number){
 const p=new URLSearchParams({auth_date:String(h.clock.now()/1000),user:JSON.stringify({id:u})});
 const text=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 p.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(config(h).botToken).digest()).update(text).digest('hex'));return p.toString();
}
function post(path:string,body:unknown,token?:string){return new Request('https://guard.example/guard/verify'+path,{method:'POST',headers:{origin:'https://guard.example',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});}
test('capacity-delayed pictures survive restart and start when capacity becomes available',async()=>{
 const h=harness({cap:true,maxActiveSessions:1});enrol(h);
 const a=await join(h,5001),b=await join(h,5002);
 for(const r of [a,b]) {const tk=h.store.issueCapTicket(r.id,r.user_id,h.clock.now())!;expect(h.store.completeCap(tk,h.clock.now(),'en',1)).toBe(true);}
 await h.v.drainOutbox();expect(h.store.liveSession(b.id)).toBeUndefined();
 expect(h.store.db.query("SELECT count(*) n FROM outbox WHERE kind='cap_picture' AND state='pending'").get()).toEqual({n:1});
 h.store.db.close();const resumed=harness({cap:true,maxActiveSessions:1,dbPath:h.dbPath});
 resumed.store.toReview(a.id,5001,'help_requested',resumed.clock.now());resumed.clock.advance(5001);
 await resumed.v.tick();expect(resumed.tg.photos.some(p=>p.mention===5002)).toBe(true);expect(resumed.tg.unrestricted).toHaveLength(0);
});
test('startup recovers an old stalled Cap pass without starting another failed picture attempt',async()=>{
 const h=harness({cap:true,maxActiveSessions:1});enrol(h);const a=await join(h,5001),b=await join(h,5002);
 for(const r of [a,b])h.store.completeCap(h.store.issueCapTicket(r.id,r.user_id,h.clock.now())!,h.clock.now(),'en',1);
 h.store.db.query("DELETE FROM outbox WHERE kind='cap_picture'").run();
 h.store.recoverCapPictures(h.clock.now());h.store.recoverCapPictures(h.clock.now());
 expect(h.store.db.query("SELECT count(*) n FROM outbox WHERE kind='cap_picture'").get()).toEqual({n:1});
});
test('concurrent delivery reports waiting until the correct picture link is available',async()=>{
 const h=harness({cap:true});enrol(h);const a=await join(h,5001),b=await join(h,5002);
 let signal!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>signal=r),gate=new Promise<void>(r=>release=r);
 const original=h.tg.sendPhoto.bind(h.tg);let first=true;
 h.tg.sendPhoto=async(...args:Parameters<typeof original>)=>{if(first){first=false;signal();await gate;}return original(...args);};
 h.store.completeCap(h.store.issueCapTicket(a.id,5001,h.clock.now())!,h.clock.now(),'en',200);
 const draining=h.v.drainOutbox();await entered;
 const tk=h.store.issueCapTicket(b.id,5002,h.clock.now())!;
 const handler=capHandler(config(h),h.store,h.v,h.clock,{generateChallenge:async()=>{throw Error('unused');},validateChallenge:async()=>({success:true,token:'fixture',expires:h.clock.now()+1000,scope:tk,riskFlags:[]})});
 const response=await handler(post('/api/redeem',{token:'fixture',solutions:[]},tk));expect((await response!.json()).state).toBe('waiting');
 const status=()=>handler(post('/status',{initData:auth(h,5002),requestId:b.id}));
 expect((await (await status())!.json()).state).toBe('waiting');
 release();await draining;
 const ready=await (await status())!.json();expect(ready.state).toBe('ready');
 expect(ready.returnUrl).toBe(`https://t.me/c/${String(GROUP).slice(4)}/${h.tg.photos.find(p=>p.mention===5002)!.id}`);
 expect((await handler(post('/status',{initData:auth(h,5001),requestId:b.id})))!.status).toBe(403);
});
test('four unfinished unauthenticated uploads do not block authenticated sessions',async()=>{
 const h=harness({cap:true});enrol(h);const r=await join(h,5001);const handler=capHandler(config(h),h.store,h.v,h.clock);
 const controllers:ReadableStreamDefaultController<Uint8Array>[]=[],pending=[];
 for(let i=0;i<4;i++){
  const body=new ReadableStream<Uint8Array>({start(c){controllers.push(c);}});
  pending.push(handler(new Request(config(h).cap.publicUrl+'/session',{method:'POST',headers:{origin:'https://guard.example'},body,duplex:'half'} as any)));
 }
 try {expect((await handler(post('/session',{initData:auth(h,5001),requestId:r.id})))!.status).toBe(200);}
 finally {for(const c of controllers){c.enqueue(new TextEncoder().encode('{}'));c.close();}await Promise.all(pending);}
});
test('body readers cancel on a hard deadline or streaming size overflow',async()=>{
 let cancelled=false;const stream=new ReadableStream({cancel(){cancelled=true;}});
 const req=new Request('https://guard.example',{method:'POST',body:stream,duplex:'half'} as any);
 await expect(readCapBody(req,20)).rejects.toThrow('body_timeout');expect(cancelled).toBe(true);
 const large=new Request('https://guard.example',{method:'POST',body:'x'.repeat(131073)});
 await expect(readCapBody(large)).rejects.toThrow('body_too_large');
});

test('ten concurrent users keep Cap, pictures, skips and approvals isolated under capacity pressure',async()=>{
 const start=performance.now();const source=new LocalAssetStore(ASSETS_DIR);
 const bank=new BoardBank(pathJoin(ASSETS_DIR,'board-bank'),source);
 source.readApprovedAsset=async()=>{throw Error('must not render during verification');};
 const h=harness({cap:true,boardBank:bank,assets:source});enrol(h);
 let sends=0,peakSends=0;
 const send=h.tg.sendPhoto.bind(h.tg);
 h.tg.sendPhoto=async(...args:Parameters<typeof send>)=>{sends++;peakSends=Math.max(peakSends,sends);await Bun.sleep(1000);try{return await send(...args);}finally{sends--;}};

 const users=Array.from({length:10},(_,i)=>6001+i);
 await Promise.all(users.map(u=>join(h,u)));await h.v.drainOutbox();
 const requests=users.map(u=>h.store.liveRequest(GROUP,u)!);
 let active=0,peak=0,busyReplies=0;
 const handler=capHandler(config(h),h.store,h.v,h.clock,{
  generateChallenge:async()=>{active++;peak=Math.max(peak,active);await Bun.sleep(25);active--;return {token:'fixture',challenges:[]} as any;},
  validateChallenge:async()=>{active++;peak=Math.max(peak,active);await Bun.sleep(25);active--;return {success:true,token:'fixture',expires:h.clock.now()+10000,riskFlags:[]} as any;}
 });
 const call=async(path:string,body:unknown,token?:string)=>{
  for(let i=0;i<100;i++) {const response=(await handler(post(path,body,token)))!;
   if(response.status!==429)return response;busyReplies++;await Bun.sleep(30);
  }throw Error('capacity did not recover');
 };
 const tickets=await Promise.all(requests.map(async r=>{
  const response=await call('/session',{initData:auth(h,r.user_id),requestId:r.id});expect(response.status).toBe(200);return (await response.json()).ticket as string;
 }));
 await Promise.all(tickets.map(async tk=>expect((await call('/api/challenge',{},tk)).status).toBe(200)));
 await Promise.all(tickets.map(async tk=>expect((await call('/api/redeem',{token:'fixture',solutions:[]},tk)).status).toBe(200)));
 const deadline=performance.now()+30000;
 while(h.tg.photos.length<10 && performance.now()<deadline){await h.v.drainOutbox();await Bun.sleep(10);}
 expect(h.tg.photos).toHaveLength(10);expect(peakSends).toBeGreaterThanOrEqual(2);expect(peakSends).toBeLessThanOrEqual(4);expect(peak).toBe(4);expect(busyReplies).toBeGreaterThan(0);
 for(const [i,r] of requests.entries()){
  const status=await call('/status',{initData:auth(h,r.user_id),requestId:r.id});const data=await status.json();
  expect(data.state).toBe('ready');expect(data.returnUrl).toEndWith('/'+h.tg.photos.find(p=>p.mention===r.user_id)!.id);
  expect((await call('/status',{initData:auth(h,users[(i+1)%10]!),requestId:r.id})).status).toBe(403);
 }
 const boards=users.map(u=>boardTokens(h,u,GROUP));
 const results=users.map((u,i)=>{
  expect(h.v.answer(users[(i+1)%10]!,GROUP,boards[i]!.correct).result).toBe('stale');
  return h.v.answer(u,GROUP,boards[i]!.correct,i%2===0);
 });
 await Promise.all(results.map(r=>h.v.afterAnswer(r,GROUP)));await h.v.drainOutbox();
 expect(h.tg.unrestricted).toHaveLength(5);
 const skipped=users.filter((_,i)=>i%2===0);
 const final=skipped.map(u=>h.v.answer(u,GROUP,boardTokens(h,u,GROUP).correct));
 await Promise.all(final.map(r=>h.v.afterAnswer(r,GROUP)));await h.v.drainOutbox();
 expect(h.tg.unrestricted).toHaveLength(10);expect(new Set(h.tg.unrestricted.map(x=>x[1])).size).toBe(10);
 for(const r of requests)expect(h.store.getRequest(r.id)!.state).toBe('approved');
 console.log(JSON.stringify({tenUserMs:Math.round(performance.now()-start),peakCapOperations:peak,peakTelegramSends:peakSends,simulatedSendLatencyMs:1000,busyReplies,photos:h.tg.photos.length,approvals:h.tg.unrestricted.length,transport:'FakeTg',capProof:'fixture',preparedBoards:bank.size}));
},60000);


test('four independent users can wait on Telegram I/O concurrently',async()=>{
 const h=harness({cap:true});enrol(h);
 let active=0,peak=0,release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const timer=setTimeout(release,2000);
 const restrict=h.tg.restrict.bind(h.tg);
 h.tg.restrict=async(...args:Parameters<typeof restrict>)=>{
  active++;peak=Math.max(peak,active);if(active===4)release();
  try{await gate;await restrict(...args);}finally{active--;}
 };
 try{
  await Promise.all(Array.from({length:10},(_,i)=>join(h,8000+i)));
  await h.v.drainOutbox();expect(peak).toBe(4);expect(h.tg.restricted).toHaveLength(10);
 }finally{clearTimeout(timer);release();}
});

test('Cap engine failures release every expensive-work slot', async () => {
 const h=harness({cap:true});enrol(h);const r=await join(h,5001);
 const ticket=h.store.issueCapTicket(r.id,5001,h.clock.now())!;
 let calls=0;
 const handler=capHandler(config(h),h.store,h.v,h.clock,{
  generateChallenge:async()=>{throw Error('unused');},
  validateChallenge:async()=>{calls++;throw Error('engine unavailable');},
 });
 for(let i=0;i<12;i++) {
  const response=(await handler(post('/api/redeem',{token:'fixture',solutions:[]},ticket)))!;
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({success:false,reason:'check_failed'});
 }
 expect(calls).toBe(12);expect(h.store.capPassed(r.id)).toBe(false);
});

test('a ticket expiring during upload never enters the Cap engine', async () => {
 const h=harness({cap:true});enrol(h);const r=await join(h,5001);
 const ticket=h.store.issueCapTicket(r.id,5001,h.clock.now())!;
 let calls=0;
 const handler=capHandler(config(h),h.store,h.v,h.clock,{
  generateChallenge:async()=>{calls++;throw Error('unexpected');},
  validateChallenge:async()=>{calls++;throw Error('unexpected');},
 });
 let controller!:ReadableStreamDefaultController<Uint8Array>;
 const body=new ReadableStream<Uint8Array>({start(c){controller=c;}});
 const pending=handler(new Request(config(h).cap.publicUrl+'/api/challenge',{
  method:'POST',headers:{origin:'https://guard.example',authorization:'Bearer '+ticket},body,duplex:'half',
 } as any));
 h.clock.advance(r.deadline_at-h.clock.now()+1);
 controller.enqueue(new TextEncoder().encode('{}'));controller.close();
 expect((await pending)!.status).toBe(403);expect(calls).toBe(0);
});

test('full upload capacity recovers after malformed bodies without consuming check slots', async () => {
 const h=harness({cap:true});enrol(h);const r=await join(h,5001);
 const handler=capHandler(config(h),h.store,h.v,h.clock);
 const controllers:ReadableStreamDefaultController<Uint8Array>[]=[];
 const pending=Array.from({length:32},()=>handler(new Request(config(h).cap.publicUrl+'/session',{
  method:'POST',headers:{origin:'https://guard.example'},
  body:new ReadableStream<Uint8Array>({start(c){controllers.push(c);}}),duplex:'half',
 } as any)));
 try {
  const busy=(await handler(post('/session',{})))!;
  expect(busy.status).toBe(429);expect(await busy.json()).toEqual({success:false,reason:'upload_busy'});
 } finally {
  for(const c of controllers){c.enqueue(new TextEncoder().encode('{'));c.close();}
  const responses=await Promise.all(pending);
  expect(responses.every(r=>r?.status===400)).toBe(true);
 }
 expect((await handler(post('/session',{initData:auth(h,5001),requestId:r.id})))!.status).toBe(200);
});
