import sharp, { type OverlayOptions, type SharpOptions } from 'sharp';
import { POLICY, shuffled, type Rng } from '@guard/core';

export interface Question {
  kind: 'identify' | 'function';
  itemId: string;
}
export interface Round {
  question: Question;
  /** Board position 0–5 (A–F, row-major) of the correct panel. */
  answerPosition: number;
  /** Item ID shown at each position. */
  itemIds: string[];
}

/**
 * Items that have a reviewed function question. Each function below matches exactly one
 * item in the whole bank, so any board containing the item has exactly one correct panel.
 * The wording lives in the i18n catalogue under `fn.<itemId>`.
 */
export const FUNCTION_ITEMS: readonly string[] = [
  'resonator',
  'xmp-burster',
  'power-cube',
  'portal-shield',
  'portal-key',
  'heat-sink',
  'multi-hack',
  'link-amp',
  'turret',
  'capsule',
];

export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

/** Picks an answer and five distinct distractors. `exclude` avoids repeating earlier answers. */
export function generateRound(approvedIds: readonly string[], rng: Rng, exclude: readonly string[] = [], easy = false): Round {
  const choices = easy ? 3 : POLICY.choices;
  const unique = [...new Set(approvedIds)];
  if (unique.length < POLICY.choices + 1) throw new Error('item bank too small: need at least seven approved items');
  const candidates = unique.filter((id) => !exclude.includes(id));
  const pool = candidates.length > 0 ? candidates : unique;
  const answer = pool[rng.int(pool.length)]!;
  const distractors = shuffled(
    unique.filter((id) => id !== answer),
    rng,
  ).slice(0, choices - 1);
  const itemIds = shuffled([answer, ...distractors], rng);
  const kind: Question['kind'] = !easy && FUNCTION_ITEMS.includes(answer) && rng.int(2) === 1 ? 'function' : 'identify';
  return { question: { kind, itemId: answer }, answerPosition: itemIds.indexOf(answer), itemIds };
}

// Letter shapes drawn as strokes so rendering never depends on fonts installed on the host.
const LETTER_PATHS: Record<(typeof LETTERS)[number], string> = {
  A: 'M20 85 L50 15 L80 85 M32 58 L68 58',
  B: 'M28 15 L28 85 L58 85 Q80 85 80 67 Q80 50 58 50 L28 50 M58 50 Q76 50 76 32 Q76 15 56 15 L28 15',
  C: 'M78 30 Q68 15 50 15 Q22 15 22 50 Q22 85 50 85 Q68 85 78 70',
  D: 'M28 15 L28 85 L48 85 Q80 85 80 50 Q80 15 48 15 Z',
  E: 'M76 15 L28 15 L28 85 L76 85 M28 50 L66 50',
  F: 'M76 15 L28 15 L28 85 M28 50 L64 50',
};

export const BOARD = { width: 900, height: 600, cell: 300, maxBytes: 1024 * 1024 } as const;
const MAX_INPUT_PIXELS = 1024 * 1024;

const between = (rng: Rng, lo: number, hi: number, steps = 100): number => lo + ((hi - lo) * rng.int(steps + 1)) / steps;

/** Panels: each one gets its own dark two-colour gradient at a random angle. */
function panelsSvg(rng: Rng): string {
  const defs: string[] = [];
  const parts: string[] = [`<rect width="900" height="600" fill="#0b0f14"/>`];
  for (let i = 0; i < POLICY.choices; i++) {
    const x = (i % 3) * BOARD.cell;
    const y = Math.floor(i / 3) * BOARD.cell;
    const tone = () => `hsl(${rng.int(360)}, ${25 + rng.int(30)}%, ${13 + rng.int(14)}%)`;
    defs.push(
      `<linearGradient id="g${i}" gradientTransform="rotate(${rng.int(360)} .5 .5)"><stop offset="0" stop-color="${tone()}"/><stop offset="1" stop-color="${tone()}"/></linearGradient>`,
    );
    parts.push(`<rect x="${x + 8}" y="${y + 8}" width="284" height="284" rx="18" fill="url(#g${i})" stroke="#5d7389" stroke-width="3"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><defs>${defs.join('')}</defs>${parts.join('')}</svg>`;
}

/** Clutter drawn over the items: crossing strokes, curves and specks in random colours. */
function clutterSvg(rng: Rng): string {
  const parts: string[] = [];
  const colour = (alpha: number) => `hsla(${rng.int(360)}, ${50 + rng.int(40)}%, ${45 + rng.int(35)}%, ${alpha})`;
  const px = () => rng.int(BOARD.width);
  const py = () => rng.int(BOARD.height);
  for (let i = 0; i < 6; i++) {
    const d = rng.int(2) === 0 ? `M${px()} ${py()} L${px()} ${py()}` : `M${px()} ${py()} Q${px()} ${py()} ${px()} ${py()}`;
    parts.push(`<path d="${d}" fill="none" stroke="${colour(between(rng, 0.22, 0.38))}" stroke-width="${2 + rng.int(3)}" stroke-linecap="round"/>`);
  }
  for (let i = 0; i < 30; i++) {
    parts.push(`<circle cx="${px()}" cy="${py()}" r="${1 + rng.int(3)}" fill="${colour(between(rng, 0.3, 0.55))}"/>`);
  }
  for (let i = 0; i < 3; i++) {
    const x = px();
    const y = py();
    const r = 14 + rng.int(26);
    parts.push(`<polygon points="${x},${y - r} ${x + r},${y + r} ${x - r},${y + r}" transform="rotate(${rng.int(360)} ${x} ${y})" fill="none" stroke="${colour(0.3)}" stroke-width="2"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">${parts.join('')}</svg>`;
}

/** The A–F discs, drawn last so clutter and noise never hide them. */
function labelsSvg(): string {
  const parts: string[] = [];
  LETTERS.forEach((letter, i) => {
    const x = (i % 3) * BOARD.cell;
    const y = Math.floor(i / 3) * BOARD.cell;
    parts.push(
      `<circle cx="${x + 46}" cy="${y + 46}" r="28" fill="#ffffff" stroke="#0b0f14" stroke-width="4"/>`,
      `<path transform="translate(${x + 26} ${y + 26}) scale(0.4)" d="${LETTER_PATHS[letter]}" fill="none" stroke="#0b0f14" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">${parts.join('')}</svg>`;
}

const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * Per-challenge preprocessing of one item image, so no two boards carry the same pixels and
 * simple template or hash matching fails: tilt, mirror, shear, uneven stretch,
 * hue/brightness/saturation shifts and blur. The item's outline stays recognisable.
 */
export async function preprocessItem(image: Uint8Array, size: number, rng: Rng): Promise<Buffer> {
  const meta = await sharp(image, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  if (!meta.width || !meta.height) throw new Error('unreadable item image');
  let img = sharp(image, { limitInputPixels: MAX_INPUT_PIXELS });
  if (rng.int(2) === 1) img = img.flop();
  img = img
    .affine([1, between(rng, -0.18, 0.18), between(rng, -0.18, 0.18), 1], { background: CLEAR })
    .rotate(rng.int(61) - 30, { background: CLEAR })
    .modulate({
      brightness: between(rng, 0.85, 1.15),
      saturation: between(rng, 0.65, 1.35),
      hue: rng.int(121) - 60,
    });
  const sheared = await img.png().toBuffer();
  // Second pass: trim the empty corners, stretch unevenly, blur, then fit the panel.
  const trimmed = await sharp(sheared).trim().png().toBuffer();
  const t = await sharp(trimmed).metadata();
  const w = Math.max(8, Math.round((t.width ?? size) * between(rng, 0.88, 1.12)));
  const h = Math.max(8, Math.round((t.height ?? size) * between(rng, 0.88, 1.12)));
  let out = sharp(trimmed).resize(w, h, { fit: 'fill' });
  const blur = between(rng, 0, 1.2);
  if (blur >= 0.4) out = out.blur(blur);
  const stretched = await out.png().toBuffer();
  return sharp(stretched).resize(size, size, { fit: 'contain', background: CLEAR }).png().toBuffer();
}

/**
 * Composites six preprocessed items into a labelled 2 × 3 board, then adds clutter strokes and
 * film-grain noise over everything except the letter discs. Output is JPEG; no metadata is kept.
 */
export async function composeBoard(images: readonly Uint8Array[], rng: Rng, easy = false): Promise<Uint8Array> {
  if (easy) return composeEasyBoard(images);
  if (images.length !== POLICY.choices) throw new Error('a board needs exactly six images');
  const layers: OverlayOptions[] = [];
  for (let i = 0; i < images.length; i++) {
    const size = 165 + rng.int(51); // 165–215 px
    const scaled = await preprocessItem(images[i]!, size, rng);
    const slack = 284 - size - 16;
    const left = (i % 3) * BOARD.cell + 16 + rng.int(slack + 1);
    const top = Math.floor(i / 3) * BOARD.cell + 16 + rng.int(slack + 1);
    layers.push({ input: scaled, left, top });
  }
  const noise = await sharp({
    create: { width: BOARD.width, height: BOARD.height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 26 } },
  } as SharpOptions)
    .png()
    .toBuffer();
  const out = await sharp(Buffer.from(panelsSvg(rng)))
    .composite([
      ...layers,
      { input: Buffer.from(clutterSvg(rng)) },
      { input: noise, blend: 'soft-light' },
      { input: Buffer.from(labelsSvg()) },
    ])
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
  if (out.byteLength > BOARD.maxBytes) throw new Error('board exceeds the 1 MiB policy cap');
  return new Uint8Array(out);
}

/** Three large, undistorted pictures, in their original colours, with clear A/B/C labels. */
export async function composeEasyBoard(images: readonly Uint8Array[]): Promise<Uint8Array> {
  if (images.length !== 3) throw new Error('easy board needs three images');
  const layers: OverlayOptions[] = [];
  for (let i = 0; i < images.length; i++) {
    const input = await sharp(images[i]!, {limitInputPixels:MAX_INPUT_PIXELS}).resize(230, 230, {fit:'contain', background:CLEAR}).png().toBuffer();
    layers.push({input, left:i * 300 + 35, top:60});
  }
  const labels = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300">${LETTERS.slice(0,3).map((l,i) =>
    `<rect x="${i*300+5}" y="5" width="290" height="290" rx="16" fill="none" stroke="#5d7389" stroke-width="2"/><path transform="translate(${i*300+132} 12) scale(0.4)" d="${LETTER_PATHS[l]}" fill="none" stroke="white" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>`;
  const out = await sharp({create:{width:900,height:300,channels:3,background:'#152331'}}).composite([...layers,{input:Buffer.from(labels)}]).jpeg({quality:90}).toBuffer();
  if (out.byteLength > BOARD.maxBytes) throw new Error('board too large');
  return out;
}
