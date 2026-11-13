import { isDatabaseError } from '@guard/database';
import { MessageCleanup } from './message-cleanup';
import { OutboxDispatcher, DeferredWork as Defer } from './outbox-dispatcher';
import { ChallengeDelivery } from './challenge-delivery';
import {
  POLICY,
  TOKEN_PATTERN,
  log,
  type Clock,
  type Config,
  type Locale,
  type Rng,
} from '@guard/core';
import type { AssetStore } from '@guard/assets';
import type { AnswerResult, OutboxRow, RequestRow, Store } from '@guard/database';
import { t, type Key } from '@guard/i18n';
import { type BoardProvider } from './board-provider';
import { TgError, classify, type Button, type Markup, type Tg } from './telegram';

export interface Deps {
  store: Store;
  tg: Tg;
  assets: AssetStore;
  boards: BoardProvider;
  config: Pick<Config, 'maxActiveSessions' | 'maxOutboxPending' | 'boardTempDir' | 'cap'>;
  clock: Clock;
  rng: Rng;
}

export class Verification {
  private readonly cleanup: MessageCleanup;
  private readonly delivery: ChallengeDelivery;
  private readonly outbox: OutboxDispatcher;
  private lastAlertCheck = 0;
  private lastPurge = 0;

  constructor(private readonly d: Deps) {
    this.cleanup = new MessageCleanup(d.store, d.tg, d.clock);
    this.delivery = new ChallengeDelivery({ ...d, presentation: {
      groupLabel: chatId => this.groupLabel(chatId),
      dropPrompt: request => this.dropPrompt(request),
      groupNotice: (request, key, retry) => this.groupNotice(request, key, retry),
      say: (chatId, text) => this.say(chatId, text),
    } });
    this.outbox = new OutboxDispatcher({
      store: d.store, clock: d.clock, rng: d.rng,
      execute: row => this.execute(row),
      onFailed: (row, error) => this.onOutboxFailed(row, error),
    });
  }

  // ---------- helpers ----------
  groupLabel(chatId: number): string {
    const g = this.d.store.getGroup(chatId);
    if (!g) return String(chatId);
    return this.d.store.settingsOf(g).label || String(chatId);
  }
  localeFor(userId: number, chatId?: number): Locale {
    const prefs = this.d.store.getPrefs(userId);
    if (prefs?.locale) return prefs.locale;
    const g = chatId === undefined ? undefined : this.d.store.getGroup(chatId);
    return g ? this.d.store.settingsOf(g).helpLocale : 'en';
  }
  /** Best-effort notice: failures are logged, never thrown, and never change admission state. */
  async say(chatId: number, text: string, markup?: Markup, rich = false): Promise<boolean> {
    try {
      await this.d.tg.sendMessage(chatId, text, markup, rich);
      return true;
    } catch (e) {
      log('warn', 'notice_failed', { kind: classify(e).kind });
      return false;
    }
  }
  private startUrl(payload: string): string {
    return `https://t.me/${this.d.tg.username}?start=${payload}`;
  }
  private dest(r: RequestRow): number {
    return this.d.store.getPrefs(r.user_id)?.explicit_dm_chat_id ?? r.contact_chat_id;
  }

  private needsCap(r: RequestRow): boolean {
    return this.d.store.requireCap && !this.d.store.capPassed(r.id);
  }
  private async promptCap(r: RequestRow, privateChat?: number): Promise<void> {
    const cfg = this.d.config.cap;
    if (!cfg || !this.d.store.capEligible(r.id, r.user_id, this.d.clock.now())) return;
    const locale = this.localeFor(r.user_id, r.chat_id);
    const text = t(locale, 'cap.prompt');
    if (privateChat !== undefined) {
      const messageId = await this.d.tg.sendMessage(privateChat, text, { inline_keyboard: [[{text: t(locale, 'cap.verify'), web_app: {url: cfg.publicUrl + '?request=' + encodeURIComponent(r.id)}}],
        [{text: t(locale, 'btn.help'), callback_data: `h:${r.id}`}]] });
      this.d.store.trackCapMessage(r.id, privateChat, messageId);
    } else {
      if (this.d.store.getRequest(r.id)?.prompt_message_id != null) return;
      const id = await this.d.tg.sendGroupPrompt(r.chat_id, r.user_id, text, {inline_keyboard: [
        [{text: t(locale, 'cap.start'), url: cfg.groupLaunch ? `https://t.me/${this.d.tg.username}?startapp=cap_${r.id}&mode=compact` : this.startUrl('cap_' + r.id)}], [{text: t(locale, 'btn.help'), callback_data: `h:${r.id}`}],
      ]});
      this.d.store.setPromptMessage(r.id, id);
    }
  }

  // ---------- incoming events ----------
  async onJoin(input: { updateId: number; chatId: number; userId: number; contactChatId: number; requestedAt: number }): Promise<void> {
    const res = this.d.store.recordJoin({
      updateId: input.updateId,
      chatId: input.chatId,
      userId: input.userId,
      contactChatId: input.contactChatId,
      requestDate: input.requestedAt,
      now: this.d.clock.now(),
    });
    log('info', 'join_request', { outcome: res.kind, chat: input.chatId });
    if (res.kind === 'created') await this.drainOutbox();
  }

  /**
   * Someone opened the bot. Returns false when they have nothing to verify, so the caller can
   * show the help text instead. No language question is asked: the group's language is used
   * and can be switched with the buttons under the picture.
   */
  async onStart(userId: number, chatId: number, payload: string): Promise<boolean> {
    const now = this.d.clock.now();
    this.d.store.recordExplicitStart(userId, chatId, now);
    const live = this.d.store.liveRequestsForUser(userId);
    if (live.length === 0) return false;
    let preferred: string | undefined;
    if (payload.startsWith('cap_')) preferred = live.find(r => r.id === payload.slice(4))?.id;
    if (payload.startsWith('r_') && TOKEN_PATTERN.test(payload.slice(2))) {
      preferred = this.d.store.resolveResumeToken(payload.slice(2), userId, now)?.id;
    }
    await this.continueVerification(userId, chatId, this.localeFor(userId, live[0]!.chat_id), preferred);
    return true;
  }

  async onLanguagePicked(userId: number, chatId: number, locale: Locale): Promise<void> {
    const now = this.d.clock.now();
    this.d.store.setLocale(userId, locale, now);
    await this.say(chatId, t(locale, 'lang.set'));
    // An active round is re-sent in the new language: same board, same answer, same attempt.
    let resent = false;
    for (const r of this.d.store.liveRequestsForUser(userId)) {
      const s = this.d.store.liveSession(r.id);
      if (s?.state === 'active') {
        await this.deliverRound(s.id, chatId);
        resent = true;
      } else if (s) {
        resent = true;
      }
    }
    if (!resent) await this.continueVerification(userId, chatId, locale, undefined, true);
  }

  private async continueVerification(
    userId: number,
    chatId: number,
    locale: Locale,
    preferred?: string,
    quietIfNone = false,
  ): Promise<void> {
    const live = this.d.store.liveRequestsForUser(userId);
    if (live.length === 0) {
      if (!quietIfNone) await this.say(chatId, t(locale, 'start.no_pending'));
      return;
    }
    const open = live.filter((r) => r.state === 'pending' || r.state === 'challenging');
    const target = (preferred && open.find((r) => r.id === preferred)) || (open.length === 1 ? open[0] : undefined);
    if (!target && open.length > 1) {
      await this.say(chatId, t(locale, 'start.pick_group'), {
        inline_keyboard: open.slice(0, 8).map((r) => [{ text: this.groupLabel(r.chat_id), callback_data: `g:${r.id}` }]),
      });
      return;
    }
    if (target && this.needsCap(target)) { await this.promptCap(target, chatId); return; }
    if (target?.kind === 'member') {
      await this.say(chatId, t(locale, 'start.in_group', { group: this.groupLabel(target.chat_id) }));
      return;
    }
    if (!target) {
      const r = live[0]!;
      const key: Key = r.state === 'approval_pending' ? 'start.approval_wait' : 'start.review_wait';
      await this.say(chatId, t(locale, key, { group: this.groupLabel(r.chat_id) }));
      return;
    }
    await this.proceed(target, userId, chatId, locale);
  }

  /** Group choice and "try again" both land here; ownership is enforced by the store. */
  async onPickRequest(userId: number, chatId: number, requestId: string): Promise<void> {
    const r = this.d.store.getRequest(requestId);
    const locale = this.localeFor(userId, r?.chat_id);
    if (!r || r.user_id !== userId) {
      await this.say(chatId, t(locale, 'challenge.stale'));
      return;
    }
    await this.proceed(r, userId, chatId, locale);
  }

  private async proceed(r: RequestRow, userId: number, chatId: number, locale: Locale): Promise<void> {
    if (this.needsCap(r)) { await this.promptCap(r, chatId); return; }
    const res = this.d.store.beginAttempt({
      requestId: r.id,
      actorId: userId,
      locale,
      now: this.d.clock.now(),
      maxActiveSessions: this.d.config.maxActiveSessions,
    });
    const group = this.groupLabel(r.chat_id);
    if (res.ok) {
      if (res.existing) {
        const s = this.d.store.getSession(res.sessionId);
        if (s?.state === 'active') await this.deliverRound(s.id, chatId);
      } else {
        await this.drainOutbox();
      }
      return;
    }
    switch (res.reason) {
      case 'not_live':
        await this.say(chatId, t(locale, 'start.no_pending'));
        break;
      case 'review':
      case 'exhausted':
        await this.say(chatId, t(locale, 'start.review_wait', { group }));
        break;
      case 'raid':
        await this.say(chatId, t(locale, 'challenge.review'));
        break;
      case 'expired':
        await this.say(chatId, t(locale, 'challenge.expired_review'));
        break;
      case 'deferred':
        await this.say(chatId, t(locale, 'challenge.deferred'));
        break;
      case 'capacity':
        await this.say(chatId, t(locale, 'challenge.capacity'));
        break;
      case 'time_short':
        await this.say(chatId, t(locale, 'challenge.time_short'), {
          inline_keyboard: [[{ text: t(locale, 'btn.start'), url: this.startUrl('verify') }]],
        });
        break;
    }
  }

  async onHelp(userId: number, chatId: number, requestId: string): Promise<void> {
    const r = this.d.store.getRequest(requestId);
    const locale = this.localeFor(userId, r?.chat_id);
    const ok = this.d.store.toReview(requestId, userId, 'help_requested', this.d.clock.now());
    if (ok && r) await this.say(chatId, t(locale, 'help.requested', { group: this.groupLabel(r.chat_id) }));
    else if (r && r.user_id === userId && r.state === 'manual_review') {
      await this.say(chatId, t(locale, 'start.review_wait', { group: this.groupLabel(r.chat_id) }));
    } else await this.say(chatId, t(locale, 'challenge.stale'));
  }

  /** Synchronous decision; the caller acknowledges the callback, then calls afterAnswer. */
  answer(userId: number, chatId: number, token: string, skip = false): AnswerResult {
    return this.d.store.answer({ actorId: userId, privateChatId: chatId, token, now: this.d.clock.now(), skip });
  }
  staleText(userId: number): string {
    return t(this.localeFor(userId), 'challenge.stale');
  }
  async afterAnswer(res: AnswerResult, chatId: number): Promise<void> {
    if (res.result === 'stale' || res.result === 'skip-limit') return;
    const req = this.d.store.getRequest(res.requestId);
    if (req?.kind === 'member') return this.afterGroupAnswer(res, req);
    if (res.messageId !== null) {
      await this.d.tg.clearKeyboard(chatId, res.messageId).catch(() => undefined);
    }
    const group = this.groupLabel(res.chatId);
    const l = res.locale;
    switch (res.result) {
      case 'wrong':
        if (res.canRetry) {
          await this.say(chatId, t(l, 'challenge.wrong_retry'), {
            inline_keyboard: [
              [{ text: t(l, 'btn.retry'), callback_data: `t:${res.requestId}` }],
              [{ text: t(l, 'btn.help'), callback_data: `h:${res.requestId}` }],
            ],
          });
        } else await this.say(chatId, t(l, 'challenge.wrong_final'));
        break;
      case 'next-round':
        await this.say(chatId, t(l, 'challenge.next'));
        await this.drainOutbox();
        break;
      case 'approval-queued':
        // Sent before approval: the bot may be unable to message the user afterwards.
        await this.say(
          chatId,
          t(l, 'challenge.passed', { group }),
        );
        await this.drainOutbox();
        break;
      case 'review':
        await this.say(chatId, t(l, 'challenge.review'));
        break;
    }
  }

  /** In-group check: no chatter. The picture is removed and the next step simply appears. */
  private async afterGroupAnswer(res: Exclude<AnswerResult, { result: 'stale' } | { result: 'skip-limit' }>, r: RequestRow): Promise<void> {
    if (res.result === 'next-round' && res.messageId !== null) {
      await this.d.tg.deleteMessage(r.chat_id, res.messageId).catch(() => undefined);
    }
    await this.sweepGroupMessages();
    if (res.result === 'wrong' && res.canRetry) await this.startInGroup(r); // a fresh picture straight away
    else if (res.result === 'wrong' || res.result === 'review') await this.groupNotice(r, 'group.review', false);
    await this.drainOutbox();
  }

  /** One short notice in the group for a member whose check stopped; removed when it is resolved. */
  private async groupNotice(r: RequestRow, key: 'group.review' | 'group.try_again', retry: boolean): Promise<void> {
    const fresh = this.d.store.getRequest(r.id);
    if (!fresh) return;
    await this.dropPrompt(fresh);
    const l = this.localeFor(r.user_id, r.chat_id);
    const rows: Button[][] = retry ? [[{ text: t(l, 'btn.retry'), callback_data: `t:${r.id}` }]] : [];
    try {
      const id = await this.d.tg.sendGroupPrompt(r.chat_id, r.user_id, t(l, key), { inline_keyboard: rows });
      this.d.store.setPromptMessage(r.id, id);
    } catch (e) {
      if (isDatabaseError(e)) throw e;
      log('warn', 'group_notice_failed', { kind: classify(e).kind });
    }
  }

  /** Starts (or restarts) a muted member's check; the picture is posted in the group. */
  private async startInGroup(r: RequestRow): Promise<void> {
    if (this.needsCap(r)) { await this.promptCap(r); return; }
    const res = this.d.store.beginAttempt({
      requestId: r.id,
      actorId: r.user_id,
      locale: this.localeFor(r.user_id, r.chat_id),
      now: this.d.clock.now(),
      maxActiveSessions: this.d.config.maxActiveSessions,
    });
    if (res.ok) {
      const fresh = this.d.store.getRequest(r.id);
      if (fresh) await this.dropPrompt(fresh);
      await this.drainOutbox();
      return;
    }
    const later = res.reason === 'capacity' || res.reason === 'deferred' || res.reason === 'time_short';
    if (res.reason !== 'not_live') await this.groupNotice(r, later ? 'group.try_again' : 'group.review', later);
  }

  // ----- buttons pressed in the group: only the new member's own presses count -----
  private ownCheck(userId: number, chatId: number, requestId?: string): RequestRow | undefined {
    const r = requestId ? this.d.store.getRequest(requestId) : this.d.store.liveRequest(chatId, userId);
    return r && r.kind === 'member' && r.user_id === userId && r.chat_id === chatId ? r : undefined;
  }
  notYoursText(userId: number, chatId: number): string {
    return t(this.localeFor(userId, chatId), 'group.not_yours');
  }
  /** Returns false when the press came from someone other than the member being checked. */
  async onGroupLanguage(userId: number, chatId: number, locale: Locale): Promise<boolean> {
    const r = this.ownCheck(userId, chatId);
    if (!r) return false;
    this.d.store.setLocale(userId, locale, this.d.clock.now());
    const s = this.d.store.liveSession(r.id);
    if (s?.state === 'active') await this.deliverRound(s.id);
    return true;
  }
  async onGroupRetry(userId: number, chatId: number, requestId: string): Promise<boolean> {
    const r = this.ownCheck(userId, chatId, requestId);
    if (!r) return false;
    if (r.state === 'pending' || r.state === 'challenging') await this.startInGroup(r);
    return true;
  }
  async onGroupHelp(userId: number, chatId: number, requestId: string): Promise<boolean> {
    const r = this.ownCheck(userId, chatId, requestId);
    if (!r) return false;
    if (this.d.store.toReview(r.id, userId, 'help_requested', this.d.clock.now())) {
      await this.sweepGroupMessages();
      await this.groupNotice(r, 'group.review', false);
    }
    return true;
  }

  /**
   * A new member appeared. Membership granted by someone else closes any open join request as an
   * external resolution. Someone who joined by themselves is muted and asked to verify.
   */
  async onMemberJoined(chatId: number, userId: number, selfJoin = false, updateId = 0, joinedAt = 0): Promise<void> {
    const now = this.d.clock.now();
    const r = this.d.store.recordMembership(chatId, userId, now);
    if (r) log('info', 'external_resolution', { chat: chatId });
    if (!selfJoin) return; // added or approved by an administrator (or by this bot)
    const res = this.d.store.recordJoin({
      updateId,
      chatId,
      userId,
      contactChatId: userId,
      requestDate: joinedAt || now,
      now,
      kind: 'member',
    });
    log('info', 'member_joined', { outcome: res.kind, chat: chatId });
    if (res.kind === 'created' || res.kind === 'review') await this.drainOutbox();
  }
  async onMemberLeft(chatId: number, userId: number): Promise<void> {
    const r = this.d.store.recordDeparture(chatId, userId, this.d.clock.now());
    if (r) await this.dropPrompt(r);
    await this.sweepGroupMessages();
  }
  cleanupCapMessages(): Promise<void> {
    return this.cleanup.cleanupCapMessages();
  }
  sweepGroupMessages(): Promise<void> {
    return this.cleanup.sweepGroupMessages();
  }
  private dropPrompt(r: RequestRow): Promise<void> {
    return this.cleanup.dropPrompt(r);
  }

  // ---------- challenge delivery ----------
  private deliverRound(sessionId: string, chatOverride?: number): Promise<void> {
    return this.delivery.deliver(sessionId, chatOverride);
  }

  // ---------- outbox ----------
  drainOutbox(): Promise<void> {
    return this.outbox.drain();
  }

  /** A failed action never becomes an approval: the request goes to a person instead. */
  private onOutboxFailed(row: OutboxRow, err: TgError): void {
    if (!row.request_id) return;
    const now = this.d.clock.now();
    const r = this.d.store.getRequest(row.request_id);
    if (!r) return;
    if (row.kind === 'approve' || row.kind === 'decline') {
      if (row.request_revision !== null) {
        this.d.store.resolveRequest(r.id, row.request_revision, 'manual_review', `action_failed_${err.kind}`, now);
      }
    } else if (row.kind === 'prepare_round' && err.kind !== 'forbidden') {
      this.d.store.toReview(r.id, null, `send_failed_${err.kind}`, now);
    }
  }

  private async execute(row: OutboxRow): Promise<void> {
    switch (row.kind) {
      case 'cap_picture': {
        const r = row.request_id ? this.d.store.getRequest(row.request_id) : undefined;
        if (!r || r.revision !== row.request_revision || r.state !== 'pending' || !this.d.store.capPassed(r.id)) return;
        const res=this.d.store.beginAttempt({requestId:r.id,actorId:r.user_id,locale:this.localeFor(r.user_id,r.chat_id),
          now:this.d.clock.now(),maxActiveSessions:this.d.config.maxActiveSessions});
        if (!res.ok && ['capacity','deferred','time_short'].includes(res.reason)) throw new Defer(5000);
        return;
      }
      case 'invite':
        return this.execInvite(row);
      case 'quarantine':
        return this.execQuarantine(row);
      case 'prepare_round': {
        const { sessionId } = JSON.parse(row.payload_json) as { sessionId: string };
        const s = this.d.store.getSession(sessionId);
        if (s && (s.state === 'preparing' || (s.state === 'active' && s.message_id === null))) {
          await this.deliverRound(sessionId);
        }
        return;
      }
      case 'approve':
      case 'decline':
        return this.execDecision(row, row.kind);
      default:
        throw new TgError('bad_request', `unknown outbox kind ${row.kind}`);
    }
  }

  /** A join request arrived: send the applicant their first picture straight away, in private. */
  private async execInvite(row: OutboxRow): Promise<void> {
    const { store, clock } = this.d;
    const r = row.request_id ? store.getRequest(row.request_id) : undefined;
    const now = clock.now();
    // Outside the contact window the applicant has to open the bot themselves (/start).
    if (!r || r.state !== 'pending' || now > r.request_date + POLICY.contactWindowMs) return;
    if (this.needsCap(r)) { await this.promptCap(r, this.dest(r)); return; }
    store.beginAttempt({
      requestId: r.id,
      actorId: r.user_id,
      locale: this.localeFor(r.user_id, r.chat_id),
      now,
      maxActiveSessions: this.d.config.maxActiveSessions,
    });
  }

  /** Mutes a newcomer who joined directly, then posts their picture check in the group. */
  private async execQuarantine(row: OutboxRow): Promise<void> {
    const { store, tg, clock } = this.d;
    const r = row.request_id ? store.getRequest(row.request_id) : undefined;
    if (!r || r.kind !== 'member' || !['pending', 'challenging', 'manual_review'].includes(r.state)) return;
    try {
      await tg.restrict(r.chat_id, r.user_id);
    } catch (e) {
      const err = classify(e);
      if (err.kind !== 'forbidden' && err.kind !== 'bad_request') throw err;
      // Without the right to mute there is nothing to enforce: record it and tell the admins.
      store.resolveRequest(r.id, r.revision, 'external_resolution', 'cannot_restrict', clock.now());
      const key = `norestrict:${r.chat_id}`;
      if (clock.now() - Number(store.getState(key) ?? '0') > 3_600_000) {
        store.setState(key, String(clock.now()));
        await this.notifyAdmins(
          r.chat_id,
          `⚠️ ${this.groupLabel(r.chat_id)}: I could not mute a new member, so they were not verified. Give me the "Ban users" admin right, or turn this off with /settings quarantine off.`,
        );
      }
      return;
    }
    const wantCheck = (JSON.parse(row.payload_json) as { prompt?: boolean }).prompt === true;
    if (wantCheck && r.state === 'pending') await this.startInGroup(r);
    else if (r.state === 'manual_review' && r.prompt_message_id === null) await this.groupNotice(r, 'group.review', false);
  }

  private async execDecision(row: OutboxRow, kind: 'approve' | 'decline'): Promise<void> {
    const { store, tg, clock } = this.d;
    const r = row.request_id ? store.getRequest(row.request_id) : undefined;
    const expected = kind === 'approve' ? 'approval_pending' : 'decline_pending';
    // Obsolete decisions (superseded, cancelled, re-applied) are discarded, never executed.
    if (!r || r.state !== expected || r.revision !== row.request_revision) return;
    const manual = (JSON.parse(row.payload_json) as { manual?: boolean }).manual === true;
    const now = clock.now();
    if (kind === 'approve' && !manual) {
      if (store.requireCap && !store.capPassed(r.id)) {
        store.resolveRequest(r.id, r.revision, 'manual_review', 'cap_required', now);
        return;
      }
      const g = store.getGroup(r.chat_id);
      if (!g || !g.enabled || g.raid_mode) {
        store.resolveRequest(r.id, r.revision, 'manual_review', g?.raid_mode ? 'raid_mode' : 'group_paused', now);
        return;
      }
      if (!store.takeApprovalBudget(r.chat_id, store.settingsOf(g).approvalsPerMinute, now)) {
        if (now - r.updated_at > 5 * 60_000) {
          store.resolveRequest(r.id, r.revision, 'manual_review', 'approval_budget', now);
          return;
        }
        throw new Defer(5000);
      }
    }
    try {
      if (r.kind === 'member') {
        // Already in the group and muted: approval lifts the mute, decline removes them.
        if (kind === 'approve') await tg.unrestrict(r.chat_id, r.user_id);
        else await tg.kick(r.chat_id, r.user_id);
      } else if (kind === 'approve') await tg.approve(r.chat_id, r.user_id);
      else await tg.decline(r.chat_id, r.user_id);
    } catch (e) {
      const err = classify(e);
      if (r.kind === 'member' && err.kind === 'bad_request') {
        store.resolveRequest(r.id, r.revision, 'external_resolution', 'member_gone', clock.now());
        await this.dropPrompt(r);
        return;
      }
      if (err.kind === 'gone') {
        // The request no longer exists at Telegram. Membership confirms admission, not its cause.
        const member = await tg.isMember(r.chat_id, r.user_id).catch(() => false);
        if (kind === 'approve' && member && row.attempts > 0) {
          store.resolveRequest(r.id, r.revision, 'approved', 'confirmed_by_membership', clock.now());
        } else {
          store.resolveRequest(r.id, r.revision, 'external_resolution', member ? 'already_member' : 'unknown', clock.now());
        }
        return;
      }
      if (err.kind === 'forbidden') {
        store.setEnabled(r.chat_id, false, null, 'bot_rights_missing', clock.now());
        store.resolveRequest(r.id, r.revision, 'manual_review', 'bot_rights_missing', clock.now());
        await this.notifyAdmins(
          r.chat_id,
          `⚠️ ${this.groupLabel(r.chat_id)}: I can no longer process join requests (missing rights). The guard is paused. Restore my "Invite users" admin right and run /setup again.`,
        );
        return;
      }
      throw err;
    }
    store.resolveRequest(
      r.id,
      r.revision,
      kind === 'approve' ? 'approved' : 'declined',
      manual ? 'manual_review' : 'challenge_passed',
      clock.now(),
    );
    await this.dropPrompt(r);
    log('info', kind === 'approve' ? 'approved' : 'declined', { chat: r.chat_id, manual });
  }

  /** Tells an applicant an administrator gave them another attempt. False if they cannot be reached. */
  async offerRetry(r: RequestRow): Promise<boolean> {
    if (r.kind === 'member') return false; // their new picture is posted in the group
    const dm = this.d.store.getPrefs(r.user_id)?.explicit_dm_chat_id;
    if (dm == null) return false;
    const l = this.localeFor(r.user_id, r.chat_id);
    return this.say(dm, t(l, 'retry.granted', { group: this.groupLabel(r.chat_id) }), {
      inline_keyboard: [
        [{ text: t(l, 'btn.retry'), callback_data: `t:${r.id}` }],
        [{ text: t(l, 'btn.help'), callback_data: `h:${r.id}` }],
      ],
    });
  }

  /** Messages the owner and delegates who have started a private chat with the bot. */
  async notifyAdmins(chatId: number, text: string): Promise<void> {
    const g = this.d.store.getGroup(chatId);
    if (!g) return;
    const ids = new Set([g.owner_user_id, ...this.d.store.listAdmins(chatId).map((a) => a.user_id)]);
    ids.delete(this.d.tg.botId);
    for (const id of ids) {
      const dm = this.d.store.getPrefs(id)?.explicit_dm_chat_id;
      if (dm != null) await this.say(dm, text);
    }
  }

  // ---------- scheduler ----------
  async tick(): Promise<void> {
    const { store, clock } = this.d;
    const now = clock.now();
    for (const e of store.expireSessions(now, 50)) {
      const req = store.getRequest(e.requestId);
      if (req?.kind === 'member') {
        await this.sweepGroupMessages();
        await this.groupNotice(req, e.canRetry ? 'group.try_again' : 'group.review', e.canRetry);
        continue;
      }
      const chat = store.getPrefs(e.userId)?.explicit_dm_chat_id ?? e.contactChatId;
      if (e.messageId !== null) await this.d.tg.clearKeyboard(chat, e.messageId).catch(() => undefined);
      if (e.canRetry) {
        await this.say(chat, t(e.locale, 'challenge.expired_retry'), {
          inline_keyboard: [
            [{ text: t(e.locale, 'btn.retry'), callback_data: `t:${e.requestId}` }],
            [{ text: t(e.locale, 'btn.help'), callback_data: `h:${e.requestId}` }],
          ],
        });
      } else await this.say(chat, t(e.locale, 'challenge.expired_review'));
    }
    for (const r of store.expireRequests(now, 50)) {
      if (r.kind === 'member') await this.groupNotice(r, 'group.review', false);
      else await this.dropPrompt(r);
    }
    await this.drainOutbox();
    await this.cleanupCapMessages();
    await this.sweepGroupMessages();

    if (now - this.lastAlertCheck >= 30_000) {
      this.lastAlertCheck = now;
      for (const due of store.dueReviewAlerts(now)) {
        const g = store.getGroup(due.chatId);
        await this.notifyAdmins(
          due.chatId,
          `🔔 ${this.groupLabel(due.chatId)}: ${due.waiting} join request(s) awaiting review${g?.raid_mode ? ' (raid mode is ON)' : ''}. Use /review.`,
        );
      }
    }
    if (now - this.lastPurge >= 3_600_000) {
      this.lastPurge = now;
      const { reviewExpired } = store.purge(now);
      for (const chatId of new Set(reviewExpired.map((r) => r.chat_id))) {
        await this.notifyAdmins(
          chatId,
          `ℹ️ ${this.groupLabel(chatId)}: old review records were purged locally. This did not decline anything at Telegram: check the group's pending join requests.`,
        );
      }
      this.delivery.purge(now);
    }
  }

}
