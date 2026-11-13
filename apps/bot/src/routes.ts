import type { Bot, Context } from 'grammy';
import { errorCode, isLocale, log, type Clock } from '@guard/core';
import type { AssetStore } from '@guard/assets';
import type { Store } from '@guard/database';
import { t } from '@guard/i18n';
import { parseDuration, type Admin, type Moderation } from './admin';
import { commandTarget } from './targets';
import { dcFromFileId, esc, userLink, type Tg } from './telegram';
import type { Verification } from './verification';

export interface Services {
  verification: Verification;
  admin: Admin;
  store: Store;
  assets: AssetStore;
  tg: Tg;
  clock: Clock;
}

const MEMBER = new Set(['member', 'administrator', 'creator']);

/** Registers handlers on the bot. Handlers must be idempotent: the durable inbox can redeliver. */
export function registerRoutes(bot: Bot, s: Services): void {
  const { verification: v, admin } = s;
  const isPrivate = (ctx: Context) => ctx.chat?.type === 'private';

  bot.on('chat_join_request', async (ctx) => {
    const req = ctx.chatJoinRequest;
    if ((req as { query_id?: unknown }).query_id) {
      // Join-query mode is not this bot's flow. Intake already answered "queue"; nothing is approved.
      log('warn', 'join_query_mode', { chat: req.chat.id });
      return;
    }
    await v.onJoin({
      updateId: ctx.update.update_id,
      chatId: req.chat.id,
      userId: req.from.id,
      contactChatId: req.user_chat_id,
      requestedAt: req.date * 1000,
    });
  });

  bot.on('chat_member', async (ctx) => {
    const { old_chat_member: before, new_chat_member: after } = ctx.chatMember;
    const wasIn = MEMBER.has(before.status) || (before.status === 'restricted' && before.is_member);
    const isIn = MEMBER.has(after.status) || (after.status === 'restricted' && after.is_member);
    if (!wasIn && isIn && !after.user.is_bot) {
      // from === the member themself means they joined on their own (link, public group).
      const selfJoin = ctx.chatMember.from.id === after.user.id;
      await v.onMemberJoined(ctx.chat.id, after.user.id, selfJoin, ctx.update.update_id, ctx.chatMember.date * 1000);
    } else if (wasIn && !isIn) await v.onMemberLeft(ctx.chat.id, after.user.id);
    const adminish = (st: string) => st === 'administrator' || st === 'creator';
    if (adminish(before.status) || adminish(after.status)) await admin.refreshAdmins(ctx.chat.id);
  });

  bot.on('my_chat_member', async (ctx) => {
    const chat = ctx.chat;
    if (chat.type === 'private') return;
    const m = ctx.myChatMember.new_chat_member;
    const usable = m.status === 'administrator' && (m.can_invite_users === true || m.can_restrict_members === true);
    await admin.onBotStatus(chat.id, chat.title ?? '', chat.type, m.status, usable);
  });

  bot.on('message:new_chat_title', async (ctx) => {
    await admin.syncTitle(ctx.chat.id, ctx.message.new_chat_title);
  });
  bot.on('message:migrate_to_chat_id', async (ctx) => {
    await admin.onMigration(ctx.chat.id);
  });

  /** What the bot does; administrators of a guarded group also get their command list. */
  const sendHelp = async (userId: number, chatId: number) => {
    const locale = v.localeFor(userId);
    let text = `${t(locale, s.store.requireCap ? 'help.cap' : 'help.text')}\n\n${t(locale, 'help.notice')}`;
    text += '\n\n/whoami: my user ID and data centre';
    if (await admin.isAdmin(userId)) text += `\n\n${admin.helpText()}`;
    await v.say(chatId, text);
  };

  // ----- applicant commands (private chat) -----
  bot.command('start', async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return;
    if (!(await v.onStart(ctx.from.id, ctx.chat.id, ctx.match.trim().slice(0, 64)))) await sendHelp(ctx.from.id, ctx.chat.id);
  });
  bot.command('help', async (ctx) => {
    if (isPrivate(ctx) && ctx.from) await sendHelp(ctx.from.id, ctx.chat.id);
  });
  bot.command('whoami', async (ctx) => {
    if (!ctx.from || !ctx.message) return;
    const target = ctx.from.id; // Always the sender, regardless of arguments or replies.
    const locale = v.localeFor(ctx.from.id);
    const fileId = await s.tg.profilePhotoFileId(target).catch(() => undefined);
    const dc = (fileId && dcFromFileId(fileId)) || t(locale, 'whoami.dc_unknown');
    const who = await s.tg.memberName(ctx.chat.id,target).catch(()=>undefined);
    await v.say(ctx.chat.id,`${userLink(target,who)}\n${esc(t(locale, 'whoami.text', { id: target, dc }))}`,undefined,true);
  });


  // ----- administration (private chat; anonymous group admins have no usable identity) -----
  bot.command('setup', async (ctx) => {
    if (!ctx.from) return;
    if (isPrivate(ctx)) await admin.setup(ctx.from.id, ctx.chat.id);
    else if (ctx.chat.type === 'supergroup' || ctx.chat.type === 'group') {
      await admin.setupFromGroup(ctx.chat.id, ctx.chat.title, ctx.chat.type);
    }
  });
  const adminCommand = (name: string, fn: (userId: number, chatId: number, args: string) => Promise<void>) => {
    bot.command(name, async (ctx) => {
      if (!isPrivate(ctx) || !ctx.from) return;
      await fn(ctx.from.id, ctx.chat.id, ctx.match.trim().slice(0, 200));
    });
  };
  // /ban, /mute and /unban: reply to the person's message in the group, or name them by user ID.
  const moderation = (name: 'ban' | 'mute' | 'unban') => {
    bot.command(name, async (ctx) => {
      if (!ctx.from || !ctx.message) return;
      const words = ctx.match.trim().split(/\s+/).filter(Boolean).slice(0, 3);
      const parsed = commandTarget(ctx.message,ctx.match.trim());
      if (parsed.ambiguous) { await v.say(ctx.chat.id,'Please specify one person only.'); return; }
      const duration = words.map(parseDuration).find((d) => d !== undefined) ?? { seconds: 3600, label: '1 h' };
      const action: Moderation = name === 'mute' ? { kind: 'mute', ...duration } : { kind: name };
      if (isPrivate(ctx)) return admin.moderate(ctx.from.id, ctx.chat.id, String(parsed.target ?? ''), action);
      await admin.moderateInGroup(ctx.from.id, ctx.chat.id, parsed.target, action);
    });
  };
  moderation('ban');
  moderation('mute');
  moderation('unban');
  adminCommand('review', (u, c) => admin.review(u, c));
  adminCommand('raid', (u, c, a) => admin.raid(u, c, a.toLowerCase()));
  adminCommand('settings', (u, c, a) => admin.settings(u, c, a));
  adminCommand('audit', (u, c) => admin.audit(u, c));
  adminCommand('status', (u, c) => admin.status(u, c));
  adminCommand('group', (u, c) => admin.pickGroup(u, c));

  // ----- callbacks: the actor is always ctx.from, never an ID inside button data -----
  const ack = async (ctx: Context, text?: string) => {
    await ctx.answerCallbackQuery(text ? { text } : {}).catch(() => undefined); // old queries cannot be answered
  };
  const privateChatOf = (ctx: Context): number | undefined => {
    const chat = ctx.callbackQuery?.message?.chat;
    return chat && chat.type === 'private' ? chat.id : undefined;
  };

  /** The chat a button was pressed in, and whether it is a group (where only the checked member counts). */
  const pressedIn = (ctx: Context): { id: number; group: boolean } | undefined => {
    const chat = ctx.callbackQuery?.message?.chat;
    return chat ? { id: chat.id, group: chat.type !== 'private' } : undefined;
  };

  bot.callbackQuery(/^[cs]:([A-Za-z0-9_-]{22})$/, async (ctx) => {
    const chat = pressedIn(ctx);
    if (!chat) return ack(ctx);
    const res = v.answer(ctx.from.id, chat.id, ctx.match[1]!, ctx.callbackQuery.data.startsWith('s:'));
    const stale = chat.group ? v.notYoursText(ctx.from.id, chat.id) : v.staleText(ctx.from.id);
    await ack(ctx, res.result === 'skip-limit' ? t(v.localeFor(ctx.from.id, chat.id), 'challenge.skip_limit') : res.result === 'stale' ? stale : undefined);
    await v.afterAnswer(res, chat.id);
  });
  bot.callbackQuery(/^l:([A-Za-z-]{2,5})$/, async (ctx) => {
    const chat = pressedIn(ctx);
    const locale = ctx.match[1];
    if (!chat || !isLocale(locale)) return ack(ctx);
    if (chat.group) {
      const own = await v.onGroupLanguage(ctx.from.id, chat.id, locale);
      return ack(ctx, own ? undefined : v.notYoursText(ctx.from.id, chat.id));
    }
    await ack(ctx);
    await v.onLanguagePicked(ctx.from.id, chat.id, locale);
  });
  bot.callbackQuery(/^([gth]):([A-Za-z0-9_-]{22})$/, async (ctx) => {
    const chat = pressedIn(ctx);
    if (!chat) return ack(ctx);
    const [, kind, id] = ctx.match;
    if (chat.group) {
      const own = kind === 'h' ? await v.onGroupHelp(ctx.from.id, chat.id, id!) : await v.onGroupRetry(ctx.from.id, chat.id, id!);
      return ack(ctx, own ? undefined : v.notYoursText(ctx.from.id, chat.id));
    }
    await ack(ctx);
    if (kind === 'h') await v.onHelp(ctx.from.id, chat.id, id!);
    else await v.onPickRequest(ctx.from.id, chat.id, id!);
  });
  bot.callbackQuery(/^a:([A-Za-z0-9_-]{22})$/, async (ctx) => {
    const chatId = privateChatOf(ctx);
    if (chatId === undefined) return ack(ctx);
    const toast = await admin.onAction(ctx.from.id, chatId, ctx.match[1]!, ctx.callbackQuery.message?.message_id);
    await ack(ctx, toast);
  });
  bot.on('callback_query', (ctx) => ack(ctx, v.staleText(ctx.from.id)));

  // ----- anything else in private chat -----
  bot.on('message', async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return;
    if ((ctx.message as { _media?: boolean })._media) {
      await v.say(ctx.chat.id, t(v.localeFor(ctx.from.id), 'contact.unneeded'));
      return;
    }
    if (!(await v.onStart(ctx.from.id, ctx.chat.id, ''))) await sendHelp(ctx.from.id, ctx.chat.id);
  });
}
