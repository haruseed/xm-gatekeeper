import { describe, expect, test } from 'bun:test';
import { TgError } from '@guard/bot';
import { BOT_ID, GROUP, OWNER, enrol, harness, join_, type Harness } from './helpers';

const U = 5001;
const REVIEWER = 3001;

/** Presses the first button of the last message sent to a chat whose label matches. */
async function press(h: Harness, actor: number, chat: number, label: RegExp): Promise<string | undefined> {
  for (const m of [...h.tg.messages].reverse()) {
    if (m.chatId !== chat || !m.markup) continue;
    const b = m.markup.inline_keyboard.flat().find((x) => label.test(x.text));
    if (b && 'callback_data' in b) return h.admin.onAction(actor, chat, b.callback_data.slice(2));
  }
  throw new Error(`no button ${label}`);
}
const state = (h: Harness, user = U) =>
  (h.store.db.query('SELECT state FROM join_requests WHERE user_id=?').get(user) as { state: string }).state;

/** Someone is promoted in Telegram; the bot learns of it from the admin list (chat_member update). */
async function addAdmin(h: Harness, userId: number, rights = true, chat = GROUP): Promise<void> {
  h.tg.admins.get(chat)!.push({ userId, isCreator: false, isBot: false, canInvite: rights, canRestrict: rights });
  await h.admin.refreshAdmins(chat);
}
async function toReview(h: Harness, user = U, chat = GROUP): Promise<void> {
  await join_(h, user, chat);
  h.store.toReview(h.store.liveRequestsForUser(user)[0]!.id, user, 'help_requested', h.clock.now());
}

describe('authority', () => {
  test('any group admin approves through /review with no grant from anyone', async () => {
    const h = harness();
    enrol(h);
    await addAdmin(h, REVIEWER);
    await toReview(h);
    await h.admin.review(REVIEWER, REVIEWER);
    await press(h, REVIEWER, REVIEWER, /Approve/);
    expect(h.tg.approved).toEqual([[GROUP, U]]);
    expect(state(h)).toBe('approved');
    expect(h.store.listAudit(GROUP, 50).some((a) => a.action === 'review_approve' && a.actor_user_id === REVIEWER)).toBe(true);
  });

  test('decline needs a confirmation step', async () => {
    const h = harness();
    enrol(h);
    await toReview(h);
    await h.admin.review(OWNER, OWNER);
    await press(h, OWNER, OWNER, /Decline/);
    expect(h.tg.declined).toHaveLength(0);
    await press(h, OWNER, OWNER, /Yes, decline/);
    expect(h.tg.declined).toEqual([[GROUP, U]]);
    expect(state(h)).toBe('declined');
  });

  test('manual approval works during raid mode', async () => {
    const h = harness();
    enrol(h);
    h.store.setRaid(GROUP, true, OWNER, 'test', h.clock.now());
    await join_(h, U);
    expect(state(h)).toBe('manual_review');
    await h.admin.review(OWNER, OWNER);
    await press(h, OWNER, OWNER, /Approve/);
    expect(h.tg.approved).toHaveLength(1);
  });

  test('a copied admin button does not work for another account and is one-use', async () => {
    const h = harness();
    enrol(h);
    await toReview(h);
    await h.admin.review(OWNER, OWNER);
    expect(await press(h, 7777, OWNER, /Approve/)).toContain('no longer valid');
    expect(h.tg.approved).toHaveLength(0);
    await press(h, OWNER, OWNER, /Approve/);
    expect(await press(h, OWNER, OWNER, /Approve/)).toContain('no longer valid');
    expect(h.tg.approved).toHaveLength(1);
  });

  test('a demoted admin loses authority when the button is pressed', async () => {
    const h = harness();
    enrol(h);
    await addAdmin(h, REVIEWER);
    await toReview(h);
    await h.admin.review(REVIEWER, REVIEWER);
    h.tg.admins.set(GROUP, h.tg.admins.get(GROUP)!.filter((a) => a.userId !== REVIEWER)); // demoted in Telegram
    await press(h, REVIEWER, REVIEWER, /Approve/);
    expect(h.tg.approved).toHaveLength(0);
    expect(state(h)).toBe('manual_review');
  });

  test('ownership transfer removes the former owner\'s powers immediately', async () => {
    const h = harness();
    enrol(h);
    await toReview(h);
    await h.admin.review(OWNER, OWNER);
    h.tg.admins.set(GROUP, [
      { userId: 4000, isCreator: true, isBot: false, canInvite: true, canRestrict: true },
      { userId: BOT_ID, isCreator: false, isBot: true, canInvite: true, canRestrict: true },
    ]);
    await press(h, OWNER, OWNER, /Approve/);
    expect(h.tg.approved).toHaveLength(0);
    expect(h.store.getGroup(GROUP)!.owner_user_id).toBe(4000);
    await h.admin.review(4000, 4000);
    await press(h, 4000, 4000, /Approve/);
    expect(h.tg.approved).toHaveLength(1);
  });

  test('authority lookup failure fails closed', async () => {
    const h = harness();
    enrol(h);
    await toReview(h);
    await h.admin.review(OWNER, OWNER);
    h.tg.failNext('getAdmins', new TgError('network', 'timeout'));
    await press(h, OWNER, OWNER, /Approve/);
    expect(h.tg.approved).toHaveLength(0);
    expect(state(h)).toBe('manual_review');
  });

  test('group A administrators cannot inspect or decide group B', async () => {
    const h = harness();
    enrol(h, GROUP, OWNER);
    enrol(h, -2002, 2000);
    await toReview(h, U, -2002);
    await h.admin.review(OWNER, OWNER);
    expect(h.tg.messages.filter((m) => m.chatId === OWNER).some((m) => m.text.includes(String(U)))).toBe(false);
    // Even a forged decision naming B's request under A's authority is rejected.
    const req = h.store.liveRequestsForUser(U)[0]!;
    expect(h.store.queueDecision(req.id, GROUP, 'approve', OWNER, h.clock.now())).toBe(false);
    const token = h.store.createActionToken(OWNER, { op: 'approve', chat: -2002, req: req.id, user: U }, h.clock.now() + 60_000);
    await h.admin.onAction(OWNER, OWNER, token);
    expect(h.tg.approved).toHaveLength(0);
  });

  test('admins without member-control rights and ordinary members have no authority', async () => {
    const h = harness();
    enrol(h);
    await addAdmin(h, REVIEWER, false); // e.g. only "pin messages"
    await addAdmin(h, 3002);
    for (const who of [REVIEWER, 7777]) {
      await h.admin.settings(who, who, 'attempts 3');
      await h.admin.raid(who, who, 'on');
    }
    expect(h.store.settingsOf(h.store.getGroup(GROUP)!).attempts).toBe(2);
    expect(h.store.getGroup(GROUP)!.raid_mode).toBe(0);
    await h.admin.settings(3002, 3002, 'attempts 3');
    expect(h.store.settingsOf(h.store.getGroup(GROUP)!).attempts).toBe(3);
    expect(h.store.getGroup(GROUP)!.settings_version).toBe(2);
    await h.admin.settings(3002, 3002, 'remove'); // removal stays with the group owner
    expect(h.tg.lastText(3002)).toContain('Only the group owner');
  });

  test('/settings is a button panel: tap a setting, tap a value, saved in place', async () => {
    const h = harness();
    enrol(h);
    await h.admin.settings(OWNER, OWNER, '');
    const panel = h.tg.messages.at(-1)!;
    expect(panel.markup!.inline_keyboard.flat().some((b) => b.text === 'Attempts: 2')).toBe(true);
    const tap = async (label: RegExp, from: { markup?: { inline_keyboard: { text: string }[][] } }, actor = OWNER) => {
      const b = from.markup!.inline_keyboard.flat().find((x) => label.test(x.text))!;
      return h.admin.onAction(actor, OWNER, (b as unknown as { callback_data: string }).callback_data.slice(2), 42);
    };
    await tap(/^Attempts/, panel);
    const options = h.tg.edits.at(-1)!;
    expect(options.messageId).toBe(42);
    expect(options.markup!.inline_keyboard.flat().map((b) => b.text)).toEqual(['1', '✅ 2', '3', '← Back']);
    expect(await tap(/^3$/, options, 7777)).toContain('no longer valid'); // someone else's tap does nothing
    expect(await tap(/^3$/, options)).toBe('Saved');
    expect(h.store.settingsOf(h.store.getGroup(GROUP)!).attempts).toBe(3);
    const back = h.tg.edits.at(-1)!;
    expect(back.markup!.inline_keyboard.flat().some((b) => b.text === 'Attempts: 3')).toBe(true);
    await tap(/^Mute & verify/, back);
    await tap(/^off$/, h.tg.edits.at(-1)!);
    expect(h.store.settingsOf(h.store.getGroup(GROUP)!).quarantine).toBe(false);
  });

  test('settings stay inside system bounds', async () => {
    const h = harness();
    enrol(h);
    for (const bad of ['attempts 99', 'attempts 0', 'burstThreshold 100000', 'auditRetentionDays 365', 'nonsense 1']) {
      await h.admin.settings(OWNER, OWNER, bad);
    }
    const s = h.store.settingsOf(h.store.getGroup(GROUP)!);
    expect([s.attempts, s.burstThreshold, s.auditRetentionDays]).toEqual([2, 20, 30]);
  });

});

describe('setup', () => {
  test('any group admin sets up and enables without anyone approving it', async () => {
    const h = harness();
    const G = -1003003;
    const mod = 2500; // an admin, not even the group creator
    h.tg.admins.set(G, [
      { userId: 2400, isCreator: true, isBot: false, canInvite: true, canRestrict: true },
      { userId: mod, isCreator: false, isBot: false, canInvite: true, canRestrict: true },
      { userId: BOT_ID, isCreator: false, isBot: true, canInvite: false, canRestrict: false },
    ]);
    h.store.upsertKnownChat(G, 'Test Agents', 'supergroup', 'administrator', h.clock.now());
    h.tg.chats.set(G, { type: 'supergroup', title: 'Test Agents' });
    await h.admin.setup(mod, mod);
    await press(h, mod, mod, /Test Agents/);
    expect(h.store.getGroup(G)).toBeUndefined(); // the bot has no usable right yet

    h.tg.admins.get(G)![2]!.canRestrict = true;
    h.clock.advance(61_000);
    await h.admin.setup(mod, mod);
    await press(h, mod, mod, /Test Agents/);
    const g = h.store.getGroup(G)!;
    expect([g.enabled, g.owner_user_id, g.invite_link]).toEqual([0, 2400, null]);
    await press(h, mod, mod, /Enable guard/);
    expect(h.store.getGroup(G)!.enabled).toBe(1);
    await h.admin.review(2400, 2400); // the creator can use it too, without ever running /setup
    expect(h.tg.lastText(2400)).toContain('Nobody is waiting');
  });

  test('a non-owner is not offered the group', async () => {
    const h = harness();
    enrol(h);
    h.store.upsertKnownChat(GROUP, 'G', 'supergroup', 'administrator', h.clock.now());
    await h.admin.setup(7777, 7777);
    expect(h.tg.messages.at(-1)!.markup).toBeUndefined();
  });

  test('the group name follows the Telegram title and /status shows no server details', async () => {
    const h = harness();
    enrol(h);
    await h.admin.syncTitle(GROUP, 'Renamed Agents'); // title-change service message
    expect(h.store.settingsOf(h.store.getGroup(GROUP)!).label).toBe('Renamed Agents');
    h.tg.chats.set(GROUP, { type: 'supergroup', title: 'Renamed Again' }); // change the bot did not see
    await h.admin.status(OWNER, OWNER);
    const text = h.tg.lastText(OWNER);
    expect(text).toContain('🛡 Renamed Again');
    expect(text).toContain('🟢 <b>Guard:</b> on');
    expect(text).not.toMatch(/^[ \t]/m); // no indentation
    for (const word of ['RSS', 'uptime', 'backup', 'Inbox', 'Intake', 'System']) expect(text).not.toContain(word);
  });

  test('/setup refreshes a missed rename before enrolment and keeps the checklist consistent', async () => {
    const h = harness();
    enrol(h);
    h.store.removeGroup(GROUP, OWNER, h.clock.now());
    h.store.upsertKnownChat(GROUP, 'test grp', 'supergroup', 'administrator', h.clock.now());
    h.tg.chats.set(GROUP, { type: 'supergroup', title: 'XM Gatekeeper UAT' });
    await h.admin.setup(OWNER, OWNER);
    expect(h.tg.messages.at(-1)!.markup!.inline_keyboard[0]![0]!.text).toBe('XM Gatekeeper UAT');
    expect(h.store.listKnownChats(25)[0]!.title).toBe('XM Gatekeeper UAT');
    expect(h.store.getGroup(GROUP)).toBeUndefined();
    await press(h, OWNER, OWNER, /^XM Gatekeeper UAT$/);
    expect(h.tg.lastText(OWNER)).toContain('Setup checklist for XM Gatekeeper UAT:');
  });

  test('a rename event refreshes known chats even before enrolment', async () => {
    const h = harness();
    h.store.upsertKnownChat(GROUP, 'test grp', 'supergroup', 'administrator', h.clock.now());
    await h.admin.syncTitle(GROUP, 'XM Gatekeeper UAT');
    expect(h.store.listKnownChats(25)[0]!.title).toBe('XM Gatekeeper UAT');
    expect(h.store.getGroup(GROUP)).toBeUndefined();
  });

  test('title sync repairs a stale picker when the enrolled label is already current', async () => {
    const h = harness();
    enrol(h, GROUP, OWNER, { label: 'XM Gatekeeper UAT' });
    h.store.upsertKnownChat(GROUP, 'test grp', 'supergroup', 'administrator', h.clock.now());
    await h.admin.syncTitle(GROUP, 'XM Gatekeeper UAT');
    expect(h.store.listKnownChats(25)[0]!.title).toBe('XM Gatekeeper UAT');
    expect(h.store.getGroup(GROUP)!.enabled).toBe(1);
  });

  test('/review shows a card per person with name, username and plain-words reason', async () => {
    const h = harness();
    enrol(h);
    h.tg.names.set(5001, { name: 'Ada <Lovelace>', username: 'ada' });
    await toReview(h, 5001);
    await toReview(h, 5002); // Telegram cannot resolve this one
    await h.admin.review(OWNER, OWNER);
    const cards = h.tg.messages.filter((m) => m.chatId === OWNER && m.markup);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.rich).toBe(true);
    expect(cards[0]!.text).toContain('<a href="tg://user?id=5001">Ada &lt;Lovelace&gt;</a>'); // escaped, links to the profile
    expect(cards[0]!.text).toContain('\n@ada\nUser ID: <code>5001</code>\n'); // name first, ID as a copyable tag
    expect(cards[0]!.text).toContain('❓ Asked for help');
    expect(cards[1]!.text).toContain('<a href="tg://user?id=5002">this user</a>');
    expect(cards[0]!.markup!.inline_keyboard.flat().map((b) => b.text)).toEqual(['✅ Approve', '🚫 Decline', '🔁 Let them try again']);
    for (const c of cards) expect(c.text).not.toMatch(/^[ \t]/m);
  });

  test('/audit lists events with clickable names, each with a copyable ID', async () => {
    const h = harness();
    enrol(h);
    h.tg.names.set(5001, { name: 'Ada Lovelace', username: 'ada' });
    h.tg.names.set(OWNER, { name: 'Grace <b>' });
    await toReview(h, 5001);
    h.store.queueDecision(h.store.liveRequestsForUser(5001)[0]!.id, GROUP, 'approve', OWNER, h.clock.now());
    await h.admin.audit(OWNER, OWNER);
    const text = h.tg.lastText(OWNER);
    expect(text).toMatch(/<code>\d\d-\d\d \d\d:\d\d<\/code> approved · <a href="tg:\/\/user\?id=5001">Ada Lovelace<\/a> · by <a href="tg:\/\/user\?id=1000">Grace &lt;b&gt;<\/a>\nUser ID: <code>5001<\/code> · Admin ID: <code>1000<\/code>/);
    expect(text).not.toMatch(/^[ \t]/m);
    // Nothing about names is written to the database.
    const dump = JSON.stringify(h.store.db.query('SELECT * FROM audit_events').all()) + JSON.stringify(h.store.db.query('SELECT * FROM join_requests').all());
    expect(dump).not.toContain('Ada');
  });

  test('time zone is a group setting and /audit shows times in it', async () => {
    const h = harness();
    enrol(h);
    h.clock.t = Date.UTC(2026, 10, 10, 23, 30); // 23:30 UTC
    await toReview(h, 5001);
    await h.admin.audit(OWNER, OWNER);
    expect(h.tg.lastText(OWNER)).toContain('🕒 UTC');
    expect(h.tg.lastText(OWNER)).toContain('<code>11-10 23:30</code>');
    await h.admin.settings(OWNER, OWNER, 'timezone Mars/Olympus');
    expect(h.tg.lastText(OWNER)).toContain('Not changed');
    await h.admin.settings(OWNER, OWNER, 'timezone Asia/Tokyo');
    expect(h.store.settingsOf(h.store.getGroup(GROUP)!).timezone).toBe('Asia/Tokyo');
    await h.admin.audit(OWNER, OWNER);
    expect(h.tg.lastText(OWNER)).toContain('🕒 Asia/Tokyo');
    expect(h.tg.lastText(OWNER)).toContain('<code>11-11 08:30</code>'); // next day in Tokyo
    // Also offered as buttons in the /settings panel.
    await h.admin.settings(OWNER, OWNER, '');
    expect(h.tg.messages.at(-1)!.markup!.inline_keyboard.flat().some((x) => x.text === 'Time zone: Asia/Tokyo')).toBe(true);
  });

  test('moderation and review replies name the person as a link', async () => {
    const h = harness();
    enrol(h);
    h.tg.names.set(5001, { name: 'Ada Lovelace' });
    await h.admin.moderateInGroup(OWNER, GROUP, 5001, { kind: 'mute', seconds: 3600, label: '1 h' });
    expect(h.tg.messages.at(-1)).toMatchObject({ chatId: GROUP, rich: true, text: '🔇 Muted <a href="tg://user?id=5001">Ada Lovelace</a> for 1 h. Lift it early with /unban.' });
    await h.admin.moderateInGroup(OWNER, GROUP, 5001, { kind: 'ban' });
    expect(h.tg.lastText(GROUP)).toBe('🚫 Banned <a href="tg://user?id=5001">Ada Lovelace</a>.');
    await toReview(h, 5002);
    await h.admin.review(OWNER, OWNER);
    await press(h, OWNER, OWNER, /Approve/);
    expect(h.tg.messages.some((m) => m.chatId === OWNER && m.text === '✅ Approved: <a href="tg://user?id=5002">this user</a>')).toBe(true);
  });

  test('/status is a card with shortcut buttons that act on that group', async () => {
    const h = harness();
    enrol(h);
    await toReview(h, 5001);
    await h.admin.status(OWNER, OWNER);
    const card = h.tg.messages.at(-1)!;
    expect(card.text).toContain('👀 Waiting for review: <b>1</b>');
    expect(card.rich).toBe(true);
    const labels = card.markup!.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(['👀 Review (1)', '⚙️ Settings', '🚨 Start raid mode', '📜 Audit log', '🔄 Refresh']);
    const tap = (label: RegExp, from: { markup?: { inline_keyboard: { text: string }[][] } }, actor = OWNER) => {
      const b = from.markup!.inline_keyboard.flat().find((x) => label.test(x.text))!;
      return h.admin.onAction(actor, OWNER, (b as unknown as { callback_data: string }).callback_data.slice(2), 77);
    };
    expect(await tap(/raid/, card, 7777)).toContain('no longer valid'); // not this admin's button
    expect(await tap(/Start raid/, card)).toBe('Raid mode started');
    expect(h.store.getGroup(GROUP)!.raid_mode).toBe(1);
    const redrawn = h.tg.edits.at(-1)!;
    expect(redrawn.messageId).toBe(77);
    expect(redrawn.text).toContain('🚨 <b>Raid mode:</b> ON');
    await tap(/Review/, redrawn);
    expect(h.tg.messages.some((m) => m.chatId === OWNER && /Approve/.test(JSON.stringify(m.markup ?? {})))).toBe(true);
    await tap(/End raid/, h.tg.edits.at(-1)!);
    expect(h.store.getGroup(GROUP)!.raid_mode).toBe(0);
  });

  test('only group admins get the admin command menu, once', async () => {
    const h = harness();
    enrol(h);
    expect(await h.admin.isAdmin(7777)).toBe(false);
    await h.admin.status(7777, 7777);
    expect(h.tg.adminMenus).toEqual([]);
    await h.admin.status(OWNER, OWNER);
    await h.admin.review(OWNER, OWNER);
    expect(h.tg.adminMenus).toEqual([OWNER]);
  });

  test('losing admin rights pauses the guard', async () => {
    const h = harness();
    enrol(h);
    await h.admin.onBotStatus(GROUP, 'G', 'supergroup', 'member', false);
    expect(h.store.getGroup(GROUP)!.enabled).toBe(0);
    expect(h.store.getGroup(GROUP)!.paused_reason).toBe('bot_rights_missing');
  });

  test('review alerts are coalesced', async () => {
    const h = harness();
    enrol(h);
    h.store.recordExplicitStart(OWNER, OWNER, h.clock.now());
    await toReview(h, 5001);
    await toReview(h, 5002);
    h.clock.advance(31_000);
    await h.v.tick();
    h.clock.advance(31_000);
    await toReview(h, 5003);
    await h.v.tick();
    expect(h.tg.messages.filter((m) => m.chatId === OWNER && m.text.includes('awaiting review'))).toHaveLength(1);
    h.clock.advance(5 * 60_000);
    await h.v.tick();
    expect(h.tg.messages.filter((m) => m.chatId === OWNER && m.text.includes('awaiting review'))).toHaveLength(2);
  });
});


describe('settings authorization after opening a panel', () => {
  test('a former manager cannot save a setting using a still-live button', async () => {
    const h = harness(); enrol(h);
    const manager = 3002;
    await addAdmin(h, manager);
    await h.admin.settings(manager, manager, '');
    await press(h, manager, manager, /^Attempts/);
    h.tg.admins.set(GROUP, h.tg.admins.get(GROUP)!.filter(a => a.userId !== manager));
    await press(h, manager, manager, /^3$/);
    expect(h.store.settingsOf(h.store.getGroup(GROUP)!).attempts).toBe(2);
    expect(h.tg.lastText(manager)).toContain('no longer have the required role');
  });

  test('role lookup failure prevents settings writes even with a valid token', async () => {
    const h = harness(); enrol(h);
    await h.admin.settings(OWNER, OWNER, '');
    await press(h, OWNER, OWNER, /^Attempts/);
    h.tg.failNext('getAdmins', new TgError('network', 'offline'));
    await press(h, OWNER, OWNER, /^3$/);
    expect(h.store.settingsOf(h.store.getGroup(GROUP)!).attempts).toBe(2);
    expect(h.tg.lastText(OWNER)).toContain('could not verify your current role');
  });

  test('expired settings tokens cannot apply changes', async () => {
    const h = harness(); enrol(h);
    await h.admin.settings(OWNER, OWNER, '');
    await press(h, OWNER, OWNER, /^Attempts/);
    h.clock.advance(60 * 60_000);
    expect(await press(h, OWNER, OWNER, /^3$/)).toBe('This button is no longer valid.');
    expect(h.store.settingsOf(h.store.getGroup(GROUP)!).attempts).toBe(2);
  });
});
