import { readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { LOCALES, sha256Hex, type Locale } from '@guard/core';

export interface ItemAsset {
  id: string;
  labels: Record<Locale, string>;
  articleUrl: string;
  filePageUrl: string;
  originalSourceUrl: string;
  creator: string;
  rightsHolder: string;
  licenceName: string;
  licenceUrl: string;
  attributionText: string;
  permissionEvidencePath: string;
  modifications: string[];
  reviewedBy: string;
  reviewedAt: string;
  approval: 'pending' | 'approved' | 'rejected';
  sha256: string;
  localRelativePath: string;
  r2Key?: string;
}
export interface Manifest {
  release: string;
  items: ItemAsset[];
}

const STRING_FIELDS = [
  'id',
  'articleUrl',
  'filePageUrl',
  'originalSourceUrl',
  'creator',
  'rightsHolder',
  'licenceName',
  'licenceUrl',
  'attributionText',
  'permissionEvidencePath',
  'reviewedBy',
  'reviewedAt',
  'sha256',
  'localRelativePath',
] as const;

export function parseManifest(json: string): Manifest {
  const raw = JSON.parse(json) as { release?: unknown; items?: unknown };
  if (typeof raw.release !== 'string' || !Array.isArray(raw.items)) throw new Error('manifest: bad shape');
  const seen = new Set<string>();
  for (const item of raw.items as Record<string, unknown>[]) {
    for (const f of STRING_FIELDS) {
      if (typeof item[f] !== 'string') throw new Error(`manifest: ${String(item.id)}.${f} must be a string`);
    }
    const id = item.id as string;
    if (!/^[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) throw new Error(`manifest: bad or duplicate id ${id}`);
    seen.add(id);
    const labels = item.labels as Record<string, unknown> | undefined;
    for (const l of LOCALES) {
      if (typeof labels?.[l] !== 'string' || !labels[l]) throw new Error(`manifest: ${id} lacks label ${l}`);
    }
    if (!['pending', 'approved', 'rejected'].includes(item.approval as string)) {
      throw new Error(`manifest: ${id} has invalid approval`);
    }
    if (!Array.isArray(item.modifications)) throw new Error(`manifest: ${id}.modifications must be an array`);
    const rel = item.localRelativePath as string;
    if (rel.startsWith('/') || rel.split(/[\\/]/).includes('..')) throw new Error(`manifest: ${id} path escapes`);
  }
  return raw as Manifest;
}

export interface AssetStore {
  readonly manifest: Manifest;
  /** IDs of items cleared for use in challenges. */
  approvedIds(): string[];
  item(id: string): ItemAsset | undefined;
  readApprovedAsset(assetId: string): Promise<Uint8Array>;
}

/** Local storage: resolves IDs through the approved manifest only; never accepts a path. */
export class LocalAssetStore implements AssetStore {
  readonly manifest: Manifest;
  private readonly root: string;
  private readonly cache = new Map<string, Uint8Array>();

  constructor(assetsDir: string) {
    this.root = realpathSync(assetsDir);
    this.manifest = parseManifest(readFileSync(join(this.root, 'manifest.json'), 'utf8'));
  }
  approvedIds(): string[] {
    return this.manifest.items.filter((i) => i.approval === 'approved').map((i) => i.id);
  }
  item(id: string): ItemAsset | undefined {
    return this.manifest.items.find((i) => i.id === id);
  }
  async readApprovedAsset(assetId: string): Promise<Uint8Array> {
    const cached = this.cache.get(assetId);
    if (cached) return cached;
    const item = this.item(assetId);
    if (!item || item.approval !== 'approved') throw new Error(`asset ${assetId} is not approved`);
    const resolved = realpathSync(join(this.root, item.localRelativePath));
    if (!resolved.startsWith(this.root + sep)) throw new Error(`asset ${assetId} escapes the assets directory`);
    const bytes = new Uint8Array(readFileSync(resolved));
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error(`asset ${assetId} is too large`);
    if (sha256Hex(bytes) !== item.sha256) throw new Error(`asset ${assetId} failed its hash check`);
    this.cache.set(assetId, bytes);
    return bytes;
  }
}
