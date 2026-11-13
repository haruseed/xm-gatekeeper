import { createHmac, timingSafeEqual } from 'node:crypto';

/** Authenticate the Mini App using Telegram's signed initData, never initDataUnsafe. */
export function telegramUser(initData: string, botToken: string, now: number): number | undefined {
  try {
    if (initData.length > 16_384) return undefined;
    const params = new URLSearchParams(initData);
    if (new Set(params.keys()).size !== [...params.keys()].length) return undefined;
    const hash = params.get('hash') ?? '';
    if (!/^[a-f0-9]{64}$/i.test(hash)) return undefined;
    params.delete('hash');
    const data = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = createHmac('sha256', secret).update(data).digest();
    if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return undefined;
    const age = now / 1000 - Number(params.get('auth_date'));
    if (!Number.isFinite(age) || age < -30 || age > 600) return undefined;
    const user = JSON.parse(params.get('user') ?? '{}');
    return Number.isSafeInteger(user.id) && user.id > 0 ? user.id : undefined;
  } catch { return undefined; }
}
