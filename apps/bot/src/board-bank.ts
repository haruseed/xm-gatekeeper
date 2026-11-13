import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex, type Rng } from '@guard/core';
import type { AssetStore } from '@guard/assets';
import { BOARD, FUNCTION_ITEMS, type Round } from '@guard/captcha';

export const bankFingerprint = (assets: AssetStore): string => sha256Hex(Buffer.from(JSON.stringify(
  assets.approvedIds().sort().map(id => [id, assets.item(id)!.sha256]),
)));
export interface BankEntry extends Round { hash: string }
export interface BankManifest { version: 1; assetsFingerprint: string; entries: BankEntry[] }

/** Immutable offline-built pool. Answers never leave the server; bytes are checked at startup. */
export class BoardBank {
  readonly size: number;
  private readonly entries: BankEntry[];
  constructor(private readonly directory: string, assets: AssetStore) {
    const m = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as BankManifest;
    if (m.version !== 1 || m.assetsFingerprint !== bankFingerprint(assets) || !Array.isArray(m.entries) || !m.entries.length) throw Error('board bank missing or stale');
    const approved = new Set(assets.approvedIds());
    const seen = new Set<string>();
    for (const e of m.entries) {
      if (!/^[a-f0-9]{64}$/.test(e.hash) || seen.has(e.hash) || !Array.isArray(e.itemIds) || e.itemIds.length !== 6 || new Set(e.itemIds).size !== 6 || e.itemIds.some(id => !approved.has(id)) || !Number.isInteger(e.answerPosition) || e.answerPosition < 0 || e.answerPosition > 5 || !e.question || e.itemIds[e.answerPosition] !== e.question.itemId || !['identify','function'].includes(e.question.kind) || (e.question.kind === 'function' && !FUNCTION_ITEMS.includes(e.question.itemId))) throw Error('invalid board bank entry');
      seen.add(e.hash);
      const bytes = this.read(e.hash);
      if (bytes.length > BOARD.maxBytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw Error('invalid board image');
    }
    // Every approved target must be represented, so skips never need live rendering.
    if ([...approved].some(id => !m.entries.some(e => e.question.itemId === id))) throw Error('board bank lacks answer coverage');
    this.entries = m.entries; this.size = this.entries.length;
  }
  pick(rng: Rng, excluded: readonly string[]): { round: BankEntry; bytes: Uint8Array } {
    const candidates = this.entries.filter(e => !excluded.includes(e.question.itemId));
    if (!candidates.length) throw Error('board bank exhausted');
    const round = candidates[rng.int(candidates.length)]!;
    return { round, bytes: this.read(round.hash) };
  }
  private read(hash: string): Uint8Array {
    const bytes = new Uint8Array(readFileSync(join(this.directory, `${hash}.jpg`)));
    if (sha256Hex(bytes) !== hash) throw Error('board bank image hash mismatch');
    return bytes;
  }
}
