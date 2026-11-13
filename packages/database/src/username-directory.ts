import type { Database } from 'bun:sqlite';
import type { UsernameDirectory } from './repositories';
import type { SqliteRuntimeState } from './runtime-state';

const RETENTION_MS = 30 * 86_400_000;
const REFRESH_MS = 3_600_000;

/** Stores only normalized Telegram usernames and observation times, never display names. */
export class SqliteUsernameDirectory implements UsernameDirectory {
  constructor(private readonly db: Database, private readonly state: Pick<SqliteRuntimeState, 'getState' | 'setState' | 'deleteState'>) {}

  rememberUsername(userId: number, username: string | undefined, now: number): void {
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    const key = `username:${userId}`;
    if (!username || !/^[a-zA-Z0-9_]{1,32}$/.test(username)) {
      this.state.deleteState(key);
      return;
    }
    const normalized = username.toLowerCase();
    const previous = this.state.getState(key);
    if (previous) {
      const known = JSON.parse(previous) as { username: string; seenAt: number };
      if (known.username === normalized && known.seenAt > now - REFRESH_MS) return;
    }
    this.state.setState(key, JSON.stringify({ username: normalized, seenAt: now }));
  }

  userIdForUsername(username: string, now: number): number | undefined {
    const matches = this.db.query(`SELECT key FROM runtime_state WHERE key GLOB 'username:*'
      AND json_extract(value,'$.username')=? AND json_extract(value,'$.seenAt')>? LIMIT 2`)
      .all(username.toLowerCase(), now - RETENTION_MS) as { key: string }[];
    return matches.length === 1 ? Number(matches[0]!.key.slice(9)) : undefined;
  }

  /** Runs inside Store's retention transaction; only this namespace is eligible. */
  purge(now: number, batch: number): void {
    this.db.query(`DELETE FROM runtime_state WHERE key IN (
      SELECT key FROM runtime_state WHERE key GLOB 'username:*' AND json_extract(value,'$.seenAt')<=? LIMIT ?
    )`).run(now - RETENTION_MS, batch);
  }
}
