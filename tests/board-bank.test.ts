import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalAssetStore} from '@guard/assets';
import {secureRng,sha256Hex} from '@guard/core';
import {BoardBank} from '../apps/bot/src/board-bank';
import {ASSETS_DIR,harness,enrol,GROUP,boardTokens} from './helpers';
const directory=join(ASSETS_DIR,'board-bank');
const assets=new LocalAssetStore(ASSETS_DIR);

test('prepared bank covers approved targets and skips never repeat an answer',()=>{
 const bank=new BoardBank(directory,assets);expect(bank.size).toBeGreaterThanOrEqual(assets.approvedIds().length);
 const used:string[]=[];
 for(let i=0;i<assets.approvedIds().length;i++){
  const {round,bytes}=bank.pick(secureRng,used);
  expect(used).not.toContain(round.question.itemId);
  expect(round.itemIds[round.answerPosition]).toBe(round.question.itemId);
  expect(sha256Hex(bytes)).toBe(round.hash);used.push(round.question.itemId);
 }
 expect(()=>bank.pick(secureRng,used)).toThrow('exhausted');
});

test('same prepared image reuses file_id across users but never shares answer tokens',async()=>{
 const bank=new BoardBank(directory,assets);
 const chosen=bank.pick(secureRng,[]);
 bank.pick=()=>chosen;
 const noRender=new LocalAssetStore(ASSETS_DIR);
 noRender.readApprovedAsset=async()=>{throw Error('runtime source image read forbidden');};
 const h=harness({cap:true,boardBank:bank,assets:noRender});enrol(h);
 for(const u of [9001,9002]){
  await h.v.onMemberJoined(GROUP,u,true,u,h.clock.now());
  const r=h.store.liveRequest(GROUP,u)!;
  const ticket=h.store.issueCapTicket(r.id,u,h.clock.now())!;
  expect(h.store.completeCap(ticket,h.clock.now(),'en',200)).toBe(true);
  await h.v.drainOutbox();
 }
 expect(h.tg.photos).toHaveLength(2);
 expect(h.tg.photos[0]!.photo).toBeInstanceOf(Uint8Array);
 expect(typeof h.tg.photos[1]!.photo).toBe('string');
 const a=boardTokens(h,9001,GROUP),b=boardTokens(h,9002,GROUP);
 expect(a.all.some(token=>b.all.includes(token))).toBe(false);
 expect(h.v.answer(9002,GROUP,a.correct).result).toBe('stale');
 expect(h.v.answer(9001,GROUP,a.correct).result).not.toBe('stale');
});

test('stale or corrupted bank is rejected instead of silently rendering on demand',()=>{
 const temp=mkdtempSync(join(tmpdir(),'guard-bank-test-'));
 try{
  cpSync(directory,temp,{recursive:true});
  const m=JSON.parse(readFileSync(join(temp,'manifest.json'),'utf8'));
  writeFileSync(join(temp,`${m.entries[0].hash}.jpg`),'corrupt');
  expect(()=>new BoardBank(temp,assets)).toThrow('hash mismatch');
  m.assetsFingerprint='outdated';writeFileSync(join(temp,'manifest.json'),JSON.stringify(m));
  expect(()=>new BoardBank(temp,assets)).toThrow('stale');
 }finally{rmSync(temp,{recursive:true,force:true});}
});
