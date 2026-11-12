// Payment follow-up: one page per project with every active booking, its payment stages and the follow-up log.
import { Router } from 'express';
import { z } from 'zod';
import { PAYMENT_OUTCOMES } from '../../shared/domain.ts';
import { HttpError, requirePermission, type SessionUser } from '../auth.ts';
import { all, get, nowIso, run } from '../db.ts';
import { audit, broadcast, leadScope, maskPhone, phoneMasked } from '../services/core.ts';
import { logActivity } from '../services/leads.ts';
import { visibleBooking } from './postsales.ts';

export const payments = Router();

export type PaymentState = 'Received' | 'Overdue' | 'Due in 7 days' | 'Upcoming';

/** Received once paid. Otherwise by due date against today in India. */
export function paymentState(p: { paid_at: string | null; due_date: string }, today: string, inWeek: string): PaymentState {
  if (p.paid_at) return 'Received';
  if (p.due_date < today) return 'Overdue';
  if (p.due_date <= inWeek) return 'Due in 7 days';
  return 'Upcoming';
}

const istDate = (offsetDays = 0) => get<{ d: string }>(`SELECT date('now', '+330 minutes', ?) AS d`, `${offsetDays} days`)!.d;

/** The projects whose bookings this person may follow up. */
function projectsFor(user: SessionUser) {
  if (user.role === 'admin') return all<{ id: number; name: string }>('SELECT id, name FROM projects ORDER BY name');
  const scope = leadScope(user);
  return all<{ id: number; name: string }>(
    `SELECT DISTINCT p.id, p.name FROM bookings b JOIN leads l ON l.id = b.lead_id JOIN units u ON u.id = b.unit_id JOIN projects p ON p.id = u.project_id
     WHERE ${scope.sql} AND b.status = 'active'
     UNION SELECT p.id, p.name FROM projects p JOIN user_projects up ON up.project_id = p.id WHERE up.user_id = ?
     ORDER BY 2`,
    ...scope.params, user.id,
  );
}

payments.get('/payments/dashboard', requirePermission('payment.followup'), (req, res) => {
  const projects = projectsFor(req.user);
  const asked = Number(req.query.project) || 0;
  if (asked && !projects.some((p) => p.id === asked)) throw new HttpError(404, 'Project not found.');
  const projectId = asked || projects[0]?.id || 0;
  const today = istDate();
  const inWeek = istDate(7);
  const monthStart = `${today.slice(0, 8)}01`;
  const scope = leadScope(req.user);
  const masked = phoneMasked(req.user);

  const bookings = projectId ? all<any>(
    `SELECT b.id, b.lead_id, b.amount_lakhs, b.created_at, b.handover_status, l.name AS lead_name, l.phone, u.tower, u.number AS unit_number
     FROM bookings b JOIN leads l ON l.id = b.lead_id JOIN units u ON u.id = b.unit_id
     WHERE ${scope.sql} AND b.status = 'active' AND u.project_id = ? ORDER BY l.name`,
    ...scope.params, projectId,
  ) : [];
  const ids = bookings.map((b) => b.id);
  const rows = ids.length ? all<any>(
    `SELECT p.id, p.booking_id, p.label, p.due_date, p.amount_lakhs, p.paid_at, p.receipt_number,
       (SELECT f.outcome FROM payment_followups f WHERE f.payment_id = p.id ORDER BY f.id DESC LIMIT 1) AS last_outcome,
       (SELECT f.promised_on FROM payment_followups f WHERE f.payment_id = p.id ORDER BY f.id DESC LIMIT 1) AS promised_on,
       (SELECT f.created_at FROM payment_followups f WHERE f.payment_id = p.id ORDER BY f.id DESC LIMIT 1) AS last_followup_at
     FROM payments p WHERE p.booking_id IN (${ids.join(',')}) ORDER BY p.due_date, p.id`,
  ) : [];

  const byBooking = new Map<number, any[]>();
  for (const r of rows) {
    const list = byBooking.get(r.booking_id) ?? [];
    list.push({ ...r, state: paymentState(r, today, inWeek) });
    byBooking.set(r.booking_id, list);
  }
  const out = bookings.map((b) => {
    const stages = byBooking.get(b.id) ?? [];
    const current = stages.find((s) => s.state !== 'Received');
    return {
      ...b,
      phone: masked ? maskPhone(b.phone) : b.phone,
      stages,
      current_stage: current?.label ?? null,
      collected_lakhs: stages.filter((s) => s.paid_at).reduce((sum, s) => sum + s.amount_lakhs, 0),
    };
  });

  // For each stage name across bookings: how many received, how many overdue, and what is still to come in.
  const strip = new Map<string, { label: string; received: number; overdue: number; pending_lakhs: number; first_due: string }>();
  for (const s of out.flatMap((b) => b.stages)) {
    const e = strip.get(s.label) ?? { label: s.label, received: 0, overdue: 0, pending_lakhs: 0, first_due: s.due_date };
    if (s.state === 'Received') e.received++;
    else e.pending_lakhs += s.amount_lakhs;
    if (s.state === 'Overdue') e.overdue++;
    if (s.due_date < e.first_due) e.first_due = s.due_date;
    strip.set(s.label, e);
  }
  const all_ = out.flatMap((b) => b.stages);
  const sum = (list: any[]) => Math.round(list.reduce((t, s) => t + s.amount_lakhs, 0) * 100000) / 100000;
  res.json({
    projects,
    project_id: projectId,
    today,
    summary: {
      overdue_lakhs: sum(all_.filter((s) => s.state === 'Overdue')),
      due_week_lakhs: sum(all_.filter((s) => s.state === 'Due in 7 days')),
      collected_month_lakhs: sum(all_.filter((s) => s.paid_at && s.paid_at.slice(0, 10) >= monthStart)),
      without_schedule: out.filter((b) => !b.stages.length).length,
    },
    stages: [...strip.values()].sort((a, b) => a.first_due.localeCompare(b.first_due) || a.label.localeCompare(b.label)),
    bookings: out,
    outcomes: PAYMENT_OUTCOMES,
  });
});

function visiblePayment(user: SessionUser, id: number) {
  const p = get<any>('SELECT * FROM payments WHERE id = ?', id);
  if (!p) throw new HttpError(404, 'Payment not found.');
  const booking = visibleBooking(user, p.booking_id);
  return { payment: p, booking };
}

payments.get('/payments/:id/followups', requirePermission('payment.followup'), (req, res) => {
  const { payment } = visiblePayment(req.user, Number(req.params.id));
  res.json({
    followups: all(
      `SELECT f.*, u.name AS user_name FROM payment_followups f LEFT JOIN users u ON u.id = f.user_id WHERE f.payment_id = ? ORDER BY f.id DESC`,
      payment.id,
    ),
  });
});

payments.post('/payments/:id/followups', requirePermission('payment.followup'), (req, res) => {
  const { payment, booking } = visiblePayment(req.user, Number(req.params.id));
  const b = z.object({
    outcome: z.enum(PAYMENT_OUTCOMES),
    notes: z.string().trim().max(1000).default(''),
    promised_on: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')]).nullish(),
  }).parse(req.body);
  if (payment.paid_at) throw new HttpError(409, 'This payment is already received.');
  const promised = b.promised_on || null;
  if (b.outcome === 'Promised to pay' && !promised) throw new HttpError(400, 'Add the date they promised to pay.');
  if (promised && promised < istDate()) throw new HttpError(400, 'The promised date cannot be in the past.');
  const r = run(
    'INSERT INTO payment_followups(payment_id, user_id, outcome, notes, promised_on, created_at) VALUES(?, ?, ?, ?, ?, ?)',
    payment.id, req.user.id, b.outcome, b.notes, promised, nowIso(),
  );
  logActivity(booking.lead_id, 'payment', `Payment follow-up: ${payment.label}`, [b.outcome, promised ? `promised ${promised}` : '', b.notes].filter(Boolean).join(' · '), req.user.id);
  audit(req, 'payment.followup', 'payment', payment.id, b.outcome);
  broadcast('bookings');
  res.status(201).json({ id: r.id });
});
