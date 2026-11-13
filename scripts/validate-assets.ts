// Release check: every approved asset loads, matches its hash and has reviewed text in all locales.
import { join } from 'node:path';
import { LOCALES } from '@guard/core';
import { LocalAssetStore } from '@guard/assets';
import { FUNCTION_ITEMS } from '@guard/captcha';
import { CATALOGUES, isKey } from '@guard/i18n';

const dir = process.env.ASSETS_DIR ?? join(import.meta.dir, '..', 'assets');
const store = new LocalAssetStore(dir);
const problems: string[] = [];
const ids = store.approvedIds();
if (ids.length < 8) problems.push(`only ${ids.length} approved items; the release needs at least 8`);
for (const id of ids) {
  try {
    await store.readApprovedAsset(id);
  } catch (e) {
    problems.push(String(e));
  }
  const item = store.item(id)!;
  if (!item.permissionEvidencePath || !item.reviewedBy) problems.push(`${id}: missing provenance record`);
}
for (const id of FUNCTION_ITEMS) {
  const key = `fn.${id}`;
  if (!isKey(key)) problems.push(`no function question text for ${id}`);
}
for (const l of LOCALES) {
  for (const [k, text] of Object.entries(CATALOGUES[l])) {
    if (/glyph/i.test(text)) problems.push(`${l}.${k} mentions glyphs`);
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`assets ok: ${ids.length} approved items, release ${store.manifest.release}`);
