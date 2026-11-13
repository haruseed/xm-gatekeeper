import { PreparedBoardProvider, RenderedBoardProvider, type BoardProvider } from '../apps/bot/src/board-provider';
import type { BoardBank } from '../apps/bot/src/board-bank';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, secureRng, tokenHash, type Clock, type GroupSettings } from '@guard/core';
import { LocalAssetStore, type AssetStore } from '@guard/assets';
import { Store, migrate, openDatabase } from '@guard/database';
import { Admin, Authority, TgError, Verification, type AdminInfo, type Markup, type SentPhoto, type Tg } from '@guard/bot';

export const ASSETS_DIR = join(import.meta.dir, '..', 'assets');
export const BOT_ID = 999;
export const OWNER = 1000;
export const GROUP = -1001;
export const T0 = 1_800_000_000_000;

export class FakeClock implements Clock {
  t = T0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

type Method = 'sendMessage' | 'sendPhoto' | 'approve' | 'decline' | 'getAdmins' | 'isMember';

/** Scripted Telegram adapter: records calls and fails on demand. */
export class FakeTg implements Tg {
  readonly botId = BOT_ID;
  readonly username = 'guard_test_bot';
  messages: { chatId: number; text: string; markup?: Markup; rich?: boolean }[] = [];
  photos: { chatId: number; photo: string | Uint8Array; caption: string; markup: Markup; mention?: number; id: number }[] = [];
  approved: [number, number][] = [];
  declined: [number, number][] = [];
  cleared: number[] = [];
  admins = new Map<number, AdminInfo[]>();
  members = new Set<string>();
  chats = new Map<number, { type: string; title: string }>();
  private failures = new Map<Method, TgError[]>();
  private nextId = 1;

  failNext(method: Method, ...errors: TgError[]): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...errors]);
  }
  private maybeFail(method: Method): void {
    const e = this.failures.get(method)?.shift();
    if (e) throw e;
  }
  async sendMessage(chatId: number, text: string, markup?: Markup, rich?: boolean): Promise<number> {
    this.maybeFail('sendMessage');
    this.messages.push({ chatId, text, ...(markup ? { markup } : {}), ...(rich ? { rich } : {}) });
    return this.nextId++;
  }
  async sendPhoto(chatId: number, photo: string | Uint8Array, caption: string, markup: Markup, mention?: number): Promise<SentPhoto> {
    this.maybeFail('sendPhoto');
    const id = this.nextId++;
    this.photos.push({ chatId, photo, caption, markup, id, ...(mention !== undefined ? { mention } : {}) });
    return { messageId: id, fileId: `file-${id}`, fileUniqueId: `uniq-${id}` };
  }
  restricted: [number, number][] = [];
  unrestricted: [number, number][] = [];
  kicked: [number, number][] = [];
  deleted: number[] = [];
  prompts: { chatId: number; userId: number; text: string; markup: Markup; id: number }[] = [];
  canRestrict = true;
  async sendGroupPrompt(chatId: number, userId: number, text: string, markup: Markup): Promise<number> {
    const id = this.nextId++;
    this.prompts.push({ chatId, userId, text, markup, id });
    return id;
  }
  async deleteMessage(_chatId: number, messageId: number): Promise<void> {
    this.deleted.push(messageId);
  }
  async restrict(chatId: number, userId: number): Promise<void> {
    if (!this.canRestrict) throw new TgError('forbidden', 'not enough rights');
    this.restricted.push([chatId, userId]);
  }
  async unrestrict(chatId: number, userId: number): Promise<void> {
    this.unrestricted.push([chatId, userId]);
  }
  async kick(chatId: number, userId: number): Promise<void> {
    this.kicked.push([chatId, userId]);
  }
  adminMenus: number[] = [];
  async setAdminMenu(userId: number): Promise<void> {
    this.adminMenus.push(userId);
  }
  profilePhoto: string | undefined = undefined;
  groupMenus: {chatId:number;enabled:readonly string[]}[]=[];
  async setGroupCommandMenu(chatId:number):Promise<void>{this.groupMenus.push({chatId,enabled:[]});}
  async profilePhotoFileId(): Promise<string | undefined> {
    return this.profilePhoto;
  }
  muted: [number, number, number][] = [];
  unbanned: [number, number][] = [];
  async mute(chatId: number, userId: number, untilSec: number): Promise<void> {
    this.muted.push([chatId, userId, untilSec]);
  }
  async unban(chatId: number, userId: number): Promise<void> {
    this.unbanned.push([chatId, userId]);
  }
  banned: [number, number][] = [];
  async ban(chatId: number, userId: number): Promise<void> {
    this.banned.push([chatId, userId]);
  }
  edits: { chatId: number; messageId: number; text: string; markup?: Markup }[] = [];
  async editMessage(chatId: number, messageId: number, text: string, markup?: Markup, _rich?: boolean): Promise<void> {
    this.edits.push({ chatId, messageId, text, ...(markup ? { markup } : {}) });
  }
  async clearKeyboard(_chatId: number, messageId: number): Promise<void> {
    this.cleared.push(messageId);
  }
  async approve(chatId: number, userId: number): Promise<void> {
    this.maybeFail('approve');
    this.approved.push([chatId, userId]);
    this.members.add(`${chatId}:${userId}`);
  }
  async decline(chatId: number, userId: number): Promise<void> {
    this.maybeFail('decline');
    this.declined.push([chatId, userId]);
  }
  async getAdmins(chatId: number): Promise<AdminInfo[]> {
    this.maybeFail('getAdmins');
    return this.admins.get(chatId) ?? [];
  }
  async isMember(chatId: number, userId: number): Promise<boolean> {
    this.maybeFail('isMember');
    return this.members.has(`${chatId}:${userId}`);
  }
  names = new Map<number, { name: string; username?: string }>();
  async memberName(_chatId: number, userId: number): Promise<{ name: string; username?: string } | undefined> {
    return this.names.get(userId);
  }
  async getChat(chatId: number): Promise<{ type: string; title: string }> {
    return this.chats.get(chatId) ?? { type: 'supergroup', title: `Group ${chatId}` };
  }
  async createJoinLink(chatId: number): Promise<string> {
    return `https://t.me/+link${Math.abs(chatId)}`;
  }
  lastText(chatId: number): string {
    return this.messages.filter((m) => m.chatId === chatId).at(-1)?.text ?? '';
  }
}

export interface Harness {
  store: Store;
  tg: FakeTg;
  clock: FakeClock;
  v: Verification;
  admin: Admin;
  authority: Authority;
  dbPath: string;
  boardDir: string;
}

export function harness(opts: { boards?: BoardProvider; boardBank?: BoardBank; assets?: AssetStore; dbPath?: string; maxActiveSessions?: number; cap?: boolean; groupLaunch?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'guard-test-'));
  const dbPath = opts.dbPath ?? join(dir, 'guard.sqlite');
  const db = openDatabase(dbPath);
  migrate(db, T0);
  const store = new Store(db, secureRng, opts.cap ?? false);
  const tg = new FakeTg();
  const clock = new FakeClock();
  const boardDir = join(dir, 'boards');
  const config = {
    ...(opts.cap ? {cap:{publicUrl:'https://guard.example/guard/verify',secret:'x'.repeat(32),groupLaunch:opts.groupLaunch ?? false}} : {}),
    maxActiveSessions: opts.maxActiveSessions ?? 200,
    maxRenderQueue: 20,
    maxOutboxPending: 500,
    boardTempDir: boardDir,
  };
  const assets = opts.assets ?? new LocalAssetStore(ASSETS_DIR);
  const boards = opts.boards ?? (opts.boardBank
    ? new PreparedBoardProvider(opts.boardBank)
    : new RenderedBoardProvider(assets, config.maxRenderQueue));
  const v = new Verification({ store, tg, boards, assets, config, clock, rng: secureRng });
  const authority = new Authority(tg, store, clock);
  const admin = new Admin(store, tg, authority, v, clock, () => ({ lastPollAt: clock.now(), startedAt: T0 }));
  return { store, tg, clock, v, admin, authority, dbPath, boardDir };
}

/** Most workflow fixtures use a longer allowed window; stage deadline tests explicitly use the one-minute policy. */
export function enrol(h: Harness, chatId = GROUP, owner = OWNER, settings: Partial<GroupSettings> = {}): void {
  h.store.enrolGroup(chatId, owner, { ...DEFAULT_SETTINGS, requestLifetimeMin: 15, challengeTimeoutSec: 240, label: `Group ${chatId}`, ...settings }, h.clock.now());
  h.store.setEnabled(chatId, true, owner, 'test', h.clock.now());
  h.tg.admins.set(chatId, [
    { userId: owner, isCreator: true, isBot: false, canInvite: true, canRestrict: true },
    { userId: BOT_ID, isCreator: false, isBot: true, canInvite: true, canRestrict: true },
  ]);
}

let updateSeq = 1;
/** A user sends a join request; the private chat ID equals the user ID, as in Telegram. */
export async function join_(h: Harness, userId: number, chatId = GROUP): Promise<void> {
  await h.v.onJoin({ updateId: updateSeq++, chatId, userId, contactChatId: userId, requestedAt: h.clock.now() });
}

/** Tokens on the most recent board sent to the user, split into the correct one and a wrong one. */
export function boardTokens(h: Harness, userId: number, chat = userId): { correct: string; wrong: string; all: string[]; caption: string } {
  const photo = h.tg.photos.filter((p) => p.chatId === chat && (chat === userId || p.mention === userId)).at(-1);
  if (!photo) throw new Error('no board was sent');
  const all = photo.markup.inline_keyboard
    .flat()
    .map((b) => ('callback_data' in b ? b.callback_data : ''))
    .filter((d) => d.startsWith('c:'))
    .map((d) => d.slice(2));
  const row = (token: string) =>
    h.store.db.query('SELECT choice, session_id FROM callback_tokens WHERE token_hash=?').get(tokenHash(token)) as
      | { choice: number; session_id: string }
      | null;
  const s = h.store.getSession(row(all[0]!)?.session_id ?? '');
  if (!s) throw new Error('the latest board is no longer live');
  const choiceOf = (token: string) => row(token)?.choice;
  const correct = all.find((tk) => choiceOf(tk) === s.answer_position)!;
  const wrong = all.find((tk) => choiceOf(tk) !== s.answer_position)!;
  return { correct, wrong, all, caption: photo.caption };
}

export async function answer(h: Harness, userId: number, token: string, chat = userId): Promise<string> {
  const res = h.v.answer(userId, chat, token);
  await h.v.afterAnswer(res, chat);
  return res.result;
}

/** Runs the applicant through language choice and both rounds correctly. */
export async function passChallenge(h: Harness, userId: number): Promise<void> {
  await answer(h, userId, boardTokens(h, userId).correct);
  await answer(h, userId, boardTokens(h, userId).correct);
}

export const net = () => new TgError('network', 'timeout');
