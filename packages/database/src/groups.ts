import type { Database } from 'bun:sqlite';
import type { GroupSettings } from '@guard/core';
import type { GroupRow } from './repositories';

/** Group records on the shared connection; Store owns policy, auditing and transactions. */
export class SqliteGroups {
  constructor(private readonly db: Database) {}
  getGroup(chatId: number): GroupRow | undefined {
    return (this.db.query('SELECT * FROM groups WHERE chat_id=?').get(chatId) as GroupRow | null) ?? undefined;
  }
  listGroups(): GroupRow[] {
    return this.db.query('SELECT * FROM groups ORDER BY chat_id').all() as GroupRow[];
  }
  insert(chatId: number, ownerId: number, settings: GroupSettings, now: number): void {
    this.db.query(`INSERT INTO groups(chat_id,owner_user_id,enabled,settings_json,owner_checked_at,updated_at)
      VALUES (?,?,0,?,?,?)`).run(chatId, ownerId, JSON.stringify(settings), now, now);
  }
  setOwner(chatId: number, ownerId: number, now: number): void {
    this.db.query('UPDATE groups SET owner_user_id=?, owner_checked_at=?, updated_at=? WHERE chat_id=?')
      .run(ownerId, now, now, chatId);
  }
  setInviteLink(chatId: number, link: string, now: number): void {
    this.db.query('UPDATE groups SET invite_link=?, updated_at=? WHERE chat_id=?').run(link, now, chatId);
  }
  setEnabled(chatId: number, enabled: boolean, reason: string, now: number): void {
    this.db.query('UPDATE groups SET enabled=?, paused_reason=?, updated_at=? WHERE chat_id=?')
      .run(enabled ? 1 : 0, enabled ? null : reason, now, chatId);
  }
  setRaid(chatId: number, on: boolean, now: number): void {
    this.db.query('UPDATE groups SET raid_mode=?, updated_at=? WHERE chat_id=?').run(on ? 1 : 0, now, chatId);
  }
  updateSettings(chatId: number, settings: GroupSettings, now: number): void {
    this.db.query('UPDATE groups SET settings_json=?, settings_version=settings_version+1, updated_at=? WHERE chat_id=?')
      .run(JSON.stringify(settings), now, chatId);
  }
  /** Display-name refresh preserves the existing policy version. */
  refreshLabel(chatId: number, settings: GroupSettings, now: number): void {
    this.db.query('UPDATE groups SET settings_json=?, updated_at=? WHERE chat_id=?').run(JSON.stringify(settings), now, chatId);
  }
  remove(chatId: number): void {
    this.db.query('DELETE FROM groups WHERE chat_id=?').run(chatId);
  }
}
