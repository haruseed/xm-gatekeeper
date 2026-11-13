import type { Clock, Role } from '@guard/core';
import type { Store } from '@guard/database';
import type { AdminInfo, Tg } from '../telegram';

/** The role a Telegram admin list gives a user: creator → owner, admin with member-control rights → manager. */
export function roleOf(admins: AdminInfo[], userId: number): Role | null {
  const a = admins.find((x) => x.userId === userId);
  if (!a || a.isBot) return null;
  if (a.isCreator) return 'owner';
  return a.canRestrict || a.canInvite ? 'manager' : null;
}

/** Resolves authority from current Telegram data. A lookup failure throws: callers fail closed. */
export class Authority {
  private readonly cache = new Map<number, { at: number; admins: AdminInfo[] }>();
  constructor(
    private readonly tg: Pick<Tg, 'getAdmins' | 'botId'>,
    private readonly store: Pick<Store, 'syncAdmins' | 'getGroup' | 'setOwner'>,
    private readonly clock: Clock,
  ) {}

  async admins(chatId: number, fresh: boolean): Promise<AdminInfo[]> {
    const now = this.clock.now();
    const hit = this.cache.get(chatId);
    if (!fresh && hit && now - hit.at < 60_000) return hit.admins;
    const admins = await this.tg.getAdmins(chatId);
    this.cache.set(chatId, { at: now, admins });
    this.store.syncAdmins(chatId, admins.filter((a) => roleOf(admins, a.userId) !== null).map((a) => a.userId), now);
    return admins;
  }
  /**
   * Authority comes straight from Telegram, per group, with no approval step inside the bot:
   * the group's creator is its owner; any human administrator holding "Ban users" or
   * "Invite users via link" is a manager. `fresh` must be true for anything that changes state.
   */
  async role(chatId: number, userId: number, fresh: boolean): Promise<Role | null> {
    const group = this.store.getGroup(chatId);
    if (!group) return null;
    const admins = await this.admins(chatId, fresh);
    const creator = admins.find((a) => a.isCreator);
    if (creator && creator.userId !== group.owner_user_id) this.store.setOwner(chatId, creator.userId, this.clock.now());
    return roleOf(admins, userId);
  }
  async botRights(chatId: number): Promise<{ invite: boolean; restrict: boolean }> {
    const me = (await this.admins(chatId, true)).find((a) => a.userId === this.tg.botId);
    return { invite: me?.canInvite === true, restrict: me?.canRestrict === true };
  }
}
