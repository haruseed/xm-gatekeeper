import { generateChallenge, validateChallenge, type ValidateChallengeBody } from 'capjs-core';
import { log, type Clock, type Config, type Locale } from '@guard/core';
import type { CapRepository, CapRequest } from '@guard/database';
import type { ApplicationLifecycle } from '../lifecycle';
import { telegramUser } from './telegram-auth';

export type CapEngine = { generateChallenge: typeof generateChallenge; validateChallenge: typeof validateChallenge };
export const defaultCapEngine: CapEngine = { generateChallenge, validateChallenge };
export interface CapVerification {
  localeFor(userId: number, chatId?: number): Locale;
  drainOutbox(): Promise<void>;
}
export interface CapReply { body: unknown; status?: number }

/** Browser verification decisions; independent of HTTP upload/concurrency handling. */
export class CapService {
  constructor(
    private readonly config: Pick<Config, 'cap' | 'botToken' | 'maxActiveSessions'>,
    private readonly store: CapRepository,
    private readonly verification: CapVerification,
    private readonly clock: Clock,
    private readonly engine: CapEngine,
    private readonly tasks?: Pick<ApplicationLifecycle, 'track'>,
  ) {}

  ticket(ticket: string, now: number): CapRequest | undefined {
    return this.store.capTicket(ticket, now);
  }

  private returnLink(requestId: string): string | undefined {
    const request = this.store.getRequest(requestId);
    const session = this.store.liveSession(requestId);
    if (request?.kind !== 'member' || !session?.message_id || !/^-100[0-9]+$/.test(String(request.chat_id))) return undefined;
    return `https://t.me/c/${String(request.chat_id).slice(4)}/${session.message_id}`;
  }
  private pictureState(requestId: string): Record<string, unknown> {
    const request = this.store.getRequest(requestId);
    const session = this.store.liveSession(requestId);
    if (request?.state === 'approved' || request?.state === 'approval_pending') return { state: 'finished' };
    if (!request || request.deadline_at <= this.clock.now() || ['manual_review', 'expired', 'declined', 'cancelled', 'external_resolution'].includes(request.state)) return { state: 'review' };
    if (session?.state === 'active' && session.message_id && session.expires_at > this.clock.now()) {
      return { state: 'ready', returnUrl: this.returnLink(requestId) };
    }
    return { state: 'waiting' };
  }
  private kickDelivery(): void {
    const delivery = this.verification.drainOutbox().catch(() => log('warn', 'cap_delivery_deferred', {}));
    this.tasks?.track(delivery);
  }

  session(route: '/session' | '/status', body: Record<string, unknown>, now: number): CapReply {
    if (typeof body.initData !== 'string' || typeof body.requestId !== 'string') return { body: { success: false }, status: 400 };
    const userId = telegramUser(body.initData, this.config.botToken, now);
    const startParam = new URLSearchParams(body.initData).get('start_param');
    if (startParam && startParam !== 'cap_' + body.requestId) return { body: { success: false }, status: 403 };
    if (!userId || this.store.getRequest(body.requestId)?.user_id !== userId) return { body: { success: false }, status: 403 };
    if (route === '/status') return { body: this.pictureState(body.requestId) };
    if (!this.store.capEligible(body.requestId, userId, now)) return { body: { success: false }, status: 403 };
    if (this.store.capPassed(body.requestId)) {
      this.store.queueCapPicture(body.requestId, now);
      this.kickDelivery();
      return { body: { passed: true, ...this.pictureState(body.requestId) } };
    }
    return { body: { ticket: this.store.issueCapTicket(body.requestId, userId, now) } };
  }

  async challenge(ticket: string, request: CapRequest, now: number): Promise<CapReply> {
    if (!this.store.takeCapChallenge(ticket, now)) return { body: { success: false, reason: 'rate_limited' }, status: 429 };
    const body = await this.engine.generateChallenge(this.config.cap!.secret, {
      scope: ticket, expiresMs: Math.min(240_000, request.deadline_at - now), format: 2,
      protocols: ['hashwx', 'instrumentation'], instrumentation: { blockAutomatedBrowsers: true, obfuscationLevel: 3 },
    });
    return { body };
  }

  async redeem(ticket: string, request: CapRequest, body: Record<string, unknown>): Promise<CapReply> {
    if (typeof body.token !== 'string' || !Array.isArray(body.solutions)) return { body: { success: false }, status: 400 };
    const result = await this.engine.validateChallenge(this.config.cap!.secret, body as unknown as ValidateChallengeBody, {
      scope: ticket, consumeNonce: (hash, ttl) => this.store.consumeCapNonce(hash, ttl, this.clock.now()),
    });
    if (!result.success) return { body: { success: false, reason: result.reason }, status: 400 };
    if (!this.store.completeCap(ticket, this.clock.now(), this.verification.localeFor(request.user_id, request.chat_id), this.config.maxActiveSessions)) return { body: { success: false }, status: 409 };
    this.kickDelivery();
    return { body: { success: true, token: result.token, expires: result.expires, ...this.pictureState(request.id) } };
  }
}
