import { LANGUAGE_OPTIONS, type GroupSettings } from '@guard/core';

/** Settings shown as buttons: label, unit and the values offered (all inside the system bounds). */
export const SETTING_MENU: { key: keyof GroupSettings; label: string; unit: string; options: string[]; perRow?: number }[] = [
  { key: 'quarantine', label: 'Mute & verify new joiners', unit: '', options: ['on', 'off'] },
  { key: 'challengeTimeoutSec', label: 'Time for picture stage', unit: ' s', options: ['60', '120', '180', '240', '300', '600'] },
  { key: 'attempts', label: 'Attempts', unit: '', options: ['1', '2', '3'] },
  { key: 'attemptWindowMin', label: 'Attempt window', unit: ' min', options: ['5', '15', '30', '60'] },
  { key: 'requestLifetimeMin', label: 'Time for Cap', unit: ' min', options: ['1', '5', '10', '15', '30', '60'] },
  { key: 'helpLocale', label: 'Group message language', unit: '', options: LANGUAGE_OPTIONS.map(x => x.locale) },
  {
    key: 'timezone',
    label: 'Time zone',
    unit: '',
    perRow: 2,
    options: ['UTC', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles'],
  },
  { key: 'burstThreshold', label: 'Raid trigger (joins per min)', unit: '', options: ['5', '10', '20', '50', '100', '200'] },
  { key: 'approvalsPerMinute', label: 'Auto-approvals per min', unit: '', options: ['1', '5', '10', '30', '60'] },
  { key: 'reviewExpiryDays', label: 'Review records kept', unit: ' d', options: ['1', '3', '7', '14'] },
  { key: 'auditRetentionDays', label: 'Audit log kept', unit: ' d', options: ['1', '7', '14', '30'] },
];
