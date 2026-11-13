/** Cleanup bookkeeping only; admission decisions do not belong to message deletion. */
export interface MessageCleanupRepository {
  capMessagesToDelete(now: number): { chat_id: number; message_id: number }[];
  finishCapMessage(chatId: number, messageId: number): void;
  retryCapMessage(chatId: number, messageId: number, now: number): void;
  takeClosedGroupMessages(limit: number): { chatId: number; messageId: number }[];
  setPromptMessage(requestId: string, messageId: number | null): void;
}
