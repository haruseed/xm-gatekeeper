import type { Clock } from '@guard/core';
import type { GroupRow, Store } from '@guard/database';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { esc, userLink, type Button, type Tg } from '../telegram';
import type { Authority } from './authority';
import type { AdminPresentation } from './presentation';

const AUDIT_LABELS: Record<string, string> = {
  member_joined: 'joined',
  join_request: 'join request',
  challenge_passed: 'passed check',
  attempt_failed: 'wrong answer',
  request_approved: 'let in',
  request_declined: 'removed',
  request_manual_review: 'to review',
  request_expired: 'expired',
  request_superseded: 're-applied',
  request_external_resolution: 'left / other',
  review_approve: 'approved',
  review_decline: 'declined',
  retry_granted: 'retry given',
  user_banned: 'banned',
  user_muted: 'muted',
  user_unbanned: 'unmuted/unban',
  raid_on: 'raid on',
  raid_off: 'raid off',
  guard_enabled: 'guard on',
  guard_paused: 'guard off',
  settings_changed: 'setting',
  group_enrolled: 'set up',
  owner_changed: 'owner changed',
};
dayjs.extend(utc);
dayjs.extend(timezone);

/** "11-10 15:22" in the group's time zone. */
export function formatTime(ms: number, zone: string): string {
  return dayjs(ms).tz(zone).format('MM-DD HH:mm');
}

const REVIEW_REASONS: Record<string, string> = {
  attempts_exhausted: 'Failed the check twice',
  challenge_expired: 'Ran out of time',
  expired: 'Ran out of time',
  help_requested: 'Asked for help',
  raid_mode: 'Joined during raid mode',
  render_failed: 'The bot could not build the check',
  group_paused: 'The guard was paused mid-check',
  user_deleted_data: 'Deleted their data mid-check',
  bot_rights_missing: 'The bot lost its admin rights',
  approval_budget: 'Too many approvals at once',
};
function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}


/** Read-only reporting after Admin has established the caller's group scope. */
export class AdminReports {
  constructor(
    private readonly store: Pick<Store, 'listAudit' | 'settingsOf' | 'countByState' | 'reviewQueue'>,
    private readonly tg: Pick<Tg, 'memberName'>,
    private readonly authority: Pick<Authority, 'botRights'>,
    private readonly ui: AdminPresentation,
    private readonly clock: Clock,
  ) {}

  private say: AdminPresentation['say'] = (...args) => this.ui.say(...args);
  private button: AdminPresentation['button'] = (...args) => this.ui.button(...args);
  private label: AdminPresentation['label'] = group => this.ui.label(group);

  /** Names are looked up from Telegram at the moment of display and are never stored. */
  private async lookupUsers(groupId: number, ids: Iterable<number>): Promise<Map<number, { name: string; username?: string }>> {
    const out = new Map<number, { name: string; username?: string }>();
    for (const id of new Set(ids)) {
      const who = await this.tg.memberName(groupId, id).catch(() => undefined);
      if (who) out.set(id, who);
    }
    return out;
  }

  /** Recent events, newest first: time, what happened, and the people involved as clickable names. */
  async audit(userId: number, chatId: number, group: GroupRow): Promise<void> {
    const rows = this.store.listAudit(group.chat_id, 20);
    const head = `📜 <b>${esc(this.label(group))}</b>`;
    if (rows.length === 0) {
      await this.say(chatId, `${head}\nNo events yet.`, undefined, true);
      return;
    }
    const people = await this.lookupUsers(
      group.chat_id,
      rows.flatMap((r) => [r.actor_user_id, r.subject_user_id]).filter((x): x is number => x !== null),
    );
    const name = (id: number) => userLink(id, people.get(id));
    const zone = this.store.settingsOf(group).timezone;
    const stamp = (ms: number) => formatTime(ms, zone);
    const lines = rows.map((r) => {
      const event = esc(AUDIT_LABELS[r.action] ?? r.action.replace(/_/g, ' '));
      const subject = r.subject_user_id ?? r.actor_user_id;
      const by = r.subject_user_id !== null && r.actor_user_id !== null && r.actor_user_id !== r.subject_user_id;
      return `<code>${stamp(r.created_at)}</code> ${event}${subject !== null ? ` · ${name(subject)}` : ''}${by ? ` · by ${name(r.actor_user_id!)}` : ''}${subject !== null ? `\nUser ID: <code>${subject}</code>` : ''}${by ? ` · Admin ID: <code>${r.actor_user_id!}</code>` : ''}`;
    });
    await this.say(chatId, [`${head}: last ${rows.length} events`, `🕒 ${esc(zone)}`, '', ...lines].join('\n'), undefined, true);
  }

  /** One status card per group: indicators, request counts and shortcut buttons. */
  async statusCard(userId: number, group: GroupRow): Promise<{ text: string; rows: Button[][] }> {
    const gid = group.chat_id;
    const c = this.store.countByState(gid);
    const light = (ok: boolean) => (ok ? '🟢' : '🔴');
    let mute = '⚪ unknown';
    let requests = '⚪ unknown';
    try {
      const r = await this.authority.botRights(gid);
      mute = r.restrict ? '🟢 ready' : '🔴 missing “Ban users” right';
      requests = r.invite ? '🟢 ready' : '⚪ not enabled';
    } catch {
      // Telegram could not be reached; the card still shows what is stored.
    }
    const waiting = c.manual_review ?? 0;
    const paused = group.paused_reason ? ` (${esc(group.paused_reason.replace(/_/g, ' '))})` : '';
    // Telegram HTML: bold headings, no indentation.
    const text = [
      `<b>🛡 ${esc(this.label(group))}</b>`,
      '',
      `${light(group.enabled === 1)} <b>Guard:</b> ${group.enabled ? 'on' : `off${paused}`}`,
      group.raid_mode ? '🚨 <b>Raid mode:</b> ON: no automatic approvals' : '⚪ <b>Raid mode:</b> off',
      '',
      '<b>Bot rights</b>',
      `Mute new joiners: ${mute}`,
      `Join requests: ${requests}`,
      '',
      '<b>Members checked</b>',
      `⏳ In progress: <b>${(c.pending ?? 0) + (c.challenging ?? 0)}</b>`,
      `👀 Waiting for review: <b>${waiting}</b>`,
      `✅ Passed: <b>${c.approved ?? 0}</b>`,
      `🚫 Declined: <b>${c.declined ?? 0}</b>`,
      `↪️ Left or handled by others: <b>${c.external_resolution ?? 0}</b>`,
    ].join('\n');
    const go = (label: string, to: string) => this.button(userId, label, { op: 'st', chat: gid, to });
    const rows: Button[][] = [
      [go(`👀 Review${waiting ? ` (${waiting})` : ''}`, 'review'), go('⚙️ Settings', 'settings')],
      [go(group.raid_mode ? '✅ End raid mode' : '🚨 Start raid mode', 'raid'), go('📜 Audit log', 'audit')],
      [go('🔄 Refresh', 'refresh')],
    ];
    return { text, rows };
  }

  async review(userId: number, chatId: number, group: GroupRow): Promise<void> {
    const gid = group.chat_id;
    const queue = this.store.reviewQueue(gid, 10);
    const counts = this.store.countByState(gid);
    const name = `<b>${esc(this.label(group))}</b>`;
    if (queue.length === 0) {
      const busy = (counts.pending ?? 0) + (counts.challenging ?? 0);
      await this.say(chatId, `✅ ${name}\nNobody is waiting for review.${busy ? `\n⏳ Being checked right now: <b>${busy}</b>` : ''}`, undefined, true);
      return;
    }
    const total = counts.manual_review ?? queue.length;
    await this.say(
      chatId,
      `👀 ${name}\n<b>${total}</b> waiting for review${total > queue.length ? `: showing the oldest ${queue.length}` : ''}`,
      undefined,
      true,
    );
    const now = this.clock.now();
    const people = await this.lookupUsers(gid, queue.map((r) => r.user_id));
    for (const r of queue) {
      const u = people.get(r.user_id);
      const member = r.kind === 'member';
      const lines = [
        `👤 <b>${userLink(r.user_id, u)}</b>`,
        `${u?.username ? `@${esc(u.username)}\n` : ''}User ID: <code>${r.user_id}</code>`,
        '',
        `${member ? '🔇 Joined, muted' : '📨 Join request'} · ${ago(now - r.request_date)}`,
        `❓ ${esc(REVIEW_REASONS[r.reason_code ?? ''] ?? (r.reason_code ?? 'unknown').replace(/_/g, ' '))}`,
      ];
      await this.say(
        chatId,
        lines.join('\n'),
        [
          [
            this.button(userId, member ? '✅ Unmute' : '✅ Approve', { op: 'approve', chat: gid, req: r.id, user: r.user_id }),
            this.button(userId, member ? '🚫 Remove' : '🚫 Decline', { op: 'decline', chat: gid, req: r.id, user: r.user_id }),
          ],
          [this.button(userId, '🔁 Let them try again', { op: 'retry', chat: gid, req: r.id, user: r.user_id })],
        ],
        true,
      );
    }
  }

}
