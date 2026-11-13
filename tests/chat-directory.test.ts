import { expect, test } from 'bun:test';
import { GROUP, OWNER, enrol, harness } from './helpers';

test('discovery filters bot status and updates renamed groups without touching unchanged timestamps', () => {
  const h = harness(); const now = h.clock.now();
  h.store.upsertKnownChat(GROUP, 'old', 'supergroup', 'administrator', now);
  h.store.upsertKnownChat(-2002, 'other', 'supergroup', 'administrator', now + 1);
  h.store.upsertKnownChat(-3003, 'removed', 'supergroup', 'left', now + 2);
  expect(h.store.listKnownChats(1).map(row => row.chat_id)).toEqual([-2002]);
  h.store.setKnownChatTitle(GROUP, 'old', now + 3);
  expect(h.store.listKnownChats(10).find(row => row.chat_id === GROUP)?.updated_at).toBe(now);
  h.store.setKnownChatTitle(GROUP, 'x'.repeat(200), now + 4);
  expect(h.store.listKnownChats(10)[0]).toMatchObject({chat_id:GROUP,title:'x'.repeat(128),updated_at:now+4});
  h.store.upsertKnownChat(GROUP, 'renamed', 'supergroup', 'member', now + 5);
  expect(h.store.listKnownChats(10).map(row => row.chat_id)).toEqual([-2002]);
  h.store.removeKnownChat(-2002);
  expect(h.store.listKnownChats(10)).toEqual([]);
});

test('administrator mirror replacement deduplicates and rolls back a partial insert failure', () => {
  const h = harness(); enrol(h);
  h.store.syncAdmins(GROUP, [OWNER, 5001, 5001], h.clock.now());
  expect(h.store.listAdmins(GROUP)).toEqual([{user_id:OWNER},{user_id:5001}]);
  h.store.db.exec("CREATE TEMP TRIGGER reject_admin BEFORE INSERT ON group_admins WHEN NEW.user_id=6002 BEGIN SELECT RAISE(ABORT,'mirror write failed'); END;");
  expect(() => h.store.syncAdmins(GROUP, [6001,6002], h.clock.now())).toThrow('mirror write failed');
  expect(h.store.listAdmins(GROUP)).toEqual([{user_id:OWNER},{user_id:5001}]);
  h.store.db.exec('DROP TRIGGER reject_admin');
  h.store.syncAdmins(-9999, [6001], h.clock.now());
  expect(h.store.listAdmins(-9999)).toEqual([]);
  h.store.syncAdmins(GROUP, [], h.clock.now());
  expect(h.store.listAdmins(GROUP)).toEqual([]);
});

test('a stale directory candidate does not grant current Telegram authority', async () => {
  const h = harness(); enrol(h);
  h.store.syncAdmins(GROUP, [5001], h.clock.now());
  expect(h.store.candidateGroupsFor(5001).map(row => row.chat_id)).toEqual([GROUP]);
  expect(await h.authority.role(GROUP, 5001, true)).toBeNull();
  expect(h.store.candidateGroupsFor(5001)).toEqual([]);
  expect(h.store.candidateGroupsFor(OWNER).map(row => row.chat_id)).toEqual([GROUP]);
});
