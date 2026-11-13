// Renders one sample challenge board for visual review: bun scripts/sample-board.ts <out.jpg>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { secureRng } from '@guard/core';
import { LocalAssetStore } from '@guard/assets';
import { composeBoard, generateRound } from '@guard/captcha';

const out = process.argv[2];
if (!out) throw new Error('usage: bun scripts/sample-board.ts <out.jpg>');
const store = new LocalAssetStore(join(import.meta.dir, '..', 'assets'));
const round = generateRound(store.approvedIds(), secureRng);
const images = await Promise.all(round.itemIds.map((id) => store.readApprovedAsset(id)));
const png = await composeBoard(images, secureRng);
writeFileSync(out, png);
console.log(JSON.stringify({ bytes: png.byteLength, ...round }));
