import { BotError } from 'grammy';
import { isDatabaseError } from '@guard/database';
import { errorCode, log, type Clock } from '@guard/core';
import type { InboxRepository } from '@guard/database';
import type { Update } from 'grammy/types';

/** Serial durable-update execution, independent of polling or webhook transport. */
export class InboxProcessor {
  private busy = false;
  constructor(
    private readonly store: Pick<InboxRepository, 'claimInbox' | 'completeInbox' | 'failInbox'>,
    private readonly clock: Clock,
    private readonly handleUpdate: (update: Update) => Promise<void>,
  ) {}

  async process(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const rows = this.store.claimInbox(this.clock.now(), 20);
        if (!rows.length) return;
        for (const row of rows) {
          try {
            await this.handleUpdate(JSON.parse(row.payload_json) as Update);
          } catch (error) {
            if (isDatabaseError(error) || (error instanceof BotError && isDatabaseError(error.error))) throw error;
            log('error', 'handler_failed', { update: row.update_id, error: errorCode(error) });
            this.store.failInbox(row.update_id, this.clock.now());
            continue;
          }
          // The handler succeeded. Failed acknowledgement must not consume its retry
          // budget or mark the update failed; stop this pass and leave it for replay.
          this.store.completeInbox(row.update_id);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
