import { expect, test } from 'bun:test';
import { sha256Hex } from '@guard/core';
import { CachedPhotoSender } from '../apps/bot/src/photo-sender';
import { TgError } from '../apps/bot/src/telegram';

test('network failure preserves the cached ID and delegates retry to the outbox', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  let evictions = 0, uploads = 0, writes = 0;
  const sender = new CachedPhotoSender({
    cacheGet(bot, hash) { expect(bot).toBe(123); expect(hash).toBe(sha256Hex(bytes)); return 'cached-id'; },
    cacheRemove() { evictions++; },
    cachePut() { writes++; },
  }, {
    botId: 123,
    async sendPhoto(_chat, photo) {
      uploads++;
      expect(photo).toBe('cached-id');
      throw new TgError('network', 'connection lost');
    },
  }, { now: () => 1000 });
  await expect(sender.send(-1001, bytes, 'caption', { inline_keyboard: [] })).rejects.toMatchObject({ kind: 'network' });
  expect(uploads).toBe(1);
  expect(evictions).toBe(0);
  expect(writes).toBe(0);
});
