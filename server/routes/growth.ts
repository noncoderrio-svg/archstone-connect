import { Router } from 'express';
import { z } from 'zod';
import { REDEVELOPMENT_SCHEMES, REDEVELOPMENT_STAGES } from '../../shared/domain.ts';
import { HttpError, requirePermission } from '../auth.ts';
import { all, get, nowIso, run, tx } from '../db.ts';
import { audit, normalizePhone, visibleLead } from '../services/core.ts';
import { ingestLead, logActivity } from '../services/leads.ts';

export const growth = Router();

// ---------- Channel partners ----------
const partnerBody = z.object({
  name: z.string().trim().min(2).max(100),
  firm: z.string().trim().max(120).default(''),
  phone: z.string().max(20).default(''),
  email: z.union([z.email(), z.literal('')]).default(''),
  rera_agent_number: z.string().trim().max(40).default(''),
  commission_percent: z.number().min(0).max(20),
  status: z.enum(['active', 'paused']).default('active'),
});

growth.get('/partners', requirePermission('partner.manage'), (_req, res) => {
  res.json({
    partners: all(
      `SELECT x.*,
        (SELECT COUNT(*) FROM leads l WHERE l.partner_id = x.id AND l.deleted_at IS NULL) AS leads,
        (SELECT COUNT(*) FROM commissions c WHERE c.partner_id = x.id AND c.status != 'cancelled') AS bookings,
        COALESCE((SELECT SUM(c.amount_lakhs) FROM commissions c WHERE c.partner_id = x.id AND c.status IN ('pending','approved')), 0) AS due_lakhs,
        COALESCE((SELECT SUM(c.amount_lakhs) FROM commissions c WHERE c.partner_id = x.id AND c.status = 'paid'), 0) AS paid_lakhs
       FROM partners x ORDER BY x.status, x.name`,
    ),
    commissions: all(
      `SELECT c.*, x.name AS partner_name, l.name AS lead_name, b.amount_lakhs AS booking_lakhs FROM commissions c
       JOIN partners x ON x.id = c.partner_id JOIN bookings b ON b.id = c.booking_id JOIN leads l ON l.id = b.lead_id
       WHERE c.status != 'cancelled' ORDER BY c.id DESC LIMIT 100`,
    ),
  });
});

growth.post('/partners', requirePermission('partner.manage'), (req, res) => {
  const b = partnerBody.parse(req.body);
  const phone = b.phone ? normalizePhone(b.phone) : '';
  const r = run(
    'INSERT INTO partners(name, firm, phone, email, rera_agent_number, commission_percent, status) VALUES(?, ?, ?, ?, ?, ?, ?)',
    b.name, b.firm, phone, b.email, b.rera_agent_number, b.commission_percent, b.status,
  );
  audit(req, 'partner.create', 'partner', r.id, b.name);
  res.status(201).json({ id: r.id });
});

growth.put('/partners/:id', requirePermission('partner.manage'), (req, res) => {
  const b = partnerBody.parse(req.body);
  const phone = b.phone ? normalizePhone(b.phone) : '';
  run(
    'UPDATE partners SET name = ?, firm = ?, phone = ?, email = ?, rera_agent_number = ?, commission_percent = ?, status = ? WHERE id = ?',
    b.name, b.firm, phone, b.email, b.rera_agent_number, b.commission_percent, b.status, Number(req.params.id),
  );
  audit(req, 'partner.update', 'partner', String(req.params.id), `${b.commission_percent}%`);
  res.json({ ok: true });
});

/** Registers a buyer for a partner. An existing lead keeps its original attribution. */
growth.post('/partners/:id/leads', requirePermission('partner.manage'), (req, res) => {
  const partner = get<any>(`SELECT * FROM partners WHERE id = ? AND status = 'active'`, Number(req.params.id));
  if (!partner) throw new HttpError(404, 'Active partner not found.');
  const b = z.object({ name: z.string().trim().min(2).max(100), phone: z.string().min(8).max(20), notes: z.string().max(500).optional() }).parse(req.body);
  const result = ingestLead({ ...b, source: 'Channel Partner', partner_id: partner.id }, req.user.id);
  let attributed = true;
  if (result.duplicate) {
    const lead = get<any>('SELECT partner_id FROM leads WHERE id = ?', result.id)!;
    attributed = lead.partner_id === partner.id;
  }
  audit(req, 'partner.lead', 'lead', result.id, `partner ${partner.id}, attributed ${attributed}`);
  res.status(result.created ? 201 : 200).json({ ...result, attributed });
});

growth.post('/leads/:id/partner', requirePermission('partner.manage'), (req, res) => {
  const lead = visibleLead(req.user, Number(req.params.id));
  const { partner_id } = z.object({ partner_id: z.number().int().nullable() }).parse(req.body);
  if (lead.partner_id && req.user.role !== 'admin') throw new HttpError(403, 'Only an admin can change an existing partner attribution.');
  run('UPDATE leads SET partner_id = ? WHERE id = ?', partner_id, lead.id);
  logActivity(lead.id, 'partner', 'Channel partner updated', '', req.user.id);
  audit(req, 'lead.partner', 'lead', lead.id, String(partner_id));
  res.json({ ok: true });
});

growth.post('/commissions/:id/status', requirePermission('booking.manage'), (req, res) => {
  const { status } = z.object({ status: z.enum(['approved', 'paid']) }).parse(req.body);
  const c = get<any>('SELECT * FROM commissions WHERE id = ?', Number(req.params.id));
  if (!c) throw new HttpError(404, 'Commission not found.');
  if (c.status === 'cancelled' || c.status === 'paid') throw new HttpError(409, `This commission is already ${c.status}.`);
  if (status === 'paid' && (c.status !== 'approved' || req.user.role !== 'admin')) throw new HttpError(403, 'An admin pays commissions after approval.');
  run('UPDATE commissions SET status = ? WHERE id = ?', status, c.id);
  audit(req, `commission.${status}`, 'commission', c.id, `${c.amount_lakhs}L`);
  res.json({ ok: true });
});

// ---------- Redevelopment pipeline ----------
const dealBody = z.object({
  name: z.string().trim().min(2).max(120),
  scheme: z.enum(REDEVELOPMENT_SCHEMES),
  location: z.string().trim().max(160).default(''),
  area_sqft: z.number().positive().nullish(),
  tenements: z.number().int().positive().nullish(),
  contact_name: z.string().trim().max(100).default(''),
  contact_phone: z.string().max(20).default(''),
  owner_id: z.number().int().nullish(),
  notes: z.string().max(2000).default(''),
});

growth.get('/redevelopment', requirePermission('redevelopment.manage'), (_req, res) => {
  res.json({
    deals: all(
      `SELECT d.*, u.name AS owner_name FROM redevelopment d LEFT JOIN users u ON u.id = d.owner_id ORDER BY d.updated_at DESC`,
    ),
  });
});

growth.post('/redevelopment', requirePermission('redevelopment.manage'), (req, res) => {
  const b = dealBody.parse(req.body);
  const phone = b.contact_phone ? normalizePhone(b.contact_phone) : '';
  const r = run(
    `INSERT INTO redevelopment(name, scheme, location, area_sqft, tenements, contact_name, contact_phone, owner_id, notes) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    b.name, b.scheme, b.location, b.area_sqft ?? null, b.tenements ?? null, b.contact_name, phone, b.owner_id ?? req.user.id, b.notes,
  );
  audit(req, 'redevelopment.create', 'redevelopment', r.id, b.name);
  res.status(201).json({ id: r.id });
});

growth.get('/redevelopment/:id', requirePermission('redevelopment.manage'), (req, res) => {
  const deal = get('SELECT * FROM redevelopment WHERE id = ?', Number(req.params.id));
  if (!deal) throw new HttpError(404, 'Opportunity not found.');
  res.json({
    deal,
    log: all(
      `SELECT r.*, u.name AS actor FROM redevelopment_log r LEFT JOIN users u ON u.id = r.actor_id WHERE r.deal_id = ? ORDER BY r.id DESC`,
      Number(req.params.id),
    ),
  });
});

growth.put('/redevelopment/:id', requirePermission('redevelopment.manage'), (req, res) => {
  const b = dealBody.parse(req.body);
  const phone = b.contact_phone ? normalizePhone(b.contact_phone) : '';
  run(
    `UPDATE redevelopment SET name = ?, scheme = ?, location = ?, area_sqft = ?, tenements = ?, contact_name = ?, contact_phone = ?, owner_id = ?, notes = ?, updated_at = ? WHERE id = ?`,
    b.name, b.scheme, b.location, b.area_sqft ?? null, b.tenements ?? null, b.contact_name, phone, b.owner_id ?? null, b.notes, nowIso(), Number(req.params.id),
  );
  res.json({ ok: true });
});

growth.post('/redevelopment/:id/stage', requirePermission('redevelopment.manage'), (req, res) => {
  const { stage } = z.object({ stage: z.enum(REDEVELOPMENT_STAGES) }).parse(req.body);
  const id = Number(req.params.id);
  const deal = get<any>('SELECT stage FROM redevelopment WHERE id = ?', id);
  if (!deal) throw new HttpError(404, 'Opportunity not found.');
  tx(() => {
    run('UPDATE redevelopment SET stage = ?, updated_at = ? WHERE id = ?', stage, nowIso(), id);
    run('INSERT INTO redevelopment_log(deal_id, body, actor_id) VALUES(?, ?, ?)', id, `Stage: ${deal.stage} → ${stage}`, req.user.id);
  });
  res.json({ ok: true });
});

growth.post('/redevelopment/:id/log', requirePermission('redevelopment.manage'), (req, res) => {
  const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
  run('INSERT INTO redevelopment_log(deal_id, body, actor_id) VALUES(?, ?, ?)', Number(req.params.id), body, req.user.id);
  run('UPDATE redevelopment SET updated_at = ? WHERE id = ?', nowIso(), Number(req.params.id));
  res.status(201).json({ ok: true });
});
