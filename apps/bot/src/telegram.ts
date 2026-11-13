import { GrammyError, HttpError, InputFile, type Api } from 'grammy';

/** grammY's Node types use an AbortController shim; Bun's native signal implements its runtime API. */
export function telegramSignal(signal?: AbortSignal): Parameters<Api['setMyCommands']>[2] {
  return signal as unknown as Parameters<Api['setMyCommands']>[2];
}

export type Button = { text: string; callback_data: string } | { text: string; url: string } | { text: string; web_app: { url: string } };
export interface Markup {
  inline_keyboard: Button[][];
}
export interface AdminInfo {
  userId: number;
  isCreator: boolean;
  isBot: boolean;
  canInvite: boolean;
  canRestrict: boolean;
}
export interface SentPhoto {
  messageId: number;
  fileId?: string;
  fileUniqueId?: string;
}

/** The narrow slice of Telegram the application uses; tests substitute a scripted adapter. */
export interface Tg {
  readonly botId: number;
  readonly username: string;
  /** `rich` sends the text as Telegram HTML (bold headings); the caller escapes user-supplied parts. */
  sendMessage(chatId: number, text: string, markup?: Markup, rich?: boolean): Promise<number>;
  /** `mentionUserId` prefixes the caption with a mention, for checks posted in a group. */
  sendPhoto(chatId: number, photo: string | Uint8Array, caption: string, markup: Markup, mentionUserId?: number): Promise<SentPhoto>;
  /** Group message that mentions the user by ID (no name is stored or needed). */
  sendGroupPrompt(chatId: number, userId: number, text: string, markup: Markup): Promise<number>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  /** Mutes a member completely. */
  restrict(chatId: number, userId: number): Promise<void>;
  /** Lifts this bot's mute; the member falls back to the group's default permissions. */
  unrestrict(chatId: number, userId: number): Promise<void>;
  /** Removes a member without leaving a permanent ban. */
  kick(chatId: number, userId: number): Promise<void>;
  /** Shows the admin command menu in this one person's private chat with the bot. */
  setAdminMenu(userId: number, signal?: AbortSignal): Promise<void>;
  setGroupCommandMenu(chatId: number, signal?: AbortSignal): Promise<void>;
  /** file_id of the user's current profile photo, if the bot can see one. */
  profilePhotoFileId(userId: number): Promise<string | undefined>;
  /** Stops a member sending anything until the given Unix time (seconds); Telegram lifts it by itself. */
  mute(chatId: number, userId: number, untilSec: number): Promise<void>;
  /** Lifts a ban so the user can join again. Does nothing if they are not banned. */
  unban(chatId: number, userId: number): Promise<void>;
  /** Permanent ban; also removes the user's recent messages in the group. */
  ban(chatId: number, userId: number): Promise<void>;
  clearKeyboard(chatId: number, messageId: number): Promise<void>;
  /** Replaces the text and buttons of a message the bot sent earlier. */
  editMessage(chatId: number, messageId: number, text: string, markup?: Markup, rich?: boolean): Promise<void>;
  approve(chatId: number, userId: number): Promise<void>;
  decline(chatId: number, userId: number): Promise<void>;
  getAdmins(chatId: number): Promise<AdminInfo[]>;
  isMember(chatId: number, userId: number): Promise<boolean>;
  getChat(chatId: number): Promise<{ type: string; title: string }>;
  /** Current name of a (present or past) group member, read live from Telegram; never stored. */
  memberName(chatId: number, userId: number): Promise<{ name: string; username?: string } | undefined>;
  createJoinLink(chatId: number): Promise<string>;
}

const DC_PLACES: Record<number, string> = { 1: 'Miami', 2: 'Amsterdam', 3: 'Miami', 4: 'Amsterdam', 5: 'Singapore' };

/**
 * Telegram does not report a user's data centre, but a file_id records the DC that stores the
 * file. For a profile photo that is the account's home DC. Returns e.g. "DC5 (Singapore)".
 */
export function dcFromFileId(fileId: string): string | undefined {
  const raw = Buffer.from(fileId, 'base64url');
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    // Run-length encoding: a zero byte is followed by the number of zeros it stands for.
    if (raw[i] === 0 && i + 1 < raw.length) {
      for (let k = 0; k < raw[i + 1]!; k++) out.push(0);
      i++;
    } else out.push(raw[i]!);
  }
  if (out.length < 8) return undefined;
  const dc = Buffer.from(out).readInt32LE(4);
  return DC_PLACES[dc] ? `DC${dc} (${DC_PLACES[dc]})` : undefined;
}

/** Menu shown only to people who administer a guarded group. Ordinary users see USER_MENU. */
export const ADMIN_MENU = [
  {command:'whoami',description:'My user ID and data centre'},
  { command: 'status', description: 'Your groups at a glance' },
  { command: 'review', description: 'People waiting for a decision' },
  { command: 'settings', description: 'Change the rules' },
  { command: 'raid', description: 'Raid mode on / off' },
  { command: 'audit', description: 'Recent actions' },
  { command: 'ban', description: 'Ban by reply, @username or ID' },
  { command: 'mute', description: 'Mute a user for a while' },
  { command: 'unban', description: 'Lift a mute or ban' },
  { command: 'setup', description: 'Set up a group' },
  { command: 'group', description: 'Switch group' },
  { command: 'help', description: 'Help' },
];
export const GROUP_USER_MENU = [{ command: 'whoami', description: 'My user ID and data centre' }];
export const GROUP_ADMIN_MENU = [
  {command:'whoami',description:'My user ID and data centre'},
  {command:'ban',description:'Ban by reply, @username or ID'},
  {command:'mute',description:'Mute by reply, @username or ID; e.g. 2h'},
  {command:'unban',description:'Lift a mute or ban by reply, @username or ID'},
  {command:'setup',description:'Set up the guard (owner)'},
];
export const USER_MENU = [
  { command: 'help', description: 'What this bot does' },
  { command: 'whoami', description: 'My user ID and data centre' },
];

/** Escapes text for use inside a `rich` (Telegram HTML) message. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A person as shown anywhere in chat: their name as a link that opens their profile, never a
 * user ID on its own. Falls back to "this user" (still a link) when Telegram cannot give a name.
 */
export function userLink(userId: number, who?: { name: string; username?: string }): string {
  const label = who?.name || (who?.username ? `@${who.username}` : 'this user');
  return `<a href="tg://user?id=${userId}">${esc(label)}</a>`;
}

export type TgErrorKind = 'rate' | 'network' | 'server' | 'forbidden' | 'gone' | 'invalid_file' | 'bad_request';
export class TgError extends Error {
  constructor(
    readonly kind: TgErrorKind,
    description: string,
    readonly retryAfterMs = 0,
  ) {
    super(description);
    this.name = 'TgError';
  }
}

export function classify(e: unknown): TgError {
  if (e instanceof TgError) return e;
  if (e instanceof GrammyError) {
    const d = e.description;
    if (e.error_code === 429) return new TgError('rate', d, ((e.parameters?.retry_after ?? 1) + 1) * 1000);
    if (e.error_code >= 500) return new TgError('server', d);
    if (/HIDE_REQUESTER_MISSING|USER_ALREADY_PARTICIPANT/i.test(d)) return new TgError('gone', d);
    if (/wrong file identifier|wrong remote file|file reference/i.test(d)) return new TgError('invalid_file', d);
    if (e.error_code === 403 || /not enough rights|CHAT_ADMIN_REQUIRED|chat not found|bot was kicked/i.test(d)) {
      return new TgError('forbidden', d);
    }
    return new TgError('bad_request', d);
  }
  if (e instanceof HttpError) return new TgError('network', 'network error');
  return new TgError('network', e instanceof Error ? e.name : 'unknown error');
}

export class GrammyTg implements Tg {
  private readonly groupMenuWrites = new Map<number, Promise<void>>();
  constructor(
    private readonly api: Api,
    readonly botId: number,
    readonly username: string,
  ) {}

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw classify(e);
    }
  }
  async sendMessage(chatId: number, text: string, markup?: Markup, rich = false): Promise<number> {
    const m = await this.call(() =>
      this.api.sendMessage(chatId, text, {
        link_preview_options: { is_disabled: true },
        ...(rich ? { parse_mode: 'HTML' as const } : {}),
        ...(markup ? { reply_markup: markup } : {}),
      }),
    );
    return m.message_id;
  }
  async sendPhoto(chatId: number, photo: string | Uint8Array, caption: string, markup: Markup, mentionUserId?: number): Promise<SentPhoto> {
    const input = typeof photo === 'string' ? photo : new InputFile(photo, 'challenge.jpg');
    const m = await this.call(async () =>
      mentionUserId === undefined
        ? this.api.sendPhoto(chatId, input, { caption, reply_markup: markup })
        : this.api.sendPhoto(chatId, input, {
            caption: `${await this.mention(chatId, mentionUserId)}\n${esc(caption)}`,
            parse_mode: 'HTML',
            reply_markup: markup,
          }),
    );
    const largest = m.photo.at(-1);
    return {
      messageId: m.message_id,
      ...(largest ? { fileId: largest.file_id, fileUniqueId: largest.file_unique_id } : {}),
    };
  }
  /** Clickable "First Last" for a group member, looked up live. */
  private async mention(chatId: number, userId: number): Promise<string> {
    return userLink(userId, await this.memberName(chatId, userId).catch(() => undefined));
  }
  async sendGroupPrompt(chatId: number, userId: number, text: string, markup: Markup): Promise<number> {
    const who = await this.mention(chatId, userId);
    const m = await this.call(() =>
      this.api.sendMessage(chatId, `${who}\n${esc(text)}`, {
        parse_mode: 'HTML',
        reply_markup: markup,
        link_preview_options: { is_disabled: true },
      }),
    );
    return m.message_id;
  }
  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.call(() => this.api.deleteMessage(chatId, messageId));
  }
  private permissions(allow: boolean) {
    return {
      can_send_messages: allow,
      can_send_audios: allow,
      can_send_documents: allow,
      can_send_photos: allow,
      can_send_videos: allow,
      can_send_video_notes: allow,
      can_send_voice_notes: allow,
      can_send_polls: allow,
      can_send_other_messages: allow,
      can_add_web_page_previews: allow,
      can_change_info: allow,
      can_invite_users: allow,
      can_pin_messages: allow,
      can_manage_topics: allow,
    };
  }
  async restrict(chatId: number, userId: number): Promise<void> {
    await this.call(() => this.api.restrictChatMember(chatId, userId, this.permissions(false)));
  }
  async unrestrict(chatId: number, userId: number): Promise<void> {
    await this.call(() => this.api.restrictChatMember(chatId, userId, this.permissions(true)));
  }
  async kick(chatId: number, userId: number): Promise<void> {
    await this.call(() => this.api.banChatMember(chatId, userId, { until_date: Math.floor(Date.now() / 1000) + 60 }));
    await this.call(() => this.api.unbanChatMember(chatId, userId, { only_if_banned: true }));
  }
  async setAdminMenu(userId: number, signal?: AbortSignal): Promise<void> {
    await this.call(() => this.api.setMyCommands(ADMIN_MENU, { scope: { type: 'chat', chat_id: userId } }, telegramSignal(signal)));
  }
  async setGroupCommandMenu(chatId: number, signal?: AbortSignal): Promise<void> {
    // Menu writes share an ordered queue per group.
    const previous = this.groupMenuWrites.get(chatId) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      signal?.throwIfAborted();
      await this.call(() => this.api.setMyCommands(GROUP_USER_MENU, { scope: { type: 'chat', chat_id: chatId } }, telegramSignal(signal)));
      await this.call(() => this.api.setMyCommands(GROUP_ADMIN_MENU, { scope: { type: 'chat_administrators', chat_id: chatId } }, telegramSignal(signal)));
    });
    this.groupMenuWrites.set(chatId, write);
    try {
      await write;
    } finally {
      if (this.groupMenuWrites.get(chatId) === write) this.groupMenuWrites.delete(chatId);
    }
  }
  async profilePhotoFileId(userId: number): Promise<string | undefined> {
    const r = await this.call(() => this.api.getUserProfilePhotos(userId, { limit: 1 }));
    return r.photos[0]?.[0]?.file_id;
  }
  async mute(chatId: number, userId: number, untilSec: number): Promise<void> {
    await this.call(() => this.api.restrictChatMember(chatId, userId, this.permissions(false), { until_date: untilSec }));
  }
  async unban(chatId: number, userId: number): Promise<void> {
    await this.call(() => this.api.unbanChatMember(chatId, userId, { only_if_banned: true }));
  }
  async ban(chatId: number, userId: number): Promise<void> {
    await this.call(() => this.api.banChatMember(chatId, userId, { revoke_messages: true }));
  }
  async clearKeyboard(chatId: number, messageId: number): Promise<void> {
    await this.call(() => this.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } }));
  }
  async editMessage(chatId: number, messageId: number, text: string, markup?: Markup, rich = false): Promise<void> {
    await this.call(() =>
      this.api.editMessageText(chatId, messageId, text, {
        link_preview_options: { is_disabled: true },
        ...(rich ? { parse_mode: 'HTML' as const } : {}),
        reply_markup: markup ?? { inline_keyboard: [] },
      }),
    );
  }
  async approve(chatId: number, userId: number): Promise<void> {
    await this.call(() => this.api.approveChatJoinRequest(chatId, userId));
  }
  async decline(chatId: number, userId: number): Promise<void> {
    await this.call(() => this.api.declineChatJoinRequest(chatId, userId));
  }
  async getAdmins(chatId: number): Promise<AdminInfo[]> {
    const admins = await this.call(() => this.api.getChatAdministrators(chatId));
    return admins.map((a) => ({
      userId: a.user.id,
      isCreator: a.status === 'creator',
      isBot: a.user.is_bot,
      canInvite: a.status === 'creator' || a.can_invite_users === true,
      canRestrict: a.status === 'creator' || a.can_restrict_members === true,
    }));
  }
  async isMember(chatId: number, userId: number): Promise<boolean> {
    const m = await this.call(() => this.api.getChatMember(chatId, userId));
    return m.status === 'member' || m.status === 'administrator' || m.status === 'creator' ||
      (m.status === 'restricted' && m.is_member);
  }
  async memberName(chatId: number, userId: number): Promise<{ name: string; username?: string } | undefined> {
    if (chatId > 0) {
      const user = await this.call(() => this.api.getChat(userId));
      if (user.type !== 'private') return undefined;
      return {name:[user.first_name,user.last_name].filter(Boolean).join(' '), ...(user.username ? {username:user.username} : {})};
    }
    const m = await this.call(() => this.api.getChatMember(chatId, userId));
    const name = [m.user.first_name, m.user.last_name].filter(Boolean).join(' ');
    return { name, ...(m.user.username ? { username: m.user.username } : {}) };
  }
  async getChat(chatId: number): Promise<{ type: string; title: string }> {
    const c = await this.call(() => this.api.getChat(chatId));
    return { type: c.type, title: c.title ?? '' };
  }
  async createJoinLink(chatId: number): Promise<string> {
    const link = await this.call(() =>
      this.api.createChatInviteLink(chatId, { name: 'Ingress Guard', creates_join_request: true }),
    );
    return link.invite_link;
  }
}
