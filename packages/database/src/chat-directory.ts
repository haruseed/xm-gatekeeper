import type { Database } from 'bun:sqlite';
import type { GroupRow } from './repositories';

export interface KnownChatRow {
  chat_id: number;
  title: string;
  type: string;
  bot_status: string;
  updated_at: number;
}

/** Observed Telegram metadata for discovery and alerts, never proof of current authority. */
export class SqliteChatDirectory {
  constructor(private readonly db: Database) {}

  upsertKnownChat(chatId: number, title: string, type: string, botStatus: string, now: number): void {
    this.db.query(`INSERT INTO known_chats(chat_id,title,type,bot_status,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, type=excluded.type,
        bot_status=excluded.bot_status, updated_at=excluded.updated_at`)
      .run(chatId, title.slice(0, 128), type, botStatus, now);
  }
  removeKnownChat(chatId: number): void {
    this.db.query('DELETE FROM known_chats WHERE chat_id=?').run(chatId);
  }
  setKnownChatTitle(chatId: number, title: string, now: number): void {
    const value = title.slice(0, 128);
    this.db.query('UPDATE known_chats SET title=?, updated_at=? WHERE chat_id=? AND title<>?').run(value, now, chatId, value);
  }
  listKnownChats(limit: number): KnownChatRow[] {
    return this.db.query("SELECT * FROM known_chats WHERE bot_status='administrator' ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as KnownChatRow[];
  }
  listAdmins(chatId: number): { user_id: number }[] {
    return this.db.query('SELECT user_id FROM group_admins WHERE chat_id=? ORDER BY user_id').all(chatId) as { user_id: number }[];
  }
  /** Caller owns the transaction and verifies that the group is still enrolled. */
  replaceAdmins(chatId: number, userIds: number[], now: number): void {
    this.db.query('DELETE FROM group_admins WHERE chat_id=?').run(chatId);
    for (const id of new Set(userIds)) {
      this.db.query("INSERT INTO group_admins(chat_id,user_id,role,granted_by,created_at) VALUES (?,?,'manager',0,?)")
        .run(chatId, id, now);
    }
  }
  candidateGroupsFor(userId: number): GroupRow[] {
    return this.db.query(`SELECT * FROM groups WHERE owner_user_id=?1
      OR chat_id IN (SELECT chat_id FROM group_admins WHERE user_id=?1) ORDER BY chat_id`).all(userId) as GroupRow[];
  }
}
