import type { Database } from 'bun:sqlite';
import { tokenHash, type Rng } from '@guard/core';

export type ActionPayload = Record<string, string | number>;
export interface ActionTokens {
  createActionToken(actor: number, payload: ActionPayload, expiresAt: number): string;
  consumeActionToken(token: string, actor: number, now: number): ActionPayload | undefined;
}

/** Actor-bound, single-use controls. The caller must still check current administrator authority. */
export class SqliteActionTokens implements ActionTokens {
  constructor(private readonly db: Database, private readonly rng: Rng) {}

  createActionToken(actor: number, payload: ActionPayload, expiresAt: number): string {
    const token = this.rng.token();
    this.db.query('INSERT INTO action_tokens(token_hash,actor_user_id,payload_json,expires_at) VALUES (?,?,?,?)')
      .run(tokenHash(token), actor, JSON.stringify(payload), expiresAt);
    return token;
  }

  consumeActionToken(token: string, actor: number, now: number): ActionPayload | undefined {
    return this.db.transaction(() => {
      const hash = tokenHash(token);
      const row = this.db.query(`SELECT payload_json FROM action_tokens
        WHERE token_hash=? AND actor_user_id=? AND consumed_at IS NULL AND expires_at>?`)
        .get(hash, actor, now) as { payload_json: string } | null;
      if (!row) return undefined;
      this.db.query('UPDATE action_tokens SET consumed_at=? WHERE token_hash=?').run(now, hash);
      // Keep parsing inside the transaction: malformed storage must not consume the token.
      return JSON.parse(row.payload_json) as ActionPayload;
    }).immediate();
  }

  /** Runs inside Store's maintenance transaction; never removes unexpired controls. */
  purge(now: number, batch: number): void {
    this.db.query('DELETE FROM action_tokens WHERE token_hash IN (SELECT token_hash FROM action_tokens WHERE expires_at<=? LIMIT ?)')
      .run(now, batch);
  }
}
