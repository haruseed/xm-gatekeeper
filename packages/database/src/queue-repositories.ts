export interface OutboxRow {
  id: string;
  dedupe_key: string;
  request_id: string | null;
  request_revision: number | null;
  kind: string;
  payload_json: string;
  state: string;
  attempts: number;
  next_attempt_at: number;
  lease_until: number | null;
  last_error_code: string | null;
  created_at: number;
}
export interface InboxRow {
  update_id: number;
  payload_json: string;
  status: string;
  attempts: number;
  available_at: number;
  received_at: number;
}

export interface EnqueueWork {
  dedupeKey: string;
  requestId: string | null;
  revision: number | null;
  kind: string;
  payload: object;
  now: number;
}

export interface OutboxRepository {
  claimOutbox(now: number, batch: number, leaseMs: number): OutboxRow[];
  completeOutbox(id: string): void;
  retryOutbox(id: string, code: string, nextAt: number, countAttempt: boolean): void;
  /** Commit failure and synchronous workflow updates on the same connection/transaction. */
  failOutbox(id: string, code: string, applyFailure?: () => void): void;
  outboxStats(now: number): { pending: number; oldestAgeMs: number };
}

export interface InboxRepository {
  nextOffset(): number | undefined;
  /** Batch insertion and offset advancement must commit atomically. */
  storeBatchAndAdvance(updates: { update_id: number; payload: object | null }[], now: number): void;
  claimInbox(now: number, batch: number): InboxRow[];
  completeInbox(updateId: number): void;
  failInbox(updateId: number, now: number): void;
  inboxStats(now: number): { pending: number; failed: number; oldestAgeMs: number };
}
