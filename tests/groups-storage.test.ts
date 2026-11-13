import { expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '@guard/core';
import { GROUP, OWNER, enrol, harness } from './helpers';

test('reenrollment refreshes owner without resetting settings, guard or raid state', () => {
  const h = harness(); enrol(h);
  const custom = {...DEFAULT_SETTINGS,label:'custom',helpLocale:'zh-TW' as const};
  h.store.updateSettings(GROUP,custom,OWNER,'helpLocale',h.clock.now());
  h.store.setRaid(GROUP,true,OWNER,'test',h.clock.now());
  const before = h.store.getGroup(GROUP)!;
  h.clock.advance(1000);
  const after = h.store.enrolGroup(GROUP,6001,DEFAULT_SETTINGS,h.clock.now());
  expect(after).toEqual({...before,owner_user_id:6001,owner_checked_at:h.clock.now(),updated_at:h.clock.now()});
});

test('settings versions increment only for settings edits, and audit failure rolls the edit back', () => {
  const h = harness(); enrol(h);
  const before = h.store.getGroup(GROUP)!;
  h.store.db.exec("CREATE TEMP TRIGGER reject_setting BEFORE INSERT ON audit_events WHEN NEW.action='settings_changed' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  expect(()=>h.store.updateSettings(GROUP,{...DEFAULT_SETTINGS,label:'changed'},OWNER,'label',h.clock.now())).toThrow('audit unavailable');
  expect(h.store.getGroup(GROUP)).toEqual(before);
  h.store.db.exec('DROP TRIGGER reject_setting');
  h.store.updateSettings(GROUP,{...DEFAULT_SETTINGS,label:'changed'},OWNER,'label',h.clock.now());
  const edited = h.store.getGroup(GROUP)!;
  expect(edited.settings_version).toBe(before.settings_version+1);
  expect(h.store.listAudit(GROUP,1)[0]?.reason_code).toBe(`label:v${before.settings_version}->v${edited.settings_version}`);
  h.store.setLabel(GROUP,'x'.repeat(100),h.clock.now());
  expect(h.store.getGroup(GROUP)?.settings_version).toBe(edited.settings_version);
  expect(h.store.settingsOf(h.store.getGroup(GROUP)!).label).toBe('x'.repeat(64));
});

test('guard pause rolls back on audit failure and resume clears its pause reason', () => {
  const h = harness(); enrol(h);
  const before = h.store.getGroup(GROUP)!;
  h.store.db.exec("CREATE TEMP TRIGGER reject_pause BEFORE INSERT ON audit_events WHEN NEW.action='guard_paused' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  expect(()=>h.store.setEnabled(GROUP,false,OWNER,'test',h.clock.now())).toThrow('audit unavailable');
  expect(h.store.getGroup(GROUP)).toEqual(before);
  h.store.db.exec('DROP TRIGGER reject_pause');
  h.store.setEnabled(GROUP,false,OWNER,'test',h.clock.now());
  expect(h.store.getGroup(GROUP)).toMatchObject({enabled:0,paused_reason:'test'});
  h.store.setEnabled(GROUP,true,OWNER,'resumed',h.clock.now());
  expect(h.store.getGroup(GROUP)).toMatchObject({enabled:1,paused_reason:null});
});

test('failed group-removal audit restores group and administrator context', () => {
  const h = harness(); enrol(h);
  h.store.setAdminContext(OWNER,GROUP,h.clock.now());
  h.store.db.exec("CREATE TEMP TRIGGER reject_removal BEFORE INSERT ON audit_events WHEN NEW.action='group_removed' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  expect(()=>h.store.removeGroup(GROUP,OWNER,h.clock.now())).toThrow('audit unavailable');
  expect(h.store.getGroup(GROUP)).toBeDefined();
  expect(h.store.getPrefs(OWNER)?.admin_chat_id).toBe(GROUP);
  h.store.db.exec('DROP TRIGGER reject_removal');
  h.store.removeGroup(GROUP,OWNER,h.clock.now());
  expect(h.store.getGroup(GROUP)).toBeUndefined();
  expect(h.store.getPrefs(OWNER)?.admin_chat_id).toBeNull();
});
