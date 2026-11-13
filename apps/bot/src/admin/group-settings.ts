import { applySetting, languageLabel, type Clock, type GroupSettings, type Role } from '@guard/core';
import type { GroupRow, Store } from '@guard/database';
import type { Button, Tg } from '../telegram';
import { SETTING_MENU } from './settings-menu';
import { CONFIRM_TTL_MS, type AdminPresentation } from './presentation';

type SettingsStore = Pick<Store, 'settingsOf' | 'getGroup' | 'updateSettings'>;

/** Editing/presentation only. Admin authenticates scope and consumes tokens before delegation. */
export class GroupSettingsEditor {
  constructor(
    private readonly store: SettingsStore,
    private readonly tg: Pick<Tg, 'editMessage'>,
    private readonly clock: Clock,
    private readonly ui: AdminPresentation,
  ) {}

  private say: AdminPresentation['say'] = (...args) => this.ui.say(...args);
  private button: AdminPresentation['button'] = (...args) => this.ui.button(...args);
  private label: AdminPresentation['label'] = group => this.ui.label(group);

  private settingValue(group: GroupRow, key: keyof GroupSettings): string {
    const v = this.store.settingsOf(group)[key];
    if (key === 'helpLocale') return languageLabel(String(v));
    return typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v);
  }
  /** Main settings panel: one button per setting showing its current value. */
  private settingsPanel(userId: number, group: GroupRow): { text: string; rows: Button[][] } {
    const gid = group.chat_id;
    const rows: Button[][] = SETTING_MENU.map((m) => [
      this.button(userId, `${m.label}: ${this.settingValue(group, m.key)}${m.unit}`, { op: 'set', chat: gid, k: m.key }),
    ]);
    if (group.enabled) rows.push([this.button(userId, '⏸ Pause guard', { op: 'pause', chat: gid })]);
    const text = [
      `Settings for ${this.label(group)}`,
      `Guard: ${group.enabled ? 'ENABLED' : `OFF${group.paused_reason ? ` (${group.paused_reason})` : ''}: enable via /setup`} · Raid mode: ${group.raid_mode ? 'ON' : 'off'}`,
      '',
      'Tap a setting to change it.',
    ].join('\n');
    return { text, rows };
  }
  /** Sub-panel: the values offered for one setting. */
  private settingOptions(userId: number, group: GroupRow, key: string): { text: string; rows: Button[][] } {
    const gid = group.chat_id;
    const m = SETTING_MENU.find((x) => x.key === key);
    if (!m) return this.settingsPanel(userId, group);
    const current = this.settingValue(group, m.key);
    const buttons = m.options.map((o) => {
      const display = key === 'helpLocale' ? languageLabel(o) : o;
      return this.button(userId, `${display === current ? '✅ ' : ''}${display}${m.unit}`, { op: 'setv', chat: gid, k: key, v: o });
    });
    const rows: Button[][] = [];
    const perRow = m.perRow ?? 3;
    for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
    rows.push([this.button(userId, '← Back', { op: 'setm', chat: gid })]);
    const hint = key === 'timezone' ? '\n\nAny other zone: /settings timezone Europe/Paris (IANA name).' : '';
    return { text: `${this.label(group)}\n${m.label}: ${current}${m.unit}\n\nChoose a new value:${hint}`, rows };
  }

  async settings(userId: number, chatId: number, s: { group: GroupRow; role: Role }, args: string): Promise<void> {
    const now = this.clock.now();
    const current = this.store.settingsOf(s.group);
    const [key, ...rest] = args.split(/\s+/).filter(Boolean);
    if (!key) {
      const panel = this.settingsPanel(userId, s.group);
      await this.say(chatId, panel.text, panel.rows);
      return;
    }
    if (key === 'pause') {
      await this.say(chatId, 'Pause the guard? New join requests will be ignored and stay in Telegram\'s pending list.', [
        [this.button(userId, 'Yes, pause', { op: 'pause2', chat: s.group.chat_id }, CONFIRM_TTL_MS)],
      ]);
      return;
    }
    if (key === 'remove') {
      if (s.role !== 'owner') {
        await this.say(chatId, 'Only the group owner can remove the group.');
        return;
      }
      await this.say(chatId, `Remove ${this.label(s.group)} from the bot and delete its stored requests, grants and settings?`, [
        [this.button(userId, 'Yes, remove', { op: 'remove2', chat: s.group.chat_id }, CONFIRM_TTL_MS)],
      ]);
      return;
    }
    const change = applySetting(current, key, rest.join(' '));
    if (!change.ok) {
      await this.say(chatId, `Not changed: ${change.error}.`);
      return;
    }
    this.store.updateSettings(s.group.chat_id, change.settings, userId, key, now);
    await this.say(chatId, `Updated ${key}. New challenges use the new policy.`);
  }

  async onAction(userId: number, chatId: number, p: Record<string, string | number>, group: GroupRow, now: number, messageId?: number): Promise<string | undefined> {
    const groupId = group.chat_id;
    let toast: string | undefined;
    if (p.op === 'setv') {
      const change = applySetting(this.store.settingsOf(group), String(p.k), String(p.v));
      if (!change.ok) return `Not changed: ${change.error}.`;
      this.store.updateSettings(groupId, change.settings, userId, String(p.k), now);
      group = this.store.getGroup(groupId)!;
      toast = 'Saved';
    }
    const panel = p.op === 'set' ? this.settingOptions(userId, group, String(p.k)) : this.settingsPanel(userId, group);
    // The panel is edited in place; if that is not possible it is sent as a new message.
    const edited =
      messageId !== undefined &&
      (await this.tg.editMessage(chatId, messageId, panel.text, { inline_keyboard: panel.rows }).then(() => true, () => false));
    if (!edited) await this.say(chatId, panel.text, panel.rows);
    return toast;
  }
}
