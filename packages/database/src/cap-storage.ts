import type { Database } from 'bun:sqlite';
import { tokenHash } from '@guard/core';

/** Cap persistence on Store's connection. Admission and workflow transactions stay in Store. */
export class SqliteCapStorage {
  constructor(private readonly db: Database) {}

  trackMessage(requestId: string, chatId: number, messageId: number): void {
    this.db.query('INSERT OR IGNORE INTO cap_messages(request_id,chat_id,message_id) VALUES (?,?,?)')
      .run(requestId, chatId, messageId);
  }
  messagesToDelete(now: number): { chat_id: number; message_id: number }[] {
    return this.db.query(`SELECT m.chat_id,m.message_id FROM cap_messages m JOIN cap_sessions c ON c.request_id=m.request_id
      WHERE c.passed_at IS NOT NULL AND m.next_attempt_at<=? LIMIT 25`).all(now) as { chat_id: number; message_id: number }[];
  }
  finishMessage(chatId: number, messageId: number): void {
    this.db.query('DELETE FROM cap_messages WHERE chat_id=? AND message_id=?').run(chatId, messageId);
  }
  retryMessage(chatId: number, messageId: number, now: number): void {
    this.db.query('UPDATE cap_messages SET next_attempt_at=? WHERE chat_id=? AND message_id=?')
      .run(now + 30_000, chatId, messageId);
  }
  passed(requestId: string): boolean {
    return !!this.db.query('SELECT 1 FROM cap_sessions WHERE request_id=? AND passed_at IS NOT NULL').get(requestId);
  }
  saveTicket(requestId: string, ticket: string, expiresAt: number): void {
    // Refreshing a ticket must not reset the request's accumulated challenge budget.
    this.db.query(`INSERT INTO cap_sessions(request_id,ticket_hash,expires_at) VALUES (?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET ticket_hash=excluded.ticket_hash, expires_at=excluded.expires_at`)
      .run(requestId, tokenHash(ticket), expiresAt);
  }
  requestForTicket(ticket: string, now: number): string | undefined {
    const row = this.db.query('SELECT request_id FROM cap_sessions WHERE ticket_hash=? AND expires_at>? AND passed_at IS NULL')
      .get(tokenHash(ticket), now) as { request_id: string } | null;
    return row?.request_id;
  }
  takeChallenge(ticket: string, now: number): boolean {
    return this.db.query(`UPDATE cap_sessions SET challenge_count=challenge_count+1,last_challenge_at=?
      WHERE ticket_hash=? AND expires_at>? AND passed_at IS NULL AND challenge_count<10 AND last_challenge_at<=?`)
      .run(now, tokenHash(ticket), now, now - 3000).changes === 1;
  }
  consumeNonce(hash: string, ttl: number, now: number): boolean {
    this.db.query('DELETE FROM cap_nonces WHERE expires_at<=?').run(now);
    return this.db.query('INSERT OR IGNORE INTO cap_nonces(hash,expires_at) VALUES (?,?)').run(hash, now + ttl).changes === 1;
  }
  markPassed(requestId: string, now: number): void {
    this.db.query('UPDATE cap_sessions SET passed_at=? WHERE request_id=?').run(now, requestId);
  }
  resetUnpassed(requestId: string): void {
    this.db.query('DELETE FROM cap_sessions WHERE request_id=? AND passed_at IS NULL').run(requestId);
  }
  picturesToRecover(now: number): { id: string }[] {
    return this.db.query(`SELECT r.id FROM join_requests r JOIN cap_sessions c ON c.request_id=r.id
      WHERE c.passed_at IS NOT NULL AND r.state='pending' AND r.deadline_at>?
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.request_id=r.id)`).all(now) as { id: string }[];
  }
}
