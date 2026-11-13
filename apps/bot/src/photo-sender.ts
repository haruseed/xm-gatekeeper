import { sha256Hex, type Clock } from '@guard/core';
import type { PhotoCacheRepository } from '@guard/database';
import { classify, type Markup, type Tg } from './telegram';

/** Upload/reuse policy is separate from challenge state transitions and outbox retries. */
export class CachedPhotoSender {
  constructor(
    private readonly cache: PhotoCacheRepository,
    private readonly tg: Pick<Tg, 'botId' | 'sendPhoto'>,
    private readonly clock: Clock,
  ) {}

  async send(chatId: number, bytes: Uint8Array, caption: string, markup: Markup, mention?: number): Promise<number> {
    const hash = sha256Hex(bytes);
    const cached = this.cache.cacheGet(this.tg.botId, hash, this.clock.now());
    let sent;
    try {
      sent = await this.tg.sendPhoto(chatId, cached ?? bytes, caption, markup, mention);
    } catch (error) {
      const failure = classify(error);
      // Transient network errors must not discard a valid file ID or duplicate an upload.
      if (!cached || failure.kind !== 'invalid_file') throw failure;
      this.cache.cacheRemove(this.tg.botId, hash);
      sent = await this.tg.sendPhoto(chatId, bytes, caption, markup, mention);
    }
    if (sent.fileId) this.cache.cachePut(this.tg.botId, hash, sent.fileId, sent.fileUniqueId ?? null, this.clock.now());
    return sent.messageId;
  }
}
