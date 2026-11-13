import type { Database } from 'bun:sqlite';
import { tokenHash, type Rng } from '@guard/core';

/** Reusable navigation links, not proof of identity or a completed verification. */
export class SqliteResumeTokens {
  constructor(private readonly db: Database, private readonly rng: Rng) {}

  create(requestId: string, expiresAt: number): string {
    const token = this.rng.token();
    this.db.query('INSERT INTO resume_tokens(token_hash,request_id,expires_at) VALUES (?,?,?)')
      .run(tokenHash(token), requestId, expiresAt);
    return token;
  }
  requestId(token: string, now: number): string | undefined {
    const row = this.db.query('SELECT request_id FROM resume_tokens WHERE token_hash=? AND expires_at>?')
      .get(tokenHash(token), now) as { request_id: string } | null;
    return row?.request_id;
  }
  removeRequest(requestId: string): void {
    this.db.query('DELETE FROM resume_tokens WHERE request_id=?').run(requestId);
  }
  purge(now: number, batch: number): void {
    this.db.query('DELETE FROM resume_tokens WHERE token_hash IN (SELECT token_hash FROM resume_tokens WHERE expires_at<=? LIMIT ?)')
      .run(now, batch);
  }
}
