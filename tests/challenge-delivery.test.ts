import { expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { LocalAssetStore } from '@guard/assets';
import { tokenHash } from '@guard/core';
import { RenderedBoardProvider } from '../apps/bot/src/board-provider';
import { ASSETS_DIR, GROUP, boardTokens, enrol, harness, join_ } from './helpers';

const USER = 5001;

test('round and matching answer tokens are committed before Telegram receives the image', async () => {
  const h = harness();
  enrol(h);
  const send = h.tg.sendPhoto.bind(h.tg);
  let checked = false;
  h.tg.sendPhoto = async (...args) => {
    const request = h.store.liveRequestsForUser(USER)[0]!;
    const session = h.store.liveSession(request.id)!;
    expect(session.state).toBe('active');
    expect(session.board_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(session.message_id).toBeNull();
    const tokens = args[3].inline_keyboard.flat()
      .flatMap(button => 'callback_data' in button && button.callback_data.startsWith('c:') ? [button.callback_data.slice(2)] : []);
    expect(tokens).toHaveLength(6);
    for (const token of tokens) {
      expect(h.store.db.query('SELECT session_id, round_version FROM callback_tokens WHERE token_hash=?').get(tokenHash(token)))
        .toEqual({ session_id: session.id, round_version: session.round_version });
    }
    checked = true;
    return send(...args);
  };
  await join_(h, USER);
  expect(checked).toBe(true);
  expect(h.store.liveSession(h.store.liveRequestsForUser(USER)[0]!.id)!.message_id).toBe(h.tg.photos[0]!.id);
});

test('missing persisted image on language resend goes to review without replacing it with a new question', async () => {
  const h = harness();
  enrol(h);
  await h.v.onMemberJoined(GROUP, USER, true, 87654, h.clock.now());
  const request = h.store.liveRequestsForUser(USER)[0]!;
  const session = h.store.liveSession(request.id)!;
  const oldToken = boardTokens(h, USER, GROUP).correct;
  unlinkSync(join(h.boardDir, `${session.board_hash}.png`));
  await h.v.onGroupLanguage(USER, GROUP, 'zh-TW');
  expect(h.tg.photos).toHaveLength(1);
  expect(h.store.getRequest(request.id)?.state).toBe('manual_review');
  expect(h.v.answer(USER, GROUP, oldToken).result).toBe('stale');
  expect(h.tg.unrestricted).toHaveLength(0);
  expect(h.tg.prompts.at(-1)?.userId).toBe(USER);
});

test('a request resolved while its board is preparing does not send the stale board', async () => {
  const renderer = new RenderedBoardProvider(new LocalAssetStore(ASSETS_DIR), 20);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => entered = resolve);
  const gate = new Promise<void>(resolve => release = resolve);
  const h = harness({ boards: { async create(rng, excluded) {
    const board = await renderer.create(rng, excluded);
    entered();
    await gate;
    return board;
  } } });
  enrol(h);
  const joining = join_(h, USER);
  await started;
  try {
    const request = h.store.liveRequestsForUser(USER)[0]!;
    expect(h.store.toReview(request.id, USER, 'help_requested', h.clock.now())).toBe(true);
  } finally {
    release();
    await joining;
  }
  expect(h.tg.photos).toHaveLength(0);
  expect(h.tg.approved).toHaveLength(0);
  expect(h.store.liveRequestsForUser(USER)[0]!.state).toBe('manual_review');
});
