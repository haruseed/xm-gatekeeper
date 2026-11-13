import type { Database } from 'bun:sqlite';

export interface AuditRow {
  id: number;
  chat_id: number | null;
  actor_user_id: number | null;
  subject_user_id: number | null;
  action: string;
  reason_code: string;
  correlation_id: string;
  created_at: number;
}

/** Uses the caller's connection/transaction; audit insertion is never best-effort. */
export class SqliteAudit {
  constructor(private readonly db: Database) {}

  audit(chatId: number | null, actor: number | null, subject: number | null,
    action: string, reason: string, now: number, correlation = ''): void {
    this.db.query(`INSERT INTO audit_events(chat_id,actor_user_id,subject_user_id,action,reason_code,correlation_id,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(chatId, actor, subject, action, reason, correlation, now);
  }
  listAudit(chatId: number, limit: number): AuditRow[] {
    return this.db.query('SELECT * FROM audit_events WHERE chat_id=? ORDER BY id DESC LIMIT ?').all(chatId, limit) as AuditRow[];
  }
  questionSkips(requestId: string): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM audit_events WHERE correlation_id=? AND action='question_skipped'")
      .get(requestId) as { n: number } | null;
    return row?.n ?? 0;
  }
  purgeGroup(chatId: number, cutoff: number, batch: number): void {
    this.db.query('DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE chat_id=? AND created_at<=? LIMIT ?)')
      .run(chatId, cutoff, batch);
  }
  purge(cutoff: number, batch: number): void {
    this.db.query('DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE created_at<=? LIMIT ?)')
      .run(cutoff, batch);
  }
}
