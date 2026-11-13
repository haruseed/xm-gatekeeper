import type { Locale, RequestState, SessionState } from '@guard/core';

export interface CapRequest {
  id: string;
  user_id: number;
  chat_id: number;
  kind: 'request' | 'member';
  state: RequestState;
  deadline_at: number;
}
export interface CapSession {
  state: SessionState;
  message_id: number | null;
  expires_at: number;
}

/** Browser verification use case; all pass/session/outbox changes remain atomic in Store. */
export interface CapRepository {
  noteVerificationServiceIssue(now: number): void;
  getRequest(requestId: string): CapRequest | undefined;
  liveSession(requestId: string): CapSession | undefined;
  capEligible(requestId: string, userId: number, now: number): CapRequest | undefined;
  capPassed(requestId: string): boolean;
  queueCapPicture(requestId: string, now: number): void;
  issueCapTicket(requestId: string, userId: number, now: number): string | undefined;
  capTicket(ticket: string, now: number): CapRequest | undefined;
  takeCapChallenge(ticket: string, now: number): boolean;
  consumeCapNonce(hash: string, ttl: number, now: number): boolean;
  completeCap(ticket: string, now: number, locale: Locale, maxActiveSessions: number): boolean;
}
