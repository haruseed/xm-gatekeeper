import { isDatabaseError } from '@guard/database';
import { POLICY, log, type Clock, type Rng } from '@guard/core';
import type { OutboxRepository, OutboxRow } from '@guard/database';
import { classify, type TgError } from './telegram';

/** Capacity deferral is not a failed delivery attempt. */
export class DeferredWork extends Error {
  constructor(readonly delayMs: number) { super('deferred'); }
}

interface Dependencies {
  store: OutboxRepository;
  clock: Clock;
  rng: Pick<Rng, 'int'>;
  execute(row: OutboxRow): Promise<void>;
  onFailed(row: OutboxRow, error: TgError): void;
}

/** Bounded delivery, grouped by request within each claimed batch. */
export class OutboxDispatcher {
  private draining = false;
  constructor(private readonly d: Dependencies) {}

  async drain(): Promise<void> {
    // Execution may itself enqueue work and request another drain. Do not await ourselves.
    if (this.draining) return;
    this.draining = true;
    try {
      for (let pass = 0; pass < 20; pass++) {
        const rows = this.d.store.claimOutbox(this.d.clock.now(), 10, 60_000);
        if (!rows.length) return;
        const groups = new Map<string, OutboxRow[]>();
        for (const row of rows) {
          const key = row.request_id ?? 'global';
          const group = groups.get(key) ?? [];
          group.push(row);
          groups.set(key, group);
        }
        const pending = [...groups.values()];
        const worker = async () => {
          for (;;) {
            const group = pending.shift();
            if (!group) return;
            for (const row of group) await this.deliver(row);
          }
        };
        // A persistence failure must not unlock draining while sibling workers still run.
        const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => worker()));
        const failed = outcomes.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliver(row: OutboxRow): Promise<void> {
    const { store, clock } = this.d;
    try {
      await this.d.execute(row);
    } catch (error) {
      if (isDatabaseError(error)) throw error;
      const now = clock.now();
      if (error instanceof DeferredWork) {
        store.retryOutbox(row.id, 'deferred', now + error.delayMs, false);
        return;
      }
      const failure = classify(error);
      if (failure.kind === 'rate') {
        store.retryOutbox(row.id, 'rate_limited', now + failure.retryAfterMs, false);
      } else if (['network', 'server'].includes(failure.kind) && row.attempts + 1 < POLICY.outboxMaxAttempts) {
        const backoff = Math.min(60_000, 1000 * 2 ** row.attempts) + this.d.rng.int(500);
        store.retryOutbox(row.id, failure.kind, now + backoff, true);
      } else {
        store.failOutbox(row.id, failure.kind, () => this.d.onFailed(row, failure));
        log('warn', 'outbox_failed', { kind: row.kind, error: failure.kind });
      }
      return;
    }
    // Execution succeeded. A database acknowledgement failure must propagate instead of
    // spending a Telegram retry or incorrectly sending the request to manual review.
    // Leave the pending row leased for recovery; handlers must remain replay-safe.
    store.completeOutbox(row.id);
  }
}
