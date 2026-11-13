import type { ApplicationLifecycle } from './lifecycle';
import { renderCapPage } from './cap-page/page';
import { dirname, join } from 'node:path';
import { TOKEN_PATTERN, type Clock, type Config } from '@guard/core';
import type { CapRepository } from '@guard/database';
import { CapacityPool } from './cap/capacity';
import { readCapBody } from './cap/read-body';
import { CapService, defaultCapEngine, type CapVerification } from './cap/service';
export { telegramUser } from './cap/telegram-auth';
export { readCapBody } from './cap/read-body';

/** HTTP boundary: routing, origin, upload limits and expensive-work admission. */
export function capHandler(config: Config, store: CapRepository, verification: CapVerification, clock: Clock, engine = defaultCapEngine, tasks?: Pick<ApplicationLifecycle, 'track'>) {
  const url = new URL(config.cap!.publicUrl);
  const base = url.pathname.replace(/\/$/, '');
  const service = new CapService(config, store, verification, clock, engine, tasks);
  const uploads = new CapacityPool(32), checks = new CapacityPool(4);
  const widgetDir = dirname(import.meta.resolve('cap-widget').replace(/^file:\/\//, ''));
  const assets: Record<string, { path: string; type: string }> = {
    '/widget.js': { path: join(widgetDir, 'cap.min.js'), type: 'application/javascript' },
    '/hashwx.wasm': { path: import.meta.resolve('@cap.js/wasm/browser/hashwx.wasm').replace(/^file:\/\//, ''), type: 'application/wasm' },
    '/pako.js': { path: join(dirname(import.meta.resolve('pako').replace(/^file:\/\//, '')), 'pako_inflate.min.js'), type: 'application/javascript' },
  };
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
  return async (req: Request): Promise<Response | undefined> => {
    const path = new URL(req.url).pathname;
    if (path !== base && !path.startsWith(base + '/')) return undefined;
    const sub = path.slice(base.length);
    if (req.method === 'GET' && sub === '') return new Response(renderCapPage(base), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
    if (req.method === 'GET' && assets[sub]) {
      const asset = assets[sub]!;
      return new Response(Bun.file(asset.path), { headers: { ...headers, 'Content-Type': asset.type } });
    }
    if (req.method !== 'POST' || req.headers.get('origin') !== url.origin) return json({ success: false }, 403);
    if (!['/session', '/status', '/api/challenge', '/api/redeem'].includes(sub)) return json({ success: false }, 404);
    const ticket = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    if (sub.startsWith('/api/') && (!TOKEN_PATTERN.test(ticket) || !service.ticket(ticket, clock.now()))) return json({ success: false }, 403);
    const releaseUpload = uploads.acquire();
    if (!releaseUpload) { store.noteVerificationServiceIssue(clock.now()); return json({ success: false, reason: 'upload_busy' }, 429); }
    let releaseCheck: (() => void) | undefined;
    try {
      let parsed: unknown;
      try { parsed = await readCapBody(req); } finally { releaseUpload(); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ success: false }, 400);
      const body = parsed as Record<string, unknown>;
      const now = clock.now();
      if (sub === '/session' || sub === '/status') {
        const reply = service.session(sub, body, now);
        return json(reply.body, reply.status);
      }
      // The ticket may expire while its body uploads, so check it again before using CPU.
      const request = service.ticket(ticket, now);
      if (!request) return json({ success: false }, 403);
      releaseCheck = checks.acquire();
      if (!releaseCheck) { store.noteVerificationServiceIssue(now); return json({ success: false, reason: 'busy' }, 429); }
      const reply = sub === '/api/challenge'
        ? await service.challenge(ticket, request, now)
        : await service.redeem(ticket, request, body);
      return json(reply.body, reply.status);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!['body_timeout', 'body_too_large'].includes(code) && !(error instanceof SyntaxError)) store.noteVerificationServiceIssue(clock.now());
      return json({ success: false, reason: code === 'body_timeout' ? 'upload_timeout' : 'check_failed' }, code === 'body_timeout' ? 408 : code === 'body_too_large' ? 413 : 400);
    } finally { releaseCheck?.(); }
  };
}
