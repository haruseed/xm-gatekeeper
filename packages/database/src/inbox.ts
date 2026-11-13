import type { Database } from 'bun:sqlite';
import { POLICY } from '@guard/core';
import type { InboxRepository, InboxRow } from './queue-repositories';
import type { SqliteRuntimeState } from './runtime-state';

/** Durable Telegram intake. Uses the owning Store's connection, never a separate commit. */
export class SqliteInbox implements InboxRepository {
  constructor(private readonly db: Database, private readonly state: Pick<SqliteRuntimeState, 'getState' | 'setState'>) {}

  nextOffset(): number | undefined {
    const value = this.state.getState('poll_offset');
    return value === undefined ? undefined : Number(value);
  }
  storeBatchAndAdvance(updates: { update_id: number; payload: object | null }[], now: number): void {
    if (updates.length === 0) return;
    this.db.transaction(() => {
      let max = -1;
      for (const update of updates) {
        if (update.payload !== null) {
          this.db.query('INSERT OR IGNORE INTO inbox(update_id,payload_json,available_at,received_at) VALUES (?,?,?,?)')
            .run(update.update_id, JSON.stringify(update.payload), now, now);
        }
        max = Math.max(max, update.update_id);
      }
      this.state.setState('poll_offset', String(max + 1));
    }).immediate();
  }
  claimInbox(now: number, batch: number): InboxRow[] {
    return this.db.query("SELECT * FROM inbox WHERE status='pending' AND available_at<=? ORDER BY update_id LIMIT ?")
      .all(now, batch) as InboxRow[];
  }
  completeInbox(updateId: number): void {
    this.db.query('DELETE FROM inbox WHERE update_id=?').run(updateId);
  }
  failInbox(updateId: number, now: number): void {
    this.db.query(`UPDATE inbox SET attempts=attempts+1, available_at=?,
      status=CASE WHEN attempts+1>=? THEN 'failed' ELSE 'pending' END WHERE update_id=?`)
      .run(now + 2000, POLICY.inboxMaxAttempts, updateId);
  }
  inboxStats(now: number): { pending: number; failed: number; oldestAgeMs: number } {
    const row = this.db.query(`SELECT SUM(status='pending') AS n, SUM(status='failed') AS f,
      MIN(CASE WHEN status='pending' THEN received_at END) AS oldest FROM inbox`).get() as { n: number | null; f: number | null; oldest: number | null };
    return { pending: row.n ?? 0, failed: row.f ?? 0, oldestAgeMs: row.oldest === null ? 0 : now - row.oldest };
  }
  purge(now: number, batch: number): void {
    this.db.query("DELETE FROM inbox WHERE update_id IN (SELECT update_id FROM inbox WHERE status='failed' AND received_at<=? LIMIT ?)")
      .run(now - 86_400_000, batch);
  }
}
