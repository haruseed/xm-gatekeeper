import { createHash, randomBytes, randomInt } from 'node:crypto';
import { isAbsolute } from 'node:path';

// ---------- Locales ----------
export const LOCALES = ['zh-HK', 'zh-TW', 'zh-CN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
// Legacy regional codes remain valid for stored settings and old message buttons.
export const LANGUAGE_OPTIONS = [
  { locale: 'zh-TW', label: '繁體中文' },
  { locale: 'zh-CN', label: '简体中文' },
  { locale: 'en', label: 'English' },
] as const;
export function languageLabel(locale: string): string {
  return LANGUAGE_OPTIONS.find(x => x.locale === (locale === 'zh-HK' ? 'zh-TW' : locale))?.label ?? locale;
}

export function isLocale(x: unknown): x is Locale {
  return typeof x === 'string' && (LOCALES as readonly string[]).includes(x);
}

// ---------- Clock and randomness (injected for tests) ----------
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export interface Rng {
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** 128-bit opaque token, base64url (22 chars). */
  token(): string;
}
export const secureRng: Rng = {
  int: (max) => randomInt(max),
  token: () => randomBytes(16).toString('base64url'),
};

export function shuffled<T>(input: readonly T[], rng: Rng): T[] {
  const result = [...input];
  for (let i = result.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// ---------- Domain states ----------
export type RequestState =
  | 'pending'
  | 'challenging'
  | 'manual_review'
  | 'approval_pending'
  | 'approved'
  | 'decline_pending'
  | 'declined'
  | 'expired'
  | 'superseded'
  | 'external_resolution';
export const LIVE_REQUEST_STATES: readonly RequestState[] = [
  'pending',
  'challenging',
  'manual_review',
  'approval_pending',
];
export type SessionState = 'preparing' | 'active' | 'passed' | 'failed' | 'expired' | 'cancelled';
export type Role = 'owner' | 'manager' | 'reviewer';
const ROLE_RANK: Record<Role, number> = { reviewer: 1, manager: 2, owner: 3 };
export function roleAtLeast(role: Role | null, min: Role): boolean {
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[min];
}

// ---------- Fixed policy (system level, not group-tunable) ----------
export const POLICY = {
  version: 1,
  rounds: 2,
  choices: 6,
  /** Initial contact window after the join request (Telegram allows five minutes). */
  contactWindowMs: 285_000,
  crossGroupStarts: 5,
  crossGroupWindowMs: 10 * 60_000,
  maxLiveRequestsPerGroup: 2000,
  alertIntervalMs: 5 * 60_000,
  outboxMaxAttempts: 8,
  inboxMaxAttempts: 5,
} as const;

// ---------- Group settings ----------
export interface GroupSettings {
  label: string;
  helpLocale: Locale;
  /** IANA time zone used when the bot shows times to this group's admins. */
  timezone: string;
  attempts: number;
  attemptWindowMin: number;
  /** Time allowed for Cap before the picture stage starts. */
  requestLifetimeMin: number;
  challengeTimeoutSec: number;
  reviewExpiryDays: number;
  burstThreshold: number;
  approvalsPerMinute: number;
  auditRetentionDays: number;
  quarantine: boolean;
}
export const DEFAULT_SETTINGS: GroupSettings = {
  label: '',
  helpLocale: 'en',
  timezone: 'UTC',
  attempts: 2,
  attemptWindowMin: 15,
  requestLifetimeMin: 1,
  challengeTimeoutSec: 60,
  reviewExpiryDays: 7,
  burstThreshold: 20,
  approvalsPerMinute: 10,
  auditRetentionDays: 30,
  quarantine: true,
};
/** System bounds: a group manager cannot disable limits or extend storage indefinitely. */
export const SETTING_BOUNDS = {
  attempts: [1, 3],
  attemptWindowMin: [5, 60],
  requestLifetimeMin: [1, 60],
  challengeTimeoutSec: [60, 600],
  reviewExpiryDays: [1, 14],
  burstThreshold: [5, 200],
  approvalsPerMinute: [1, 60],
  auditRetentionDays: [1, 30],
} as const satisfies Partial<Record<keyof GroupSettings, readonly [number, number]>>;
export type NumericSetting = keyof typeof SETTING_BOUNDS;
export const NUMERIC_SETTINGS = Object.keys(SETTING_BOUNDS) as NumericSetting[];

export function parseSettings(json: string): GroupSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('settings: invalid JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('settings: not an object');
  const r = raw as Record<string, unknown>;
  const out: GroupSettings = { ...DEFAULT_SETTINGS };
  if (typeof r.label === 'string') out.label = r.label.slice(0, 64);
  if (isLocale(r.helpLocale)) out.helpLocale = r.helpLocale;
  if (typeof r.timezone === 'string' && isTimeZone(r.timezone)) out.timezone = r.timezone;
  for (const key of NUMERIC_SETTINGS) {
    const v = r[key];
    if (v === undefined) continue;
    const [lo, hi] = SETTING_BOUNDS[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
      throw new Error(`settings: ${key} out of bounds`);
    }
    out[key] = v;
  }
  if (typeof r.quarantine === 'boolean') out.quarantine = r.quarantine;
  return out;
}

/** True for a time zone name the runtime knows (IANA, e.g. "Asia/Taipei"). */
export function isTimeZone(zone: string): boolean {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export type SettingChange = { ok: true; settings: GroupSettings } | { ok: false; error: string };
export function applySetting(current: GroupSettings, key: string, value: string): SettingChange {
  if (key === 'timezone') {
    const zone = value.trim();
    if (!isTimeZone(zone)) return { ok: false, error: 'timezone must be an IANA name such as Asia/Tokyo, Europe/London or UTC' };
    return { ok: true, settings: { ...current, timezone: zone } };
  }
  if (key === 'helpLocale') {
    if (!isLocale(value)) return { ok: false, error: `helpLocale must be one of ${LOCALES.join(', ')}` };
    return { ok: true, settings: { ...current, helpLocale: value } };
  }
  if (key === 'quarantine') {
    if (value !== 'on' && value !== 'off') return { ok: false, error: 'quarantine must be on or off' };
    return { ok: true, settings: { ...current, quarantine: value === 'on' } };
  }
  if ((NUMERIC_SETTINGS as string[]).includes(key)) {
    const k = key as NumericSetting;
    const [lo, hi] = SETTING_BOUNDS[k];
    const n = Number(value);
    if (!/^\d+$/.test(value) || n < lo || n > hi) {
      return { ok: false, error: `${k} must be an integer from ${lo} to ${hi}` };
    }
    return { ok: true, settings: { ...current, [k]: n } };
  }
  return { ok: false, error: 'unknown setting' };
}

// ---------- Configuration ----------
export interface Config {
  cap?: { publicUrl: string; secret: string; groupLaunch?: boolean };
  botToken: string;
  databasePath: string;
  assetsDir: string;
  boardTempDir: string;
  maxActiveSessions: number;
  maxRenderQueue: number;
  maxOutboxPending: number;
  logLevel: LogLevel;
  /** Set → updates arrive by webhook; unset → long polling. */
  webhook?: { url: string; path: string; port: number; secret: string };
}
function intIn(env: Record<string, string | undefined>, key: string, def: number, lo: number, hi: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < lo || n > hi) throw new Error(`${key} must be an integer from ${lo} to ${hi}`);
  return n;
}
function absPath(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is required`);
  if (!isAbsolute(v) || v.includes('\0')) throw new Error(`${key} must be an absolute path`);
  return v;
}
export function loadConfig(env: Record<string, string | undefined>): Config {
  const botToken = env.BOT_TOKEN ?? '';
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(botToken)) throw new Error('BOT_TOKEN is missing or malformed');
  const storage = env.ASSET_STORAGE ?? 'local';
  if (storage !== 'local') throw new Error('ASSET_STORAGE: only "local" is supported in this release');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!isLogLevel(logLevel)) throw new Error('LOG_LEVEL must be debug, info, warn or error');
  let webhook: Config['webhook'];
  if (env.WEBHOOK_URL) {
    let url: URL;
    try {
      url = new URL(env.WEBHOOK_URL);
    } catch {
      throw new Error('WEBHOOK_URL is not a valid URL');
    }
    if (url.protocol !== 'https:' || url.pathname.length < 2) throw new Error('WEBHOOK_URL must be https with a path');
    const secret = env.WEBHOOK_SECRET ?? '';
    if (!/^[A-Za-z0-9_-]{24,256}$/.test(secret)) throw new Error('WEBHOOK_SECRET must be 24–256 characters of A-Z a-z 0-9 _ -');
    webhook = { url: url.toString(), path: url.pathname, port: intIn(env, 'WEBHOOK_PORT', 8788, 1024, 65535), secret };
  }
  let cap: Config['cap'];
  if (env.CAP_PUBLIC_URL || env.CAP_SECRET) {
    const url = new URL(env.CAP_PUBLIC_URL ?? '');
    if (!webhook || url.pathname === '/' || url.pathname === webhook?.path || url.protocol !== 'https:' || url.origin !== new URL(webhook.url).origin || url.search || url.hash || url.username || url.password)
      throw new Error('CAP_PUBLIC_URL must be HTTPS on the webhook origin, with no query, fragment or credentials');
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.CAP_SECRET ?? '')) throw new Error('CAP_SECRET must be 32–256 random URL-safe characters');
    cap = { publicUrl: url.toString().replace(/\/$/, ''), secret: env.CAP_SECRET! };
  }
  return {
    ...(cap ? { cap } : {}),
    ...(webhook ? { webhook } : {}),
    botToken,
    databasePath: absPath(env, 'DATABASE_PATH'),
    assetsDir: absPath(env, 'ASSETS_DIR'),
    boardTempDir: absPath(env, 'BOARD_TEMP_DIR'),
    maxActiveSessions: intIn(env, 'MAX_ACTIVE_SESSIONS', 200, 1, 2000),
    maxRenderQueue: intIn(env, 'MAX_RENDER_QUEUE', 20, 1, 200),
    maxOutboxPending: intIn(env, 'MAX_OUTBOX_PENDING', 500, 10, 5000),
    logLevel,
  };
}

// ---------- Structured, redacted logging ----------
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];
function isLogLevel(x: string): x is LogLevel {
  return (LEVELS as readonly string[]).includes(x);
}
let minLevel = 1;
export function setLogLevel(level: LogLevel): void {
  minLevel = LEVELS.indexOf(level);
}
/** Removes bot tokens and t.me invite links from anything that reaches the log. */
export function redact(text: string): string {
  return text
    .replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, '[token]')
    .replace(/t\.me\/\+[A-Za-z0-9_-]+/g, 't.me/+[link]');
}
export function log(level: LogLevel, event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  if (LEVELS.indexOf(level) < minLevel) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
  (level === 'error' || level === 'warn' ? console.error : console.log)(redact(line));
}
export function errorCode(e: unknown): string {
  if (e instanceof Error) return redact(`${e.name}: ${e.message}`).slice(0, 200);
  return 'unknown';
}
