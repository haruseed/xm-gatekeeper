import type { Database } from 'bun:sqlite';
import type { Rng } from '@guard/core';
import type { EnqueueWork, OutboxRepository, OutboxRow } from './queue-repositories';

/** Outbox insertion joins workflow transactions; only claim operations open their own transaction. */
export class SqliteOutbox implements OutboxRepository {
  constructor(private readonly db: Database, private readonly rng: Rng) {}

  enqueue(work: EnqueueWork): void {
    this.db.query(`INSERT OR IGNORE INTO outbox(id,dedupe_key,request_id,request_revision,kind,payload_json,next_attempt_at,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(this.rng.token(), work.dedupeKey, work.requestId, work.revision,
      work.kind, JSON.stringify(work.payload), work.now, work.now);
  }
  claimOutbox(now: number, batch: number, leaseMs: number): OutboxRow[] {
    return this.db.transaction(() => {
      const rows = this.db.query(`SELECT * FROM outbox WHERE state='pending' AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?)
        ORDER BY CASE kind WHEN 'approve' THEN 0 WHEN 'decline' THEN 0 ELSE 1 END, created_at LIMIT ?`)
        .all(now, now, batch) as OutboxRow[];
      for (const row of rows) this.db.query('UPDATE outbox SET lease_until=? WHERE id=?').run(now + leaseMs, row.id);
      return rows;
    }).immediate();
  }
  completeOutbox(id: string): void {
    this.db.query("UPDATE outbox SET state='done', lease_until=NULL WHERE id=?").run(id);
  }
  retryOutbox(id: string, code: string, nextAt: number, countAttempt: boolean): void {
    this.db.query('UPDATE outbox SET attempts=attempts+?, last_error_code=?, next_attempt_at=?, lease_until=NULL WHERE id=?')
      .run(countAttempt ? 1 : 0, code, nextAt, id);
  }
  failOutbox(id: string, code: string, applyFailure?: () => void): void {
    this.db.transaction(() => {
      this.db.query("UPDATE outbox SET state='failed', last_error_code=?, lease_until=NULL WHERE id=?").run(code, id);
      applyFailure?.();
    }).immediate();
  }

  cancelRequest(requestId: string): void {
    // Muting is still required even if a request moved to review or was cancelled.
    this.db.query("UPDATE outbox SET state='cancelled' WHERE request_id=? AND state='pending' AND kind<>'quarantine'").run(requestId);
  }
  outboxStats(now: number): { pending: number; oldestAgeMs: number } {
    const row = this.db.query("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM outbox WHERE state='pending'")
      .get() as { n: number; oldest: number | null };
    return { pending: row.n, oldestAgeMs: row.oldest === null ? 0 : now - row.oldest };
  }
  purge(now: number, batch: number): void {
    this.db.query("DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE state<>'pending' AND created_at<=? LIMIT ?)")
      .run(now - 86_400_000, batch);
  }
}
