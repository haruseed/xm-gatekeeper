import type { Clock, Role } from '@guard/core';
import type { GroupRow, Store } from '@guard/database';
import { resolveTarget, type UserTarget } from '../targets';
import { classify, userLink, type AdminInfo, type Tg } from '../telegram';
import type { Verification } from '../verification';
import type { Authority } from './authority';
import type { AdminPresentation } from './presentation';

export type Moderation = { kind: 'ban' } | { kind: 'unban' } | { kind: 'mute'; seconds: number; label: string };
const MOD_USAGE: Record<Moderation['kind'], string> = {
  ban: 'Reply to a message from the user with /ban, or send /ban <@username|user_id>.',
  mute: 'Reply to a message from the user with /mute 2h, or send /mute <@username|user_id> 2h. Durations: 10m, 2h, 3d (default 1h).',
  unban: 'Reply to a message from the user with /unban, or send /unban <@username|user_id>. It lifts a mute and a ban.',
};
/** "30m", "2h", "3d" → seconds, from one minute to 366 days. Undefined when not a duration. */
export function parseDuration(text: string): { seconds: number; label: string } | undefined {
  const m = /^(\d{1,4})\s*(m|h|d)$/i.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const seconds = n * (unit === 'm' ? 60 : unit === 'h' ? 3600 : 86_400);
  if (seconds < 60 || seconds > 366 * 86_400) return undefined;
  return { seconds, label: `${n} ${unit === 'm' ? 'min' : unit === 'h' ? 'h' : 'd'}` };
}

type ModerationStore = Pick<Store, 'getGroup' | 'userIdForUsername' | 'rememberUsername' | 'liveRequest' | 'recordBan' | 'audit' | 'queueDecision'>;
type ScopeResolver = (userId: number, chatId: number, min: Role) => Promise<{ group: GroupRow; role: Role } | undefined>;

/** Group/private moderation shares one execution policy and fresh Telegram authority checks. */
export class ModerationService {
  constructor(
    private readonly store: ModerationStore,
    private readonly tg: Pick<Tg, 'memberName' | 'ban' | 'mute' | 'unban' | 'unrestrict' | 'deleteMessage'>,
    private readonly authority: Pick<Authority, 'admins'>,
    private readonly verification: Pick<Verification, 'sweepGroupMessages' | 'drainOutbox'>,
    private readonly clock: Clock,
    private readonly scope: ScopeResolver,
    private readonly ui: AdminPresentation,
  ) {}

  private say: AdminPresentation['say'] = (...args) => this.ui.say(...args);
  private label: AdminPresentation['label'] = group => this.ui.label(group);
  private async link(groupId: number, userId: number): Promise<string> {
    return userLink(userId, await this.tg.memberName(groupId, userId).catch(() => undefined));
  }

  // ---------- moderation: /ban, /mute, /unban ----------
  /**
   * Inside a group these are open to every current Telegram administrator of THAT group who
   * holds the "Ban users" right, checked fresh against Telegram. Everyone else is ignored silently.
   */
  async moderateInGroup(actorId: number, groupId: number, target: UserTarget | undefined, action: Moderation): Promise<void> {
    if (!this.store.getGroup(groupId)) return;
    let admins: AdminInfo[];
    try {
      admins = await this.authority.admins(groupId, true);
    } catch {
      return; // cannot verify the caller: do nothing
    }
    if (!admins.some((a) => a.userId === actorId && a.canRestrict && !a.isBot)) return;
    const targetId = await resolveTarget(this.store, this.tg, groupId, target, this.clock.now());
    if (targetId === undefined) {
      await this.say(groupId, `${MOD_USAGE[action.kind]}\nUnknown or ambiguous username? Reply to their message instead.`);
      return;
    }
    await this.applyModeration(groupId, groupId, actorId, targetId, admins, action);
  }
  /** The same commands in private chat, by user ID, for the selected group. */
  async moderate(userId: number, chatId: number, target: string, action: Moderation): Promise<void> {
    const s = await this.scope(userId, chatId, 'reviewer');
    if (!s) return;
    if (!/^\d{1,15}$/.test(target) && !/^@[a-zA-Z0-9_]{1,32}$/.test(target)) {
      await this.say(chatId, `${MOD_USAGE[action.kind]}\nHere in private chat, give @username or the user ID: it applies to ${this.label(s.group)}.`);
      return;
    }
    const admins = await this.authority.admins(s.group.chat_id, true).catch(() => undefined);
    if (!admins) {
      await this.say(chatId, 'I could not check the group with Telegram, so nothing was changed.');
      return;
    }
    const targetId = await resolveTarget(this.store, this.tg, s.group.chat_id, target, this.clock.now());
    if (targetId === undefined) { await this.say(chatId, 'I cannot verify that username. Reply to their message in the group, or use their user ID. Nothing was changed.'); return; }
    await this.applyModeration(chatId, s.group.chat_id, userId, targetId, admins, action);
  }
  banInGroup(actorId: number, groupId: number, targetId: number | undefined): Promise<void> {
    return this.moderateInGroup(actorId, groupId, targetId, { kind: 'ban' });
  }
  ban(userId: number, chatId: number, arg: string): Promise<void> {
    return this.moderate(userId, chatId, arg, { kind: 'ban' });
  }

  private async applyModeration(
    replyChat: number,
    groupId: number,
    actorId: number,
    targetId: number,
    admins: AdminInfo[],
    action: Moderation,
  ): Promise<void> {
    const now = this.clock.now();
    if (admins.some((a) => a.userId === targetId)) {
      await this.say(replyChat, 'Administrators cannot be moderated with this command.');
      return;
    }
    const checking = this.store.liveRequest(groupId, targetId);
    const who = await this.link(groupId, targetId); // looked up before a ban makes them harder to resolve
    try {
      if (action.kind === 'ban') {
        await this.tg.ban(groupId, targetId);
        const closed = this.store.recordBan(groupId, targetId, actorId, now);
        await this.verification.sweepGroupMessages();
        if (closed?.prompt_message_id != null) await this.tg.deleteMessage(groupId, closed.prompt_message_id).catch(() => undefined);
        await this.say(replyChat, `🚫 Banned ${who}.`, undefined, true);
      } else if (action.kind === 'mute') {
        if (checking?.kind === 'member') {
          // A timed mute would expire into full access and skip the check.
          await this.say(replyChat, 'That member is already muted until they pass the check. Use /review to decide, or /ban.');
          return;
        }
        await this.tg.mute(groupId, targetId, Math.floor(now / 1000) + action.seconds);
        this.store.audit(groupId, actorId, targetId, 'user_muted', action.label, now);
        await this.say(replyChat, `🔇 Muted ${who} for ${action.label}. Lift it early with /unban.`, undefined, true);
      } else {
        if (checking?.kind === 'member') {
          // Lifting the mute of someone under check is an approval: record it as one.
          this.store.queueDecision(checking.id, groupId, 'approve', actorId, now);
          await this.verification.sweepGroupMessages();
          await this.verification.drainOutbox();
        } else {
          await this.tg.unban(groupId, targetId); // lift a ban first, so they can come back
          await this.tg.unrestrict(groupId, targetId).catch(() => undefined); // then any mute; fails harmlessly if they are not in the group
        }
        this.store.audit(groupId, actorId, targetId, 'user_unbanned', 'admin_command', now);
        await this.say(replyChat, `✅ ${who} is no longer muted or banned.`, undefined, true);
      }
    } catch (e) {
      const kind = classify(e).kind;
      await this.say(replyChat, kind === 'forbidden' ? 'I need the "Ban users" admin right to do that.' : 'Telegram refused; nothing was changed.');
    }
  }

}
