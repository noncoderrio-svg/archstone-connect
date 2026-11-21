// Feature switches, bulletin bar, duty (weekly offs, shifts, absences) and KYC numbers.
import { Router } from 'express';
import { z } from 'zod';
import { FEATURES, ROLES, aadhaarValid, panValid, type FeatureSwitches } from '../../shared/domain.ts';
import { HttpError, assertCan, requirePermission, type SessionUser } from '../auth.ts';
import { all, get, run, setSetting, tx } from '../db.ts';
import { audit, broadcast, notify, visibleLead, workableLead } from '../services/core.ts';
import { teamOf } from '../services/hierarchy.ts';
import { assignLead, logActivity } from '../services/leads.ts';
import { decryptText, encryptText } from '../services/secrets.ts';
import { aadhaarHash, assertFeature, dutyState, features, istClock, maskPan, preferOnDuty, weeklyOffDays } from '../services/workplace.ts';

export const workplace = Router();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-16.');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:30.');

// ---------- Feature switches (administrator only) ----------
workplace.get('/features', (req, res) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can change features.');
  res.json({ features: features(), catalog: FEATURES });
});

workplace.put('/features', (req, res) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can change features.');
  // A screen opened before a new feature was added does not send it, so anything missing keeps its current value.
  const sent = z.object(Object.fromEntries(FEATURES.map((f) => [f.key, z.boolean().optional()])) as Record<keyof FeatureSwitches, z.ZodOptional<z.ZodBoolean>>).parse(req.body);
  const before = features();
  const b = Object.fromEntries(FEATURES.map((f) => [f.key, sent[f.key] ?? before[f.key]])) as FeatureSwitches;
  setSetting('features', b);
  const changed = FEATURES.filter((f) => before[f.key] !== b[f.key]).map((f) => `${f.key} ${b[f.key] ? 'on' : 'off'}`);
  if (changed.length) audit(req, 'settings.features', 'settings', '', changed.join(', '));
  res.json({ ok: true });
});

// ---------- Bulletin bar ----------
const KINDS = ['news', 'target', 'launch', 'offer', 'birthday'] as const;
const bulletinBody = z.object({
  text: z.string().trim().min(3).max(280),
  kind: z.enum(KINDS).default('news'),
  starts_on: day,
  ends_on: day,
  roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
  active: z.boolean().default(true),
}).refine((b) => b.ends_on >= b.starts_on, { message: 'The end date must be on or after the start date.' });

const showBulletin = (r: any) => ({ ...r, roles: JSON.parse(r.roles), active: Boolean(r.active) });

/** What this person sees today. Nothing when the feature is off or they may not see it. */
workplace.get('/bulletins/current', (req, res) => {
  if (!features().bulletin || !req.user.permissions.includes('bulletin.view')) return res.json({ bulletins: [] });
  const today = istClock().date;
  const rows = all<any>('SELECT id, text, kind, roles FROM bulletins WHERE active = 1 AND starts_on <= ? AND ends_on >= ? ORDER BY starts_on DESC, id DESC LIMIT 20', today, today);
  res.json({ bulletins: rows.map(showBulletin).filter((b) => !b.roles.length || b.roles.includes(req.user.role)).map(({ id, text, kind }) => ({ id, text, kind })) });
});

workplace.get('/bulletins', requirePermission('bulletin.manage'), (_req, res) => {
  res.json({ bulletins: all<any>('SELECT b.*, u.name AS author FROM bulletins b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.ends_on DESC, b.id DESC LIMIT 200').map(showBulletin), today: istClock().date });
});

workplace.post('/bulletins', requirePermission('bulletin.manage'), (req, res) => {
  const b = bulletinBody.parse(req.body);
  const { id } = run('INSERT INTO bulletins(text, kind, starts_on, ends_on, roles, active, created_by) VALUES(?, ?, ?, ?, ?, ?, ?)',
    b.text, b.kind, b.starts_on, b.ends_on, JSON.stringify(b.roles), b.active ? 1 : 0, req.user.id);
  audit(req, 'bulletin.create', 'bulletin', id, b.text.slice(0, 80));
  broadcast('bulletins');
  res.status(201).json({ id });
});

workplace.put('/bulletins/:id', requirePermission('bulletin.manage'), (req, res) => {
  const id = Number(req.params.id);
  const b = bulletinBody.parse(req.body);
  const { changes } = run('UPDATE bulletins SET text = ?, kind = ?, starts_on = ?, ends_on = ?, roles = ?, active = ? WHERE id = ?',
    b.text, b.kind, b.starts_on, b.ends_on, JSON.stringify(b.roles), b.active ? 1 : 0, id);
  if (!changes) throw new HttpError(404, 'Message not found.');
  audit(req, 'bulletin.update', 'bulletin', id);
  broadcast('bulletins');
  res.json({ ok: true });
});

workplace.delete('/bulletins/:id', requirePermission('bulletin.manage'), (req, res) => {
  const id = Number(req.params.id);
  run('DELETE FROM bulletins WHERE id = ?', id);
  audit(req, 'bulletin.delete', 'bulletin', id);
  broadcast('bulletins');
  res.json({ ok: true });
});

// ---------- Duty ----------
/** Admins manage everyone; other people with the permission manage only those below them. */
function dutyPeople(user: SessionUser): number[] | 'all' {
  return user.role === 'admin' ? 'all' : teamOf(user.id);
}
function assertDutyOver(user: SessionUser, targetId: number) {
  assertFeature('duty');
  assertCan(user, 'duty.manage');
  const people = dutyPeople(user);
  if (people !== 'all' && !people.includes(targetId)) throw new HttpError(403, 'You can only manage duty for people in your team.');
  const target = get<any>('SELECT id, name, role, status, manager_id, weekly_off, shift_start, shift_end FROM users WHERE id = ?', targetId);
  if (!target) throw new HttpError(404, 'User not found.');
  return target;
}

workplace.get('/duty', requirePermission('duty.manage'), (req, res) => {
  assertFeature('duty');
  const date = day.optional().parse(req.query.date) ?? istClock().date;
  const people = dutyPeople(req.user);
  const rows = all<any>(
    `SELECT u.id, u.name, u.role, u.team, u.weekly_off, u.shift_start, u.shift_end, a.reason AS absent_reason
     FROM users u LEFT JOIN absences a ON a.user_id = u.id AND a.date = ?
     WHERE u.status = 'active' AND u.role != 'admin' ORDER BY u.name`,
    date,
  ).filter((u) => people === 'all' || people.includes(u.id));
  const today = istClock().date;
  res.json({
    date,
    today,
    people: rows.map((u) => ({
      ...u,
      weekly_off: weeklyOffDays(u.weekly_off),
      // "Now" only makes sense for today; other dates show the planned day.
      state: date === today ? dutyState(u) : u.absent_reason !== null ? 'absent' : weeklyOffDays(u.weekly_off).includes(new Date(`${date}T12:00:00Z`).getUTCDay()) ? 'weekly_off' : 'on',
    })),
  });
});

workplace.put('/duty/users/:id', (req, res) => {
  const target = assertDutyOver(req.user, Number(req.params.id));
  const b = z.object({
    weekly_off: z.array(z.number().int().min(0).max(6)).max(6),
    shift_start: z.union([time, z.literal('')]),
    shift_end: z.union([time, z.literal('')]),
  }).refine((b) => Boolean(b.shift_start) === Boolean(b.shift_end), { message: 'Set both shift start and end, or neither.' })
    .refine((b) => !b.shift_start || b.shift_start !== b.shift_end, { message: 'The shift cannot start and end at the same time.' })
    .parse(req.body);
  run('UPDATE users SET weekly_off = ?, shift_start = ?, shift_end = ? WHERE id = ?', [...new Set(b.weekly_off)].sort().join(','), b.shift_start, b.shift_end, target.id);
  audit(req, 'duty.update', 'user', target.id, `off ${b.weekly_off.join(',') || 'none'}, shift ${b.shift_start || '-'}–${b.shift_end || '-'}`);
  broadcast('duty');
  res.json({ ok: true });
});

/** Picks a colleague to take over: same role, same manager first, then the same role anywhere, on duty where possible. */
function standIn(target: any, excludeIds: number[]) {
  const sameManager = target.manager_id
    ? all<any>(`SELECT id, name FROM users WHERE status = 'active' AND role = ? AND manager_id = ? AND id != ? ORDER BY id`, target.role, target.manager_id, target.id)
    : [];
  const sameRole = all<any>(`SELECT id, name FROM users WHERE status = 'active' AND role = ? AND id != ? ORDER BY id`, target.role, target.id);
  for (const pool of [sameManager, sameRole]) {
    const left = pool.filter((p) => !excludeIds.includes(p.id));
    const present = left.filter((p) => !get('SELECT 1 AS x FROM absences WHERE user_id = ? AND date = ?', p.id, istClock().date));
    const best = preferOnDuty(present);
    if (best.length) return best[0];
  }
  return null;
}

workplace.post('/duty/absences', (req, res) => {
  const b = z.object({
    user_id: z.number().int(),
    date: day.optional(),
    reason: z.string().trim().max(120).default(''),
    hand_over_followups: z.boolean().default(true),
    hand_over_leads: z.boolean().default(false),
    to_user_id: z.number().int().optional(),
  }).parse(req.body);
  const target = assertDutyOver(req.user, b.user_id);
  const date = b.date ?? istClock().date;
  let to: { id: number; name: string } | null = null;
  if (b.hand_over_followups || b.hand_over_leads) {
    if (b.to_user_id) {
      if (b.to_user_id === target.id) throw new HttpError(400, 'Choose someone other than the absent person.');
      to = get<any>(`SELECT id, name FROM users WHERE id = ? AND status = 'active'`, b.to_user_id) ?? null;
      if (!to) throw new HttpError(400, 'The person taking over is not active.');
    } else {
      to = standIn(target, []);
      if (!to) throw new HttpError(409, 'Nobody else with the same role is available. Choose who takes over.');
    }
  }
  const moved = tx(() => {
    run('INSERT INTO absences(user_id, date, reason, marked_by) VALUES(?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET reason = excluded.reason, marked_by = excluded.marked_by',
      target.id, date, b.reason, req.user.id);
    let followups = 0;
    let leads = 0;
    if (to && b.hand_over_followups) {
      // Overdue follow-ups and those due on the absent day (India time).
      followups = run(
        `UPDATE tasks SET owner_id = ? WHERE owner_id = ? AND completed_at IS NULL AND date(due_at, '+330 minutes') <= ?`,
        to.id, target.id, date,
      ).changes;
    }
    if (to && b.hand_over_leads) {
      const open = all<{ id: number }>(`SELECT id FROM leads WHERE owner_id = ? AND deleted_at IS NULL AND stage NOT IN ('Booked','Lost','Unqualified')`, target.id);
      for (const l of open) assignLead(l.id, to.id, req.user.id, `${target.name} absent on ${date}`);
      leads = open.length;
    }
    return { followups, leads };
  });
  if (to && moved.followups) notify(to.id, 'Follow-ups handed to you', `${moved.followups} from ${target.name}, absent on ${date}`, '/followups');
  audit(req, 'duty.absent', 'user', target.id, `${date}${b.reason ? `: ${b.reason}` : ''}; ${moved.followups} follow-ups, ${moved.leads} leads to ${to?.name ?? 'nobody'}`);
  broadcast('duty');
  broadcast('tasks');
  res.status(201).json({ date, to, ...moved });
});

workplace.delete('/duty/absences/:userId/:date', (req, res) => {
  const target = assertDutyOver(req.user, Number(req.params.userId));
  const date = day.parse(req.params.date);
  run('DELETE FROM absences WHERE user_id = ? AND date = ?', target.id, date);
  audit(req, 'duty.present', 'user', target.id, `${date} (follow-ups already handed over stay where they are)`);
  broadcast('duty');
  res.json({ ok: true });
});

// ---------- KYC numbers ----------
workplace.get('/leads/:id/kyc', requirePermission('kyc.view'), (req, res) => {
  assertFeature('kyc');
  const lead = visibleLead(req.user, Number(req.params.id));
  const pan = lead.kyc_pan_enc ? decryptText(lead.kyc_pan_enc) : '';
  const sameAadhaar = lead.kyc_aadhaar_hash
    ? all<any>(`SELECT id, name FROM leads WHERE kyc_aadhaar_hash = ? AND id != ? AND deleted_at IS NULL LIMIT 5`, lead.kyc_aadhaar_hash, lead.id)
    : [];
  audit(req, 'kyc.view', 'lead', lead.id);
  res.json({
    pan,
    aadhaar: lead.kyc_aadhaar_last4 ? `XXXX XXXX ${lead.kyc_aadhaar_last4}` : '',
    // Only says another customer has the same Aadhaar; their details stay behind the usual lead permissions.
    aadhaar_also_on: sameAadhaar.map((l) => l.id),
  });
});

workplace.put('/leads/:id/kyc', requirePermission('kyc.view'), (req, res) => {
  assertFeature('kyc');
  const lead = workableLead(req.user, Number(req.params.id));
  const b = z.object({
    pan: z.string().trim().max(20).nullable().optional(),
    aadhaar: z.string().trim().max(20).nullable().optional(),
  }).parse(req.body);
  const changed: string[] = [];
  if (b.pan !== undefined) {
    const pan = (b.pan ?? '').toUpperCase().replace(/\s/g, '');
    if (pan && !panValid(pan)) throw new HttpError(400, 'That PAN does not look right. It should be 5 letters, 4 digits and 1 letter, like ABCPE1234F.');
    run('UPDATE leads SET kyc_pan_enc = ? WHERE id = ?', pan ? encryptText(pan) : '', lead.id);
    changed.push(pan ? `PAN ${maskPan(pan)}` : 'PAN removed');
  }
  if (b.aadhaar !== undefined) {
    const digits = (b.aadhaar ?? '').replace(/[\s-]/g, '');
    if (digits && !aadhaarValid(digits)) throw new HttpError(400, 'That Aadhaar number is not valid. Please check all 12 digits.');
    run('UPDATE leads SET kyc_aadhaar_last4 = ?, kyc_aadhaar_hash = ? WHERE id = ?', digits ? digits.slice(-4) : '', digits ? aadhaarHash(digits) : '', lead.id);
    changed.push(digits ? `Aadhaar ending ${digits.slice(-4)}` : 'Aadhaar removed');
  }
  if (changed.length) {
    logActivity(lead.id, 'document', 'KYC details updated', changed.join(', '), req.user.id);
    audit(req, 'kyc.update', 'lead', lead.id, changed.join(', '));
  }
  res.json({ ok: true });
});
