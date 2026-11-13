import { describe, expect, test } from 'bun:test';
import { secureRng } from '@guard/core';
import { LocalAssetStore, type AssetStore } from '@guard/assets';
import { Store, openDatabase } from '@guard/database';
import { TgError } from '@guard/bot';
import { ASSETS_DIR, GROUP, OWNER, answer, boardTokens, enrol, harness, join_, net, passChallenge } from './helpers';

const U = 5001;
const state = (h: ReturnType<typeof harness>, user = U, chat = GROUP) =>
  (h.store.db.query('SELECT state FROM join_requests WHERE user_id=? AND chat_id=? ORDER BY generation DESC LIMIT 1').get(user, chat) as
    | { state: string }
    | null)?.state;
const reason = (h: ReturnType<typeof harness>, user = U) =>
  (h.store.db.query('SELECT reason_code FROM join_requests WHERE user_id=? ORDER BY generation DESC LIMIT 1').get(user) as { reason_code: string })
    .reason_code;

describe('admission flow', () => {
  test('join request → picture at once → two correct rounds → exactly one approval', async () => {
    const h = harness();
    enrol(h, GROUP, OWNER, { helpLocale: 'zh-HK' });
    await join_(h, U);
    // No language question: the first picture arrives straight away in the group's language.
    expect(h.tg.messages).toHaveLength(0);
    expect(h.tg.photos).toHaveLength(1);
    expect(h.tg.photos[0]!.chatId).toBe(U);
    expect(h.tg.photos[0]!.caption).toContain('第 1 / 2 回合');
    const langs = h.tg.photos[0]!.markup.inline_keyboard.flat().filter((b) => 'callback_data' in b && b.callback_data.startsWith('l:'));
    expect(langs.map(b => b.text)).toEqual(['繁體中文', '简体中文', 'English']); // one Traditional Chinese option
    expect(await answer(h, U, boardTokens(h, U).correct)).toBe('next-round');
    expect(h.tg.photos).toHaveLength(2);
    expect(h.tg.approved).toHaveLength(0);
    expect(await answer(h, U, boardTokens(h, U).correct)).toBe('approval-queued');
    expect(h.tg.approved).toEqual([[GROUP, U]]);
    expect(state(h)).toBe('approved');
    // The pass notice is sent before the approval call.
    expect(h.tg.messages.some((m) => m.text.includes('驗證通過'))).toBe(true);
  });

  test('callback data never encodes the answer and boards differ between rounds', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    const first = boardTokens(h, U);
    expect(new Set(first.all).size).toBe(6);
    for (const tk of first.all) expect(tk).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await answer(h, U, first.correct);
    expect(h.tg.photos[0]!.photo).not.toEqual(h.tg.photos[1]!.photo);
  });

  test('wrong answer ends the attempt; second failure goes to review, never approval', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    expect(await answer(h, U, boardTokens(h, U).wrong)).toBe('wrong');
    expect(state(h)).toBe('pending');
    const retry = h.tg.messages.at(-1)!.markup!.inline_keyboard[0]![0]!;
    const requestId = 'callback_data' in retry ? retry.callback_data.slice(2) : '';
    await h.v.onPickRequest(U, U, requestId);
    expect(h.tg.photos).toHaveLength(2);
    expect(await answer(h, U, boardTokens(h, U).wrong)).toBe('wrong');
    expect(state(h)).toBe('manual_review');
    expect(reason(h)).toBe('attempts_exhausted');
    // A third try is refused; restarting or changing language does not reset attempts.
    await h.v.onStart(U, U, '');
    await h.v.onLanguagePicked(U, U, 'zh-TW');
    expect(h.tg.photos).toHaveLength(2);
    expect(h.tg.approved).toHaveLength(0);
  });

  test('replayed, concurrent and foreign callbacks cause at most one transition', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    const b1 = boardTokens(h, U);
    // Another account pressing a copied button changes nothing.
    expect(h.v.answer(7777, 7777, b1.correct).result).toBe('stale');
    expect(h.v.answer(U, 7777, b1.correct).result).toBe('stale');
    // Correct and wrong racing: only the first wins.
    const [a, b] = [h.v.answer(U, U, b1.correct), h.v.answer(U, U, b1.wrong)];
    expect([a.result, b.result]).toEqual(['next-round', 'stale']);
    await h.v.afterAnswer(a, U);
    const b2 = boardTokens(h, U);
    expect(h.v.answer(U, U, b1.correct).result).toBe('stale'); // first-round token after advancing
    const results = [h.v.answer(U, U, b2.correct), h.v.answer(U, U, b2.correct)].map((r) => r.result);
    expect(results).toEqual(['approval-queued', 'stale']);
    const approvals = h.store.db.query(`SELECT COUNT(*) AS n FROM outbox WHERE kind='approve'`).get() as { n: number };
    expect(approvals.n).toBe(1);
    await h.v.drainOutbox();
    expect(h.tg.approved).toHaveLength(1);
  });

  test('duplicate join updates do not create sessions, invites or reset limits', async () => {
    const h = harness();
    enrol(h);
    const input = { chatId: GROUP, userId: U, contactChatId: U, requestedAt: h.clock.now() };
    await h.v.onJoin({ updateId: 1, ...input });
    await h.v.onJoin({ updateId: 1, ...input }); // redelivery
    await h.v.onJoin({ updateId: 2, ...input }); // same user/group/date under another update
    expect(h.tg.photos).toHaveLength(1);
    expect((h.store.db.query('SELECT COUNT(*) AS n FROM join_requests').get() as { n: number }).n).toBe(1);
  });

  test('reapplication supersedes the old generation and its tokens', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    const old = boardTokens(h, U);
    h.clock.advance(20_000);
    await join_(h, U);
    expect(h.v.answer(U, U, old.correct).result).toBe('stale');
    const rows = h.store.db.query('SELECT state, generation FROM join_requests ORDER BY generation').all() as { state: string; generation: number }[];
    expect(rows.map((r) => r.state)).toEqual(['superseded', 'challenging']);
    expect(h.tg.approved).toHaveLength(0);
  });

  test('a stale approval for an old revision is discarded', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    await answer(h, U, boardTokens(h, U).correct);
    h.tg.failNext('approve', net());
    await answer(h, U, boardTokens(h, U).correct); // approval queued, first call times out
    expect(state(h)).toBe('approval_pending');
    h.clock.advance(1000);
    await join_(h, U); // user re-applied meanwhile
    h.clock.advance(60_000);
    await h.v.drainOutbox();
    expect(h.tg.approved).toHaveLength(0);
    expect(state(h)).toBe('challenging'); // the new application simply starts its own check
  });

  test('language change re-sends the same round without a new attempt', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    const before = boardTokens(h, U);
    const answerBefore = h.store.liveSession(h.store.liveRequestsForUser(U)[0]!.id)!.answer_position;
    await h.v.onLanguagePicked(U, U, 'zh-CN');
    expect(h.tg.photos).toHaveLength(2);
    expect(h.tg.photos[1]!.caption).toContain('第 1 / 2 轮');
    expect(typeof h.tg.photos[1]!.photo).toBe('string'); // exact bytes → cached file_id reused
    const s = h.store.liveSession(h.store.liveRequestsForUser(U)[0]!.id)!;
    expect(s.answer_position).toBe(answerBefore);
    expect((h.store.db.query('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n).toBe(1);
    expect(h.v.answer(U, U, before.correct).result).toBe('stale'); // old token set is invalid
    expect(await answer(h, U, boardTokens(h, U).correct)).toBe('next-round');
  });

  test('a user with requests in two groups verifies each independently', async () => {
    const h = harness();
    enrol(h, GROUP);
    enrol(h, -2002, 2000);
    await join_(h, U, GROUP);
    await join_(h, U, -2002);
    expect(h.tg.photos).toHaveLength(2); // one picture per group
    expect(h.tg.photos[0]!.caption).toContain('Group -1001');
    expect(h.tg.photos[1]!.caption).toContain('Group -2002');
    await answer(h, U, boardTokens(h, U).correct); // the latest picture belongs to the second group
    await answer(h, U, boardTokens(h, U).correct);
    expect(h.tg.approved).toEqual([[-2002, U]]);
    expect([state(h, U, GROUP), state(h, U, -2002)]).toEqual(['challenging', 'approved']);
  });

  test('help request goes to manual review without an explanation', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    const r = h.store.liveRequestsForUser(U)[0]!;
    await h.v.onHelp(7777, 7777, r.id); // someone else cannot move it
    expect(state(h)).toBe('challenging');
    await h.v.onHelp(U, U, r.id);
    expect(state(h)).toBe('manual_review');
    expect(reason(h)).toBe('help_requested');
  });

  test('the generic /start route finds only the caller\'s own pending request', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    expect(await h.v.onStart(7777, 7777, 'verify')).toBe(false); // nothing of theirs to verify
    // A request-specific resume link copied to another account does not work either.
    const token = h.store.createResumeToken(h.store.liveRequestsForUser(U)[0]!.id, h.clock.now() + 60_000);
    expect(await h.v.onStart(7777, 7777, `r_${token}`)).toBe(false);
    expect(h.tg.photos.filter((p) => p.chatId === 7777)).toHaveLength(0);
    expect(await h.v.onStart(U, U, `r_${token}`)).toBe(true); // the owner gets their picture again
    expect(h.tg.photos.filter((p) => p.chatId === U)).toHaveLength(2);
  });
});

describe('limits, raid mode and expiry', () => {
  test('arrival burst enters review-only raid mode that does not end by itself', async () => {
    const h = harness();
    enrol(h, GROUP, OWNER, { burstThreshold: 5 });
    for (let i = 0; i < 5; i++) await join_(h, 6000 + i);
    expect(h.store.getGroup(GROUP)!.raid_mode).toBe(0);
    await join_(h, 6005);
    expect(h.store.getGroup(GROUP)!.raid_mode).toBe(1);
    expect(state(h, 6005)).toBe('manual_review');
    // An applicant mid-challenge cannot be auto-approved during the raid.
    expect(await answer(h, 6000, boardTokens(h, 6000).correct)).toBe('review');
    expect(state(h, 6000)).toBe('manual_review');
    h.clock.advance(3_600_000);
    await h.v.tick();
    expect(h.store.getGroup(GROUP)!.raid_mode).toBe(1);
    expect(h.tg.approved).toHaveLength(0);
  });

  test('a pass during raid mode is routed to review, not approved', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    await answer(h, U, boardTokens(h, U).correct);
    h.store.setRaid(GROUP, true, OWNER, 'test', h.clock.now());
    expect(await answer(h, U, boardTokens(h, U).correct)).toBe('review');
    expect(state(h)).toBe('manual_review');
    expect(h.tg.approved).toHaveLength(0);
  });

  test('expired challenge and expired request go to manual review, never approval', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    const tokens = boardTokens(h, U);
    h.clock.advance(16 * 60_000);
    await h.v.tick();
    expect(state(h)).toBe('manual_review');
    expect(h.v.answer(U, U, tokens.correct).result).toBe('stale');
    expect(h.tg.approved).toHaveLength(0);

    await join_(h, 5002); // never interacts
    h.clock.advance(16 * 60_000);
    await h.v.tick();
    expect(state(h, 5002)).toBe('manual_review');
  });

  test('answer at the exact expiry millisecond is rejected', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    const s = h.store.liveSession(h.store.liveRequestsForUser(U)[0]!.id)!;
    const tokens = boardTokens(h, U);
    h.clock.t = s.expires_at;
    expect(h.v.answer(U, U, tokens.correct).result).toBe('stale');
  });

  test('without an explicit /start the challenge stays inside the contact window', async () => {
    const h = harness();
    enrol(h, GROUP, OWNER, { challengeTimeoutSec: 600 });
    // The join update reaches the bot late: Telegram no longer lets it message the applicant.
    await h.v.onJoin({ updateId: 7001, chatId: GROUP, userId: U, contactChatId: U, requestedAt: h.clock.now() - 290_000 });
    expect(h.tg.photos).toHaveLength(0);
    expect(state(h)).toBe('pending');
    expect(await h.v.onStart(U, U, 'verify')).toBe(true); // they open the bot themselves
    expect(h.tg.photos).toHaveLength(1);
  });

  test('limits survive a restart', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    await answer(h, U, boardTokens(h, U).wrong);
    h.store.db.close();
    const h2 = harness({ dbPath: h.dbPath });
    h2.clock.t = h.clock.t;
    const r = h2.store.liveRequestsForUser(U)[0]!;
    await h2.v.onPickRequest(U, U, r.id);
    await answer(h2, U, boardTokens(h2, U).wrong);
    expect(h2.store.getRequest(r.id)!.state).toBe('manual_review');
  });

  test('global session capacity defers without image work', async () => {
    const h = harness({ maxActiveSessions: 1 });
    enrol(h);
    await join_(h, U);
    await join_(h, 5002);
    expect(h.tg.photos).toHaveLength(1);
    expect(state(h, 5002)).toBe('pending');
    await h.v.onStart(5002, 5002, '');
    expect(h.tg.lastText(5002)).toContain('busy');
    expect(h.tg.photos).toHaveLength(1);
  });

  test('group approval budget makes surplus passes wait', async () => {
    const h = harness();
    enrol(h, GROUP, OWNER, { approvalsPerMinute: 1 });
    await join_(h, U);
    await join_(h, 5002);
    await passChallenge(h, U);
    await passChallenge(h, 5002);
    expect(h.tg.approved).toHaveLength(1);
    expect(state(h, 5002)).toBe('approval_pending');
    h.clock.advance(61_000);
    await h.v.tick();
    expect(h.tg.approved).toHaveLength(2);
  });
});

describe('failure handling never approves', () => {
  test('approval timeout then confirmed membership resolves with provenance', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    h.tg.failNext('approve', net(), new TgError('gone', 'USER_ALREADY_PARTICIPANT'));
    h.tg.members.add(`${GROUP}:${U}`);
    await passChallenge(h, U);
    expect(state(h)).toBe('approval_pending');
    h.clock.advance(5000);
    await h.v.tick();
    expect(state(h)).toBe('approved');
    expect(reason(h)).toBe('confirmed_by_membership');
  });

  test('a vanished request is an unknown external resolution, not a success', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    h.tg.failNext('approve', new TgError('gone', 'HIDE_REQUESTER_MISSING'));
    await passChallenge(h, U);
    expect(state(h)).toBe('external_resolution');
    expect(reason(h)).toBe('unknown');
  });

  test('membership seen from another admin is recorded as external', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    h.v.onMemberJoined(GROUP, U);
    expect(state(h)).toBe('external_resolution');
  });

  test('missing bot rights pause the group and send the request to review', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    h.tg.failNext('approve', new TgError('forbidden', 'not enough rights'));
    await passChallenge(h, U);
    expect(state(h)).toBe('manual_review');
    expect(h.store.getGroup(GROUP)!.enabled).toBe(0);
    await join_(h, 5002);
    expect(state(h, 5002)).toBeUndefined(); // paused groups are not handled automatically
  });

  test('persistent network failure ends in review', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    h.tg.failNext('approve', ...Array.from({ length: 8 }, net));
    await passChallenge(h, U);
    for (let i = 0; i < 10; i++) {
      h.clock.advance(120_000);
      await h.v.drainOutbox();
    }
    expect(state(h)).toBe('manual_review');
    expect(h.tg.approved).toHaveLength(0);
  });

  test('rate limiting is honoured without consuming an attempt', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    h.tg.failNext('approve', new TgError('rate', 'Too Many Requests', 7000));
    await passChallenge(h, U);
    h.clock.advance(3000);
    await h.v.drainOutbox();
    expect(h.tg.approved).toHaveLength(0);
    h.clock.advance(5000);
    await h.v.drainOutbox();
    expect(h.tg.approved).toHaveLength(1);
  });

  test('corrupt assets route to review', async () => {
    const real = new LocalAssetStore(ASSETS_DIR);
    const broken: AssetStore = {
      manifest: real.manifest,
      approvedIds: () => real.approvedIds(),
      item: (id) => real.item(id),
      readApprovedAsset: async () => {
        throw new Error('hash mismatch');
      },
    };
    const h = harness({ assets: broken });
    enrol(h);
    await join_(h, U);
    expect(h.tg.photos).toHaveLength(0);
    expect(state(h)).toBe('manual_review');
    expect(reason(h)).toBe('render_failed');
  });

  test('a send that fails after the round was stored is re-sent with the same answer', async () => {
    const h = harness();
    enrol(h);
    h.tg.failNext('sendPhoto', net());
    await join_(h, U);
    expect(h.tg.photos).toHaveLength(0);
    const s1 = h.store.liveSession(h.store.liveRequestsForUser(U)[0]!.id)!;
    h.clock.advance(3000);
    await h.v.tick();
    expect(h.tg.photos).toHaveLength(1);
    const s2 = h.store.getSession(s1.id)!;
    expect(s2.answer_position).toBe(s1.answer_position);
    expect(s2.board_hash).toBe(s1.board_hash);
    expect(await answer(h, U, boardTokens(h, U).correct)).toBe('next-round');
  });

  test('invalid cached file reference evicts once and re-uploads identical bytes', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    h.tg.failNext('sendPhoto', new TgError('invalid_file', 'wrong file identifier'));
    await h.v.onLanguagePicked(U, U, 'zh-TW'); // re-send uses the cached file_id, which is now invalid
    expect(h.tg.photos).toHaveLength(2);
    expect(h.tg.photos[1]!.photo).toBeInstanceOf(Uint8Array);
    expect(h.tg.photos[1]!.photo).toEqual(h.tg.photos[0]!.photo);
  });

  test('crash after the decision commit: restart replays the approval exactly once', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    await answer(h, U, boardTokens(h, U).correct);
    const res = h.v.answer(U, U, boardTokens(h, U).correct); // committed, process "dies" before the API call
    expect(res.result).toBe('approval-queued');
    h.store.db.close();
    const h2 = harness({ dbPath: h.dbPath });
    h2.clock.t = h.clock.t + 1000;
    await h2.v.tick();
    await h2.v.tick();
    expect(h2.tg.approved).toEqual([[GROUP, U]]);
  });

  test('retention keeps live requests and removes expired answers and tokens', async () => {
    const h = harness();
    enrol(h);
    await join_(h, U);
    await passChallenge(h, U);
    await join_(h, 5002);
    await answer(h, 5002, boardTokens(h, 5002).wrong);
    h.clock.advance(2 * 86_400_000);
    h.store.purge(h.clock.now());
    const n = (sql: string) => (h.store.db.query(sql).get() as { n: number }).n;
    expect(n('SELECT COUNT(*) AS n FROM callback_tokens')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM sessions WHERE answer_position IS NOT NULL')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM attempts')).toBe(0);
    expect(n(`SELECT COUNT(*) AS n FROM join_requests WHERE state='approved'`)).toBe(1);
    h.clock.advance(31 * 86_400_000);
    h.store.purge(h.clock.now());
    expect(n(`SELECT COUNT(*) AS n FROM join_requests WHERE state='approved'`)).toBe(0);
  });

  test('second process is refused by the instance lock', async () => {
    const { acquireInstanceLock } = await import('@guard/database');
    const h = harness();
    const lock = acquireInstanceLock(h.dbPath);
    expect(() => acquireInstanceLock(h.dbPath)).toThrow();
    lock.close();
    acquireInstanceLock(h.dbPath).close();
    void Store;
    void openDatabase;
    void secureRng;
  });
});
