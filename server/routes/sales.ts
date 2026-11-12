import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Role } from '../../shared/domain.ts';
import { HttpError, assertCan, permissionsFor, requirePermission, type SessionUser } from '../auth.ts';
import { all, get, getSetting, minutesFromNow, nowIso, run, tx } from '../db.ts';
import { audit, broadcast, leadScope, notify, notifyUrgent, visibleLead, workableLead } from '../services/core.ts';
import { addVisitToCalendar, isConnected, removeVisitFromCalendar } from '../services/google.ts';
import { managerChain } from '../services/hierarchy.ts';
import { changeStage, logActivity, rescore } from '../services/leads.ts';
import { formatIst, sendAutomation } from '../services/whatsapp.ts';

export const sales = Router();

const managesProject = (user: SessionUser, projectId: number) =>
  user.role === 'admin' || (user.role === 'site_head' && user.project_ids.includes(projectId));

// ---------- Projects ----------
const projectBody = z.object({
  name: z.string().trim().min(2).max(100),
  location: z.string().max(120).default(''),
  configuration: z.string().max(120).default(''),
  type: z.string().max(60).default('Residential'),
  price_from_lakhs: z.number().positive().nullish(),
  rera_number: z.string().trim().max(40).default(''),
  brochure_url: z.union([z.url(), z.literal('')]).default(''),
  status: z.enum(['ongoing', 'upcoming', 'completed']).default('ongoing'),
  verify_note: z.string().max(240).default(''),
  gst_percent: z.number().min(0).max(100).nullish(),
  stamp_duty_percent: z.number().min(0).max(100).nullish(),
  registration_lakhs: z.number().min(0).nullish(),
  other_charges_lakhs: z.number().min(0).nullish(),
  call_script: z.string().max(4000).default(''),
  objections: z.string().max(4000).default(''),
});

const saveRates = (projectId: number, b: z.infer<typeof projectBody>) =>
  run(
    'UPDATE projects SET gst_percent = ?, stamp_duty_percent = ?, registration_lakhs = ?, other_charges_lakhs = ?, call_script = ?, objections = ? WHERE id = ?',
    b.gst_percent ?? null, b.stamp_duty_percent ?? null, b.registration_lakhs ?? null, b.other_charges_lakhs ?? null, b.call_script, b.objections, projectId,
  );

sales.get('/projects', (_req, res) => {
  res.json({
    projects: all(
      `SELECT p.*,
        (SELECT COUNT(*) FROM units u WHERE u.project_id = p.id) AS total_units,
        (SELECT COUNT(*) FROM units u WHERE u.project_id = p.id AND u.status = 'Available') AS available_units,
        (SELECT COUNT(*) FROM units u WHERE u.project_id = p.id AND u.status = 'Hold') AS held_units,
        (SELECT COUNT(*) FROM units u WHERE u.project_id = p.id AND u.status IN ('Booked','Sold')) AS sold_units
       FROM projects p ORDER BY p.status, p.name`,
    ),
  });
});

sales.post('/projects', requirePermission('settings.manage'), (req, res) => {
  const b = projectBody.parse(req.body);
  const r = run(
    `INSERT INTO projects(name, location, configuration, type, price_from_lakhs, rera_number, brochure_url, status, verify_note)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    b.name, b.location, b.configuration, b.type, b.price_from_lakhs ?? null, b.rera_number, b.brochure_url, b.status, b.verify_note,
  );
  saveRates(r.id, b);
  audit(req, 'project.create', 'project', r.id, b.name);
  res.status(201).json({ id: r.id });
});

sales.put('/projects/:id', (req, res) => {
  const projectId = Number(req.params.id);
  if (!managesProject(req.user, projectId)) throw new HttpError(403, 'You cannot edit this project.');
  const b = projectBody.parse(req.body);
  run(
    `UPDATE projects SET name = ?, location = ?, configuration = ?, type = ?, price_from_lakhs = ?, rera_number = ?, brochure_url = ?, status = ?, verify_note = ? WHERE id = ?`,
    b.name, b.location, b.configuration, b.type, b.price_from_lakhs ?? null, b.rera_number, b.brochure_url, b.status, b.verify_note, projectId,
  );
  saveRates(projectId, b);
  audit(req, 'project.update', 'project', projectId, b.name);
  res.json({ ok: true });
});

// ---------- Inventory ----------
sales.get('/projects/:id/units', (req, res) => {
  res.json({
    units: all(
      `SELECT u.id, u.tower, u.floor, u.number, u.configuration, u.carpet_sqft, u.price_lakhs, u.status, u.hold_until,
        u.held_by, u.lead_id, h.name AS held_by_name, l.name AS lead_name,
        EXISTS (SELECT 1 FROM bookings b WHERE b.unit_id = u.id AND b.status = 'active') AS has_booking,
        (SELECT b.id FROM bookings b WHERE b.unit_id = u.id ORDER BY b.id DESC LIMIT 1) AS booking_id,
        EXISTS (SELECT 1 FROM approvals a WHERE a.unit_id = u.id AND a.type = 'booking' AND a.status = 'pending') AS pending_booking
       FROM units u LEFT JOIN users h ON h.id = u.held_by LEFT JOIN leads l ON l.id = u.lead_id
       WHERE u.project_id = ? ORDER BY u.tower, u.floor DESC, u.number`,
      Number(req.params.id),
    ),
  });
});

sales.post('/projects/:id/units', requirePermission('inventory.manage'), (req, res) => {
  const projectId = Number(req.params.id);
  if (!managesProject(req.user, projectId)) throw new HttpError(403, 'You cannot edit this project.');
  const b = z.object({
    tower: z.string().trim().min(1).max(10),
    floors: z.number().int().min(1).max(100),
    per_floor: z.number().int().min(1).max(30),
    configuration: z.string().max(40),
    carpet_sqft: z.number().positive().nullish(),
    price_lakhs: z.number().positive().nullish(),
  }).parse(req.body);
  let created = 0;
  tx(() => {
    for (let floor = 1; floor <= b.floors; floor++) {
      for (let n = 1; n <= b.per_floor; n++) {
        const number = `${floor}${String(n).padStart(2, '0')}`;
        created += run(
          `INSERT OR IGNORE INTO units(project_id, tower, floor, number, configuration, carpet_sqft, price_lakhs) VALUES(?, ?, ?, ?, ?, ?, ?)`,
          projectId, b.tower, floor, number, b.configuration, b.carpet_sqft ?? null, b.price_lakhs ?? null,
        ).changes;
      }
    }
  });
  audit(req, 'inventory.add', 'project', projectId, `${created} units`);
  broadcast('inventory');
  res.status(201).json({ created });
});

sales.post('/units/:id/hold', (req, res) => {
  assertCan(req.user, 'unit.hold');
  const unitId = Number(req.params.id);
  const { lead_id } = z.object({ lead_id: z.number().int() }).parse(req.body);
  const lead = workableLead(req.user, lead_id);
  const hours = getSetting('hold_hours', 24);
  const { changes } = run(
    `UPDATE units SET status = 'Hold', held_by = ?, hold_until = ?, lead_id = ? WHERE id = ? AND status = 'Available'`,
    req.user.id, minutesFromNow(hours * 60), lead.id, unitId,
  );
  if (!changes) throw new HttpError(409, 'This unit is no longer available.');
  logActivity(lead.id, 'inventory', `Unit held for ${hours} hours`, '', req.user.id);
  broadcast('inventory');
  res.json({ ok: true });
});

sales.post('/units/:id/release', (req, res) => {
  const unit = get<any>('SELECT * FROM units WHERE id = ?', Number(req.params.id));
  if (!unit) throw new HttpError(404, 'Unit not found.');
  if (unit.held_by !== req.user.id && !req.user.permissions.includes('inventory.manage')) throw new HttpError(403, 'Only the person who held it can release it.');
  if (unit.status !== 'Hold') throw new HttpError(409, 'This unit is not on hold.');
  run(`UPDATE units SET status = 'Available', held_by = NULL, hold_until = NULL, lead_id = NULL WHERE id = ?`, unit.id);
  broadcast('inventory');
  res.json({ ok: true });
});

// ---------- Approvals and bookings ----------
const reviewersFor = (projectId: number | null) =>
  all<any>(
    `SELECT DISTINCT u.id FROM users u LEFT JOIN user_projects up ON up.user_id = u.id
     WHERE u.status = 'active' AND (u.role IN ('admin','sourcing_manager') OR (u.role = 'site_head' AND up.project_id = ?))`,
    projectId,
  );

sales.post('/approvals', (req, res) => {
  const b = z.object({
    type: z.enum(['booking', 'discount']),
    lead_id: z.number().int(),
    unit_id: z.number().int(),
    amount_lakhs: z.number().positive(),
    discount_percent: z.number().min(0).max(50).default(0),
    note: z.string().max(500).default(''),
  }).parse(req.body);
  if (b.type === 'booking') assertCan(req.user, 'unit.book');
  const lead = workableLead(req.user, b.lead_id);
  const unit = bookableUnit(b.unit_id, lead.id);
  const id = requestApproval(req.user, b.type, lead, unit, b.amount_lakhs, b.discount_percent, b.note);
  res.status(201).json({ id });
});

/** A flat that can still be booked for this customer. */
function bookableUnit(unitId: number, leadId: number) {
  const unit = get<any>('SELECT * FROM units WHERE id = ?', unitId);
  if (!unit) throw new HttpError(404, 'Unit not found.');
  if (['Booked', 'Sold'].includes(unit.status)) throw new HttpError(409, 'This unit is already booked.');
  if (unit.status === 'Hold' && unit.lead_id !== leadId) throw new HttpError(409, 'This unit is on hold for another lead.');
  return unit;
}

function requestApproval(user: SessionUser, type: 'booking' | 'discount', lead: any, unit: any, amount: number, discount: number, note: string) {
  if (type === 'booking' && get(`SELECT 1 AS x FROM approvals WHERE unit_id = ? AND type = 'booking' AND status = 'pending'`, unit.id)) {
    throw new HttpError(409, 'This flat already has a booking request waiting for approval.');
  }
  const r = run(
    `INSERT INTO approvals(type, lead_id, unit_id, amount_lakhs, discount_percent, note, requested_by) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    type, lead.id, unit.id, amount, discount, note, user.id,
  );
  logActivity(lead.id, 'approval', `${type === 'booking' ? 'Booking' : 'Discount'} approval requested`, note, user.id);
  // The nearest manager who may approve gets it. Anyone else stays as the backup when there is none.
  const nearest = managerChain(user.id).find((id) => {
    const person = get<{ role: Role }>('SELECT role FROM users WHERE id = ?', id)!;
    return permissionsFor(id, person.role).includes('approval.review');
  });
  for (const u of nearest ? [{ id: nearest }] : reviewersFor(unit.project_id)) notifyUrgent(u.id, 'Approval needed', `${lead.name} · ${type}`, '/approvals');
  broadcast('approvals');
  return r.id;
}

/** Marks the flat booked, moves the customer to Booked and records the booking and any partner commission. */
function createBooking(lead: any, unitId: number, amount: number, discount: number, approvalId: number | null, actorId: number) {
  const { changes } = run(
    `UPDATE units SET status = 'Booked', lead_id = ?, held_by = NULL, hold_until = NULL
     WHERE id = ? AND (status = 'Available' OR (status = 'Hold' AND lead_id = ?))`,
    lead.id, unitId, lead.id,
  );
  if (!changes) throw new HttpError(409, 'This unit has already been booked.');
  run(`UPDATE leads SET stage = 'Booked', updated_at = ? WHERE id = ?`, nowIso(), lead.id);
  logActivity(lead.id, 'stage', `Stage: ${lead.stage} → Booked`, `₹${amount} Lakhs`, actorId);
  rescore(lead.id);
  const booking = run(
    'INSERT INTO bookings(lead_id, unit_id, approval_id, amount_lakhs, discount_percent) VALUES(?, ?, ?, ?, ?)',
    lead.id, unitId, approvalId, amount, discount,
  );
  const partner = lead.partner_id ? get<any>('SELECT id, commission_percent FROM partners WHERE id = ?', lead.partner_id) : null;
  if (partner?.commission_percent) {
    run(
      'INSERT INTO commissions(partner_id, booking_id, percent, amount_lakhs) VALUES(?, ?, ?, ?)',
      partner.id, booking.id, partner.commission_percent, Math.round(amount * partner.commission_percent * 1000) / 100000,
    );
  }
  return booking.id;
}

/** "Book flat" from the flat's own window. An admin's booking is final at once; anyone else's goes for approval. */
sales.post('/units/:id/book', (req, res) => {
  assertCan(req.user, 'unit.book');
  const b = z.object({
    lead_id: z.number().int(),
    amount_lakhs: z.number().positive(),
    discount_percent: z.number().min(0).max(50).default(0),
    note: z.string().max(500).default(''),
  }).parse(req.body);
  const lead = workableLead(req.user, b.lead_id);
  const unit = bookableUnit(Number(req.params.id), lead.id);
  if (req.user.role !== 'admin') {
    const id = requestApproval(req.user, 'booking', lead, unit, b.amount_lakhs, b.discount_percent, b.note);
    return res.status(202).json({ status: 'pending', approval_id: id });
  }
  const bookingId = tx(() => createBooking(lead, unit.id, b.amount_lakhs, b.discount_percent, null, req.user.id));
  audit(req, 'booking.direct', 'booking', bookingId, `unit ${unit.id}, ${b.amount_lakhs}L`);
  broadcast('inventory');
  broadcast('leads');
  broadcast('bookings');
  res.status(201).json({ status: 'booked', booking_id: bookingId });
});

/**
 * Sets or changes the customer on a held or booked flat.
 * A held flat: the person holding it, or an inventory manager. A booked flat: the booking right.
 * A flat with a booking record keeps its buyer; that booking must be cancelled or erased first.
 */
sales.post('/units/:id/customer', (req, res) => {
  const unit = get<any>('SELECT * FROM units WHERE id = ?', Number(req.params.id));
  if (!unit) throw new HttpError(404, 'Unit not found.');
  const { lead_id } = z.object({ lead_id: z.number().int() }).parse(req.body);
  if (unit.status === 'Hold') {
    if (unit.held_by !== req.user.id && !req.user.permissions.includes('inventory.manage')) {
      throw new HttpError(403, 'Only the person holding this flat or an inventory manager can change its customer.');
    }
    if (get(`SELECT 1 AS x FROM approvals WHERE unit_id = ? AND type = 'booking' AND status = 'pending'`, unit.id)) {
      throw new HttpError(409, 'This flat has a booking request waiting. Approve or reject it first.');
    }
  } else if (['Booked', 'Sold'].includes(unit.status)) {
    assertCan(req.user, 'unit.book');
    if (get(`SELECT 1 AS x FROM bookings WHERE unit_id = ? AND status = 'active'`, unit.id)) {
      throw new HttpError(409, 'This flat has a booking record, so it keeps its buyer.');
    }
  } else {
    throw new HttpError(409, 'Only a held or booked flat has a customer to change.');
  }
  const lead = workableLead(req.user, lead_id);
  if (lead.id === unit.lead_id) return res.json({ ok: true });
  const before = unit.lead_id ? get<any>('SELECT id, name FROM leads WHERE id = ?', unit.lead_id) : null;
  tx(() => {
    run('UPDATE units SET lead_id = ? WHERE id = ?', lead.id, unit.id);
    const label = `Flat ${unit.tower}-${unit.number}`;
    logActivity(lead.id, 'inventory', `${label} set to this customer`, before ? `Previously ${before.name}` : '', req.user.id);
    if (before) logActivity(before.id, 'inventory', `${label} moved to another customer`, lead.name, req.user.id);
  });
  audit(req, 'unit.customer', 'unit', unit.id, `${before?.id ?? 'none'} → ${lead.id}`);
  broadcast('inventory');
  res.json({ ok: true });
});

sales.get('/approvals', (req, res) => {
  const scope = leadScope(req.user);
  const mine = req.user.permissions.includes('approval.review') ? '' : 'AND a.requested_by = ?';
  res.json({
    approvals: all(
      `SELECT a.*, l.name AS lead_name, u.number AS unit_number, u.tower, p.name AS project_name, r.name AS requested_by_name
       FROM approvals a JOIN leads l ON l.id = a.lead_id LEFT JOIN units u ON u.id = a.unit_id
       LEFT JOIN projects p ON p.id = u.project_id JOIN users r ON r.id = a.requested_by
       WHERE ${scope.sql} ${mine} ORDER BY a.status = 'pending' DESC, a.id DESC LIMIT 100`,
      ...scope.params, ...(mine ? [req.user.id] : []),
    ),
  });
});

sales.post('/approvals/:id/review', requirePermission('approval.review'), (req, res) => {
  const { approve, note } = z.object({ approve: z.boolean(), note: z.string().max(300).optional() }).parse(req.body);
  const a = get<any>('SELECT * FROM approvals WHERE id = ?', Number(req.params.id));
  if (!a) throw new HttpError(404, 'Approval not found.');
  if (a.status !== 'pending') throw new HttpError(409, 'This request has already been reviewed.');
  const lead = visibleLead(req.user, a.lead_id);
  if (a.requested_by === req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'You cannot approve your own request.');
  const limit = getSetting('discount_limit_percent', 2);
  if (approve && req.user.role !== 'admin' && a.discount_percent > limit) {
    throw new HttpError(403, `Discounts above ${limit}% need admin approval.`);
  }
  tx(() => {
    if (approve && a.type === 'booking') createBooking(lead, a.unit_id, a.amount_lakhs, a.discount_percent, a.id, req.user.id);
    run(
      `UPDATE approvals SET status = ?, reviewed_by = ?, reviewed_at = ?, note = CASE WHEN ? != '' THEN ? ELSE note END WHERE id = ?`,
      approve ? 'approved' : 'rejected', req.user.id, nowIso(), note ?? '', note ?? '', a.id,
    );
    logActivity(a.lead_id, 'approval', `${a.type === 'booking' ? 'Booking' : 'Discount'} ${approve ? 'approved' : 'rejected'}`, note ?? '', req.user.id);
  });
  audit(req, `approval.${approve ? 'approve' : 'reject'}`, 'approval', a.id, `${a.type} ${a.amount_lakhs}L ${a.discount_percent}%`);
  notify(a.requested_by, `${a.type === 'booking' ? 'Booking' : 'Discount'} ${approve ? 'approved' : 'rejected'}`, lead.name, `/leads/${lead.id}`);
  broadcast('approvals');
  broadcast('inventory');
  broadcast('leads');
  res.json({ ok: true });
});

// ---------- Site visits ----------
sales.get('/visits', (req, res) => {
  const scope = leadScope(req.user);
  res.json({
    visits: all(
      `SELECT v.id, v.lead_id, v.scheduled_at, v.status, v.pickup, v.rating, v.feedback, v.checked_in_at, v.latitude, v.longitude,
        (SELECT COUNT(*) FROM site_visits x WHERE x.lead_id = v.lead_id AND x.id < v.id AND x.status IN ('Checked In','Completed')) AS previous_visits,
        l.name AS lead_name, p.name AS project_name, h.name AS host_name
       FROM site_visits v JOIN leads l ON l.id = v.lead_id JOIN projects p ON p.id = v.project_id
       LEFT JOIN users h ON h.id = v.host_id WHERE ${scope.sql} ORDER BY v.scheduled_at DESC LIMIT 200`,
      ...scope.params,
    ),
  });
});

sales.post('/visits', async (req, res) => {
  const b = z.object({
    lead_id: z.number().int(),
    project_id: z.number().int(),
    scheduled_at: z.string().min(10),
    pickup: z.boolean().default(false),
  }).parse(req.body);
  const lead = workableLead(req.user, b.lead_id);
  if (lead.do_not_contact) throw new HttpError(422, 'This contact is marked do not contact.');
  const otp = String(randomInt(100000, 1000000));
  const visitId = tx(() => {
    const r = run(
      `INSERT INTO site_visits(lead_id, project_id, host_id, scheduled_at, otp, pickup, created_by) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      lead.id, b.project_id, lead.owner_id, b.scheduled_at, otp, b.pickup ? 1 : 0, req.user.id,
    );
    logActivity(lead.id, 'visit', 'Site visit scheduled', formatIst(b.scheduled_at), req.user.id);
    run('INSERT INTO tasks(lead_id, owner_id, type, due_at) VALUES(?, ?, ?, ?)', lead.id, lead.owner_id ?? req.user.id, 'Site Visit', b.scheduled_at);
    changeStage(lead, 'Site Visit Scheduled', req.user.id);
    return r.id;
  });
  const fresh = get<any>('SELECT * FROM leads WHERE id = ?', lead.id)!;
  const confirmed = await sendAutomation('visit_confirm', fresh, { visit_time: formatIst(b.scheduled_at), otp }).catch(() => false);
  const calendarUser = [lead.owner_id, req.user.id].find((u) => u && isConnected(u));
  let calendar = false;
  if (calendarUser) {
    const project = get<any>('SELECT name, location FROM projects WHERE id = ?', b.project_id);
    // A calendar failure must not undo a visit that has already been booked.
    calendar = await addVisitToCalendar(calendarUser, { summary: `Site visit: ${lead.name}`, location: `${project?.name}, ${project?.location}`, startUtc: b.scheduled_at })
      .then((eventId) => { run('UPDATE site_visits SET google_event_id = ? WHERE id = ?', eventId, visitId); return true; })
      .catch(() => false);
  }
  broadcast('visits');
  res.status(201).json({ id: visitId, whatsapp_sent: confirmed, calendar_added: calendar });
});

const visitFor = (user: SessionUser, visitId: number) => {
  const v = get<any>('SELECT * FROM site_visits WHERE id = ?', visitId);
  if (!v) throw new HttpError(404, 'Visit not found.');
  workableLead(user, v.lead_id);
  return v;
};

sales.post('/visits/:id/checkin', requirePermission('visit.checkin'), (req, res) => {
  const v = visitFor(req.user, Number(req.params.id));
  const b = z.object({
    otp: z.string().optional(),
    override_reason: z.string().trim().max(200).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  }).parse(req.body);
  if (v.status !== 'Scheduled') throw new HttpError(409, 'This visit is not awaiting check-in.');
  if (b.override_reason) {
    if (!['admin', 'site_head'].includes(req.user.role)) throw new HttpError(403, 'Only a site head can check in without an OTP.');
    audit(req, 'visit.override_checkin', 'visit', v.id, b.override_reason);
  } else if (b.otp !== v.otp) {
    throw new HttpError(400, 'That OTP is not correct.');
  }
  run(
    `UPDATE site_visits SET status = 'Checked In', checked_in_at = ?, latitude = ?, longitude = ? WHERE id = ?`,
    nowIso(), b.latitude ?? null, b.longitude ?? null, v.id,
  );
  logActivity(v.lead_id, 'visit', 'Customer checked in at site', b.override_reason ?? '', req.user.id);
  rescore(v.lead_id);
  broadcast('visits');
  res.json({ ok: true });
});

sales.post('/visits/:id/complete', (req, res) => {
  const v = visitFor(req.user, Number(req.params.id));
  const b = z.object({
    status: z.enum(['Completed', 'No Show', 'Cancelled']),
    rating: z.number().int().min(1).max(5).optional(),
    feedback: z.string().max(1000).default(''),
  }).parse(req.body);
  if (b.status === 'Completed' && v.status !== 'Checked In') throw new HttpError(409, 'Check the customer in first.');
  run('UPDATE site_visits SET status = ?, rating = ?, feedback = ? WHERE id = ?', b.status, b.rating ?? null, b.feedback, v.id);
  logActivity(v.lead_id, 'visit', `Site visit ${b.status.toLowerCase()}`, b.feedback, req.user.id);
  if (b.status === 'Cancelled' && v.google_event_id) {
    const lead = get<any>('SELECT owner_id FROM leads WHERE id = ?', v.lead_id);
    const owner = [lead?.owner_id, req.user.id].find((u) => u && isConnected(u));
    if (owner) void removeVisitFromCalendar(owner, v.google_event_id).catch(() => undefined);
  }
  if (b.status === 'Completed') {
    const lead = get<any>('SELECT * FROM leads WHERE id = ?', v.lead_id)!;
    changeStage(lead, 'Site Visit Done', req.user.id);
    void sendAutomation('post_visit', lead).catch(() => false);
  }
  rescore(v.lead_id);
  broadcast('visits');
  res.json({ ok: true });
});
