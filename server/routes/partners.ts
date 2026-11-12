// Sourcing Manager desk: channel partners, who to contact today, the contact log, and what partners brought in.
import { Router } from 'express';
import { z } from 'zod';
import { LEAD_ROLES } from '../../shared/domain.ts';
import { HttpError, requirePermission, type SessionUser } from '../auth.ts';
import { all, get, nowIso, run, tx } from '../db.ts';
import { audit, broadcast, leadScope, normalizePhone } from '../services/core.ts';
import { ingestLead } from '../services/leads.ts';

export const partners = Router();

export const CONTACT_KINDS = ['Call', 'WhatsApp', 'Meeting', 'Site visit'] as const;

/** Admins and Site Heads see every partner. Everyone else sees their own partners and those nobody owns yet. */
const seesAllPartners = (user: SessionUser) => user.role === 'admin' || user.role === 'site_head';

function partnerFilter(user: SessionUser) {
  return seesAllPartners(user) ? { sql: '1 = 1', params: [] as number[] } : { sql: '(x.manager_id = ? OR x.manager_id IS NULL)', params: [user.id] };
}

function visiblePartner(user: SessionUser, id: number) {
  const f = partnerFilter(user);
  const p = get<any>(`SELECT x.* FROM partners x WHERE x.id = ? AND ${f.sql}`, id, ...f.params);
  if (!p) throw new HttpError(404, 'Partner not found.');
  return p;
}

/** Today's date in India, which is when follow-up dates fall due. */
const todayIst = () => get<{ d: string }>(`SELECT date('now', '+330 minutes') AS d`)!.d;
const daysAgo = (n: number) => get<{ d: string }>(`SELECT datetime('now', ?) AS d`, `-${n} days`)!.d;
const monthStart = () => `${nowIso().slice(0, 8)}01 00:00:00`;

/** A partner is due when their follow-up date has arrived, or when nobody has ever contacted them. */
const DUE_SQL = `x.status = 'active' AND (x.last_contact_at IS NULL OR (x.next_contact_on IS NOT NULL AND x.next_contact_on <= ?))`;

partners.get('/partners', requirePermission('partner.manage'), (req, res) => {
  const f = partnerFilter(req.user);
  const scope = leadScope(req.user);
  const today = todayIst();
  const week = daysAgo(7);
  const month = monthStart();
  const rows = all<any>(
    `SELECT x.*, m.name AS manager_name, (${DUE_SQL}) AS due,
       (SELECT COUNT(*) FROM leads l WHERE l.partner_id = x.id AND ${scope.sql}) AS leads,
       (SELECT COUNT(*) FROM leads l WHERE l.partner_id = x.id AND l.created_at >= ? AND ${scope.sql}) AS leads_7d,
       (SELECT COUNT(*) FROM bookings b JOIN leads l ON l.id = b.lead_id WHERE l.partner_id = x.id AND b.status = 'active' AND ${scope.sql}) AS bookings,
       COALESCE((SELECT SUM(b.amount_lakhs) FROM bookings b JOIN leads l ON l.id = b.lead_id WHERE l.partner_id = x.id AND b.status = 'active' AND ${scope.sql}), 0) AS booking_lakhs,
       COALESCE((SELECT SUM(c.amount_lakhs) FROM commissions c WHERE c.partner_id = x.id AND c.status IN ('pending','approved')), 0) AS due_lakhs,
       COALESCE((SELECT SUM(c.amount_lakhs) FROM commissions c WHERE c.partner_id = x.id AND c.status = 'paid'), 0) AS paid_lakhs
     FROM partners x LEFT JOIN users m ON m.id = x.manager_id
     WHERE ${f.sql} ORDER BY x.status, x.name`,
    today, ...scope.params, week, ...scope.params, ...scope.params, ...scope.params, ...f.params,
  ).map((p) => ({ ...p, due: Boolean(p.due) }));
  const ids = rows.map((p) => p.id);
  const inPartners = ids.length ? `l.partner_id IN (${ids.join(',')})` : '1 = 0';

  const recentLeads = all(
    `SELECT l.id, l.name, l.stage, l.created_at, x.name AS partner_name, p.name AS project_name
     FROM leads l JOIN partners x ON x.id = l.partner_id LEFT JOIN projects p ON p.id = l.project_id
     WHERE ${inPartners} AND ${scope.sql} AND l.created_at >= ? ORDER BY l.created_at DESC LIMIT 50`,
    ...scope.params, week,
  );
  const recentVisits = all(
    `SELECT v.id, v.lead_id, v.scheduled_at, v.status, l.name AS lead_name, x.name AS partner_name, p.name AS project_name
     FROM site_visits v JOIN leads l ON l.id = v.lead_id JOIN partners x ON x.id = l.partner_id JOIN projects p ON p.id = v.project_id
     WHERE ${inPartners} AND ${scope.sql} AND v.scheduled_at >= ? AND v.scheduled_at <= ? ORDER BY v.scheduled_at DESC LIMIT 50`,
    ...scope.params, week, nowIso(),
  );
  const monthBookings = all(
    `SELECT b.id, b.amount_lakhs, b.created_at, l.id AS lead_id, l.name AS lead_name, x.name AS partner_name, p.name AS project_name, u.tower, u.number AS unit_number
     FROM bookings b JOIN leads l ON l.id = b.lead_id JOIN partners x ON x.id = l.partner_id JOIN units u ON u.id = b.unit_id JOIN projects p ON p.id = u.project_id
     WHERE ${inPartners} AND ${scope.sql} AND b.status = 'active' AND b.created_at >= ? ORDER BY b.created_at DESC`,
    ...scope.params, month,
  );
  // Ranked by number of bookings, then booking value.
  const top = rows.filter((p) => p.bookings > 0)
    .sort((a, b) => b.bookings - a.bookings || b.booking_lakhs - a.booking_lakhs)
    .slice(0, 5)
    .map((p) => ({ id: p.id, name: p.name, firm: p.firm, bookings: p.bookings, booking_lakhs: p.booking_lakhs }));

  res.json({
    today,
    partners: rows,
    due_today: rows.filter((p) => p.due).map((p) => p.id),
    recent_leads: recentLeads,
    recent_visits: recentVisits,
    month_bookings: monthBookings,
    top_partners: top,
    commissions: all(
      `SELECT c.*, x.name AS partner_name, l.name AS lead_name, b.amount_lakhs AS booking_lakhs FROM commissions c
       JOIN partners x ON x.id = c.partner_id JOIN bookings b ON b.id = c.booking_id JOIN leads l ON l.id = b.lead_id
       WHERE c.status != 'cancelled' AND ${f.sql} ORDER BY c.id DESC LIMIT 100`,
      ...f.params,
    ),
    can_move: seesAllPartners(req.user),
    managers: seesAllPartners(req.user)
      ? all(`SELECT id, name FROM users WHERE role = 'sourcing_manager' AND status = 'active' ORDER BY name`)
      : [],
    kinds: CONTACT_KINDS,
  });
});

const partnerBody = z.object({
  name: z.string().trim().min(2).max(100),
  firm: z.string().trim().max(120).default(''),
  area: z.string().trim().max(120).default(''),
  phone: z.string().max(20).default(''),
  email: z.union([z.email(), z.literal('')]).default(''),
  rera_agent_number: z.string().trim().max(40).default(''),
  commission_percent: z.number().min(0).max(20),
  status: z.enum(['active', 'paused']).default('active'),
  manager_id: z.number().int().nullish(),
});

function assertSourcingManager(id: number) {
  const m = get<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = ?', id);
  if (!m || m.role !== 'sourcing_manager' || m.status !== 'active') throw new HttpError(400, 'Choose an active Sourcing Manager.');
}

partners.post('/partners', requirePermission('partner.manage'), (req, res) => {
  const b = partnerBody.parse(req.body);
  const phone = b.phone ? normalizePhone(b.phone) : '';
  // A Sourcing Manager's new partner is theirs. Admins and Site Heads may choose, or leave it unassigned.
  let managerId: number | null = req.user.role === 'sourcing_manager' ? req.user.id : null;
  if (seesAllPartners(req.user) && b.manager_id !== undefined) {
    if (b.manager_id) assertSourcingManager(b.manager_id);
    managerId = b.manager_id ?? null;
  }
  const r = run(
    'INSERT INTO partners(name, firm, area, phone, email, rera_agent_number, commission_percent, status, manager_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    b.name, b.firm, b.area, phone, b.email, b.rera_agent_number, b.commission_percent, b.status, managerId,
  );
  audit(req, 'partner.create', 'partner', r.id, b.name);
  broadcast('partners');
  res.status(201).json({ id: r.id });
});

partners.put('/partners/:id', requirePermission('partner.manage'), (req, res) => {
  const p = visiblePartner(req.user, Number(req.params.id));
  const b = partnerBody.parse(req.body);
  const phone = b.phone ? normalizePhone(b.phone) : '';
  run(
    'UPDATE partners SET name = ?, firm = ?, area = ?, phone = ?, email = ?, rera_agent_number = ?, commission_percent = ?, status = ? WHERE id = ?',
    b.name, b.firm, b.area, phone, b.email, b.rera_agent_number, b.commission_percent, b.status, p.id,
  );
  audit(req, 'partner.update', 'partner', p.id, `${b.commission_percent}%`);
  broadcast('partners');
  res.json({ ok: true });
});

/** Only an Admin or Site Head moves a partner to another Sourcing Manager. */
partners.put('/partners/:id/manager', requirePermission('partner.manage'), (req, res) => {
  if (!seesAllPartners(req.user)) throw new HttpError(403, 'Only an admin or site head can move a partner.');
  const p = visiblePartner(req.user, Number(req.params.id));
  const { manager_id } = z.object({ manager_id: z.number().int().nullable() }).parse(req.body);
  if (manager_id) assertSourcingManager(manager_id);
  run('UPDATE partners SET manager_id = ? WHERE id = ?', manager_id, p.id);
  audit(req, 'partner.move', 'partner', p.id, `${p.manager_id ?? 'none'} → ${manager_id ?? 'none'}`);
  broadcast('partners');
  res.json({ ok: true });
});

// ---------- Contact log ----------
partners.get('/partners/:id/contacts', requirePermission('partner.manage'), (req, res) => {
  const p = visiblePartner(req.user, Number(req.params.id));
  res.json({
    contacts: all(
      `SELECT c.*, u.name AS user_name FROM partner_contacts c LEFT JOIN users u ON u.id = c.user_id WHERE c.partner_id = ? ORDER BY c.id DESC LIMIT 200`,
      p.id,
    ),
  });
});

partners.post('/partners/:id/contacts', requirePermission('partner.manage'), (req, res) => {
  const p = visiblePartner(req.user, Number(req.params.id));
  const b = z.object({
    kind: z.enum(CONTACT_KINDS),
    notes: z.string().trim().max(1000).default(''),
    next_contact_on: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date for "contact again on".'), z.literal('')]).nullish(),
  }).parse(req.body);
  const next = b.next_contact_on || null;
  if (next && next < todayIst()) throw new HttpError(400, 'Choose today or a later date to contact again.');
  const id = tx(() => {
    const r = run('INSERT INTO partner_contacts(partner_id, user_id, kind, notes, next_contact_on) VALUES(?, ?, ?, ?, ?)', p.id, req.user.id, b.kind, b.notes, next);
    run('UPDATE partners SET last_contact_at = ?, next_contact_on = ? WHERE id = ?', nowIso(), next, p.id);
    return r.id;
  });
  broadcast('partners');
  res.status(201).json({ id });
});

// ---------- Partner leads ----------
/** Registers a buyer for a partner. An existing lead keeps its original attribution. */
partners.post('/partners/:id/leads', requirePermission('partner.manage'), (req, res) => {
  const partner = visiblePartner(req.user, Number(req.params.id));
  if (partner.status !== 'active') throw new HttpError(404, 'Active partner not found.');
  const b = z.object({
    name: z.string().trim().min(2).max(100),
    phone: z.string().min(8).max(20),
    notes: z.string().max(500).optional(),
    project_id: z.number().int().nullish(),
    owner_id: z.number().int().nullish(),
  }).parse(req.body);
  if (b.project_id && !get('SELECT 1 AS x FROM projects WHERE id = ?', b.project_id)) throw new HttpError(400, 'That project was not found.');
  let owner: { id: number; role: string } | undefined;
  if (b.owner_id) {
    owner = get<any>('SELECT id, role FROM users WHERE id = ? AND status = ?', b.owner_id, 'active');
    if (!owner || !(LEAD_ROLES as readonly string[]).includes(owner.role)) throw new HttpError(400, 'Choose an active person who works leads.');
    if (owner.id !== req.user.id && !req.user.permissions.includes('lead.reassign')) throw new HttpError(403, 'You can assign this lead only to yourself.');
  }
  // Leaving the person empty uses automatic routing, as for any other new lead.
  const result = ingestLead({
    name: b.name, phone: b.phone, notes: b.notes, source: 'Channel Partner', partner_id: partner.id,
    project_id: b.project_id ?? null, owner_id: owner?.id,
  }, req.user.id);
  if (result.created && owner?.role === 'telecaller') run('UPDATE leads SET presales_id = ? WHERE id = ?', owner.id, result.id);
  let attributed = true;
  if (result.duplicate) {
    const lead = get<any>('SELECT partner_id FROM leads WHERE id = ?', result.id)!;
    attributed = lead.partner_id === partner.id;
  }
  audit(req, 'partner.lead', 'lead', result.id, `partner ${partner.id}, attributed ${attributed}`);
  res.status(result.created ? 201 : 200).json({ ...result, attributed });
});
