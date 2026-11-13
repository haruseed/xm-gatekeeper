import { AdminReports } from './admin/reports';
export { formatTime } from './admin/reports';
import { ModerationService, type Moderation } from './admin/moderation';
export { parseDuration, type Moderation } from './admin/moderation';
import { Authority, roleOf } from './admin/authority';
export { Authority, roleOf } from './admin/authority';
import { GroupSettingsEditor } from './admin/group-settings';
import { ACTION_TTL_MS, CONFIRM_TTL_MS, type AdminPresentation } from './admin/presentation';
import type { UserTarget } from './targets';
import {
  DEFAULT_SETTINGS,
  log,
  roleAtLeast,
  type Clock,
  type Role,
} from '@guard/core';
import type { GroupRow, Store } from '@guard/database';
import { classify, userLink, type AdminInfo, type Button, type Tg } from './telegram';
import type { Verification } from './verification';

export class Admin {
  constructor(
    private readonly store: Store,
    private readonly tg: Tg,
    private readonly authority: Authority,
    private readonly verification: Verification,
    private readonly clock: Clock,
    private readonly health: () => { lastPollAt: number; startedAt: number; mode?: 'webhook' | 'polling' },
  ) {
    const presentation: AdminPresentation = {
      say: (chatId, text, rows, rich) => this.say(chatId, text, rows, rich),
      button: (actor, text, payload, ttl) => this.button(actor, text, payload, ttl),
      label: group => this.label(group),
    };
    this.reports = new AdminReports(store, tg, authority, presentation, clock);
    this.groupSettings = new GroupSettingsEditor(store, tg, clock, presentation);
    this.moderation = new ModerationService(store, tg, authority, verification, clock,
      (userId, chatId, min) => this.scope(userId, chatId, min), presentation);
  }

  private readonly groupSettings: GroupSettingsEditor;
  private readonly moderation: ModerationService;
  private readonly reports: AdminReports;

  private readonly menuShown = new Set<number>();

  private say(chatId: number, text: string, rows?: Button[][], rich = false): Promise<boolean> {
    return this.verification.say(chatId, text, rows ? { inline_keyboard: rows } : undefined, rich);
  }
  private button(actor: number, text: string, payload: Record<string, string | number>, ttl = ACTION_TTL_MS): Button {
    return { text, callback_data: `a:${this.store.createActionToken(actor, payload, this.clock.now() + ttl)}` };
  }
  private label(g: GroupRow): string {
    return this.store.settingsOf(g).label || String(g.chat_id);
  }

  /** Groups where the user currently holds authority (verified against Telegram, short cache). */
  private async groupsFor(userId: number): Promise<{ group: GroupRow; role: Role }[]> {
    const out: { group: GroupRow; role: Role }[] = [];
    for (const group of this.store.candidateGroupsFor(userId)) {
      try {
        const role = await this.authority.role(group.chat_id, userId, false);
        if (role) out.push({ group, role });
      } catch (e) {
        log('warn', 'role_lookup_failed', { kind: classify(e).kind });
      }
    }
    // Admins get the admin command menu in their own chat with the bot; nobody else sees it.
    if (out.length > 0 && !this.menuShown.has(userId)) {
      this.menuShown.add(userId);
      await this.tg.setAdminMenu(userId).catch(() => this.menuShown.delete(userId));
    }
    return out;
  }

  /**
   * Picks the group an admin command applies to and re-checks authority with fresh Telegram
   * data. Replies and returns undefined when the actor lacks the role or must choose a group.
   */
  private async scope(userId: number, chatId: number, min: Role): Promise<{ group: GroupRow; role: Role } | undefined> {
    const groups = await this.groupsFor(userId);
    if (groups.length === 0) {
      await this.say(chatId, 'I do not know of a group you administer. Send /setup to set one up or to refresh your groups.');
      return undefined;
    }
    const ctx = this.store.getPrefs(userId)?.admin_chat_id;
    const picked = groups.length === 1 ? groups[0] : groups.find((g) => g.group.chat_id === ctx);
    if (!picked) {
      await this.say(
        chatId,
        'Which group? Choose one, then send the command again.',
        groups.slice(0, 10).map((g) => [this.button(userId, this.label(g.group), { op: 'ctx', chat: g.group.chat_id })]),
      );
      return undefined;
    }
    let role: Role | null;
    try {
      role = await this.authority.role(picked.group.chat_id, userId, true);
    } catch {
      await this.say(chatId, 'I could not verify your current role with Telegram, so nothing was changed. Try again shortly.');
      return undefined;
    }
    if (!roleAtLeast(role, min)) {
      await this.say(chatId, `This needs the ${min} role (or higher) in ${this.label(picked.group)}.`);
      return undefined;
    }
    return { group: this.store.getGroup(picked.group.chat_id)!, role: role! };
  }

  /** Shown under /help only to people who administer an enrolled group (or run the bot). */
  helpText(): string {
    const lines = [
      'For group administrators',
      'Only administrators of a group (with the "Ban users" or "Invite users" right) can use these, and only for their own group. Send them here in private chat.',
      '',
      '/setup — set up the guard for your group and switch it on',
      '/settings — change the rules (tap buttons)',
      '/review — people waiting for a decision: approve, decline or let them try again',
      '/raid on|off — stop automatic approvals during a spam wave',
      '/ban <@username|user_id> — ban someone (in the group: reply to their message with /ban)',
      '/mute <@username|user_id> 2h — stop someone sending messages for a while (in the group: reply with /mute 2h)',
      '/unban <@username|user_id> — lift a mute or a ban (in the group: reply with /unban)',
      '/audit — recent admin actions',
      '/status — your groups at a glance',
      '/group — switch group, if you administer several',
    ];
    return lines.join('\n');
  }
  /** True for a current administrator of at least one guarded group (also gives them the admin menu). */
  async isAdmin(userId: number): Promise<boolean> {
    return (await this.groupsFor(userId)).length > 0;
  }

  // ---------- /setup ----------
  async setupFromGroup(chatId: number, title: string, type: string): Promise<void> {
    this.store.upsertKnownChat(chatId, title, type, 'administrator', this.clock.now());
    await this.say(chatId, `Setup continues in a private chat: https://t.me/${this.tg.username} — the group owner should send /setup there.`);
  }

  async setup(userId: number, chatId: number): Promise<void> {
    const rows: Button[][] = [];
    for (const chat of this.store.listKnownChats(25)) {
      try {
        const admins = await this.authority.admins(chat.chat_id, false);
        if (roleOf(admins, userId) !== null) {
          const current = await this.tg.getChat(chat.chat_id);
          await this.syncTitle(chat.chat_id, current.title);
          const enrolled = this.store.getGroup(chat.chat_id);
          rows.push([this.button(userId, `${current.title}${enrolled?.enabled ? ' ✅' : ''}`, { op: 'setup', chat: chat.chat_id })]);
        }
      } catch {
        // The bot may have lost access to this chat; it is simply not offered.
      }
    }
    if (rows.length === 0) {
      await this.say(
        chatId,
        [
          'To enrol a group:',
          '1. The group must be a supergroup and you must be one of its administrators.',
          '2. Add me to the group as an administrator with the "Ban users" right (to mute newcomers until they verify). Add "Invite users via link" too if you want me to handle join requests.',
          '3. Send /setup here again and pick the group.',
        ].join('\n'),
      );
      return;
    }
    await this.say(chatId, 'Choose the group to set up:', rows);
  }

  private async setupGroup(userId: number, chatId: number, groupId: number): Promise<void> {
    const now = this.clock.now();
    let chat: { type: string; title: string };
    let admins: AdminInfo[];
    try {
      chat = await this.tg.getChat(groupId);
      admins = await this.authority.admins(groupId, true);
    } catch {
      await this.say(chatId, 'I could not read that group from Telegram. Check that I am still an administrator there.');
      return;
    }
    const isOwner = roleOf(admins, userId) !== null;
    const me = admins.find((a) => a.userId === this.tg.botId);
    const botCanInvite = me?.canInvite === true;
    const botCanRestrict = me?.canRestrict === true;
    const checks = [
      `${chat.type === 'supergroup' ? '✅' : '❌'} Supergroup${chat.type === 'supergroup' ? '' : ' — convert the group to a supergroup first'}`,
      `${isOwner ? '✅' : '❌'} You are an administrator of the group (with "Ban users" or "Invite users")`,
      `${botCanRestrict ? '✅' : botCanInvite ? '➖' : '❌'} I have the "Ban users" admin right (mute newcomers until verified)`,
      `${botCanInvite ? '✅' : botCanRestrict ? '➖' : '❌'} I have the "Invite users via link" admin right (handle join requests)`,
    ];
    if (chat.type !== 'supergroup' || !isOwner || (!botCanInvite && !botCanRestrict)) {
      await this.say(chatId, [`Setup checklist for ${chat.title}:`, ...checks, '', 'Fix the ❌ items, then run /setup again.'].join('\n'));
      return;
    }
    let group = this.store.enrolGroup(groupId, admins.find((a) => a.isCreator)?.userId ?? userId, { ...DEFAULT_SETTINGS, label: chat.title.slice(0, 64) || String(groupId) }, now);
    if (!group.invite_link && botCanInvite) {
      try {
        this.store.setInviteLink(groupId, await this.tg.createJoinLink(groupId), now);
      } catch {
        await this.say(chatId, 'I could not create the join-request invitation link. Check my admin rights and run /setup again.');
        return;
      }
      group = this.store.getGroup(groupId)!;
    }
    this.store.setAdminContext(userId, groupId, now);
    group = (await this.syncTitle(groupId, chat.title)) ?? group;
    const lines = [
      `Setup checklist for ${chat.title}:`,
      ...checks,
      '',
      'How it works once enabled:',
      botCanRestrict
        ? this.store.requireCap ? '• New members are muted, complete Cap in a private Mini App, then answer one easy three-choice picture in the group to be unmuted.' : '• Anyone who joins the group by any link is muted at once and gets a picture check right in the group. Two correct taps and they are unmuted. They never need to open a chat with me.'
        : '• ➖ Without the "Ban users" right I cannot mute people who join directly; only join requests are verified.',
      botCanInvite
        ? '• Join requests (groups or links with "Approve new members") are verified before the person gets in.'
        : '• ➖ Without "Invite users via link" I cannot approve join requests.',
      ...(group.invite_link ? [`• Optional stricter entry, a link that always creates a join request: ${group.invite_link}`] : []),
      '• People added by an administrator are not challenged.',
      '• Failures and timeouts stay muted and go to /review. A passed challenge is friction, not proof of a human.',
      '',
      group.enabled ? 'The guard is currently ENABLED.' : 'The guard is currently OFF. Test with a second account after enabling.',
    ];
    await this.say(chatId, lines.join('\n'), [
      [group.enabled ? this.button(userId, 'Pause guard', { op: 'pause', chat: groupId }) : this.button(userId, 'Enable guard', { op: 'enable', chat: groupId })],
    ]);
  }

  // ---------- action buttons ----------
  async onAction(userId: number, chatId: number, token: string, messageId?: number): Promise<string | undefined> {
    const now = this.clock.now();
    const p = this.store.consumeActionToken(token, userId, now);
    if (!p) return 'This button is no longer valid.';
    const groupId = typeof p.chat === 'number' ? p.chat : 0;
    const need = async (min: Role): Promise<boolean> => {
      // A button label is not authorisation: authority is re-checked when pressed.
      try {
        if (roleAtLeast(await this.authority.role(groupId, userId, true), min)) return true;
      } catch {
        await this.say(chatId, 'I could not verify your current role with Telegram, so nothing was changed.');
        return false;
      }
      await this.say(chatId, 'You no longer have the required role for this action.');
      return false;
    };
    switch (p.op) {
      case 'ctx': {
        this.store.setAdminContext(userId, groupId, now);
        const g = this.store.getGroup(groupId);
        await this.say(chatId, `Commands now apply to ${g ? this.label(g) : groupId}.`);
        return;
      }
      case 'setup':
        await this.setupGroup(userId, chatId, groupId);
        return;
      case 'enable': {
        if (!(await need('manager'))) return;
        let ok = false;
        try {
          const rights = await this.authority.botRights(groupId);
          ok = rights.invite || rights.restrict;
        } catch {
          ok = false;
        }
        if (!ok) {
          await this.say(chatId, 'I need the "Ban users" or "Invite users via link" admin right, so the guard stays off.');
          return;
        }
        this.store.setEnabled(groupId, true, userId, 'owner_enabled', now);
        await this.say(chatId, '✅ Guard enabled. New members are now verified automatically. Use /review for the manual queue and /raid in an emergency.');
        return;
      }
      case 'st': {
        if (!(await need('manager'))) return;
        // Shortcuts act on this card's group, whichever group other commands currently apply to.
        this.store.setAdminContext(userId, groupId, now);
        let toast: string | undefined;
        if (p.to === 'review') await this.review(userId, chatId);
        else if (p.to === 'settings') await this.settings(userId, chatId, '');
        else if (p.to === 'audit') await this.audit(userId, chatId);
        else if (p.to === 'raid') {
          const g = this.store.getGroup(groupId);
          if (g) this.store.setRaid(groupId, g.raid_mode === 0, userId, 'status_button', now);
          toast = g?.raid_mode === 0 ? 'Raid mode started' : 'Raid mode ended';
        } else toast = 'Updated';
        // Buttons are one-use, so the card is redrawn in place with fresh ones.
        const group = await this.syncTitle(groupId);
        if (group) {
          const card = await this.reports.statusCard(userId, group);
          const edited =
            messageId !== undefined &&
            (await this.tg.editMessage(chatId, messageId, card.text, { inline_keyboard: card.rows }, true).then(() => true, () => false));
          if (!edited && p.to !== 'refresh') await this.say(chatId, card.text, card.rows, true);
        }
        return toast;
      }
      case 'setm':
      case 'set':
      case 'setv': {
        if (!(await need('manager'))) return;
        const group = this.store.getGroup(groupId);
        if (!group) return 'This button is no longer valid.';
        return this.groupSettings.onAction(userId, chatId, p, group, now, messageId);
      }
      case 'pause':
        if (!(await need('manager'))) return;
        await this.say(chatId, 'Pause the guard? New join requests will be ignored and stay in Telegram\'s pending list.', [
          [this.button(userId, 'Yes, pause', { op: 'pause2', chat: groupId }, CONFIRM_TTL_MS)],
        ]);
        return;
      case 'pause2':
        if (!(await need('manager'))) return;
        this.store.setEnabled(groupId, false, userId, 'admin_paused', now);
        await this.say(chatId, 'Guard paused. Run /setup to enable it again.');
        return;
      case 'remove2':
        if (!(await need('owner'))) return;
        this.store.removeGroup(groupId, userId, now);
        await this.say(chatId, 'Group removed from the bot with its requests, grants and settings. Pending requests remain in Telegram\'s own list.');
        return;
      case 'approve':
      case 'decline2': {
        if (!(await need('reviewer'))) return;
        const decision = p.op === 'approve' ? 'approve' : 'decline';
        const ok = this.store.queueDecision(String(p.req), groupId, decision, userId, now);
        await this.verification.sweepGroupMessages();
        const who = await this.link(groupId, Number(p.user));
        if (ok) await this.say(chatId, `${decision === 'approve' ? '✅ Approved' : '🚫 Declined'}: ${who}`, undefined, true);
        else await this.say(chatId, 'That request is no longer waiting for review.');
        if (ok) await this.verification.drainOutbox();
        return;
      }
      case 'retry': {
        if (!(await need('reviewer'))) return;
        const before = this.store.grantRetry(String(p.req), groupId, userId, now);
        if (!before) {
          await this.say(chatId, 'That request is no longer waiting for review.');
          return;
        }
        if (before.prompt_message_id !== null) await this.tg.deleteMessage(groupId, before.prompt_message_id).catch(() => undefined);
        const told = await this.verification.offerRetry(before);
        await this.verification.drainOutbox();
        const who = await this.link(groupId, before.user_id);
        await this.say(
          chatId,
          told
            ? `🔁 ${who} can try again; I told them in private chat.`
            : before.kind === 'member'
              ? `🔁 ${who} can try again; a new picture check was posted in the group.`
              : `🔁 ${who} can try again, but I cannot message them. Ask them to open https://t.me/${this.tg.username}?start=verify`,
          undefined,
          true,
        );
        return;
      }
      case 'decline':
        if (!(await need('reviewer'))) return;
        await this.say(
          chatId,
          `Decline ${await this.link(groupId, Number(p.user))}? They are removed or turned away and would have to join again.`,
          [[this.button(userId, 'Yes, decline', { op: 'decline2', chat: groupId, req: p.req ?? '', user: p.user ?? 0 }, CONFIRM_TTL_MS)]],
          true,
        );
        return;
      default:
        return 'This button is no longer valid.';
    }
  }

  // ---------- commands ----------
  async review(userId: number, chatId: number): Promise<void> {
    const scope = await this.scope(userId, chatId, 'reviewer');
    if (scope) await this.reports.review(userId, chatId, scope.group);
  }

  async raid(userId: number, chatId: number, arg: string): Promise<void> {
    const s = await this.scope(userId, chatId, 'manager');
    if (!s) return;
    const now = this.clock.now();
    if (arg === 'on' || arg === 'off') {
      this.store.setRaid(s.group.chat_id, arg === 'on', userId, 'admin_command', now);
      await this.say(
        chatId,
        arg === 'on'
          ? `Raid mode ON for ${this.label(s.group)}: no automatic approvals; new requests go straight to /review.`
          : `Raid mode OFF for ${this.label(s.group)}. Requests already in review stay there.`,
      );
      return;
    }
    await this.say(chatId, `${this.label(s.group)}: raid mode is ${s.group.raid_mode ? 'ON' : 'OFF'}. Use /raid on or /raid off. It never switches off by itself.`);
  }

  async settings(userId: number, chatId: number, args: string): Promise<void> {
    const scope = await this.scope(userId, chatId, 'manager');
    if (!scope) return;
    if (!args.trim()) scope.group = (await this.syncTitle(scope.group.chat_id)) ?? scope.group;
    await this.groupSettings.settings(userId, chatId, scope, args);
  }

  moderateInGroup(actorId: number, groupId: number, target: UserTarget | undefined, action: Moderation): Promise<void> {
    return this.moderation.moderateInGroup(actorId, groupId, target, action);
  }
  moderate(userId: number, chatId: number, target: string, action: Moderation): Promise<void> {
    return this.moderation.moderate(userId, chatId, target, action);
  }
  banInGroup(actorId: number, groupId: number, targetId: number | undefined): Promise<void> {
    return this.moderation.banInGroup(actorId, groupId, targetId);
  }
  ban(userId: number, chatId: number, arg: string): Promise<void> {
    return this.moderation.ban(userId, chatId, arg);
  }

  /** A person as a clickable name; names are read from Telegram when shown and never stored. */
  private async link(groupId: number, userId: number): Promise<string> {
    return userLink(userId, await this.tg.memberName(groupId, userId).catch(() => undefined));
  }

  async audit(userId: number, chatId: number): Promise<void> {
    const scope = await this.scope(userId, chatId, 'manager');
    if (scope) await this.reports.audit(userId, chatId, scope.group);
  }

  async status(userId: number, chatId: number): Promise<void> {
    const groups = await this.groupsFor(userId);
    let shown = 0;
    for (const entry of groups.slice(0, 5)) {
      const group = await this.syncTitle(entry.group.chat_id);
      if (!group) continue;
      const card = await this.reports.statusCard(userId, group);
      await this.say(chatId, card.text, card.rows, true);
      shown++;
    }
    if (shown === 0) await this.say(chatId, 'I do not know of a group you administer. Send /setup to set one up.');
  }

  async pickGroup(userId: number, chatId: number): Promise<void> {
    const groups = await this.groupsFor(userId);
    if (groups.length === 0) {
      await this.say(chatId, 'You do not administer any enrolled group.');
      return;
    }
    await this.say(
      chatId,
      'Choose the group that admin commands apply to:',
      groups.slice(0, 10).map((g) => [this.button(userId, `${this.label(g.group)} (${g.role})`, { op: 'ctx', chat: g.group.chat_id })]),
    );
  }

  /**
   * The display name always follows the group's Telegram title. Pass the title when an update
   * carried it; otherwise it is read from Telegram. Returns the current group row.
   */
  async syncTitle(chatId: number, title?: string): Promise<GroupRow | undefined> {
    const group = this.store.getGroup(chatId);
    const current = title ?? (await this.tg.getChat(chatId).then((c) => c.title, () => undefined));
    if (!current) return group;
    this.store.setKnownChatTitle(chatId, current, this.clock.now());
    if (!group || current.slice(0, 64) === this.store.settingsOf(group).label) return group;
    this.store.setLabel(chatId, current, this.clock.now());
    return this.store.getGroup(chatId);
  }

  /** Admin list changed in Telegram: refresh the mirror so new admins can use the bot at once. */
  async refreshAdmins(chatId: number): Promise<void> {
    if (this.store.getGroup(chatId)) await this.authority.admins(chatId, true).catch(() => undefined);
  }

  /** Bot removed or demoted, or the chat migrated: pause safely and tell the owner. */
  async onBotStatus(chatId: number, title: string, type: string, status: string, usable: boolean): Promise<void> {
    const now = this.clock.now();
    if (status === 'left' || status === 'kicked') this.store.removeKnownChat(chatId);
    else this.store.upsertKnownChat(chatId, title, type, status, now);
    const g = this.store.getGroup(chatId);
    if (g?.enabled && (status !== 'administrator' || !usable)) {
      this.store.setEnabled(chatId, false, null, 'bot_rights_missing', now);
      await this.verification.notifyAdmins(chatId, `⚠️ ${this.label(g)}: my admin rights changed, so the guard is paused. Restore my "Ban users" right and run /setup.`);
    }
  }
  async onMigration(chatId: number): Promise<void> {
    const g = this.store.getGroup(chatId);
    if (!g) return;
    this.store.setEnabled(chatId, false, null, 'chat_migrated', this.clock.now());
    await this.verification.notifyAdmins(chatId, `⚠️ ${this.label(g)}: the chat ID changed (group migration). The guard is paused; the owner must run /setup for the new supergroup.`);
  }
}
