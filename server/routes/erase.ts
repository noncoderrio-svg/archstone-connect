// Admin erase: permanent removal of bookings, files, flats, projects, partners, calling lists, site visits and approvals.
// Every route is refused on the server for anyone but an admin. Customers (leads) are never deleted here.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { BOARD_STAGES, type Stage } from '../../shared/domain.ts';
import { HttpError } from '../auth.ts';
import { all, get, nowIso, run, tx } from '../db.ts';
import { audit, broadcast } from '../services/core.ts';
import { removeVisitFromCalendar } from '../services/google.ts';
import { changeStage, logActivity } from '../services/leads.ts';
import { dataDir } from '../services/secrets.ts';

export const erase = Router();

const adminOnly = (req: Request, _res: Response, next: NextFunction) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Only an admin can erase records.');
  next();
};
erase.use('/erase', adminOnly);

const id = (v: unknown) => Number(v);
const money = (v: number) => Math.round(v * 100000) / 100000;
const placeholders = (ids: number[]) => ids.map(() => '?').join(',');
const BOOKING_FIRST = 'A booking record depends on this. Erase the booking first.';

// ---------- Bookings ----------
function bookingImpact(bookingId: number) {
  const b = get<any>(
    `SELECT b.*, l.name AS lead_name, l.stage AS lead_stage, u.tower, u.number AS unit_number, u.status AS unit_status, p.name AS project_name
     FROM bookings b JOIN leads l ON l.id = b.lead_id JOIN units u ON u.id = b.unit_id JOIN projects p ON p.id = u.project_id WHERE b.id = ?`,
    bookingId,
  );
  if (!b) throw new HttpError(404, 'Booking not found.');
  const payments = get<any>(
    `SELECT COUNT(*) AS schedule, SUM(paid_at IS NOT NULL) AS receipts, COALESCE(SUM(CASE WHEN paid_at IS NOT NULL THEN amount_lakhs END), 0) AS receipts_lakhs
     FROM payments WHERE booking_id = ?`,
    b.id,
  )!;
  const followups = get<{ n: number }>('SELECT COUNT(*) n FROM payment_followups f JOIN payments p ON p.id = f.payment_id WHERE p.booking_id = ?', b.id)!.n;
  const commission = get<any>('SELECT c.amount_lakhs, c.status, x.name AS partner_name FROM commissions c JOIN partners x ON x.id = c.partner_id WHERE c.booking_id = ?', b.id) ?? null;
  const active = b.status === 'active';
  const back = previousStage(b.lead_stage);
  return {
    booking: {
      id: b.id, status: b.status, amount_lakhs: b.amount_lakhs, created_at: b.created_at,
      lead_id: b.lead_id, lead_name: b.lead_name, project_name: b.project_name, flat: `${b.tower}-${b.unit_number}`,
    },
    removes: {
      payment_stages: Number(payments.schedule ?? 0),
      receipts: Number(payments.receipts ?? 0),
      receipts_lakhs: money(Number(payments.receipts_lakhs ?? 0)),
      followups,
      commission,
    },
    flat: active ? `Flat ${b.tower}-${b.unit_number} becomes available again.` : 'The booking was already cancelled, so the flat is not touched.',
    customer: active && back ? `${b.lead_name} moves back from ${b.lead_stage} to ${back}. The customer is kept.` : `${b.lead_name} is kept as they are.`,
    _raw: b,
    _back: active ? back : null,
  };
}

/** One stage back along the sales funnel, such as Booked to Working Deal. */
function previousStage(stage: string): Stage | null {
  const i = BOARD_STAGES.indexOf(stage as Stage);
  return i > 0 ? BOARD_STAGES[i - 1] : null;
}

const strip = <T extends { _raw: unknown; _back: unknown }>({ _raw, _back, ...rest }: T) => rest;

erase.get('/erase/bookings/:id', (req, res) => {
  res.json(strip(bookingImpact(id(req.params.id))));
});

const confirmBody = z.object({
  reason: z.string().trim().min(3, 'Give a reason.').max(300),
  confirm: z.string(),
});

erase.post('/erase/bookings/:id', (req, res) => {
  const b = confirmBody.parse(req.body);
  if (b.confirm !== 'ERASE') throw new HttpError(400, 'Type ERASE to confirm.');
  const impact = bookingImpact(id(req.params.id));
  const raw = impact._raw as any;
  tx(() => {
    run('DELETE FROM payment_followups WHERE payment_id IN (SELECT id FROM payments WHERE booking_id = ?)', raw.id);
    run('DELETE FROM payments WHERE booking_id = ?', raw.id);
    run('DELETE FROM commissions WHERE booking_id = ?', raw.id);
    run('DELETE FROM bookings WHERE id = ?', raw.id);
    if (raw.status === 'active') {
      run(`UPDATE units SET status = 'Available', lead_id = NULL, held_by = NULL, hold_until = NULL WHERE id = ? AND lead_id IS ?`, raw.unit_id, raw.lead_id);
      const lead = get<any>('SELECT * FROM leads WHERE id = ?', raw.lead_id)!;
      if (impact._back) changeStage(lead, impact._back as string, req.user.id);
    }
    logActivity(raw.lead_id, 'stage', 'Booking erased by an admin', b.reason, req.user.id);
  });
  const r = impact.removes;
  audit(req, 'erase.booking', 'booking', raw.id,
    `${raw.lead_name}, ${raw.project_name} ${raw.tower}-${raw.unit_number}, ₹${raw.amount_lakhs}L (${raw.status}). Removed ${r.payment_stages} payment stages, ` +
    `${r.receipts} receipts worth ₹${r.receipts_lakhs}L, ${r.followups} follow-up notes${r.commission ? `, commission ₹${r.commission.amount_lakhs}L (${r.commission.status})` : ''}. Reason: ${b.reason}`);
  broadcast('bookings');
  broadcast('inventory');
  broadcast('leads');
  res.json({ ok: true });
});

// ---------- One customer file ----------
erase.delete('/erase/documents/:id', (req, res) => {
  const d = get<any>('SELECT * FROM documents WHERE id = ?', id(req.params.id));
  if (!d) throw new HttpError(404, 'File not found.');
  rmSync(join(dataDir(), 'documents', d.storage_name), { force: true });
  run('DELETE FROM documents WHERE id = ?', d.id);
  logActivity(d.lead_id, 'document', `Document deleted: ${d.type}`, d.filename, req.user.id);
  audit(req, 'erase.document', 'document', d.id, `${d.type} "${d.filename}" (${d.size} bytes) of lead ${d.lead_id}, removed from disk`);
  broadcast('leads');
  res.json({ ok: true });
});

// ---------- Flats ----------
const unitIds = z.object({ ids: z.array(z.number().int()).min(1).max(5000) });

function unitsImpact(ids: number[]) {
  const units = all<any>(`SELECT u.id, u.tower, u.number, u.status, p.name AS project_name FROM units u JOIN projects p ON p.id = u.project_id WHERE u.id IN (${placeholders(ids)})`, ...ids);
  if (units.length !== new Set(ids).size) throw new HttpError(404, 'Some of these flats were not found.');
  const booked = all<any>(
    `SELECT DISTINCT u.tower, u.number FROM bookings b JOIN units u ON u.id = b.unit_id WHERE b.unit_id IN (${placeholders(ids)})`,
    ...ids,
  );
  const approvals = get<{ n: number }>(`SELECT COUNT(*) n FROM approvals WHERE unit_id IN (${placeholders(ids)})`, ...ids)!.n;
  return { count: units.length, held: units.filter((u) => u.status === 'Hold').length, approvals, blocked: booked.map((u) => `${u.tower}-${u.number}`) };
}

erase.post('/erase/units/preview', (req, res) => {
  res.json(unitsImpact(unitIds.parse(req.body).ids));
});

erase.post('/erase/units', (req, res) => {
  const { ids } = unitIds.parse(req.body);
  const impact = unitsImpact(ids);
  if (impact.blocked.length) throw new HttpError(409, `Flat ${impact.blocked.slice(0, 5).join(', ')} has a booking record. Erase the booking first.`);
  tx(() => {
    // Booking and discount requests on these flats have no booking behind them, so they go with the flats.
    run(`DELETE FROM approvals WHERE unit_id IN (${placeholders(ids)})`, ...ids);
    run(`DELETE FROM units WHERE id IN (${placeholders(ids)})`, ...ids);
  });
  audit(req, 'erase.units', 'unit', ids.length === 1 ? ids[0] : '', `${impact.count} flats removed (${impact.held} on hold), ${impact.approvals} approval requests with them. Ids: ${ids.slice(0, 50).join(',')}${ids.length > 50 ? '…' : ''}`);
  broadcast('inventory');
  broadcast('approvals');
  res.json({ deleted: impact.count });
});

// ---------- Projects ----------
function projectImpact(projectId: number) {
  const p = get<any>('SELECT id, name FROM projects WHERE id = ?', projectId);
  if (!p) throw new HttpError(404, 'Project not found.');
  const count = (sql: string) => get<{ n: number }>(sql, p.id)!.n;
  return {
    project: p,
    units: count('SELECT COUNT(*) n FROM units WHERE project_id = ?'),
    visits: count('SELECT COUNT(*) n FROM site_visits WHERE project_id = ?'),
    customers: count('SELECT COUNT(*) n FROM leads WHERE project_id = ?'),
    bookings: count('SELECT COUNT(*) n FROM bookings b JOIN units u ON u.id = b.unit_id WHERE u.project_id = ?'),
  };
}

erase.get('/erase/projects/:id', (req, res) => res.json(projectImpact(id(req.params.id))));

erase.post('/erase/projects/:id', (req, res) => {
  const { confirm_name } = z.object({ confirm_name: z.string() }).parse(req.body);
  const impact = projectImpact(id(req.params.id));
  const p = impact.project;
  if (confirm_name.trim() !== p.name) throw new HttpError(400, 'Type the project name exactly to confirm.');
  if (impact.bookings) throw new HttpError(409, `${impact.bookings} booking record${impact.bookings > 1 ? 's depend' : ' depends'} on this project. Erase the booking${impact.bookings > 1 ? 's' : ''} first.`);
  const events = all<any>(`SELECT created_by, google_event_id FROM site_visits WHERE project_id = ? AND google_event_id != ''`, p.id);
  tx(() => {
    run('DELETE FROM approvals WHERE unit_id IN (SELECT id FROM units WHERE project_id = ?)', p.id);
    run('DELETE FROM site_visits WHERE project_id = ?', p.id);
    run('DELETE FROM units WHERE project_id = ?', p.id);
    // Customers and everything else that pointed at the project stay, without a project.
    for (const table of ['leads', 'call_lists', 'media_assets', 'wa_campaigns', 'ad_spend', 'lead_routes']) {
      run(`UPDATE ${table} SET project_id = NULL WHERE project_id = ?`, p.id);
    }
    run('DELETE FROM user_projects WHERE project_id = ?', p.id);
    run('DELETE FROM projects WHERE id = ?', p.id);
  });
  for (const e of events) if (e.created_by) void removeVisitFromCalendar(e.created_by, e.google_event_id).catch(() => undefined);
  audit(req, 'erase.project', 'project', p.id, `"${p.name}" removed with ${impact.units} flats and ${impact.visits} site visits. ${impact.customers} customers kept without a project.`);
  broadcast('inventory');
  broadcast('leads');
  broadcast('visits');
  res.json({ ok: true });
});

// ---------- Channel partners ----------
function partnerImpact(partnerId: number) {
  const x = get<any>('SELECT id, name FROM partners WHERE id = ?', partnerId);
  if (!x) throw new HttpError(404, 'Partner not found.');
  const count = (sql: string) => get<{ n: number }>(sql, x.id)!.n;
  return {
    partner: x,
    contacts: count('SELECT COUNT(*) n FROM partner_contacts WHERE partner_id = ?'),
    customers: count('SELECT COUNT(*) n FROM leads WHERE partner_id = ?'),
    commissions: count('SELECT COUNT(*) n FROM commissions WHERE partner_id = ?'),
  };
}

erase.get('/erase/partners/:id', (req, res) => res.json(partnerImpact(id(req.params.id))));

erase.post('/erase/partners/:id', (req, res) => {
  const impact = partnerImpact(id(req.params.id));
  if (impact.commissions) throw new HttpError(409, `${impact.commissions} booking${impact.commissions > 1 ? 's carry' : ' carries'} a commission for this partner. Erase the booking${impact.commissions > 1 ? 's' : ''} first.`);
  tx(() => {
    run('DELETE FROM partner_contacts WHERE partner_id = ?', impact.partner.id);
    run('UPDATE leads SET partner_id = NULL WHERE partner_id = ?', impact.partner.id);
    run('DELETE FROM partners WHERE id = ?', impact.partner.id);
  });
  audit(req, 'erase.partner', 'partner', impact.partner.id, `"${impact.partner.name}" removed with ${impact.contacts} contact log entries. ${impact.customers} customers kept without the partner credit.`);
  broadcast('partners');
  broadcast('leads');
  res.json({ ok: true });
});

// ---------- Calling lists ----------
const UNCALLED = `NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.type = 'call') AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = l.id)`;

function listImpact(listId: number) {
  const list = get<any>('SELECT id, name FROM call_lists WHERE id = ?', listId);
  if (!list) throw new HttpError(404, 'List not found.');
  const c = get<any>(`SELECT COUNT(*) AS total, COALESCE(SUM(${UNCALLED}), 0) AS uncalled FROM leads l WHERE l.call_list_id = ? AND l.deleted_at IS NULL`, list.id)!;
  return { list, numbers: Number(c.total), uncalled: Number(c.uncalled) };
}

erase.get('/erase/call-lists/:id', (req, res) => res.json(listImpact(id(req.params.id))));

/** "keep": every number stays as a lead. "move_uncalled": numbers nobody called go to Deleted leads, where they can be restored. */
erase.post('/erase/call-lists/:id', (req, res) => {
  const { mode } = z.object({ mode: z.enum(['keep', 'move_uncalled']) }).parse(req.body);
  const impact = listImpact(id(req.params.id));
  const moved = tx(() => {
    const n = mode === 'move_uncalled'
      ? run(`UPDATE leads SET deleted_at = ? WHERE call_list_id = ? AND deleted_at IS NULL AND id IN (SELECT l.id FROM leads l WHERE l.call_list_id = ? AND ${UNCALLED})`, nowIso(), impact.list.id, impact.list.id).changes
      : 0;
    run('UPDATE leads SET call_list_id = NULL WHERE call_list_id = ?', impact.list.id);
    run('DELETE FROM call_lists WHERE id = ?', impact.list.id);
    return n;
  });
  audit(req, 'erase.call_list', 'call_list', impact.list.id,
    `"${impact.list.name}" removed. ${impact.numbers} numbers; ${mode === 'keep' ? 'all kept as leads' : `${moved} uncalled moved to Deleted leads, the rest kept`}.`);
  broadcast('leads');
  res.json({ ok: true, moved_to_deleted: moved });
});

// ---------- Site visits ----------
erase.delete('/erase/visits/:id', (req, res) => {
  const v = get<any>('SELECT v.*, l.name AS lead_name FROM site_visits v JOIN leads l ON l.id = v.lead_id WHERE v.id = ?', id(req.params.id));
  if (!v) throw new HttpError(404, 'Site visit not found.');
  run('DELETE FROM site_visits WHERE id = ?', v.id);
  if (v.google_event_id && v.created_by) void removeVisitFromCalendar(v.created_by, v.google_event_id).catch(() => undefined);
  logActivity(v.lead_id, 'visit', 'Site visit deleted by an admin', v.scheduled_at, req.user.id);
  audit(req, 'erase.visit', 'site_visit', v.id, `${v.lead_name}, ${v.scheduled_at}, ${v.status}`);
  broadcast('visits');
  res.json({ ok: true });
});

// ---------- Approval requests ----------
erase.delete('/erase/approvals/:id', (req, res) => {
  const a = get<any>('SELECT a.*, l.name AS lead_name FROM approvals a JOIN leads l ON l.id = a.lead_id WHERE a.id = ?', id(req.params.id));
  if (!a) throw new HttpError(404, 'Approval not found.');
  if (get('SELECT 1 AS x FROM bookings WHERE approval_id = ?', a.id)) throw new HttpError(409, BOOKING_FIRST);
  run('DELETE FROM approvals WHERE id = ?', a.id);
  audit(req, 'erase.approval', 'approval', a.id, `${a.type} for ${a.lead_name}, ${a.status}, ₹${a.amount_lakhs ?? 0}L`);
  broadcast('approvals');
  res.json({ ok: true });
});
