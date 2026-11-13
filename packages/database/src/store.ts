import { SqliteGroups } from './groups';
import { SqliteResumeTokens } from './resume-tokens';
import { SqliteChatDirectory, type KnownChatRow } from './chat-directory';
export type { KnownChatRow } from './chat-directory';
import { SqliteAudit, type AuditRow } from './audit';
export type { AuditRow } from './audit';
import { SqliteRateLimits } from './rate-limits';
import { SqliteUserPreferences, type PrefsRow } from './user-preferences';
export type { PrefsRow } from './user-preferences';
import type { MessageCleanupRepository } from './message-cleanup-repository';
import { SqliteActionTokens, type ActionTokens, type ActionPayload } from './action-tokens';
import { SqliteCapStorage } from './cap-storage';
import type { CapRepository } from './cap-repository';
import { SqliteInbox } from './inbox';
import { SqliteOutbox } from './outbox';
import type { EnqueueWork, InboxRow, OutboxRow, InboxRepository, OutboxRepository } from './queue-repositories';
export type { InboxRow, OutboxRow } from './queue-repositories';
import { SqliteRuntimeState } from './runtime-state';
import { SqliteUsernameDirectory } from './username-directory';
import { SqlitePhotoCache } from './photo-cache';
import type { GroupRow, UsernameDirectory, PhotoCacheRepository } from './repositories';
export type { GroupRow } from './repositories';
import type { Database } from 'bun:sqlite';
import {
  POLICY,
  LIVE_REQUEST_STATES,
  parseSettings,
  tokenHash,
  type GroupSettings,
  type Locale,
  type RequestState,
  type Rng,
  type Role,
  type SessionState,
} from '@guard/core';

export interface RequestRow {
  id: string;
  chat_id: number;
  user_id: number;
  contact_chat_id: number;
  request_date: number;
  source_update_id: number;
  generation: number;
  state: RequestState;
  reason_code: string | null;
  deadline_at: number;
  revision: number;
  created_at: number;
  updated_at: number;
  /** 'request': a pending Telegram join request. 'member': someone who joined directly and is muted. */
  kind: 'request' | 'member';
  prompt_message_id: number | null;
}
export interface SessionRow {
  id: string;
  request_id: string;
  attempt_no: number;
  locale: Locale;
  state: SessionState;
  round_no: number;
  round_version: number;
  answer_position: number | null;
  board_hash: string | null;
  question_json: string | null;
  used_items_json: string;
  message_id: number | null;
  policy_version: number;
  expires_at: number;
  created_at: number;
}


export type JoinResult =
  | { kind: 'ignored'; reason: 'unconfigured' | 'overflow' }
  | { kind: 'duplicate' }
  | { kind: 'created'; request: RequestRow }
  | { kind: 'review'; request: RequestRow; raidStarted: boolean };

export type BeginResult =
  | { ok: true; sessionId: string; existing: boolean }
  | {
      ok: false;
      reason: 'cap_required' | 'not_live' | 'review' | 'raid' | 'exhausted' | 'deferred' | 'capacity' | 'time_short' | 'expired';
    };

export type AnswerResult =
  | { result: 'stale' }
  | { result: 'skip-limit' }
  | {
      result: 'wrong' | 'next-round' | 'approval-queued' | 'review';
      sessionId: string;
      requestId: string;
      chatId: number;
      locale: Locale;
      messageId: number | null;
      canRetry: boolean;
    };

export interface ExpiredSession {
  sessionId: string;
  requestId: string;
  userId: number;
  chatId: number;
  contactChatId: number;
  locale: Locale;
  messageId: number | null;
  canRetry: boolean;
}

const LIVE = `('pending','challenging','manual_review','approval_pending')`;

export class Store implements MessageCleanupRepository, ActionTokens, CapRepository, UsernameDirectory, PhotoCacheRepository, InboxRepository, OutboxRepository {
  constructor(
    readonly db: Database,
    private readonly rng: Rng,
    readonly requireCap = false,
    readonly autoRemoveFailed = false,
  ) {
    this.groups = new SqliteGroups(db);
    this.resumeTokens = new SqliteResumeTokens(db, rng);
    this.chatDirectory = new SqliteChatDirectory(db);
    this.auditLog = new SqliteAudit(db);
    this.rateLimits = new SqliteRateLimits(db);
    this.preferences = new SqliteUserPreferences(db);
    this.actionTokens = new SqliteActionTokens(db, rng);
    this.capStorage = new SqliteCapStorage(db);
    this.runtimeState = new SqliteRuntimeState(db);
    this.inbox = new SqliteInbox(db, this.runtimeState);
    this.outbox = new SqliteOutbox(db, rng);
    this.usernames = new SqliteUsernameDirectory(db, this.runtimeState);
    this.photoCache = new SqlitePhotoCache(db);
  }

  private readonly groups: SqliteGroups;
  private readonly resumeTokens: SqliteResumeTokens;
  private readonly chatDirectory: SqliteChatDirectory;
  private readonly auditLog: SqliteAudit;
  private readonly rateLimits: SqliteRateLimits;
  private readonly preferences: SqliteUserPreferences;
  private readonly actionTokens: SqliteActionTokens;
  private readonly capStorage: SqliteCapStorage;
  private readonly inbox: SqliteInbox;
  private readonly outbox: SqliteOutbox;
  private readonly runtimeState: SqliteRuntimeState;
  private readonly usernames: SqliteUsernameDirectory;
  private readonly photoCache: SqlitePhotoCache;

  scheduleReviewNotice(chatId: number, messageId: number, dueAt: number): void {
    this.setState(`review_notice:${chatId}:${messageId}`, JSON.stringify({chatId, messageId, dueAt}));
  }
  dueReviewNotices(now: number): { chatId: number; messageId: number }[] {
    return this.db.query("SELECT value FROM runtime_state WHERE key GLOB 'review_notice:*' AND json_extract(value,'$.dueAt')<=? ORDER BY json_extract(value,'$.dueAt') LIMIT 25")
      .all(now).map(row => { const {chatId, messageId} = JSON.parse((row as {value:string}).value); return {chatId, messageId}; });
  }
  finishReviewNotice(chatId: number, messageId: number): void {
    this.deleteState(`review_notice:${chatId}:${messageId}`);
  }
  scheduleExistingReviewNotices(now: number): void {
    this.tx(() => {
      if (this.getState('review_notice_cleanup_v1')) return;
      const rows = this.db.query("SELECT chat_id,prompt_message_id FROM join_requests WHERE kind='member' AND state='manual_review' AND prompt_message_id IS NOT NULL").all() as {chat_id:number;prompt_message_id:number}[];
      for (const row of rows) this.scheduleReviewNotice(row.chat_id, row.prompt_message_id, now + 60_000);
      this.setState('review_notice_cleanup_v1', 'done');
    });
  }

  trackCapMessage(requestId: string, chatId: number, messageId: number): void {
    this.capStorage.trackMessage(requestId, chatId, messageId);
  }
  capMessagesToDelete(now: number): { chat_id: number; message_id: number }[] {
    return this.capStorage.messagesToDelete(now);
  }
  finishCapMessage(chatId: number, messageId: number): void {
    this.capStorage.finishMessage(chatId, messageId);
  }
  retryCapMessage(chatId: number, messageId: number, now: number): void {
    this.capStorage.retryMessage(chatId, messageId, now);
  }
  capPassed(requestId: string): boolean {
    return this.capStorage.passed(requestId);
  }
  capEligible(requestId: string, userId: number, now: number): RequestRow | undefined {
    const r = this.getRequest(requestId);
    if (!r || r.user_id !== userId || !['pending', 'challenging'].includes(r.state) || r.deadline_at <= now) return undefined;
    const g = this.getGroup(r.chat_id);
    return g?.enabled && !g.raid_mode ? r : undefined;
  }
  issueCapTicket(requestId: string, userId: number, now: number): string | undefined {
    const r = this.capEligible(requestId, userId, now);
    if (!r || this.capPassed(requestId)) return undefined;
    const ticket = this.rng.token();
    this.capStorage.saveTicket(r.id, ticket, Math.min(r.deadline_at, now + 600_000));
    return ticket;
  }
  capTicket(ticket: string, now: number): RequestRow | undefined {
    const requestId = this.capStorage.requestForTicket(ticket, now);
    const r = requestId ? this.getRequest(requestId) : undefined;
    return r && this.capEligible(r.id, r.user_id, now);
  }
  takeCapChallenge(ticket: string, now: number): boolean {
    return this.capStorage.takeChallenge(ticket, now);
  }
  consumeCapNonce(hash: string, ttl: number, now: number): boolean {
    return this.capStorage.consumeNonce(hash, ttl, now);
  }
  completeCap(ticket: string, now: number, locale: Locale, maxActiveSessions: number): boolean {
    return this.tx(() => {
      const r = this.capTicket(ticket, now);
      if (!r) return false;
      this.capStorage.markPassed(r.id, now);
      const group = this.getGroup(r.chat_id)!;
      // Passing Cap starts the picture clock exactly once, in the same transaction.
      const pictureDeadline = now + this.settingsOf(group).challengeTimeoutSec * 1000;
      this.run('UPDATE join_requests SET deadline_at=? WHERE id=?', pictureDeadline, r.id);
      const legacy = this.liveSession(r.id);
      if (legacy) {
        this.run("UPDATE sessions SET state='cancelled', answer_position=NULL WHERE id=?", legacy.id);
        this.run('DELETE FROM callback_tokens WHERE session_id=?', legacy.id);
      }
      // Queue the picture in the same transaction so a restart cannot lose the next step.
      const begun = this.beginAttempt({requestId:r.id, actorId:r.user_id, locale, now, maxActiveSessions});
      if (!begun.ok && ['capacity','deferred','time_short'].includes(begun.reason)) this.queueCapPicture(r.id, now);
      this.audit(r.chat_id, null, r.user_id, 'cap_passed', 'browser_check', now, r.id);
      return true;
    });
  }

  queueCapPicture(requestId: string, now: number): void {
    const r = this.getRequest(requestId);
    if (!r || r.state !== 'pending' || !this.capPassed(r.id)) return;
    this.enqueue({dedupeKey:`cap-picture:${r.id}:${r.revision}`, requestId:r.id, revision:r.revision,
      kind:'cap_picture',payload:{},now});
  }
  recoverCapPictures(now: number): void {
    for (const r of this.capStorage.picturesToRecover(now)) this.queueCapPicture(r.id, now);
  }

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  private one<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return (this.db.query(sql).get(...params) as T | null) ?? undefined;
  }
  private all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.query(sql).all(...params) as T[];
  }
  private run(sql: string, ...params: (string | number | null)[]): number {
    return this.db.query(sql).run(...params).changes;
  }

  // ---------- Audit ----------
  audit(
    chatId: number | null,
    actor: number | null,
    subject: number | null,
    action: string,
    reason: string,
    now: number,
    correlation = '',
  ): void {
    this.auditLog.audit(chatId, actor, subject, action, reason, now, correlation);
  }
  listAudit(chatId: number, limit: number): AuditRow[] {
    return this.auditLog.listAudit(chatId, limit);
  }

  // ---------- Runtime state ----------
  getState(key: string): string | undefined {
    return this.runtimeState.getState(key);
  }
  setState(key: string, value: string): void {
    this.runtimeState.setState(key, value);
  }
  deleteState(key: string): void {
    this.runtimeState.deleteState(key);
  }

  rememberUsername(userId: number, username: string | undefined, now: number): void {
    this.usernames.rememberUsername(userId, username, now);
  }
  userIdForUsername(username: string, now: number): number | undefined {
    return this.usernames.userIdForUsername(username, now);
  }


  // ---------- Groups ----------
  getGroup(chatId: number): GroupRow | undefined {
    return this.groups.getGroup(chatId);
  }
  listGroups(): GroupRow[] {
    return this.groups.listGroups();
  }
  settingsOf(group: GroupRow): GroupSettings {
    return parseSettings(group.settings_json);
  }
  enrolGroup(chatId: number, ownerId: number, settings: GroupSettings, now: number): GroupRow {
    return this.tx(() => {
      const existing = this.getGroup(chatId);
      if (existing) {
        this.groups.setOwner(chatId, ownerId, now);
      } else {
        this.groups.insert(chatId, ownerId, settings, now);
        this.audit(chatId, ownerId, null, 'group_enrolled', 'setup', now);
      }
      return this.getGroup(chatId)!;
    });
  }
  setInviteLink(chatId: number, link: string, now: number): void {
    this.groups.setInviteLink(chatId, link, now);
  }
  setEnabled(chatId: number, enabled: boolean, actor: number | null, reason: string, now: number): void {
    this.tx(() => {
      this.groups.setEnabled(chatId, enabled, reason, now);
      this.audit(chatId, actor, null, enabled ? 'guard_enabled' : 'guard_paused', reason, now);
    });
  }
  setRaid(chatId: number, on: boolean, actor: number | null, reason: string, now: number): void {
    this.tx(() => {
      this.groups.setRaid(chatId, on, now);
      if (!on) this.rateLimits.resetBurst(chatId);
      this.audit(chatId, actor, null, on ? 'raid_on' : 'raid_off', reason, now);
    });
  }
  setOwner(chatId: number, ownerId: number, now: number): void {
    this.tx(() => {
      const g = this.getGroup(chatId);
      if (!g) return;
      if (g.owner_user_id !== ownerId) {
        this.audit(chatId, null, ownerId, 'owner_changed', 'telegram_owner', now);
      }
      this.groups.setOwner(chatId, ownerId, now);
    });
  }
  updateSettings(chatId: number, settings: GroupSettings, actor: number, key: string, now: number): void {
    this.tx(() => {
      const g = this.getGroup(chatId);
      if (!g) return;
      this.groups.updateSettings(chatId, settings, now);
      this.audit(chatId, actor, null, 'settings_changed', `${key}:v${g.settings_version}->v${g.settings_version + 1}`, now);
    });
  }
  /** Keeps the stored display name equal to the group's current Telegram title. */
  setLabel(chatId: number, label: string, now: number): void {
    const g = this.getGroup(chatId);
    if (!g) return;
    const settings = { ...this.settingsOf(g), label: label.slice(0, 64) };
    this.groups.refreshLabel(chatId, settings, now);
  }
  removeGroup(chatId: number, actor: number, now: number): void {
    this.tx(() => {
      this.groups.remove(chatId);
      this.run('DELETE FROM attempts WHERE chat_id=?', chatId);
      this.preferences.clearGroupContext(chatId);
      this.audit(chatId, actor, null, 'group_removed', 'owner_request', now);
    });
  }

  upsertKnownChat(chatId: number, title: string, type: string, botStatus: string, now: number): void {
    this.chatDirectory.upsertKnownChat(chatId, title, type, botStatus, now);
  }
  removeKnownChat(chatId: number): void { this.chatDirectory.removeKnownChat(chatId); }
  setKnownChatTitle(chatId: number, title: string, now: number): void {
    this.chatDirectory.setKnownChatTitle(chatId, title, now);
  }
  listKnownChats(limit: number): KnownChatRow[] { return this.chatDirectory.listKnownChats(limit); }

  // ---------- Administrators (mirror of Telegram, never an authority source) ----------
  listAdmins(chatId: number): { user_id: number }[] { return this.chatDirectory.listAdmins(chatId); }
  syncAdmins(chatId: number, userIds: number[], now: number): void {
    this.tx(() => {
      if (!this.getGroup(chatId)) return;
      this.chatDirectory.replaceAdmins(chatId, userIds, now);
    });
  }
  /** Candidates only; callers must verify current Telegram authority. */
  candidateGroupsFor(userId: number): GroupRow[] { return this.chatDirectory.candidateGroupsFor(userId); }

  // ---------- Users ----------
  getPrefs(userId: number): PrefsRow | undefined {
    return this.preferences.getPrefs(userId);
  }
  /** Records a direct private message from the user: the only evidence they started a chat. */
  recordExplicitStart(userId: number, dmChatId: number, now: number): void {
    this.tx(() => {
      this.preferences.touch(userId, now);
      this.preferences.setExplicitChat(userId, dmChatId);
    });
  }
  setLocale(userId: number, locale: Locale, now: number): void {
    this.tx(() => {
      this.preferences.touch(userId, now);
      this.preferences.setLocale(userId, locale);
      // A language change never mints a new challenge or resets limits.
      this.run(
        `UPDATE sessions SET locale=? WHERE state IN ('preparing','active')
           AND request_id IN (SELECT id FROM join_requests WHERE user_id=?)`,
        locale,
        userId,
      );
    });
  }
  setAdminContext(userId: number, chatId: number | null, now: number): void {
    this.tx(() => {
      this.preferences.touch(userId, now);
      this.preferences.setAdminContext(userId, chatId);
    });
  }
  // ---------- Limits ----------
  takeApprovalBudget(chatId: number, perMinute: number, now: number): boolean {
    return this.tx(() => this.rateLimits.take('approve', String(chatId), perMinute, perMinute / 60_000, now));
  }

  // ---------- Join requests ----------
  getRequest(id: string): RequestRow | undefined {
    return this.one<RequestRow>('SELECT * FROM join_requests WHERE id=?', id);
  }
  liveRequest(chatId: number, userId: number): RequestRow | undefined {
    return this.one<RequestRow>(
      `SELECT * FROM join_requests WHERE chat_id=? AND user_id=? AND state IN ${LIVE}`,
      chatId,
      userId,
    );
  }
  liveRequestsForUser(userId: number): RequestRow[] {
    return this.all<RequestRow>(
      `SELECT * FROM join_requests WHERE user_id=? AND state IN ${LIVE} ORDER BY created_at`,
      userId,
    );
  }
  reviewQueue(chatId: number, limit: number): RequestRow[] {
    return this.all<RequestRow>(
      `SELECT * FROM join_requests WHERE chat_id=? AND state='manual_review' ORDER BY created_at LIMIT ?`,
      chatId,
      limit,
    );
  }
  countByState(chatId: number): Record<string, number> {
    const rows = this.all<{ state: string; n: number }>(
      'SELECT state, COUNT(*) AS n FROM join_requests WHERE chat_id=? GROUP BY state',
      chatId,
    );
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  private setRequest(r: RequestRow, state: RequestState, reason: string, now: number): void {
    this.run(
      'UPDATE join_requests SET state=?, reason_code=?, revision=revision+1, updated_at=? WHERE id=?',
      state,
      reason,
      now,
      r.id,
    );
    this.audit(r.chat_id, null, r.user_id, `request_${state}`, reason, now, r.id);
  }
  private closeSessions(requestId: string, state: SessionState): void {
    this.run(
      `DELETE FROM callback_tokens WHERE session_id IN
         (SELECT id FROM sessions WHERE request_id=? AND state IN ('preparing','active'))`,
      requestId,
    );
    this.run(
      `UPDATE sessions SET state=?, answer_position=NULL WHERE request_id=? AND state IN ('preparing','active')`,
      state,
      requestId,
    );
  }
  private cancelOutbox(requestId: string): void {
    this.outbox.cancelRequest(requestId);
  }
  private closeRequest(r: RequestRow, state: RequestState, reason: string, now: number): void {
    this.closeSessions(r.id, 'cancelled');
    this.cancelOutbox(r.id);
    this.resumeTokens.removeRequest(r.id);
    this.setRequest(r, state, reason, now);
  }

  recordJoin(input: {
    updateId: number;
    chatId: number;
    userId: number;
    contactChatId: number;
    requestDate: number;
    now: number;
    kind?: 'request' | 'member';
  }): JoinResult {
    const { updateId, chatId, userId, now } = input;
    const kind = input.kind ?? 'request';
    return this.tx((): JoinResult => {
      const group = this.getGroup(chatId);
      if (!group || !group.enabled) return { kind: 'ignored', reason: 'unconfigured' };
      if (this.one('SELECT 1 FROM join_requests WHERE source_update_id=?', updateId)) return { kind: 'duplicate' };
      const live = this.liveRequest(chatId, userId);
      if (live && live.request_date === input.requestDate) return { kind: 'duplicate' };
      const settings = this.settingsOf(group);
      if (kind === 'member' && !settings.quarantine) return { kind: 'ignored', reason: 'unconfigured' };
      const liveCount = this.one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM join_requests WHERE chat_id=? AND state IN ${LIVE}`,
        chatId,
      )!.n;
      if (!live && liveCount >= POLICY.maxLiveRequestsPerGroup) {
        this.bumpCounter(`overflow:${chatId}`);
        return { kind: 'ignored', reason: 'overflow' };
      }
      if (live) this.closeRequest(live, 'superseded', 'new_request', now);
      const generation =
        this.one<{ g: number }>(
          'SELECT COALESCE(MAX(generation),0)+1 AS g FROM join_requests WHERE chat_id=? AND user_id=?',
          chatId,
          userId,
        )!.g;
      const burstOk = this.rateLimits.take('burst', String(chatId), settings.burstThreshold, settings.burstThreshold / 60_000, now);
      let raid = group.raid_mode === 1;
      let raidStarted = false;
      if (!burstOk && !raid) {
        this.groups.setRaid(chatId, true, now);
        this.audit(chatId, null, null, 'raid_on', 'arrival_burst', now);
        raid = true;
        raidStarted = true;
      }
      const id = this.rng.token();
      this.run(
        `INSERT INTO join_requests(id,chat_id,user_id,contact_chat_id,request_date,source_update_id,generation,
           state,reason_code,deadline_at,created_at,updated_at,kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        chatId,
        userId,
        input.contactChatId,
        input.requestDate,
        updateId,
        generation,
        raid ? 'manual_review' : 'pending',
        raid ? 'raid_mode' : null,
        input.requestDate + (this.requireCap ? settings.requestLifetimeMin * 60_000 : settings.challengeTimeoutSec * 1000),
        now,
        now,
        kind,
      );
      this.audit(chatId, null, userId, kind === 'member' ? 'member_joined' : 'join_request', raid ? 'raid_mode' : 'received', now, id);
      const request = this.getRequest(id)!;
      if (kind === 'member') {
        // Mute first in every case; the verification prompt is only posted outside raid mode.
        this.enqueue({ dedupeKey: `quarantine:${id}`, requestId: id, revision: null, kind: 'quarantine', payload: { prompt: !raid }, now });
        return raid ? { kind: 'review', request, raidStarted } : { kind: 'created', request };
      }
      if (raid) return { kind: 'review', request, raidStarted };
      this.enqueue({ dedupeKey: `invite:${id}`, requestId: id, revision: 0, kind: 'invite', payload: {}, now });
      return { kind: 'created', request };
    });
  }

  private bumpCounter(key: string): void {
    const cur = Number(this.getState(`count:${key}`) ?? '0');
    this.setState(`count:${key}`, String(cur + 1));
  }

  createResumeToken(requestId: string, expiresAt: number): string {
    return this.resumeTokens.create(requestId, expiresAt);
  }
  /** A live link only locates the caller's own unresolved request; it grants no admission. */
  resolveResumeToken(token: string, userId: number, now: number): RequestRow | undefined {
    const requestId = this.resumeTokens.requestId(token, now);
    const request = requestId ? this.getRequest(requestId) : undefined;
    return request && request.user_id === userId && LIVE_REQUEST_STATES.includes(request.state) ? request : undefined;
  }

  /** Moves a pending/challenging request to manual review (help requested, raid, limits…). */
  toReview(requestId: string, userId: number | null, reason: string, now: number): boolean {
    return this.tx(() => {
      const r = this.getRequest(requestId);
      if (!r || (r.state !== 'pending' && r.state !== 'challenging')) return false;
      if (userId !== null && r.user_id !== userId) return false;
      this.closeSessions(r.id, 'cancelled');
      this.cancelOutbox(r.id);
      this.setRequest(r, 'manual_review', reason, now);
      return true;
    });
  }

  /**
   * An administrator lets someone in review try again: the request returns to pending with a
   * fresh time window and a clean attempt count. Returns the row as it was before the change.
   */
  grantRetry(requestId: string, chatId: number, actor: number, now: number): RequestRow | undefined {
    return this.tx(() => {
      const r = this.getRequest(requestId);
      const group = this.getGroup(chatId);
      if (!r || !group || r.chat_id !== chatId || r.state !== 'manual_review') return undefined;
      const settings = this.settingsOf(group);
      this.run('DELETE FROM attempts WHERE chat_id=? AND user_id=?', r.chat_id, r.user_id);
      this.run(
        `UPDATE join_requests SET state='pending', reason_code='retry_granted', revision=revision+1,
           deadline_at=?, prompt_message_id=NULL, updated_at=? WHERE id=?`,
        now + (this.requireCap && !this.capPassed(r.id) ? settings.requestLifetimeMin * 60_000 : settings.challengeTimeoutSec * 1000),
        now,
        r.id,
      );
      this.capStorage.resetUnpassed(r.id);
      this.audit(r.chat_id, actor, r.user_id, 'retry_granted', 'manual_review', now, r.id);
      if (r.kind === 'member') {
        // Post a fresh Verify button in the group (the mute is simply re-applied).
        this.enqueue({ dedupeKey: `quarantine:${r.id}:${r.revision + 1}`, requestId: r.id, revision: null, kind: 'quarantine', payload: { prompt: true }, now });
      }
      return r;
    });
  }

  noteVerificationServiceIssue(now: number): void {
    this.setState('verification_service_issue_at', String(now));
  }

  /** Only delivered challenges may cause an automatic removal. Service failures stay in review. */
  private failVerification(r: RequestRow, reason: string, now: number, delivered?: boolean): void {
    const group = this.getGroup(r.chat_id);
    const wasDelivered = delivered ?? (this.requireCap && !this.capPassed(r.id)
      ? r.prompt_message_id !== null || !!this.db.query('SELECT 1 FROM cap_messages WHERE request_id=?').get(r.id)
      : !!this.db.query("SELECT 1 FROM sessions WHERE request_id=? AND message_id IS NOT NULL AND state IN ('active','failed','expired')").get(r.id));
    const serviceIssue = Number(this.getState('verification_service_issue_at') ?? 0) >= r.created_at
      || !!this.db.query("SELECT 1 FROM outbox WHERE request_id=? AND kind IN ('quarantine','invite','prepare_round','cap_picture') AND last_error_code IS NOT NULL").get(r.id);
    if (this.autoRemoveFailed && group?.enabled && !group.raid_mode && wasDelivered && !serviceIssue && now <= r.deadline_at + 30_000) {
      this.queueDecision(r.id, r.chat_id, 'decline', 0, now, reason);
    } else this.setRequest(r, 'manual_review', reason, now);
  }

  /** Records a reviewer's decision and queues the Telegram action. */
  queueDecision(requestId: string, chatId: number, decision: 'approve' | 'decline', actor: number, now: number, reason = 'manual_review'): boolean {
    return this.tx(() => {
      const r = this.getRequest(requestId);
      if (!r || r.chat_id !== chatId) return false;
      if (r.state !== 'manual_review' && r.state !== 'pending' && r.state !== 'challenging') return false;
      this.closeSessions(r.id, 'cancelled');
      this.cancelOutbox(r.id);
      const state: RequestState = decision === 'approve' ? 'approval_pending' : 'decline_pending';
      this.run(
        'UPDATE join_requests SET state=?, reason_code=?, revision=revision+1, updated_at=? WHERE id=?',
        state,
        reason,
        now,
        r.id,
      );
      this.audit(r.chat_id, reason === 'manual_review' ? actor : null, r.user_id, reason === 'manual_review' ? `review_${decision}` : 'automatic_decline', reason, now, r.id);
      this.enqueue({
        dedupeKey: `${decision}:${r.id}:${r.revision + 1}`,
        requestId: r.id,
        revision: r.revision + 1,
        kind: decision,
        payload: { manual: reason === 'manual_review' },
        now,
      });
      return true;
    });
  }

  /** Final resolution after a Telegram action; guarded by the expected revision. */
  resolveRequest(requestId: string, revision: number, state: RequestState, reason: string, now: number): boolean {
    return this.tx(() => {
      const r = this.getRequest(requestId);
      if (!r || r.revision !== revision) return false;
      this.closeRequest(r, state, reason, now);
      return true;
    });
  }

  setPromptMessage(requestId: string, messageId: number | null): void {
    this.run('UPDATE join_requests SET prompt_message_id=? WHERE id=?', messageId, requestId);
  }
  /** A muted newcomer left before a decision: close the record; nothing else to do. */
  recordDeparture(chatId: number, userId: number, now: number): RequestRow | undefined {
    return this.tx(() => {
      const r = this.liveRequest(chatId, userId);
      if (!r || r.kind !== 'member') return undefined;
      this.closeRequest(r, 'external_resolution', 'member_left', now);
      return r;
    });
  }

  /** An administrator banned the user: close any open verification and audit who did it. */
  recordBan(chatId: number, userId: number, actor: number, now: number): RequestRow | undefined {
    return this.tx(() => {
      const r = this.liveRequest(chatId, userId);
      if (r) this.closeRequest(r, 'declined', 'banned', now);
      this.audit(chatId, actor, userId, 'user_banned', 'admin_command', now, r?.id ?? '');
      return r;
    });
  }

  /** Membership observed outside this bot's own approval: never credited as a CAPTCHA pass. */
  recordMembership(chatId: number, userId: number, now: number): RequestRow | undefined {
    return this.tx(() => {
      const r = this.liveRequest(chatId, userId);
      if (!r) return undefined;
      if (r.kind === 'member' || r.state === 'approval_pending') return undefined; // already tracked / being reconciled
      this.closeRequest(r, 'external_resolution', 'member_observed', now);
      return r;
    });
  }

  // ---------- Sessions ----------
  getSession(id: string): SessionRow | undefined {
    return this.one<SessionRow>('SELECT * FROM sessions WHERE id=?', id);
  }
  liveSession(requestId: string): SessionRow | undefined {
    return this.one<SessionRow>(`SELECT * FROM sessions WHERE request_id=? AND state IN ('preparing','active')`, requestId);
  }
  activeSessionCount(): number {
    return this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions WHERE state IN ('preparing','active')`)!.n;
  }
  private attemptsUsed(chatId: number, userId: number, windowMs: number, now: number): number {
    return this.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM attempts WHERE chat_id=? AND user_id=? AND started_at>?',
      chatId,
      userId,
      now - windowMs,
    )!.n;
  }

  beginAttempt(input: { requestId: string; actorId: number; locale: Locale; now: number; maxActiveSessions: number }): BeginResult {
    const { now } = input;
    return this.tx((): BeginResult => {
      const r = this.getRequest(input.requestId);
      if (!r || r.user_id !== input.actorId) return { ok: false, reason: 'not_live' };
      if (r.state === 'manual_review' || r.state === 'approval_pending') return { ok: false, reason: 'review' };
      if (r.state !== 'pending' && r.state !== 'challenging') return { ok: false, reason: 'not_live' };
      const group = this.getGroup(r.chat_id);
      if (!group || !group.enabled) {
        this.setRequest(r, 'manual_review', 'group_paused', now);
        return { ok: false, reason: 'review' };
      }
      if (group.raid_mode) {
        this.setRequest(r, 'manual_review', 'raid_mode', now);
        return { ok: false, reason: 'raid' };
      }
      if (this.requireCap && !this.capPassed(r.id)) return { ok: false, reason: 'cap_required' };
      const existing = this.liveSession(r.id);
      if (existing) return { ok: true, sessionId: existing.id, existing: true };
      const settings = this.settingsOf(group);
      if (this.attemptsUsed(r.chat_id, r.user_id, settings.attemptWindowMin * 60_000, now) >= settings.attempts) {
        this.failVerification(r, 'attempts_exhausted', now);
        return { ok: false, reason: 'exhausted' };
      }
      const prefs = this.getPrefs(r.user_id);
      // In-group checks have no contact window; private ones need a chat the user started.
      const limit = r.kind === 'member' || prefs?.explicit_dm_chat_id != null ? r.deadline_at : Math.min(r.deadline_at, r.request_date + POLICY.contactWindowMs);
      // The current stage owns its deadline; picture retries never reset it.
      const expiresAt = limit;
      if (expiresAt <= now) {
        if (r.deadline_at <= now) {
          this.failVerification(r, 'expired', now);
          return { ok: false, reason: 'expired' };
        }
        return { ok: false, reason: 'time_short' };
      }
      const recent = this.one<{ n: number }>(
        'SELECT COUNT(*) AS n FROM attempts WHERE user_id=? AND started_at>?',
        r.user_id,
        now - POLICY.crossGroupWindowMs,
      )!.n;
      if (recent >= POLICY.crossGroupStarts) return { ok: false, reason: 'deferred' };
      if (this.activeSessionCount() >= input.maxActiveSessions) return { ok: false, reason: 'capacity' };

      const sessionId = this.rng.token();
      const attemptNo =
        this.one<{ n: number }>('SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM sessions WHERE request_id=?', r.id)!.n;
      this.run(
        `INSERT INTO sessions(id,request_id,attempt_no,locale,state,policy_version,expires_at,created_at)
         VALUES (?,?,?,?,'preparing',?,?,?)`,
        sessionId,
        r.id,
        attemptNo,
        input.locale,
        POLICY.version,
        expiresAt,
        now,
      );
      this.run('INSERT INTO attempts(chat_id,user_id,started_at,session_id) VALUES (?,?,?,?)', r.chat_id, r.user_id, now, sessionId);
      if (r.state !== 'challenging') {
        this.run(`UPDATE join_requests SET state='challenging', updated_at=? WHERE id=?`, now, r.id);
      }
      this.enqueue({
        dedupeKey: `round:${sessionId}:1`,
        requestId: r.id,
        revision: null,
        kind: 'prepare_round',
        payload: { sessionId },
        now,
      });
      return { ok: true, sessionId, existing: false };
    });
  }

  /** Persists a generated round before it is sent. Token index = board position. */
  activateRound(input: {
    sessionId: string;
    roundNo: number;
    answerPosition: number;
    answerItem: string;
    boardHash: string;
    questionJson: string;
    tokenHashes: string[];
    now: number;
  }): boolean {
    return this.tx(() => {
      const s = this.getSession(input.sessionId);
      if (!s || s.state !== 'preparing' || s.round_no !== input.roundNo || s.expires_at <= input.now) return false;
      const used = JSON.parse(s.used_items_json) as string[];
      this.run(
        `UPDATE sessions SET state='active', answer_position=?, board_hash=?, question_json=?,
           used_items_json=?, message_id=NULL WHERE id=?`,
        input.answerPosition,
        input.boardHash,
        input.questionJson,
        JSON.stringify([...used, input.answerItem]),
        s.id,
      );
      this.insertTokens(s.id, s.round_version, input.tokenHashes, s.expires_at);
      return true;
    });
  }
  /** Replaces the token set of an active round (resend, language change). Same board, same answer. */
  reissueTokens(sessionId: string, tokenHashes: string[], now: number): SessionRow | undefined {
    return this.tx(() => {
      const s = this.getSession(sessionId);
      if (!s || s.state !== 'active' || s.expires_at <= now) return undefined;
      this.run('DELETE FROM callback_tokens WHERE session_id=?', s.id);
      this.run('UPDATE sessions SET round_version=round_version+1, message_id=NULL WHERE id=?', s.id);
      this.insertTokens(s.id, s.round_version + 1, tokenHashes, s.expires_at);
      return this.getSession(s.id);
    });
  }
  private insertTokens(sessionId: string, roundVersion: number, hashes: string[], expiresAt: number): void {
    hashes.forEach((hash, choice) => {
      this.run(
        `INSERT INTO callback_tokens(token_hash,session_id,round_version,action,choice,expires_at)
         VALUES (?,?,?,'answer',?,?)`,
        hash,
        sessionId,
        roundVersion,
        choice,
        expiresAt,
      );
    });
  }
  /** Group check pictures whose session has ended (ban, leave, decision, expiry): hand them over once for deletion. */
  takeClosedGroupMessages(limit: number): { chatId: number; messageId: number }[] {
    return this.tx(() => {
      const rows = this.all<{ id: string; message_id: number; chat_id: number }>(
        `SELECT s.id, s.message_id, r.chat_id FROM sessions s JOIN join_requests r ON r.id=s.request_id
         WHERE r.kind='member' AND s.message_id IS NOT NULL AND s.state NOT IN ('preparing','active') LIMIT ?`,
        limit,
      );
      for (const row of rows) this.run('UPDATE sessions SET message_id=NULL WHERE id=?', row.id);
      return rows.map((row) => ({ chatId: row.chat_id, messageId: row.message_id }));
    });
  }
  setSessionMessage(sessionId: string, roundVersion: number, messageId: number): void {
    this.run('UPDATE sessions SET message_id=? WHERE id=? AND round_version=?', messageId, sessionId, roundVersion);
  }

  /** One immediate transaction, no awaits: the single authority for an applicant's answer. */
  answer(input: { actorId: number; privateChatId: number; token: string; now: number; skip?: boolean }): AnswerResult {
    const { now } = input;
    return this.tx((): AnswerResult => {
      const row = this.one<{
        choice: number;
        t_round: number;
        t_expires: number;
        consumed_at: number | null;
        action: string;
        session_id: string;
      }>(
        `SELECT choice, round_version AS t_round, expires_at AS t_expires, consumed_at, action, session_id
         FROM callback_tokens WHERE token_hash=?`,
        tokenHash(input.token),
      );
      if (!row || row.action !== 'answer' || row.consumed_at !== null || row.t_expires <= now) return { result: 'stale' };
      const s = this.getSession(row.session_id);
      if (!s || s.state !== 'active' || s.round_version !== row.t_round || s.expires_at <= now) return { result: 'stale' };
      const r = this.getRequest(s.request_id);
      if (!r || r.state !== 'challenging' || r.user_id !== input.actorId) return { result: 'stale' };
      if (this.requireCap && !this.capPassed(r.id)) return { result: 'stale' };
      const prefs = this.getPrefs(r.user_id);
      // A member's check lives in the group itself; a join request's check lives in private chat.
      const rightChat =
        r.kind === 'member'
          ? input.privateChatId === r.chat_id
          : input.privateChatId === r.contact_chat_id || input.privateChatId === prefs?.explicit_dm_chat_id;
      if (!rightChat) return { result: 'stale' };
      const base = { sessionId: s.id, requestId: r.id, chatId: r.chat_id, locale: s.locale, messageId: s.message_id };
      if (input.skip) {
        const used = this.auditLog.questionSkips(r.id);
        if (used >= 3) return {result:'skip-limit'};
      }
      // Consume every token of the round: only one competing callback can win.
      this.run('DELETE FROM callback_tokens WHERE session_id=?', s.id);

      const group = this.getGroup(r.chat_id);
      if (!group || !group.enabled || group.raid_mode) {
        this.run(`UPDATE sessions SET state='cancelled', answer_position=NULL WHERE id=?`, s.id);
        this.setRequest(r, 'manual_review', group?.raid_mode ? 'raid_mode' : 'group_paused', now);
        return { result: 'review', ...base, canRetry: false };
      }
      if (input.skip) {
        this.run(`UPDATE sessions SET state='preparing', round_version=round_version+1,
          answer_position=NULL, board_hash=NULL, question_json=NULL WHERE id=?`, s.id);
        this.audit(r.chat_id, input.actorId, r.user_id, 'question_skipped', 'user_requested', now, r.id);
        this.enqueue({dedupeKey:`skip:${s.id}:${s.round_version + 1}`, requestId:r.id, revision:null,
          kind:'prepare_round', payload:{sessionId:s.id}, now});
        return {result:'next-round', ...base, canRetry:false};
      }
      if (row.choice !== s.answer_position) {
        this.run(`UPDATE sessions SET state='failed', answer_position=NULL WHERE id=?`, s.id);
        const settings = this.settingsOf(group);
        const used = this.attemptsUsed(r.chat_id, r.user_id, settings.attemptWindowMin * 60_000, now);
        const canRetry = used < settings.attempts && r.deadline_at > now;
        if (canRetry) {
          this.run(`UPDATE join_requests SET state='pending', updated_at=? WHERE id=?`, now, r.id);
          this.audit(r.chat_id, null, r.user_id, 'attempt_failed', 'wrong_answer', now, r.id);
        } else {
          this.failVerification(r, 'attempts_exhausted', now);
        }
        return { result: 'wrong', ...base, canRetry };
      }
      if (s.round_no < (this.capPassed(r.id) ? 1 : POLICY.rounds)) {
        this.run(
          `UPDATE sessions SET state='preparing', round_no=round_no+1, round_version=round_version+1,
             answer_position=NULL, board_hash=NULL, question_json=NULL WHERE id=?`,
          s.id,
        );
        this.enqueue({
          dedupeKey: `round:${s.id}:${s.round_no + 1}`,
          requestId: r.id,
          revision: null,
          kind: 'prepare_round',
          payload: { sessionId: s.id },
          now,
        });
        return { result: 'next-round', ...base, canRetry: false };
      }
      this.run(`UPDATE sessions SET state='passed', answer_position=NULL WHERE id=?`, s.id);
      this.run(
        `UPDATE join_requests SET state='approval_pending', reason_code='challenge_passed',
           revision=revision+1, updated_at=? WHERE id=?`,
        now,
        r.id,
      );
      this.audit(r.chat_id, null, r.user_id, 'challenge_passed', this.capPassed(r.id) ? 'cap_and_one_picture' : 'two_rounds', now, r.id);
      this.enqueue({
        dedupeKey: `approve:${r.id}:${r.revision + 1}`,
        requestId: r.id,
        revision: r.revision + 1,
        kind: 'approve',
        payload: {},
        now,
      });
      return { result: 'approval-queued', ...base, canRetry: false };
    });
  }

  /** Expires overdue sessions in a bounded batch. */
  expireSessions(now: number, batch: number): ExpiredSession[] {
    return this.tx(() => {
      const rows = this.all<SessionRow>(
        `SELECT * FROM sessions WHERE state IN ('preparing','active') AND expires_at<=? LIMIT ?`,
        now,
        batch,
      );
      const out: ExpiredSession[] = [];
      for (const s of rows) {
        this.run('DELETE FROM callback_tokens WHERE session_id=?', s.id);
        this.run(`UPDATE sessions SET state='expired', answer_position=NULL WHERE id=?`, s.id);
        const r = this.getRequest(s.request_id);
        if (!r) continue;
        this.cancelOutbox(r.id);
        let canRetry = false;
        if (r.state === 'challenging') {
          const group = this.getGroup(r.chat_id);
          const settings = group ? this.settingsOf(group) : undefined;
          canRetry =
            !!settings &&
            !!group?.enabled &&
            !group.raid_mode &&
            this.attemptsUsed(r.chat_id, r.user_id, settings.attemptWindowMin * 60_000, now) < settings.attempts &&
            r.deadline_at > now;
          if (canRetry) this.run(`UPDATE join_requests SET state='pending', updated_at=? WHERE id=?`, now, r.id);
          else this.failVerification(r, 'challenge_expired', now, s.state === 'active' && s.message_id !== null);
        }
        out.push({
          sessionId: s.id,
          requestId: r.id,
          userId: r.user_id,
          chatId: r.chat_id,
          contactChatId: r.contact_chat_id,
          locale: s.locale,
          messageId: s.message_id,
          canRetry,
        });
      }
      return out;
    });
  }
  /** Expire overdue requests; delivered checks may queue automatic removal. */
  expireRequests(now: number, batch: number): RequestRow[] {
    return this.tx(() => {
      const rows = this.all<RequestRow>(
        `SELECT * FROM join_requests WHERE state IN ('pending','challenging') AND deadline_at<=? LIMIT ?`,
        now,
        batch,
      );
      for (const r of rows) {
        this.closeSessions(r.id, 'expired');
        this.cancelOutbox(r.id);
        this.failVerification(r, 'expired', now);
      }
      return rows;
    });
  }

  // ---------- Action tokens (admin buttons, confirmations) ----------
  createActionToken(actor: number, payload: ActionPayload, expiresAt: number): string {
    return this.actionTokens.createActionToken(actor, payload, expiresAt);
  }
  /** One-use and actor-bound; current authorization is checked by the caller. */
  consumeActionToken(token: string, actor: number, now: number): ActionPayload | undefined {
    return this.actionTokens.consumeActionToken(token, actor, now);
  }

  // ---------- Durable queues (same SQLite connection and surrounding transactions) ----------
  private enqueue(work: EnqueueWork): void {
    this.outbox.enqueue(work);
  }
  claimOutbox(now: number, batch: number, leaseMs: number): OutboxRow[] {
    return this.outbox.claimOutbox(now, batch, leaseMs);
  }
  completeOutbox(id: string): void { this.outbox.completeOutbox(id); }
  retryOutbox(id: string, code: string, nextAt: number, countAttempt: boolean): void {
    this.outbox.retryOutbox(id, code, nextAt, countAttempt);
  }
  failOutbox(id: string, code: string, applyFailure?: () => void): void {
    this.outbox.failOutbox(id, code, applyFailure);
  }
  outboxStats(now: number): { pending: number; oldestAgeMs: number } { return this.outbox.outboxStats(now); }

  nextOffset(): number | undefined { return this.inbox.nextOffset(); }
  storeBatchAndAdvance(updates: { update_id: number; payload: object | null }[], now: number): void {
    this.inbox.storeBatchAndAdvance(updates, now);
  }
  claimInbox(now: number, batch: number): InboxRow[] { return this.inbox.claimInbox(now, batch); }
  completeInbox(updateId: number): void { this.inbox.completeInbox(updateId); }
  failInbox(updateId: number, now: number): void { this.inbox.failInbox(updateId, now); }
  inboxStats(now: number): { pending: number; failed: number; oldestAgeMs: number } { return this.inbox.inboxStats(now); }

  // ---------- Telegram file cache ----------
  cacheGet(botId: number, hash: string, now: number): string | undefined {
    return this.photoCache.cacheGet(botId, hash, now);
  }
  cachePut(botId: number, hash: string, fileId: string, uniqueId: string | null, now: number): void {
    this.photoCache.cachePut(botId, hash, fileId, uniqueId, now);
  }
  cacheRemove(botId: number, hash: string): void {
    this.photoCache.cacheRemove(botId, hash);
  }

  // ---------- Review alerts ----------
  /** Groups with review items newer than their last alert, at most once per interval. */
  dueReviewAlerts(now: number): { chatId: number; waiting: number }[] {
    const rows = this.all<{ chat_id: number; n: number; newest: number }>(
      `SELECT chat_id, COUNT(*) AS n, MAX(updated_at) AS newest FROM join_requests
       WHERE state='manual_review' GROUP BY chat_id`,
    );
    const due: { chatId: number; waiting: number }[] = [];
    for (const row of rows) {
      const last = Number(this.getState(`alert:${row.chat_id}`) ?? '0');
      if (row.newest > last && now - last >= POLICY.alertIntervalMs) {
        this.setState(`alert:${row.chat_id}`, String(now));
        due.push({ chatId: row.chat_id, waiting: row.n });
      }
    }
    return due;
  }

  // ---------- Retention ----------
  /** Hourly maintenance in bounded batches. Returns board hashes that are no longer referenced. */
  purge(now: number, batch = 500): { reviewExpired: RequestRow[] } {
    const day = 86_400_000;
    return this.tx(() => {
      this.usernames.purge(now, batch);
      const reviewExpired: RequestRow[] = [];
      for (const g of this.listGroups()) {
        const s = this.settingsOf(g);
        const stale = this.all<RequestRow>(
          `SELECT * FROM join_requests WHERE chat_id=? AND state='manual_review' AND updated_at<=? LIMIT ?`,
          g.chat_id,
          now - s.reviewExpiryDays * day,
          batch,
        );
        for (const r of stale) {
          this.closeRequest(r, 'expired', 'review_expired', now);
          reviewExpired.push(r);
        }
        this.auditLog.purgeGroup(g.chat_id, now - s.auditRetentionDays * day, batch);
      }
      const lim = (sql: string, ...p: (string | number)[]) => this.run(sql, ...p, batch);
      this.auditLog.purge(now - 30 * day, batch);
      lim(
        `DELETE FROM join_requests WHERE id IN (SELECT id FROM join_requests
           WHERE state NOT IN ${LIVE} AND state NOT IN ('decline_pending') AND updated_at<=? LIMIT ?)`,
        now - 30 * day,
      );
      lim(
        `DELETE FROM sessions WHERE id IN (SELECT id FROM sessions
           WHERE state NOT IN ('preparing','active') AND created_at<=? LIMIT ?)`,
        now - day,
      );
      lim(`DELETE FROM callback_tokens WHERE token_hash IN (SELECT token_hash FROM callback_tokens WHERE expires_at<=? LIMIT ?)`, now);
      this.resumeTokens.purge(now, batch);
      this.actionTokens.purge(now, batch);
      lim(`DELETE FROM attempts WHERE rowid IN (SELECT rowid FROM attempts WHERE started_at<=? LIMIT ?)`, now - day);
      this.rateLimits.purge(now, batch);
      this.inbox.purge(now, batch);
      this.outbox.purge(now, batch);
      this.photoCache.purge(now, batch);
      this.preferences.purge(now, batch);
      return { reviewExpired };
    });
  }
}
