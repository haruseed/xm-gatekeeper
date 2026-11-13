import type { Database } from 'bun:sqlite';
import type { Locale } from '@guard/core';

export interface PrefsRow {
  user_id: number;
  locale: Locale | null;
  explicit_dm_chat_id: number | null;
  admin_chat_id: number | null;
  last_seen_at: number;
}

/** Storage only. Store owns transactions spanning preferences and active sessions. */
export class SqliteUserPreferences {
  constructor(private readonly db: Database) {}

  getPrefs(userId: number): PrefsRow | undefined {
    return this.db.query('SELECT * FROM user_preferences WHERE user_id=?').get(userId) as PrefsRow | null ?? undefined;
  }
  touch(userId: number, now: number): void {
    this.db.query(`INSERT INTO user_preferences(user_id,last_seen_at) VALUES (?,?)
      ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(userId, now);
  }
  setExplicitChat(userId: number, chatId: number): void {
    this.db.query('UPDATE user_preferences SET explicit_dm_chat_id=? WHERE user_id=?').run(chatId, userId);
  }
  setLocale(userId: number, locale: Locale): void {
    this.db.query('UPDATE user_preferences SET locale=? WHERE user_id=?').run(locale, userId);
  }
  setAdminContext(userId: number, chatId: number | null): void {
    this.db.query('UPDATE user_preferences SET admin_chat_id=? WHERE user_id=?').run(chatId, userId);
  }
  clearGroupContext(chatId: number): void {
    this.db.query('UPDATE user_preferences SET admin_chat_id=NULL WHERE admin_chat_id=?').run(chatId);
  }
  purge(now: number, batch: number): void {
    this.db.query('DELETE FROM user_preferences WHERE user_id IN (SELECT user_id FROM user_preferences WHERE last_seen_at<=? LIMIT ?)')
      .run(now - 90 * 86_400_000, batch);
  }
}
