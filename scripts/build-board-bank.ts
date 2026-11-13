import { mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { LocalAssetStore } from '@guard/assets';
import { secureRng, sha256Hex } from '@guard/core';
import { generateRound, composeBoard } from '@guard/captcha';
import { BoardBank, bankFingerprint, type BankEntry } from '../apps/bot/src/board-bank';

const output = resolve(process.argv[2] ?? 'assets/board-bank');
const count = Number(process.argv[3] ?? 300);
const assets = new LocalAssetStore(resolve('assets'));
const ids = assets.approvedIds();
if (!Number.isInteger(count) || count < ids.length || count > 5000) throw Error('count must cover all targets and be <= 5000');
if (existsSync(output)) throw Error('output exists: build into a new versioned directory');
const staging = `${output}.building-${process.pid}`;
mkdirSync(staging, {recursive:true, mode:0o700});
const entries: BankEntry[] = [];
for (let i=0;i<count;i++) {
  const target = ids[i % ids.length]!;
  const round = generateRound(ids, secureRng, ids.filter(id=>id!==target));
  const images = await Promise.all(round.itemIds.map(id=>assets.readApprovedAsset(id)));
  const bytes = await composeBoard(images, secureRng);
  const hash = sha256Hex(bytes);
  writeFileSync(join(staging, `${hash}.jpg`), bytes, {mode:0o600});
  entries.push({...round, hash});
  if ((i+1)%25===0) console.log(`Built ${i+1}/${count}`);
}
writeFileSync(join(staging,'manifest.json'),JSON.stringify({version:1,assetsFingerprint:bankFingerprint(assets),entries}),{mode:0o600});
new BoardBank(staging,assets);
renameSync(staging,output);
console.log(`Validated ${count} preprocessed boards: ${output}`);
