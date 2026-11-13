import type { AssetStore } from '@guard/assets';
import { composeBoard, generateRound, type Round } from '@guard/captcha';
import type { Rng } from '@guard/core';
import type { BoardBank } from './board-bank';

export interface ChallengeBoard {
  round: Round;
  bytes: Uint8Array;
}

/** Supplies image bytes and their matching server-side answer metadata. */
export interface BoardProvider {
  create(rng: Rng, excluded: readonly string[]): ChallengeBoard | Promise<ChallengeBoard>;
}

/** Transient capacity pressure; the workflow should retry, not send to manual review. */
export class BoardProviderBusy extends Error {
  constructor(readonly delayMs = 2000) {
    super('board provider busy');
  }
}

/** Production uses the validated offline pool, with no rendering fallback. */
export class PreparedBoardProvider implements BoardProvider {
  constructor(private readonly bank: Pick<BoardBank, 'pick'>) {}

  create(rng: Rng, excluded: readonly string[]): ChallengeBoard {
    return this.bank.pick(rng, excluded);
  }
}

/** Legacy renderer, explicitly selected by the composition root (primarily tests). */
export class RenderedBoardProvider implements BoardProvider {
  private rendering = 0;
  private renderChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly assets: Pick<AssetStore, 'approvedIds' | 'readApprovedAsset'>,
    private readonly maxRenderQueue: number,
    private readonly render: typeof composeBoard = composeBoard,
  ) {}

  async create(rng: Rng, excluded: readonly string[]): Promise<ChallengeBoard> {
    const round = generateRound(this.assets.approvedIds(), rng, excluded);
    const images = await Promise.all(round.itemIds.map(id => this.assets.readApprovedAsset(id)));
    // Preserve the existing queue boundary: asset reads precede admission to rendering.
    if (this.rendering >= this.maxRenderQueue) throw new BoardProviderBusy();
    this.rendering++;
    const run = this.renderChain.then(() => this.render(images, rng));
    this.renderChain = run.catch(() => undefined);
    try {
      return { round, bytes: await run };
    } finally {
      this.rendering--;
    }
  }
}
