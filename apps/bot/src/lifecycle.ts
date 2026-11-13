import { errorCode, log } from '@guard/core';
import { sleep, type Poller } from './polling';
import type { Verification } from './verification';

/** Non-overlapping one-second scheduler: expiry, outbox, alerts, retention, inbox retries. */
export async function runScheduler(verification: Verification, poller: Poller, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await verification.tick();
      if (!signal.aborted) await poller.processInbox();
    } catch (e) {
      log('error', 'tick_failed', { error: errorCode(e) });
    }
    await sleep(1000, signal);
  }
}

/** Tracks startup, workers and detached HTTP work until shutdown has drained them. */
export class ApplicationLifecycle {
  private readonly controller = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private stopping: Promise<boolean> | undefined;
  readonly signal = this.controller.signal;

  constructor(
    private readonly stopAccepting: () => void | Promise<void>,
    private readonly close: () => void,
    private readonly deadlineMs = 10_000,
  ) {}

  track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }

  /** False means the deadline expired: exit the process without closing a database still in use. */
  stop(): Promise<boolean> {
    if (this.stopping) return this.stopping;
    this.controller.abort();
    this.stopping = this.drain();
    return this.stopping;
  }

  private async drain(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = async () => {
      await this.stopAccepting();
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
      return true;
    };
    try {
      const drained = await Promise.race([
        settled(),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.deadlineMs); }),
      ]);
      if (drained) this.close();
      else log('warn', 'shutdown_deadline', {});
      return drained;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Installed before network startup so termination also handles partial initialization. */
export function installShutdown(lifecycle: ApplicationLifecycle): () => void {
  const stop = (name: string) => {
    log('info', 'shutdown', { signal: name });
    void lifecycle.stop().then(
      drained => process.exit(drained ? 0 : 1),
      error => { log('error', 'shutdown_failed', { error: errorCode(error) }); process.exit(1); },
    );
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  return () => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  };
}
