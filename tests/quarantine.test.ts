import { describe, expect, test } from 'bun:test';
import { parseDuration } from '@guard/bot';
import { GROUP, OWNER, answer, boardTokens, enrol, harness, type Harness } from './helpers';

const U = 5001;
let seq = 9000;
const selfJoin = (h: Harness, user = U) => h.v.onMemberJoined(GROUP, user, true, seq++, h.clock.now());
const state = (h: Harness, user = U) =>
  (h.store.db.query('SELECT state FROM join_requests WHERE user_id=? ORDER BY generation DESC LIMIT 1').get(user) as { state: string } | null)?.state;
const tokens = (h: Harness, user = U) => boardTokens(h, user, GROUP);
const tap = (h: Harness, token: string, user = U) => answer(h, user, token, GROUP);
const groupPhotos = (h: Harness) => h.tg.photos.filter((p) => p.chatId === GROUP);

describe('people who join the group directly', () => {
  test('are muted and get the picture check in the group itself, with no private chat', async () => {
    const h = harness();
    enrol(h);
    await selfJoin(h);
    expect(h.tg.restricted).toEqual([[GROUP, U]]);
    expect(groupPhotos(h)).toHaveLength(1);
    expect(groupPhotos(h)[0]!.mention).toBe(U);
    expect(h.tg.messages.filter((m) => m.chatId === U)).toHaveLength(0); // nothing sent privately
    expect(await tap(h, tokens(h).correct)).toBe('next-round');
    expect(h.tg.deleted).toContain(groupPhotos(h)[0]!.id); // round one is removed
    expect(groupPhotos(h)).toHaveLength(2);
    expect(h.tg.unrestricted).toHaveLength(0);
    expect(await tap(h, tokens(h).correct)).toBe('approval-queued');
    expect(h.tg.unrestricted).toEqual([[GROUP, U]]);
    expect(h.tg.approved).toHaveLength(0); // no join request exists to approve
    expect(h.tg.deleted).toContain(groupPhotos(h)[1]!.id);
    expect(h.tg.messages.filter((m) => m.chatId === GROUP)).toHaveLength(0); // no chatter left behind
    expect(state(h)).toBe('approved');
  });

  test('other members pressing the buttons changes nothing', async () => {
    const h = harness();
    enrol(h);
    await selfJoin(h);
    const t1 = tokens(h);
    expect(h.v.answer(7777, GROUP, t1.correct).result).toBe('stale');
    expect(h.v.answer(7777, GROUP, t1.wrong).result).toBe('stale');
    expect(h.v.answer(U, U, t1.correct).result).toBe('stale'); // nor does the wrong chat
    expect(await h.v.onGroupLanguage(7777, GROUP, 'zh-HK')).toBe(false);
    expect(await h.v.onGroupHelp(7777, GROUP, h.store.liveRequestsForUser(U)[0]!.id)).toBe(false);
    expect(state(h)).toBe('challenging');
    expect(await tap(h, t1.correct)).toBe('next-round');
  });

  test('two newcomers are checked side by side without mixing up', async () => {
    const h = harness();
    enrol(h);
    await selfJoin(h, U);
    await selfJoin(h, 5002);
    expect(h.v.answer(5002, GROUP, tokens(h, U).correct).result).toBe('stale');
    await tap(h, tokens(h, 5002).correct, 5002);
    await tap(h, tokens(h, 5002).correct, 5002);
    expect(h.tg.unrestricted).toEqual([[GROUP, 5002]]);
    expect(state(h, U)).toBe('challenging');
  });

  test('a wrong tap brings a fresh picture; a second one leaves them muted for review', async () => {
    const h = harness();
    enrol(h);
    await selfJoin(h);
    expect(await tap(h, tokens(h).wrong)).toBe('wrong');
    expect(groupPhotos(h)).toHaveLength(2); // new attempt appears by itself
    expect(await tap(h, tokens(h).wrong)).toBe('wrong');
    expect(state(h)).toBe('manual_review');
    expect(h.tg.unrestricted).toHaveLength(0);
    expect(h.tg.prompts.at(-1)!.text).toContain('administrator will review');
    h.store.queueDecision(h.store.liveRequestsForUser(U)[0]!.id, GROUP, 'decline', OWNER, h.clock.now());
    await h.v.drainOutbox();
    expect(h.tg.kicked).toEqual([[GROUP, U]]);
    expect(h.tg.deleted).toContain(h.tg.prompts.at(-1)!.id); // the notice is cleaned up
    expect(state(h)).toBe('declined');
  });

  test('language buttons re-post the same round in the chosen language', async () => {
    const h = harness();
    enrol(h);
    await selfJoin(h);
    const before = h.store.liveSession(h.store.liveRequestsForUser(U)[0]!.id)!.answer_position;
    expect(await h.v.onGroupLanguage(U, GROUP, 'zh-HK')).toBe(true);
    expect(groupPhotos(h)).toHaveLength(2);
    expect(groupPhotos(h)[1]!.caption).toContain('回合');
    expect(h.tg.deleted).toContain(groupPhotos(h)[0]!.id);
    expect(h.store.liveSession(h.store.liveRequestsForUser(U)[0]!.id)!.answer_position).toBe(before);
    expect(await tap(h, tokens(h).correct)).toBe('next-round');
  });

  test('the shared deadline ends verification without a self-service timeout retry', async () => {
    const h = harness();
    enrol(h, GROUP, OWNER, { requestLifetimeMin: 1, challengeTimeoutSec: 60 });
    await selfJoin(h);
    h.clock.advance(60_000);
    await h.v.tick();
    expect(h.tg.deleted).toContain(groupPhotos(h)[0]!.id);
    const notice = h.tg.prompts.at(-1)!;
    const id = h.store.liveRequestsForUser(U)[0]!.id;
    expect(notice.markup.inline_keyboard.flat().some(b => 'callback_data' in b && b.callback_data.startsWith('t:'))).toBe(false);
    expect(await h.v.onGroupRetry(7777, GROUP, id)).toBe(false);
    expect(await h.v.onGroupRetry(U, GROUP, id)).toBe(true);
    expect(groupPhotos(h)).toHaveLength(1);
    expect(state(h)).toBe('manual_review');
    expect(h.tg.unrestricted).toHaveLength(0);
  });

  test('"I need help" under the picture sends them to review', async () => {
    const h = harness();
    enrol(h);
    await selfJoin(h);
    expect(await h.v.onGroupHelp(U, GROUP, h.store.liveRequestsForUser(U)[0]!.id)).toBe(true);
    expect(state(h)).toBe('manual_review');
    expect(h.tg.deleted).toContain(groupPhotos(h)[0]!.id);
  });

  test('members added or approved by an admin, or by this bot, are not challenged', async () => {
    const h = harness();
    enrol(h);
    await h.v.onMemberJoined(GROUP, U, false, seq++, h.clock.now());
    expect(h.tg.restricted).toHaveLength(0);
    expect(state(h)).toBeUndefined();
  });

  test('leaving closes the record', async () => {
    const h = harness();
    enrol(h);
    await selfJoin(h);
    const before = tokens(h);
    await h.v.onMemberLeft(GROUP, U);
    expect(state(h)).toBe('external_resolution');
    expect(h.tg.deleted).toContain(groupPhotos(h)[0]!.id); // the picture does not linger
    expect(h.v.answer(U, GROUP, before.correct).result).toBe('stale');
  });

  test('raid mode mutes without a check and waits for review', async () => {
    const h = harness();
    enrol(h);
    h.store.setRaid(GROUP, true, OWNER, 'test', h.clock.now());
    await selfJoin(h);
    expect(h.tg.restricted).toHaveLength(1);
    expect(groupPhotos(h)).toHaveLength(0);
    expect(state(h)).toBe('manual_review');
    h.store.queueDecision(h.store.liveRequestsForUser(U)[0]!.id, GROUP, 'approve', OWNER, h.clock.now());
    await h.v.drainOutbox();
    expect(h.tg.unrestricted).toEqual([[GROUP, U]]);
  });

  test('without the right to mute nothing is enforced and admins are told once', async () => {
    const h = harness();
    enrol(h);
    h.store.recordExplicitStart(OWNER, OWNER, h.clock.now());
    h.tg.canRestrict = false;
    await selfJoin(h, U);
    await selfJoin(h, 5002);
    expect(groupPhotos(h)).toHaveLength(0);
    expect(state(h)).toBe('external_resolution');
    expect(h.tg.messages.filter((m) => m.chatId === OWNER && m.text.includes('could not mute'))).toHaveLength(1);
  });

  test('switched off per group', async () => {
    const h = harness();
    enrol(h, GROUP, OWNER, { quarantine: false });
    await selfJoin(h);
    expect(h.tg.restricted).toHaveLength(0);
  });
});

describe('retry granted by an admin', () => {
  async function pressRetry(h: Harness, actor: number): Promise<void> {
    await h.admin.review(actor, actor);
    const b = h.tg.messages.filter((m) => m.chatId === actor && m.markup).at(-1)!.markup!.inline_keyboard.flat().find((x) => /try again/.test(x.text))!;
    await h.admin.onAction(actor, actor, 'callback_data' in b ? b.callback_data.slice(2) : '');
  }

  test('a failed member gets a fresh picture in the group and can then pass', async () => {
    const h = harness();
    enrol(h);
    const MOD = 3100;
    h.tg.admins.get(GROUP)!.push({ userId: MOD, isCreator: false, isBot: false, canInvite: false, canRestrict: true });
    await h.admin.refreshAdmins(GROUP);
    await selfJoin(h);
    await tap(h, tokens(h).wrong);
    await tap(h, tokens(h).wrong);
    expect(state(h)).toBe('manual_review');
    await pressRetry(h, MOD); // any admin of the group, no grant needed
    expect(state(h)).toBe('challenging');
    expect(groupPhotos(h)).toHaveLength(3);
    expect(h.store.listAudit(GROUP, 30).some((a) => a.action === 'retry_granted' && a.actor_user_id === MOD)).toBe(true);
    await tap(h, tokens(h).correct);
    await tap(h, tokens(h).correct);
    expect(h.tg.unrestricted).toEqual([[GROUP, U]]);
    expect(state(h)).toBe('approved');
  });

  test('works after a timeout, and outsiders cannot grant it', async () => {
    const h = harness();
    enrol(h);
    await selfJoin(h);
    h.clock.advance(16 * 60_000);
    await h.v.tick();
    const id = h.store.liveRequestsForUser(U)[0]!.id;
    const token = h.store.createActionToken(7777, { op: 'retry', chat: GROUP, req: id, user: U }, h.clock.now() + 60_000);
    await h.admin.onAction(7777, 7777, token);
    expect(state(h)).toBe('manual_review');
    await pressRetry(h, OWNER);
    expect(state(h)).toBe('challenging');
    expect(groupPhotos(h)).toHaveLength(2);
  });
});

describe('/ban', () => {
  const MOD = 3100;
  test('any Telegram admin of the group with the ban right can ban there; others are ignored', async () => {
    const h = harness();
    enrol(h);
    h.tg.admins.get(GROUP)!.push(
      { userId: MOD, isCreator: false, isBot: false, canInvite: false, canRestrict: true },
      { userId: 3200, isCreator: false, isBot: false, canInvite: true, canRestrict: false },
    );
    await h.admin.banInGroup(7777, GROUP, U); // ordinary member
    await h.admin.banInGroup(3200, GROUP, U); // admin without the ban right
    expect(h.tg.banned).toHaveLength(0);
    await selfJoin(h);
    await h.admin.banInGroup(MOD, GROUP, U); // no bot grant needed
    expect(h.tg.banned).toEqual([[GROUP, U]]);
    expect(state(h)).toBe('declined');
    expect(h.tg.deleted).toContain(h.tg.photos.find((p) => p.chatId === GROUP)!.id); // their check picture is removed
    expect(h.store.listAudit(GROUP, 20).some((a) => a.action === 'user_banned' && a.actor_user_id === MOD)).toBe(true);
  });
  test('admins of one group cannot ban in another, and admins cannot be banned', async () => {
    const h = harness();
    enrol(h, GROUP, OWNER);
    enrol(h, -2002, 2000);
    await h.admin.banInGroup(OWNER, -2002, U);
    await h.admin.banInGroup(OWNER, GROUP, OWNER);
    expect(h.tg.banned).toHaveLength(0);
    await h.admin.ban(OWNER, OWNER, String(U)); // private chat, owner's own group
    expect(h.tg.banned).toEqual([[GROUP, U]]);
  });
});

describe('/mute and /unban', () => {
  const MOD = 3100;
  function setup() {
    const h = harness();
    enrol(h);
    h.tg.admins.get(GROUP)!.push({ userId: MOD, isCreator: false, isBot: false, canInvite: false, canRestrict: true });
    return h;
  }
  test('durations parse within one minute to 366 days', () => {
    expect(parseDuration('30m')).toEqual({ seconds: 1800, label: '30 min' });
    expect(parseDuration('2H')).toEqual({ seconds: 7200, label: '2 h' });
    expect(parseDuration('3d')?.seconds).toBe(259_200);
    for (const bad of ['', '0m', '5', '2w', '9999d', 'h2', '-1h']) expect(parseDuration(bad)).toBeUndefined();
  });
  test('a group admin mutes for a set time and lifts it early with /unban', async () => {
    const h = setup();
    await h.admin.moderateInGroup(7777, GROUP, U, { kind: 'mute', seconds: 7200, label: '2 h' }); // not an admin
    expect(h.tg.muted).toHaveLength(0);
    await h.admin.moderateInGroup(MOD, GROUP, U, { kind: 'mute', seconds: 7200, label: '2 h' });
    expect(h.tg.muted).toEqual([[GROUP, U, Math.floor(h.clock.now() / 1000) + 7200]]);
    expect(h.tg.messages.at(-1)!.text).toContain('for 2 h');
    await h.admin.moderateInGroup(MOD, GROUP, U, { kind: 'unban' });
    expect(h.tg.unrestricted).toEqual([[GROUP, U]]);
    expect(h.tg.unbanned).toEqual([[GROUP, U]]);
    const actions = h.store.listAudit(GROUP, 20).filter((a) => a.actor_user_id === MOD).map((a) => a.action);
    expect(actions).toEqual(['user_unbanned', 'user_muted']);
  });
  test('admins cannot be muted, and admins of another group cannot act here', async () => {
    const h = setup();
    enrol(h, -2002, 2000);
    await h.admin.moderateInGroup(MOD, GROUP, OWNER, { kind: 'mute', seconds: 3600, label: '1 h' });
    await h.admin.moderateInGroup(2000, GROUP, U, { kind: 'mute', seconds: 3600, label: '1 h' });
    await h.admin.moderateInGroup(2000, GROUP, U, { kind: 'unban' });
    expect(h.tg.muted).toHaveLength(0);
    expect(h.tg.unbanned).toHaveLength(0);
  });
  test('someone still under check cannot get a timed mute; /unban on them counts as an approval', async () => {
    const h = setup();
    await selfJoin(h);
    await h.admin.moderateInGroup(MOD, GROUP, U, { kind: 'mute', seconds: 3600, label: '1 h' });
    expect(h.tg.muted).toHaveLength(0); // would otherwise expire into full access without the check
    await h.admin.moderateInGroup(MOD, GROUP, U, { kind: 'unban' });
    expect(h.tg.unrestricted).toEqual([[GROUP, U]]);
    expect(state(h)).toBe('approved');
    expect(h.tg.deleted).toContain(groupPhotos(h)[0]!.id);
  });
  test('works in private chat by user ID for the admin\'s group', async () => {
    const h = setup();
    await h.admin.moderate(OWNER, OWNER, String(U), { kind: 'mute', seconds: 600, label: '10 min' });
    expect(h.tg.muted).toHaveLength(1);
    await h.admin.moderate(7777, 7777, String(U), { kind: 'unban' });
    expect(h.tg.unbanned).toHaveLength(0);
  });
});
