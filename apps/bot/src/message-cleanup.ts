import type { Clock } from '@guard/core';
import type { MessageCleanupRepository } from '@guard/database';
import { classify, type Tg } from './telegram';

interface Prompt {
  id: string;
  chat_id: number;
  prompt_message_id: number | null;
}

/** Cap prompts retry durably; group pictures/prompts retain their best-effort policy. */
export class MessageCleanup {
  constructor(
    private readonly store: MessageCleanupRepository,
    private readonly tg: Pick<Tg, 'deleteMessage'>,
    private readonly clock: Clock,
  ) {}

  async cleanupCapMessages(): Promise<void> {
    for (const message of this.store.capMessagesToDelete(this.clock.now())) {
      let retry = false;
      try {
        await this.tg.deleteMessage(message.chat_id, message.message_id);
      } catch (error) {
        const kind = classify(error).kind;
        retry = kind !== 'bad_request' && kind !== 'forbidden';
      }
      // Storage failures propagate. They must not be classified as Telegram failures.
      if (retry) this.store.retryCapMessage(message.chat_id, message.message_id, this.clock.now());
      else this.store.finishCapMessage(message.chat_id, message.message_id);
    }
  }

  async cleanupReviewNotices(): Promise<void> {
    for (const message of this.store.dueReviewNotices(this.clock.now())) {
      let retry = false;
      let delay = 30_000;
      try {
        await this.tg.deleteMessage(message.chatId, message.messageId);
      } catch (error) {
        const failure = classify(error);
        retry = !['bad_request', 'forbidden'].includes(failure.kind);
        if (failure.kind === 'rate') delay = Math.max(delay, failure.retryAfterMs);
      }
      if (retry) this.store.scheduleReviewNotice(message.chatId, message.messageId, this.clock.now() + delay);
      else this.store.finishReviewNotice(message.chatId, message.messageId);
    }
  }

  async sweepGroupMessages(): Promise<void> {
    for (const message of this.store.takeClosedGroupMessages(50)) {
      await this.tg.deleteMessage(message.chatId, message.messageId).catch(() => undefined);
    }
  }

  async dropPrompt(request: Prompt): Promise<void> {
    if (request.prompt_message_id === null) return;
    await this.tg.deleteMessage(request.chat_id, request.prompt_message_id).catch(() => undefined);
    this.store.setPromptMessage(request.id, null);
  }
}
