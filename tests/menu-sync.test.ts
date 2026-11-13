import { expect, test } from 'bun:test';
import { Api } from 'grammy';
import { GrammyTg, TgError } from '../apps/bot/src/telegram';
import { synchronizeMenus } from '../apps/bot/src/menu-sync';
import { GROUP, OWNER, enrol, harness } from './helpers';

const fakeApi = () => {
  const api = new Api('999:test');
  api.setMyCommands = async () => true;
  return api;
};

test('menu retries preserve the group scope after a temporary network failure', async () => {
  const h = harness(); enrol(h);
  const recorded: number[] = [];
  await synchronizeMenus({
    api: fakeApi(), store: h.store,
    tg: {
      setAdminMenu: async () => {},
      setGroupCommandMenu: async chat => {
        recorded.push(chat);
        if (recorded.length === 1) throw new TgError('network', 'offline');
      },
    },
  }, new AbortController().signal, async () => {});
  expect(recorded).toEqual([GROUP, GROUP]);
});

test('menu synchronization caps retries and respects cancellation', async () => {
  const h = harness();
  const controller = new AbortController();
  const api = new Api('999:test');
  let calls = 0;
  api.setMyCommands = async () => { calls++; throw new TgError('network', 'offline'); };
  await synchronizeMenus({ api, tg: h.tg, store: h.store }, controller.signal, async () => {});
  expect(calls).toBe(9); // Three global scopes, at most three attempts per scope.
  calls = 0;
  await synchronizeMenus({ api, tg: h.tg, store: h.store }, controller.signal, async () => { controller.abort(); });
  expect(calls).toBe(1);
});

test('group menu updates serialize both Telegram scopes in invocation order', async () => {
  const api = new Api('999:test');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writes: { scope: string; commands: string[] }[] = [];
  api.setMyCommands = async (commands, options) => {
    writes.push({ scope: options!.scope!.type, commands: commands.map(c => c.command) });
    if (writes.length === 1) { entered.resolve(); await release.promise; }
    return true;
  };
  const tg = new GrammyTg(api, 999, 'test');
  const startup = tg.setGroupCommandMenu(GROUP);
  await entered.promise;
  const second = tg.setGroupCommandMenu(GROUP);
  release.resolve();
  await Promise.all([startup, second]);
  expect(writes.map(w => w.scope)).toEqual(['chat', 'chat_administrators', 'chat', 'chat_administrators']);
  expect(writes[0]!.commands).toEqual(writes[2]!.commands);
  expect(writes[1]!.commands).toEqual(writes[3]!.commands);
});
