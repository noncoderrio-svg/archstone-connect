// Company switches, duty (weekly offs, shifts, absences) and KYC number handling.
import { createHmac, randomBytes } from 'node:crypto';
import { FEATURE_DEFAULTS, type FeatureKey, type FeatureSwitches } from '../../shared/domain.ts';
import { HttpError } from '../auth.ts';
import { all, get, getSetting, setSetting } from '../db.ts';

// ---------- Feature switches ----------
export const features = (): FeatureSwitches => ({ ...FEATURE_DEFAULTS, ...getSetting<Partial<FeatureSwitches>>('features', {}) });
export const featureOn = (key: FeatureKey) => features()[key];
export function assertFeature(key: FeatureKey) {
  if (!featureOn(key)) throw new HttpError(404, 'This feature is switched off by the administrator.');
}

// ---------- India time ----------
/** Today's date, weekday (0 = Sunday) and minutes since midnight, in India time. */
export function istClock(at = Date.now()) {
  const d = new Date(at + 330 * 60000);
  return { date: d.toISOString().slice(0, 10), weekday: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

// ---------- Duty ----------
export type DutyState = 'on' | 'weekly_off' | 'absent' | 'off_shift';
interface DutyRow { id: number; weekly_off: string; shift_start: string; shift_end: string }

export const weeklyOffDays = (value: string) => (value ? value.split(',').map(Number).filter((n) => n >= 0 && n <= 6) : []);

/** Whether someone is working at this moment: not on their weekly off, not marked absent, and inside their shift if they have one. */
export function dutyState(user: DutyRow, at = Date.now()): DutyState {
  const now = istClock(at);
  if (weeklyOffDays(user.weekly_off).includes(now.weekday)) return 'weekly_off';
  if (get('SELECT 1 AS x FROM absences WHERE user_id = ? AND date = ?', user.id, now.date)) return 'absent';
  if (user.shift_start && user.shift_end) {
    const start = toMinutes(user.shift_start);
    const end = toMinutes(user.shift_end);
    const inside = start <= end ? now.minutes >= start && now.minutes < end : now.minutes >= start || now.minutes < end; // A night shift wraps past midnight.
    if (!inside) return 'off_shift';
  }
  return 'on';
}

export function dutyStateOf(userId: number, at = Date.now()): DutyState {
  const row = get<DutyRow>('SELECT id, weekly_off, shift_start, shift_end FROM users WHERE id = ?', userId);
  return row ? dutyState(row, at) : 'on';
}

/**
 * Who should not get a new lead now, strictest first: people off shift or off today, then only people off today.
 * Empty lists when the feature is off. Callers try each list in turn, and finally nobody excluded, so a lead is never left unassigned.
 */
export function assignmentExclusions(at = Date.now()): number[][] {
  if (!featureOn('duty')) return [[]];
  const rows = all<DutyRow>(`SELECT id, weekly_off, shift_start, shift_end FROM users WHERE status = 'active'`);
  const states = rows.map((r) => ({ id: r.id, state: dutyState(r, at) }));
  const notOn = states.filter((s) => s.state !== 'on').map((s) => s.id);
  const offToday = states.filter((s) => s.state === 'weekly_off' || s.state === 'absent').map((s) => s.id);
  return [notOn, offToday, []];
}

/** Picks from a list of people, preferring those on duty. Keeps the original order. */
export function preferOnDuty<T extends { id: number }>(people: T[], at = Date.now()): T[] {
  for (const excluded of assignmentExclusions(at)) {
    const left = people.filter((p) => !excluded.includes(p.id));
    if (left.length) return left;
  }
  return people;
}

/** Off-duty people still get the bell, but no phone or WhatsApp alert. */
export const offDutyNow = (userId: number) => featureOn('duty') && dutyStateOf(userId) !== 'on';

// ---------- KYC numbers ----------
/** A keyed hash, so the same Aadhaar can be recognised again without the number being stored. The key never leaves the server. */
export function aadhaarHash(digits: string) {
  let salt = getSetting<string>('kyc_hash_salt', '');
  if (!salt) {
    salt = randomBytes(32).toString('hex');
    setSetting('kyc_hash_salt', salt);
  }
  return createHmac('sha256', salt).update(digits).digest('hex');
}
export const maskPan = (pan: string) => (pan.length === 10 ? `${pan.slice(0, 2)}•••••${pan.slice(7)}` : '');
