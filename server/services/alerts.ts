import { ALERT_DEFAULTS, type AlertKind } from '../../shared/domain.ts';
import { get, getSetting, run } from '../db.ts';
import { notify } from './core.ts';
import { sendToStaff } from './whatsapp.ts';

export type AlertRules = typeof ALERT_DEFAULTS;
export interface AlertPrefs { push: Partial<Record<AlertKind, boolean>>; whatsapp: Partial<Record<AlertKind, boolean>> }

export const alertRules = (): AlertRules => ({ ...ALERT_DEFAULTS, ...getSetting<Partial<AlertRules>>('alert_rules', {}) });

export const istHour = () => new Date(Date.now() + 5.5 * 3600000).getUTCHours();

/** Quiet hours may run past midnight, such as 21:00 to 08:00. */
export function isQuietNow(rules = alertRules(), hour = istHour()) {
  if (!rules.quiet_enabled || rules.quiet_start === rules.quiet_end) return false;
  return rules.quiet_start < rules.quiet_end
    ? hour >= rules.quiet_start && hour < rules.quiet_end
    : hour >= rules.quiet_start || hour < rules.quiet_end;
}

export function quietStatus() {
  const rules = alertRules();
  return { now: isQuietNow(rules), start: rules.quiet_start, end: rules.quiet_end };
}

export function alertPrefs(userId: number): AlertPrefs {
  const row = get<{ alert_prefs: string }>('SELECT alert_prefs FROM users WHERE id = ?', userId);
  const saved = JSON.parse(row?.alert_prefs || '{}');
  return { push: saved.push ?? {}, whatsapp: saved.whatsapp ?? {} };
}

export const saveAlertPrefs = (userId: number, prefs: AlertPrefs) =>
  run('UPDATE users SET alert_prefs = ? WHERE id = ?', JSON.stringify(prefs), userId);

const WHATSAPP_RULE: Partial<Record<AlertKind, keyof AlertRules>> = {
  new_lead: 'whatsapp_new_lead', followup: 'whatsapp_followup', overdue: 'whatsapp_overdue', team: 'whatsapp_overdue',
};

/**
 * The one way staff are alerted. The bell always records it. Phone alerts and
 * WhatsApp respect quiet hours, the company rules and each person's choices.
 */
export function alertUser(
  userId: number | null | undefined, kind: AlertKind, title: string, body: string, link: string,
  whatsapp?: { template: string; vars: Record<string, string> },
) {
  if (!userId) return;
  const rules = alertRules();
  const prefs = alertPrefs(userId);
  const quiet = isQuietNow(rules);
  notify(userId, title, body, link, { kind, push: !quiet && prefs.push[kind] !== false });

  const rule = WHATSAPP_RULE[kind];
  if (!whatsapp || quiet || !rule || !rules[rule] || prefs.whatsapp[kind] === false) return;
  const phone = get<{ phone: string | null }>('SELECT phone FROM users WHERE id = ?', userId)?.phone;
  if (phone) void sendToStaff(phone, whatsapp.template, whatsapp.vars).catch(() => undefined);
}
