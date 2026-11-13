import { expect, test } from 'bun:test';
import { secureRng } from '@guard/core';
import { BoardProviderBusy, RenderedBoardProvider } from '../apps/bot/src/board-provider';

const ids = ['resonator', 'xmp-burster', 'power-cube', 'portal-shield', 'portal-key', 'heat-sink', 'multi-hack'];
const assets = {
  approvedIds: () => ids,
  readApprovedAsset: async (id: string) => new Uint8Array([ids.indexOf(id)]),
};

test('render capacity is bounded and returns matching six-choice metadata after pressure clears', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const provider = new RenderedBoardProvider(assets, 1, async images => {
    calls++;
    entered.resolve();
    await release.promise;
    return new Uint8Array(images.map(image => image[0]!));
  });
  const first = provider.create(secureRng, ['resonator']);
  await entered.promise;
  await expect(provider.create(secureRng, [])).rejects.toBeInstanceOf(BoardProviderBusy);
  expect(calls).toBe(1);
  release.resolve();
  const board = await first;
  expect(board.round.question.itemId).not.toBe('resonator');
  expect(board.round.itemIds).toHaveLength(6);
  expect(new Set(board.round.itemIds).size).toBe(6);
  expect(board.round.itemIds[board.round.answerPosition]).toBe(board.round.question.itemId);
  expect([...board.bytes]).toEqual(board.round.itemIds.map(id => ids.indexOf(id)));
  await provider.create(secureRng, []);
  expect(calls).toBe(2);
});

test('queued rendering stays serial and a failed render does not poison the next task', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let active = 0;
  let peak = 0;
  const provider = new RenderedBoardProvider(assets, 2, async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    try {
      if (calls === 1) {
        entered.resolve();
        await release.promise;
        throw new Error('render failed');
      }
      return new Uint8Array([42]);
    } finally {
      active--;
    }
  });
  const first = provider.create(secureRng, []);
  const failure = first.catch(error => error);
  await entered.promise;
  const second = provider.create(secureRng, []);
  release.resolve();
  expect(await failure).toMatchObject({ message: 'render failed' });
  expect((await second).bytes).toEqual(new Uint8Array([42]));
  expect(peak).toBe(1);
  expect(calls).toBe(2);
});

test('provider pressure defers delivery and retries without sending the applicant to review', async () => {
  const { harness, enrol, GROUP, ASSETS_DIR } = await import('./helpers');
  const { LocalAssetStore } = await import('@guard/assets');
  const { BoardBank } = await import('../apps/bot/src/board-bank');
  const { join } = await import('node:path');
  const bank = new BoardBank(join(ASSETS_DIR, 'board-bank'), new LocalAssetStore(ASSETS_DIR));
  let busy = true;
  const h = harness({ cap: true, boards: {
    create(rng, excluded) {
      if (busy) throw new BoardProviderBusy();
      return bank.pick(rng, excluded);
    },
  } });
  enrol(h);
  await h.v.onMemberJoined(GROUP, 9001, true, 9001, h.clock.now());
  const request = h.store.liveRequest(GROUP, 9001)!;
  const ticket = h.store.issueCapTicket(request.id, 9001, h.clock.now())!;
  expect(h.store.completeCap(ticket, h.clock.now(), 'en', 200)).toBe(true);
  await h.v.drainOutbox();
  expect(h.store.getRequest(request.id)!.state).toBe('challenging');
  expect(h.tg.photos).toHaveLength(0);
  busy = false;
  h.clock.advance(2001);
  await h.v.drainOutbox();
  expect(h.tg.photos).toHaveLength(1);
  expect(h.store.getRequest(request.id)!.state).toBe('challenging');
});
