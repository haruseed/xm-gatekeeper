import type { Api } from 'grammy';
import { errorCode, log } from '@guard/core';
import type { GroupRow } from '@guard/database';
import { telegramSignal, classify, GROUP_ADMIN_MENU, GROUP_USER_MENU, USER_MENU, type Tg } from './telegram';
import { sleep } from './polling';

interface Dependencies {
  api: Pick<Api, 'setMyCommands'>;
  tg: Pick<Tg, 'setAdminMenu' | 'setGroupCommandMenu'>;
  store: { listGroups(): GroupRow[] };
}

/** Noncritical startup work. Each scope gets at most three bounded attempts. */
export async function synchronizeMenus(d: Dependencies, signal: AbortSignal, wait = sleep): Promise<void> {
  if (signal.aborted) return;
  const jobs: ((attemptSignal: AbortSignal) => Promise<unknown>)[] = [
    s => d.api.setMyCommands(USER_MENU, { scope: { type: 'all_private_chats' } }, telegramSignal(s)),
    s => d.api.setMyCommands(GROUP_USER_MENU, { scope: { type: 'all_group_chats' } }, telegramSignal(s)),
    s => d.api.setMyCommands(GROUP_ADMIN_MENU, { scope: { type: 'all_chat_administrators' } }, telegramSignal(s)),
    ...d.store.listGroups().map(group => (s: AbortSignal) => d.tg.setGroupCommandMenu(
      group.chat_id,
      s,
    )),
  ];
  for (const job of jobs) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) return;
      try {
        await job(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
        break;
      } catch (error) {
        if (signal.aborted) return;
        const failure = classify(error);
        if (attempt === 2 || !['network', 'server', 'rate'].includes(failure.kind)) {
          log('warn', 'set_commands_failed', { error: errorCode(error) });
          break;
        }
        // Do not retry before Telegram's requested delay; abandon unusually long waits.
        const delay = failure.kind === 'rate' ? failure.retryAfterMs : 1000 * 2 ** attempt;
        if (delay > 30_000) {
          log('warn', 'set_commands_deferred', {});
          break;
        }
        await wait(delay, signal);
      }
    }
  }
}
