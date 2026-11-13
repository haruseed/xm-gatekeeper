import type { Database } from 'bun:sqlite';

/** Shared connection, no independent transactions: callers own workflow atomicity. */
export class SqliteRuntimeState {
  constructor(private readonly db: Database) {}

  getState(key: string): string | undefined {
    const row = this.db.query('SELECT value FROM runtime_state WHERE key=?').get(key) as { value: string } | null;
    return row?.value;
  }
  setState(key: string, value: string): void {
    this.db.query('INSERT INTO runtime_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  deleteState(key: string): void {
    this.db.query('DELETE FROM runtime_state WHERE key=?').run(key);
  }
}
