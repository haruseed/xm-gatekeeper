import type { ApplicationLifecycle } from './lifecycle';
import { timingSafeEqual } from 'node:crypto';
import type { Update } from 'grammy/types';
import { errorCode, log } from '@guard/core';
import type { Poller } from './polling';

const MAX_BODY_BYTES = 1024 * 1024;

function sameSecret(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Webhook endpoint. Telegram is answered 200 only after the update is committed to the durable
 * inbox; any failure returns 500 so Telegram delivers it again. Handling happens afterwards.
 */
export function webhookHandler(intake: Pick<Poller, 'accept' | 'processInbox'>, path: string, secret: string, tasks?: Pick<ApplicationLifecycle, 'track'>) {
  return async (req: Request): Promise<Response> => {
    if (new URL(req.url).pathname !== path || req.method !== 'POST') return new Response('not found', { status: 404 });
    // Telegram echoes the secret set with setWebhook; anything else is not Telegram.
    if (!sameSecret(req.headers.get('x-telegram-bot-api-secret-token'), secret)) {
      return new Response('forbidden', { status: 403 });
    }
    let update: Update;
    try {
      const body = await req.text();
      if (body.length > MAX_BODY_BYTES) return new Response('too large', { status: 413 });
      update = JSON.parse(body) as Update;
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (typeof update !== 'object' || update === null || !Number.isSafeInteger(update.update_id)) {
      return new Response('bad request', { status: 400 });
    }
    try {
      await intake.accept([update]);
    } catch (e) {
      log('error', 'webhook_store_failed', { error: errorCode(e) });
      return new Response('retry', { status: 500 });
    }
    const processing = intake.processInbox().catch((e) => log('error', 'inbox_failed', { error: errorCode(e) }));
    tasks?.track(processing);
    return new Response('ok');
  };
}

/** Listens on localhost only; the reverse proxy terminates TLS. */
export function startWebhookServer(intake: Pick<Poller, 'accept' | 'processInbox'>, cfg: { path: string; port: number; secret: string }, extra?: (req: Request) => Promise<Response | undefined>, tasks?: Pick<ApplicationLifecycle, 'track'>) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: cfg.port,
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: async (req) => (await extra?.(req)) ?? webhookHandler(intake, cfg.path, cfg.secret, tasks)(req),
  });
}
