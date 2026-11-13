import type { Message, User } from 'grammy/types';
import type { UsernameDirectory } from '@guard/database';
import type { Tg } from './telegram';

export const USERNAME = /^@[a-zA-Z0-9_]{1,32}$/;
export type UserTarget = number | string;

/** Explicit arguments take priority over a reply. Multiple targets are rejected. */
export function commandTarget(message: Message, args: string): { target?: UserTarget; ambiguous: boolean } {
  let text = message.text ?? '';
  for (const e of [...(message.entities ?? [])].sort((a,b)=>b.offset-a.offset)) {
    if (e.type === 'text_mention') text = text.slice(0,e.offset) + ' '.repeat(e.length) + text.slice(e.offset+e.length);
  }
  const command = message.entities?.find(e=>e.type==='bot_command' && e.offset===0);
  const argumentsText = command ? text.slice(command.length) : args;
  const targets: UserTarget[] = argumentsText.split(/\s+/).filter(w => USERNAME.test(w) || /^\d{1,15}$/.test(w));
  for (const e of message.entities ?? []) if (e.type === 'text_mention') targets.push(e.user.id);
  if (targets.length > 1) return { ambiguous: true };
  const direct = targets[0];
  if (direct !== undefined) return {target:direct,ambiguous:false};
  const reply = message.reply_to_message;
  if (reply?.from && !reply.forum_topic_created && !reply.from.is_bot) return {target:reply.from.id,ambiguous:false};
  return {ambiguous:false};
}

/** Recheck a cached username live before using its ID for an action. Never guess. */
export async function resolveTarget(store: UsernameDirectory, tg: Pick<Tg, 'memberName'>, groupId: number, target: UserTarget | undefined, now: number): Promise<number | undefined> {
  if (typeof target === 'number') return Number.isSafeInteger(target) && target > 0 ? target : undefined;
  if (target && /^\d{1,15}$/.test(target)) return Number(target) > 0 ? Number(target) : undefined;
  if (!target || !USERNAME.test(target)) return undefined;
  const username = target.slice(1).toLowerCase();
  const id = store.userIdForUsername(username,now);
  if (id === undefined) return undefined;
  const current = await tg.memberName(groupId,id).catch(()=>undefined);
  if (!current) return undefined;
  store.rememberUsername(id,current.username,now);
  return current.username?.toLowerCase() === username ? id : undefined;
}

/** Index only Telegram-supplied identity fields, never usernames typed in message text. */
export function rememberUser(store: UsernameDirectory, user: User | undefined, now: number): void {
  if (user && !user.is_bot) store.rememberUsername(user.id,user.username,now);
}
