/** Read models and use-case contracts, independent of the SQLite Store implementation. */
export interface GroupRow {
  chat_id: number;
  owner_user_id: number;
  enabled: number;
  mode: string;
  settings_json: string;
  settings_version: number;
  raid_mode: number;
  invite_link: string | null;
  paused_reason: string | null;
  owner_checked_at: number;
  updated_at: number;
}

/** Minimal username index; display names and message contents are never persisted. */
export interface UsernameDirectory {
  userIdForUsername(username: string, now: number): number | undefined;
  rememberUsername(userId: number, username: string | undefined, now: number): void;
}

/** Telegram file IDs are scoped to the bot and exact image bytes. */
export interface PhotoCacheRepository {
  cacheGet(botId: number, hash: string, now: number): string | undefined;
  cachePut(botId: number, hash: string, fileId: string, uniqueId: string | null, now: number): void;
  cacheRemove(botId: number, hash: string): void;
}
