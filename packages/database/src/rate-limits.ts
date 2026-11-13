import type { Database } from 'bun:sqlite';

/** Persistent token buckets on Store's connection. Call mutations inside the owning transaction. */
export class SqliteRateLimits {
  constructor(private readonly db: Database) {}

  take(scope: string, key: string, capacity: number, refillPerMs: number, now: number): boolean {
    const row = this.db.query('SELECT tokens, updated_at FROM limits WHERE scope=? AND bucket_key=?')
      .get(scope, key) as { tokens: number; updated_at: number } | null;
    let tokens = capacity;
    if (row) tokens = Math.min(capacity, row.tokens + Math.max(0, now - row.updated_at) * refillPerMs);
    const allowed = tokens >= 1;
    if (allowed) tokens -= 1;
    const expires = now + Math.ceil(capacity / refillPerMs) + 60_000;
    this.db.query(`INSERT INTO limits(scope,bucket_key,tokens,updated_at,expires_at) VALUES (?,?,?,?,?)
      ON CONFLICT(scope,bucket_key) DO UPDATE SET tokens=excluded.tokens,
        updated_at=excluded.updated_at, expires_at=excluded.expires_at`)
      .run(scope, key, tokens, now, expires);
    return allowed;
  }

  resetBurst(chatId: number): void {
    this.db.query("DELETE FROM limits WHERE scope='burst' AND bucket_key=?").run(String(chatId));
  }

  purge(now: number, batch: number): void {
    this.db.query('DELETE FROM limits WHERE rowid IN (SELECT rowid FROM limits WHERE expires_at<=? LIMIT ?)')
      .run(now, batch);
  }
}
