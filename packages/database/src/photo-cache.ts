import type { Database } from 'bun:sqlite';
import type { PhotoCacheRepository } from './repositories';

/** Content-addressed Telegram cache; separate bot identities never share file IDs. */
export class SqlitePhotoCache implements PhotoCacheRepository {
  constructor(private readonly db: Database) {}

  cacheGet(botId: number, hash: string, now: number): string | undefined {
    const row = this.db.query("SELECT file_id FROM file_cache WHERE bot_id=? AND content_hash=? AND media_kind='photo'")
      .get(botId, hash) as { file_id: string } | null;
    if (row) this.db.query("UPDATE file_cache SET last_used_at=? WHERE bot_id=? AND content_hash=? AND media_kind='photo'").run(now, botId, hash);
    return row?.file_id;
  }
  cachePut(botId: number, hash: string, fileId: string, uniqueId: string | null, now: number): void {
    this.db.query(`INSERT INTO file_cache(bot_id,content_hash,media_kind,file_id,file_unique_id,last_used_at)
      VALUES (?,?,'photo',?,?,?)
      ON CONFLICT(bot_id,content_hash,media_kind) DO UPDATE SET file_id=excluded.file_id,
        file_unique_id=excluded.file_unique_id, last_used_at=excluded.last_used_at`)
      .run(botId, hash, fileId, uniqueId, now);
  }
  cacheRemove(botId: number, hash: string): void {
    this.db.query("DELETE FROM file_cache WHERE bot_id=? AND content_hash=? AND media_kind='photo'").run(botId, hash);
  }

  /** One-day idle retention, executed within Store's bounded maintenance transaction. */
  purge(now: number, batch: number): void {
    this.db.query('DELETE FROM file_cache WHERE rowid IN (SELECT rowid FROM file_cache WHERE last_used_at<=? LIMIT ?)')
      .run(now - 86_400_000, batch);
  }
}
