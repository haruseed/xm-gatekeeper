import { describe, expect, test } from 'bun:test';
import { Bot } from 'grammy';
import sharp from 'sharp';
import type { Update } from 'grammy/types';
import { LOCALES, applySetting, DEFAULT_SETTINGS, loadConfig, parseSettings, redact, secureRng, type Rng } from '@guard/core';
import { LocalAssetStore, parseManifest } from '@guard/assets';
import { BOARD, FUNCTION_ITEMS, composeBoard, generateRound, preprocessItem } from '@guard/captcha';
import { MIGRATIONS, migrate, openDatabase } from '@guard/database';
import { CATALOGUES, KEYS, t } from '@guard/i18n';
import { Poller, dcFromFileId, projectUpdate, registerRoutes, webhookHandler } from '@guard/bot';
import { ASSETS_DIR, BOT_ID, GROUP, boardTokens, enrol, harness } from './helpers';

describe('captcha', () => {
  const assets = new LocalAssetStore(ASSETS_DIR);
  const ids = assets.approvedIds();

  test('every round has six distinct identities and exactly one correct position', () => {
    for (let i = 0; i < 500; i++) {
      const r = generateRound(ids, secureRng);
      expect(new Set(r.itemIds).size).toBe(6);
      expect(r.itemIds.filter((id) => id === r.question.itemId)).toHaveLength(1);
      expect(r.itemIds[r.answerPosition]).toBe(r.question.itemId);
      if (r.question.kind === 'function') expect(FUNCTION_ITEMS).toContain(r.question.itemId);
    }
  });
  test('randomness is injectable and earlier answers are avoided', () => {
    let n = 0;
    const fixed: Rng = { int: () => 0, token: () => `t${n++}` };
    expect(generateRound(ids, fixed)).toEqual(generateRound(ids, fixed));
    for (let i = 0; i < 100; i++) expect(generateRound(ids, secureRng, [ids[0]!]).question.itemId).not.toBe(ids[0]!);
  });
  test('a bank that is too small is refused', () => {
    expect(() => generateRound(ids.slice(0, 6), secureRng)).toThrow();
  });
  test('board is a 900×600 JPEG under the size cap, different every time', async () => {
    const r = generateRound(ids, secureRng);
    const images = await Promise.all(r.itemIds.map((id) => assets.readApprovedAsset(id)));
    const board = await composeBoard(images, secureRng);
    expect([...board.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(board.byteLength).toBeLessThan(BOARD.maxBytes);
    const meta = await sharp(board).metadata();
    expect([meta.width, meta.height]).toEqual([900, 600]);
    expect(Buffer.from(await composeBoard(images, secureRng)).equals(Buffer.from(board))).toBe(false);
  });
  test('preprocessing makes every rendering of the same item different', async () => {
    const src = await assets.readApprovedAsset(ids[0]!);
    const a = await preprocessItem(src, 200, secureRng);
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add((await preprocessItem(src, 200, secureRng)).toString('base64'));
    expect(seen.size).toBeGreaterThan(3);
    expect([...a.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    let n = 0;
    const fixed: Rng = { int: () => 0, token: () => `t${n++}` };
    expect((await preprocessItem(src, 200, fixed)).equals(await preprocessItem(src, 200, fixed))).toBe(true);
  });
  test('manifest rejects traversal and unapproved assets are unreadable', async () => {
    const m = JSON.parse(JSON.stringify(assets.manifest)) as typeof assets.manifest;
    m.items[0]!.localRelativePath = '../secret.png';
    expect(() => parseManifest(JSON.stringify(m))).toThrow();
    await expect(assets.readApprovedAsset('not-an-item')).rejects.toThrow();
  });
});

describe('i18n', () => {
  test('legacy locale codes resolve to complete catalogues with unified Traditional Chinese', () => {
    for (const l of LOCALES) {
      for (const k of KEYS) {
        const text = CATALOGUES[l][k];
        expect(text.length).toBeGreaterThan(0);
        const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(ph(text)).toEqual(ph(CATALOGUES.en[k]));
        expect(text.toLowerCase()).not.toContain('glyph');
      }
    }
    for (const id of FUNCTION_ITEMS) expect(KEYS).toContain(`fn.${id}` as (typeof KEYS)[number]);
    expect(CATALOGUES['zh-HK']).toBe(CATALOGUES['zh-TW']);
  });
  test('interpolation leaves special characters untouched', () => {
    expect(t('en', 'start.review_wait', { group: '<b>*_[x](y)' })).toContain('<b>*_[x](y)');
  });
});

describe('configuration and settings', () => {
  const good = {
    BOT_TOKEN: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    DATABASE_PATH: '/srv/x/guard.sqlite',
    ASSETS_DIR: '/srv/x/assets',
    BOARD_TEMP_DIR: '/srv/x/tmp',
  };
  test('valid configuration loads with defaults', () => {
    expect(loadConfig(good)).toMatchObject({ maxActiveSessions: 200, logLevel: 'info' });
  });
  test('webhook settings are validated; without them the bot polls', () => {
    expect(loadConfig(good).webhook).toBeUndefined();
    const hook = { ...good, WEBHOOK_URL: 'https://example.org/guard/hook', WEBHOOK_SECRET: 's'.repeat(32) };
    expect(loadConfig(hook).webhook).toEqual({ url: 'https://example.org/guard/hook', path: '/guard/hook', port: 8788, secret: 's'.repeat(32) });
    expect(() => loadConfig({ ...hook, WEBHOOK_URL: 'http://example.org/guard/hook' })).toThrow();
    expect(() => loadConfig({ ...hook, WEBHOOK_SECRET: 'short' })).toThrow();
    expect(() => loadConfig({ ...hook, WEBHOOK_PORT: '80' })).toThrow();
  });
  test('missing or unsafe values stop startup', () => {
    const bad: Record<string, string>[] = [
      { BOT_TOKEN: '' },
      { DATABASE_PATH: 'relative.sqlite' },
      { MAX_ACTIVE_SESSIONS: '0' },
      { MAX_RENDER_QUEUE: '9999' },
      { ASSET_STORAGE: 'ftp' },
      { LOG_LEVEL: 'loud' },
    ];
    for (const patch of bad) expect(() => loadConfig({ ...good, ...patch })).toThrow();
  });
  test('settings are bounded and unknown values rejected', () => {
    expect(applySetting(DEFAULT_SETTINGS, 'attempts', '3').ok).toBe(true);
    expect(applySetting(DEFAULT_SETTINGS, 'attempts', '4').ok).toBe(false);
    expect(applySetting(DEFAULT_SETTINGS, 'helpLocale', 'fr').ok).toBe(false);
    expect(applySetting(DEFAULT_SETTINGS, 'timezone', 'Asia/Taipei')).toMatchObject({ ok: true, settings: { timezone: 'Asia/Taipei' } });
    for (const bad of ['Nowhere/Land', '../etc', '', 'Asia/Taipei; drop']) expect(applySetting(DEFAULT_SETTINGS, 'timezone', bad).ok).toBe(false);
    expect(parseSettings(JSON.stringify({ timezone: 'Bad/Zone' })).timezone).toBe('UTC');
    expect(() => parseSettings(JSON.stringify({ attempts: 50 }))).toThrow();
    expect(parseSettings(JSON.stringify({ quarantine: false })).quarantine).toBe(false);
    expect(parseSettings('{}').quarantine).toBe(true);
    expect(applySetting(DEFAULT_SETTINGS, 'quarantine', 'off')).toMatchObject({ ok: true, settings: { quarantine: false } });
  });
  test('log redaction removes tokens and invite links', () => {
    const out = redact('x 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA https://t.me/+AbCdEf123');
    expect(out).not.toContain('AAAAAAAA');
    expect(out).not.toContain('AbCdEf123');
  });
});

describe('migrations', () => {
  test('fresh install, idempotent re-run and tamper detection', () => {
    const h = harness();
    expect(migrate(h.store.db, 1)).toEqual([]);
    h.store.db.query('UPDATE schema_migrations SET checksum=? WHERE version=1').run('tampered');
    expect(() => migrate(h.store.db, 1)).toThrow();
    h.store.db.query('UPDATE schema_migrations SET version=? WHERE version=?').run(MIGRATIONS.length + 5, MIGRATIONS.length);
    expect(() => migrate(h.store.db, 1)).toThrow(); // never downgrades
    void openDatabase;
  });
});

describe('durable intake', () => {
  const joinUpdate = (id: number, user: number): Update =>
    ({
      update_id: id,
      chat_join_request: {
        chat: { id: GROUP, type: 'supergroup', title: 'Agents' },
        from: { id: user, is_bot: false, first_name: 'Secret Name', username: 'secret_user' },
        user_chat_id: user,
        date: 1_800_000_000,
        bio: 'private biography',
        invite_link: { invite_link: 'https://t.me/+abc' },
      },
    }) as unknown as Update;

  test('projection drops biographies, names, free text, contacts and invite links', () => {
    const j = JSON.stringify(projectUpdate(joinUpdate(1, 5)));
    for (const secret of ['biography', 'Secret', 'secret_user', 't.me/+']) expect(j).not.toContain(secret);
    const msg = (extra: object) =>
      ({ update_id: 2, message: { message_id: 1, date: 1, chat: { id: 5, type: 'private', first_name: 'N' }, from: { id: 5, is_bot: false, first_name: 'N' }, ...extra } }) as unknown as Update;
    expect(JSON.stringify(projectUpdate(msg({ text: 'my phone is 555' })))).not.toContain('555');
    const contact = JSON.stringify(projectUpdate(msg({ contact: { phone_number: '+85212345678', first_name: 'N' } })));
    expect(contact).not.toContain('8521');
    const cmd = projectUpdate(msg({ text: '/start r_abc', entities: [{ type: 'bot_command', offset: 0, length: 6 }] }));
    expect(JSON.stringify(cmd)).toContain('/start r_abc');
    const banReply = (replyExtra: object) =>
      ({ update_id: 4, message: { message_id: 2, date: 1, chat: { id: GROUP, type: 'supergroup', title: 'G' }, from: { id: 5, is_bot: false, first_name: 'N' }, text: '/ban', entities: [{ type: 'bot_command', offset: 0, length: 4 }], reply_to_message: { message_id: 1, date: 1, chat: { id: GROUP, type: 'supergroup', title: 'G' }, from: { id: 66, is_bot: false, first_name: 'Spammer' }, text: 'buy now', ...replyExtra } } }) as unknown as Update;
    const kept = JSON.stringify(projectUpdate(banReply({})));
    expect(kept).toContain('"id":66');
    expect(kept).not.toContain('buy now');
    expect(JSON.stringify(projectUpdate(banReply({ forum_topic_created: { name: 't', icon_color: 1 } })))).not.toContain('"id":66');
    const groupChatter = { update_id: 3, message: { message_id: 1, date: 1, chat: { id: GROUP, type: 'supergroup', title: 'G' }, from: { id: 5, is_bot: false, first_name: 'N' }, text: 'hello all' } } as unknown as Update;
    expect(projectUpdate(groupChatter)).toBeNull();
  });

  function wired() {
    const h = harness();
    enrol(h);
    const bot = new Bot('1:test', {
      botInfo: { id: BOT_ID, is_bot: true, first_name: 'G', username: 'guard_test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } as never,
    });
    bot.api.config.use(async () => ({ ok: true, result: true }) as never); // no network in tests
    registerRoutes(bot, { verification: h.v, admin: h.admin, store: h.store, assets: new LocalAssetStore(ASSETS_DIR), tg: h.tg, clock: h.clock });
    return { h, bot, poller: new Poller(bot, h.store, h.clock) };
  }
  const cb = (id: number, user: number, data: string): Update =>
    ({
      update_id: id,
      callback_query: { id: String(id), from: { id: user, is_bot: false, first_name: 'N' }, chat_instance: 'x', data, message: { message_id: 9, date: 1, chat: { id: user, type: 'private', first_name: 'N' } } },
    }) as unknown as Update;

  test('updates flow inbox → handlers end to end and the offset advances atomically', async () => {
    const { h, poller } = wired();
    const U = 5001;
    h.clock.t = 1_800_000_000_000 + 5000;
    const feed = async (...updates: Update[]) => {
      h.store.storeBatchAndAdvance(updates.map((u) => ({ update_id: u.update_id, payload: projectUpdate(u) })), h.clock.now());
      await poller.processInbox();
    };
    await feed(joinUpdate(10, U));
    expect(h.store.nextOffset()).toBe(11);
    await feed(joinUpdate(10, U)); // Telegram redelivery
    expect(h.tg.photos).toHaveLength(1);
    await feed(cb(11, U, 'l:zh-TW')); // language button under the picture
    expect(h.tg.photos.at(-1)!.caption).toContain('回合');
    await feed(cb(12, U, `c:${boardTokens(h, U).correct}`));
    await feed(cb(13, U, `c:${boardTokens(h, U).correct}`), cb(14, U, 'c:AAAAAAAAAAAAAAAAAAAAAA'), cb(15, U, 'x:junk'));
    expect(h.tg.approved).toEqual([[GROUP, U]]);
    expect(h.store.inboxStats(h.clock.now()).pending).toBe(0);
    expect(h.store.nextOffset()).toBe(16);
  });

  test('/whoami returns the user ID and the data centre read from the profile photo', async () => {
    const { h, poller } = wired();
    const send = async (id: number) => {
      const cmd = { update_id: id, message: { message_id: 1, date: 1, chat: { id: 5001, type: 'private', first_name: 'N' }, from: { id: 5001, is_bot: false, first_name: 'N' }, text: '/whoami', entities: [{ type: 'bot_command', offset: 0, length: 7 }] } } as unknown as Update;
      h.store.storeBatchAndAdvance([{ update_id: id, payload: projectUpdate(cmd) }], h.clock.now());
      await poller.processInbox();
    };
    await send(40);
    expect(h.tg.lastText(5001)).toContain('User ID: 5001');
    expect(h.tg.lastText(5001)).toContain('unknown');
    // A file_id whose decoded bytes carry type 2 and data centre 5 (zeros are run-length encoded).
    h.tg.profilePhoto = Buffer.from([2, 0, 3, 5, 0, 3, 9, 9, 9, 9]).toString('base64url');
    await send(41);
    expect(h.tg.lastText(5001)).toContain('DC5 (Singapore)');
    expect(dcFromFileId('AA')).toBeUndefined();
  });

  test('webhook: only Telegram\'s secret is accepted and 200 is sent only after the durable commit', async () => {
    const { h, poller } = wired();
    h.clock.t = 1_800_000_000_000 + 5000;
    const SECRET = 'x'.repeat(32);
    // The handler starts processing in the background; wait until the inbox has drained.
    const settle = async () => {
      for (let i = 0; i < 300 && h.store.inboxStats(h.clock.now()).pending > 0; i++) await Bun.sleep(10);
      await poller.processInbox();
    };
    const handle = webhookHandler(poller, '/guard/hook', SECRET);
    const post = (body: unknown, secret?: string, path = '/guard/hook') =>
      handle(new Request(`http://127.0.0.1${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...(secret ? { headers: { 'x-telegram-bot-api-secret-token': secret } } : {}) }));
    expect((await post(joinUpdate(50, 5001))).status).toBe(403);
    expect((await post(joinUpdate(50, 5001), 'wrong'.repeat(8))).status).toBe(403);
    expect((await post(joinUpdate(50, 5001), SECRET, '/other')).status).toBe(404);
    expect((await post('{not json', SECRET)).status).toBe(400);
    expect(h.store.inboxStats(h.clock.now()).pending).toBe(0);
    expect(h.tg.photos).toHaveLength(0);

    expect((await post(joinUpdate(50, 5001), SECRET)).status).toBe(200);
    await settle();
    expect(h.tg.photos).toHaveLength(1);
    expect((await post(joinUpdate(50, 5001), SECRET)).status).toBe(200); // Telegram retry: no duplicate
    await settle();
    expect(h.tg.photos).toHaveLength(1);

    // If the inbox cannot be written, Telegram is told to retry and nothing is lost.
    const failing = webhookHandler({ accept: async () => { throw new Error('disk full'); }, processInbox: async () => undefined }, '/guard/hook', SECRET);
    const res = await failing(new Request('http://127.0.0.1/guard/hook', { method: 'POST', body: JSON.stringify(joinUpdate(51, 5002)), headers: { 'x-telegram-bot-api-secret-token': SECRET } }));
    expect(res.status).toBe(500);
  });

  test('a failed handler keeps its inbox row for retry and is never marked complete', async () => {
    const { h, bot, poller } = wired();
    let fail = true;
    bot.on('chat_join_request', () => undefined);
    const original = h.v.onJoin.bind(h.v);
    h.v.onJoin = async (input) => {
      if (fail) throw new Error('disk full');
      return original(input);
    };
    h.clock.t = 1_800_000_000_000 + 5000;
    h.store.storeBatchAndAdvance([{ update_id: 20, payload: projectUpdate(joinUpdate(20, 5001)) }], h.clock.now());
    await poller.processInbox();
    expect(h.store.inboxStats(h.clock.now()).pending).toBe(1);
    expect(h.tg.photos).toHaveLength(0);
    fail = false;
    h.clock.advance(3000);
    await poller.processInbox();
    expect(h.store.inboxStats(h.clock.now()).pending).toBe(0);
    expect(h.tg.photos).toHaveLength(1);
  });
});
