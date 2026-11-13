// Build the original MIT-licensed demo artwork. Supply separately licensed assets for game-specific use.
import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '@guard/core';
import type { ItemAsset, Manifest } from '@guard/assets';

const root = join(import.meta.dir, '..', 'assets');
const defs = JSON.parse(readFileSync(join(root, 'source', 'items.json'), 'utf8')) as {
  id: string; en: string; zhHant: string; zhHans: string;
}[];
mkdirSync(join(root, 'items'), { recursive: true });
const items: ItemAsset[] = [];
for (const d of defs) {
  const png = await sharp(join(root, 'source', `${d.id}.svg`))
    .resize(256, 256).png({ compressionLevel: 9 }).toBuffer();
  const rel = `items/${d.id}.png`;
  writeFileSync(join(root, rel), png);
  items.push({
    id: d.id,
    labels: { 'zh-HK': d.zhHant, 'zh-TW': d.zhHant, 'zh-CN': d.zhHans, en: d.en },
    articleUrl: '', filePageUrl: '', originalSourceUrl: `assets/source/${d.id}.svg`,
    creator: 'XM Gatekeeper contributors', rightsHolder: 'XM Gatekeeper contributors',
    licenceName: 'MIT', licenceUrl: 'https://opensource.org/license/mit',
    attributionText: 'Copyright (c) 2026 haruseed', permissionEvidencePath: '../LICENSE',
    modifications: ['rasterised to 256×256 PNG', 'preprocessed and composited into challenge boards'],
    reviewedBy: 'XM Gatekeeper contributors', reviewedAt: '2026-11-13', approval: 'approved',
    sha256: sha256Hex(new Uint8Array(png)), localRelativePath: rel,
  });
}
const manifest: Manifest = { release: '0.1.0-alpha.1-demo', items };
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`built ${items.length} original demo assets`);
