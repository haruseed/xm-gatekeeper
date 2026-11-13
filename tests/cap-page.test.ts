import { renderCapPage } from '../apps/bot/src/cap-page/page';
import { capPageController } from '../apps/bot/src/cap-page/controller';
import {test,expect} from 'bun:test';
import {runInNewContext} from 'node:vm';
import {capHandler} from '../apps/bot/src/cap';
import {harness,ASSETS_DIR} from './helpers';

async function scenario(mode:'home'|'ready'|'review'|'busy'|'rate-limit'|'error'|'finished', options: {legacy?: boolean; duplicateSolve?: boolean; search?: string} = {}) {
 const html = renderCapPage('/guard/verify');
 const script=html.split('<script>')[1]!.split('</script>')[0]!;
 const elements:Record<string,any>={};const calls:string[]=[];const opened:string[]=[];const identities:unknown[]=[];let closed=false,closedBeforeReady=false,statusCalls=0,proofCalls=0,ready=false;
 const el=(id:string)=>elements[id]??=( {hidden:true,textContent:'',classList:{toggle(){},add(){},remove(){}},setAttribute(){},removeAttribute(){},replaceChildren(){},append(child:any){if(child.solve){void child.solve();if(options.duplicateSolve)void child.solve();}}} );
 const document={documentElement:{dataset:{}},getElementById:el,head:{append(script:any){script.onload();}},createElement(){return {setAttribute(){},addEventListener(name:string,fn:any){if(name==='solve')this.solve=fn;},solve:undefined as any};}};
 const context:any={document,URLSearchParams,AbortSignal,location:{search:options.search ?? (options.legacy?'?request=fixture':'')},matchMedia:()=>({matches:false}),setTimeout:(fn:any)=>setTimeout(fn,0),window:{Telegram:{WebApp:{initData:mode==='home'||options.legacy?'user=x':'start_param=cap_fixture',colorScheme:'dark',ready(){},onEvent(){},openTelegramLink(url:string){opened.push(url);},close(){closed=true;closedBeforeReady=!ready;}}}},fetch:async(url:string,request?:RequestInit)=>{
  if(request?.body)identities.push(JSON.parse(String(request.body)));
  calls.push(url);
  if(url.endsWith('/session'))return Response.json({passed:mode!=='busy'&&mode!=='rate-limit',ticket:'fixture'},{status:mode==='error'?403:200});
  if(url.endsWith('/status')){statusCalls++;ready=mode!=='review'&&statusCalls>1;return Response.json({state:mode==='finished'?'finished':mode==='review'?'review':ready?'ready':'waiting',returnUrl:'https://t.me/c/123/456'});}
  proofCalls++;return Response.json({reason:mode==='rate-limit'?'rate_limited':'busy'},{status:proofCalls<3?429:200});
 }};
 runInNewContext(script,context);
 if(mode==='busy'||mode==='rate-limit'){
  for(let i=0;i<100 && !context.window.CAP_CUSTOM_FETCH;i++)await Bun.sleep(1);
  await context.window.CAP_CUSTOM_FETCH('/guard/verify/api/challenge');
 }
 for(let i=0;i<100 && !closed && mode!=='home'&&mode!=='error'&&mode!=='review'&&mode!=='finished';i++)await Bun.sleep(2);
 await Bun.sleep(10);
 return {calls,opened,identities,closed,closedBeforeReady,statusCalls,proofCalls,elements};
}
test('profile home does not start verification or call its API',async()=>{const s=await scenario('home');expect(s.calls).toHaveLength(0);expect(s.closed).toBe(false);});
test('direct group launch closes only after picture readiness',async()=>{const s=await scenario('ready');expect(s.statusCalls).toBe(2);expect(s.closed).toBe(true);expect(s.closedBeforeReady).toBe(false);});
test('review and authentication errors stop progress and leave a return action',async()=>{for(const mode of ['review','error'] as const){const s=await scenario(mode);expect(s.closed).toBe(false);expect(s.elements.progress.hidden).toBe(true);expect(s.elements.close.hidden).toBe(false);}});
test('capacity responses are retried, but per-user rate limits are not',async()=>{expect((await scenario('busy')).proofCalls).toBe(3);expect((await scenario('rate-limit')).proofCalls).toBe(1);});

// Keep HTTP delivery covered independently from browser-controller scenarios.
test('Cap endpoint serves the pure page with the existing security headers', async () => {
 const h=harness({cap:true});
 const handler=capHandler({botToken:'123456:'+'a'.repeat(40),databasePath:h.dbPath,assetsDir:ASSETS_DIR,boardTempDir:h.boardDir,maxActiveSessions:200,maxOutboxPending:500,maxRenderQueue:20,logLevel:'error',cap:{publicUrl:'https://guard.example/guard/verify',secret:'x'.repeat(32)}},h.store,h.v,h.clock);
 const html=await (await handler(new Request('https://guard.example/guard/verify')))!.text();
 expect(html).toBe(renderCapPage('/guard/verify'));
 const response = (await handler(new Request('https://guard.example/guard/verify')))!;
 expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
 expect(response.headers.get('cache-control')).toBe('no-store');
 expect(response.headers.get('referrer-policy')).toBe('no-referrer');
 expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});

test('configured base paths cannot escape the inline controller', () => {
 const base = '/verify</script><script>alert("x")</script>';
 const script = capPageController(base);
 expect(script).not.toContain('</script>');
 expect(script).toContain('\\u003c/script>');
 const encodedBase = script.slice(script.lastIndexOf('mountCapPage(') + 'mountCapPage('.length, -2);
 expect(JSON.parse(encodedBase)).toBe(base);
});


test('legacy launch follows the ready picture link before closing', async () => {
 const result = await scenario('ready', {legacy:true});
 expect(result.opened).toEqual(['https://t.me/c/123/456']);
 expect(result.closed).toBe(true);
 expect(result.closedBeforeReady).toBe(false);
});

test('direct launch uses the signed start parameter rather than a conflicting query', async () => {
 const result = await scenario('ready', {search:'?request=other'});
 expect(result.identities[0]).toMatchObject({requestId:'fixture'});
 expect(result.opened).toHaveLength(0);
 expect(result.closed).toBe(true);
});

test('duplicate widget solve events start only one readiness polling loop', async () => {
 const result = await scenario('busy', {duplicateSolve:true});
 expect(result.statusCalls).toBe(2);
 expect(result.closedBeforeReady).toBe(false);
});

test('already completed verification leaves a manual return action without a new challenge', async () => {
 const result = await scenario('finished');
 expect(result.elements.status.textContent).toBe('Your verification is complete.');
 expect(result.elements.progress.hidden).toBe(true);
 expect(result.elements.close.hidden).toBe(false);
 expect(result.closed).toBe(false);
 expect(result.proofCalls).toBe(0);
});
