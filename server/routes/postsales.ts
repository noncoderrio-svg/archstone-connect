import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import express, { Router } from 'express';
import { z } from 'zod';
import { BOOKING_ROLES, DOCUMENT_TYPES, HANDOVER_STAGES, RECEIPT_PREFIX } from '../../shared/domain.ts';
import { HttpError, requirePermission, type SessionUser } from '../auth.ts';
import { config } from '../config.ts';
import { all, get, getSetting, nowIso, run, tx } from '../db.ts';
import { audit, broadcast, leadScope, visibleLead, workableLead } from '../services/core.ts';
import { uploadToDrive } from '../services/google.ts';
import { changeStage, logActivity } from '../services/leads.ts';
import { dataDir, decrypt, encrypt } from '../services/secrets.ts';

export const postsales = Router();
export const publicBuyer = Router();

const portalHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Only a hash is stored, so a copied database cannot open anyone's page. */
publicBuyer.get('/buyer/:token', (req, res) => {
  const b = get<any>(
    `SELECT b.id, b.amount_lakhs, b.handover_status, l.name AS buyer, u.tower, u.number AS unit, u.configuration, p.name AS project, p.location, p.rera_number, o.name AS contact
     FROM bookings b JOIN leads l ON l.id = b.lead_id JOIN units u ON u.id = b.unit_id JOIN projects p ON p.id = u.project_id LEFT JOIN users o ON o.id = l.owner_id
     WHERE b.portal_hash = ? AND b.portal_hash != '' AND b.status = 'active'`,
    portalHash(String(req.params.token)),
  );
  if (!b) throw new HttpError(404, 'This link is not available.');
  const payments = all<any>('SELECT label, due_date, amount_lakhs, paid_at, receipt_number FROM payments WHERE booking_id = ? ORDER BY due_date', b.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    buyer: b.buyer.split(' ')[0], project: b.project, location: b.location, rera: b.rera_number, tower: b.tower, unit: b.unit, configuration: b.configuration,
    amount_lakhs: b.amount_lakhs, handover_status: b.handover_status, handover_stages: HANDOVER_STAGES, contact: b.contact, payments,
    collected_lakhs: payments.filter((p) => p.paid_at).reduce((s, p) => s + p.amount_lakhs, 0),
  });
});

postsales.post('/bookings/:id/portal', requirePermission('booking.manage'), (req, res) => {
  const booking = visibleBooking(req.user, Number(req.params.id));
  // Each new link replaces the last, so an old link can be retired by making a new one.
  const token = randomBytes(24).toString('base64url');
  run('UPDATE bookings SET portal_hash = ? WHERE id = ?', portalHash(token), booking.id);
  audit(req, 'booking.portal_link', 'booking', String(booking.id));
  res.status(201).json({ url: `${config.appUrl}/buyer/${token}` });
});

postsales.delete('/bookings/:id/portal', requirePermission('booking.manage'), (req, res) => {
  const booking = visibleBooking(req.user, Number(req.params.id));
  run(`UPDATE bookings SET portal_hash = '' WHERE id = ?`, booking.id);
  audit(req, 'booking.portal_off', 'booking', String(booking.id));
  res.json({ ok: true });
});

const docsDir = () => join(dataDir(), 'documents');
const MAX_FILE = 10 * 1024 * 1024;
/** Amounts are held in lakhs, so five decimal places is one rupee. */
const round = (v: number) => Math.round(v * 100000) / 100000;

// ---------- Cost sheet ----------
postsales.get('/leads/:id/cost-sheet', (req, res) => {
  const lead = workableLead(req.user, Number(req.params.id));
  const q = z.object({ unit_id: z.coerce.number().int(), discount: z.coerce.number().min(0).max(50).default(0) }).parse(req.query);
  const unit = get<any>('SELECT * FROM units WHERE id = ?', q.unit_id);
  if (!unit) throw new HttpError(404, 'Unit not found.');
  if (!unit.price_lakhs) throw new HttpError(422, 'This unit has no price yet.');
  const project = get<any>('SELECT * FROM projects WHERE id = ?', unit.project_id)!;
  const agreement = round(unit.price_lakhs * (1 - q.discount / 100));
  const lines = [{ label: 'Unit price', amount: unit.price_lakhs }];
  if (q.discount) lines.push({ label: `Discount (${q.discount}%)`, amount: round(agreement - unit.price_lakhs) });
  lines.push({ label: 'Agreement value', amount: agreement });
  const missing: string[] = [];
  const percentLine = (label: string, rate: number | null) => {
    if (rate === null) missing.push(label);
    else lines.push({ label: `${label} (${rate}%)`, amount: round((agreement * rate) / 100) });
  };
  const flatLine = (label: string, value: number | null) => {
    if (value === null) missing.push(label);
    else lines.push({ label, amount: value });
  };
  percentLine('GST', project.gst_percent);
  percentLine('Stamp duty', project.stamp_duty_percent);
  flatLine('Registration', project.registration_lakhs);
  flatLine('Other charges', project.other_charges_lakhs);
  const total = round(lines.filter((l) => !['Unit price'].includes(l.label) && !l.label.startsWith('Discount')).reduce((sum, l) => sum + l.amount, 0));
  audit(req, 'costsheet.view', 'lead', lead.id, `unit ${unit.id}`);
  res.json({
    lead: { name: lead.name },
    project: { name: project.name, location: project.location, rera_number: project.rera_number },
    unit: { tower: unit.tower, number: unit.number, floor: unit.floor, configuration: unit.configuration, carpet_sqft: unit.carpet_sqft },
    prepared_by: req.user.name,
    lines,
    total,
    missing,
  });
});

// ---------- Bookings ----------
const bookingScope = (user: SessionUser) => {
  if (!(BOOKING_ROLES as readonly string[]).includes(user.role)) throw new HttpError(403, 'Bookings are not available for your role.');
  return leadScope(user);
};

postsales.get('/bookings', (req, res) => {
  const scope = bookingScope(req.user);
  res.json({
    bookings: all(
      `SELECT b.*, l.name AS lead_name, u.tower, u.number AS unit_number, p.name AS project_name,
        COALESCE((SELECT SUM(x.amount_lakhs) FROM payments x WHERE x.booking_id = b.id AND x.paid_at IS NOT NULL), 0) AS collected_lakhs,
        (SELECT COUNT(*) FROM payments x WHERE x.booking_id = b.id) AS milestones,
        (SELECT COUNT(*) FROM payments x WHERE x.booking_id = b.id AND x.paid_at IS NULL AND x.due_date < date('now')) AS overdue
       FROM bookings b JOIN leads l ON l.id = b.lead_id JOIN units u ON u.id = b.unit_id JOIN projects p ON p.id = u.project_id
       WHERE ${scope.sql} ORDER BY b.id DESC LIMIT 200`,
      ...scope.params,
    ),
  });
});

export function visibleBooking(user: SessionUser, id: number) {
  bookingScope(user);
  const b = get<any>('SELECT * FROM bookings WHERE id = ?', id);
  if (!b) throw new HttpError(404, 'Booking not found.');
  visibleLead(user, b.lead_id);
  return b;
}

postsales.get('/bookings/:id', (req, res) => {
  const b = visibleBooking(req.user, Number(req.params.id));
  res.json({
    booking: get(
      `SELECT b.*, l.name AS lead_name, u.tower, u.number AS unit_number, p.name AS project_name FROM bookings b
       JOIN leads l ON l.id = b.lead_id JOIN units u ON u.id = b.unit_id JOIN projects p ON p.id = u.project_id WHERE b.id = ?`,
      b.id,
    ),
    payments: all('SELECT * FROM payments WHERE booking_id = ? ORDER BY due_date, id', b.id),
    default_plan: getSetting('payment_plan', [] as { label: string; percent: number }[]),
  });
});

postsales.put('/bookings/:id/schedule', requirePermission('booking.manage'), (req, res) => {
  const b = visibleBooking(req.user, Number(req.params.id));
  const { items } = z.object({
    items: z.array(z.object({
      label: z.string().trim().min(2).max(80),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Each milestone needs a due date.'),
      amount_lakhs: z.number().positive(),
    })).min(1).max(40),
  }).parse(req.body);
  const paid = get<{ v: number }>('SELECT COALESCE(SUM(amount_lakhs), 0) v FROM payments WHERE booking_id = ? AND paid_at IS NOT NULL', b.id)!.v;
  const total = round(items.reduce((sum, i) => sum + i.amount_lakhs, 0) + paid);
  if (Math.abs(total - b.amount_lakhs) > 0.01) {
    throw new HttpError(400, `Milestones add up to ₹${total} Lakhs, but the booking is ₹${b.amount_lakhs} Lakhs.`);
  }
  tx(() => {
    run('DELETE FROM payments WHERE booking_id = ? AND paid_at IS NULL', b.id);
    for (const i of items) run('INSERT INTO payments(booking_id, label, due_date, amount_lakhs) VALUES(?, ?, ?, ?)', b.id, i.label, i.due_date, i.amount_lakhs);
  });
  audit(req, 'booking.schedule', 'booking', b.id, `${items.length} milestones`);
  broadcast('bookings');
  res.json({ ok: true });
});

postsales.post('/payments/:id/paid', requirePermission('payment.record'), (req, res) => {
  const p = get<any>('SELECT * FROM payments WHERE id = ?', Number(req.params.id));
  if (!p) throw new HttpError(404, 'Payment not found.');
  const b = visibleBooking(req.user, p.booking_id);
  if (p.paid_at) throw new HttpError(409, 'This payment is already recorded.');
  const { reference } = z.object({ reference: z.string().trim().min(3, 'Enter the cheque or transaction reference.').max(80) }).parse(req.body);
  const receipt = tx(() => {
    const year = nowIso().slice(0, 4);
    const count = get<{ n: number }>(`SELECT COUNT(*) n FROM payments WHERE receipt_number LIKE ?`, `${RECEIPT_PREFIX}-${year}-%`)!.n;
    const number = `${RECEIPT_PREFIX}-${year}-${String(count + 1).padStart(5, '0')}`;
    run('UPDATE payments SET paid_at = ?, reference = ?, receipt_number = ?, recorded_by = ? WHERE id = ?', nowIso(), reference, number, req.user.id, p.id);
    logActivity(b.lead_id, 'payment', `Payment received: ${p.label}`, `₹${p.amount_lakhs} Lakhs. Receipt ${number}`, req.user.id);
    return number;
  });
  audit(req, 'payment.record', 'payment', p.id, `${p.amount_lakhs}L ${receipt}`);
  broadcast('bookings');
  res.json({ receipt_number: receipt });
});

postsales.post('/bookings/:id/handover', requirePermission('booking.manage'), (req, res) => {
  const b = visibleBooking(req.user, Number(req.params.id));
  const { status } = z.object({ status: z.enum(HANDOVER_STAGES) }).parse(req.body);
  run('UPDATE bookings SET handover_status = ? WHERE id = ?', status, b.id);
  logActivity(b.lead_id, 'stage', `Handover stage: ${status}`, '', req.user.id);
  broadcast('bookings');
  res.json({ ok: true });
});

/** Admin only. Frees the unit and reverses any unpaid commission. */
postsales.post('/bookings/:id/cancel', requirePermission('settings.manage'), (req, res) => {
  const b = visibleBooking(req.user, Number(req.params.id));
  if (b.status !== 'active') throw new HttpError(409, 'This booking is already cancelled.');
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Give a reason.').max(300) }).parse(req.body);
  const paidCommission = get(`SELECT 1 AS x FROM commissions WHERE booking_id = ? AND status = 'paid'`, b.id);
  tx(() => {
    run(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`, b.id);
    run(`UPDATE units SET status = 'Available', lead_id = NULL WHERE id = ?`, b.unit_id);
    run(`UPDATE commissions SET status = 'cancelled' WHERE booking_id = ? AND status != 'paid'`, b.id);
    const lead = get<any>('SELECT * FROM leads WHERE id = ?', b.lead_id)!;
    changeStage(lead, 'Working Deal', req.user.id);
    logActivity(b.lead_id, 'stage', 'Booking cancelled', reason, req.user.id);
  });
  audit(req, 'booking.cancel', 'booking', b.id, reason);
  broadcast('bookings');
  broadcast('inventory');
  res.json({ ok: true, commission_already_paid: Boolean(paidCommission) });
});

// ---------- KYC and documents ----------
const SIGNATURES: { mime: string; bytes: number[] }[] = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
];
const sniff = (data: Buffer) => SIGNATURES.find((s) => s.bytes.every((b, i) => data[i] === b))?.mime;

const documentFor = (user: SessionUser, id: number) => {
  const d = get<any>('SELECT * FROM documents WHERE id = ?', id);
  if (!d) throw new HttpError(404, 'Document not found.');
  workableLead(user, d.lead_id);
  return d;
};

postsales.post('/leads/:id/documents', express.raw({ type: () => true, limit: MAX_FILE }), (req, res) => {
  const lead = workableLead(req.user, Number(req.params.id));
  const q = z.object({ type: z.enum(DOCUMENT_TYPES), name: z.string().min(1).max(160) }).parse(req.query);
  const data = req.body as Buffer;
  if (!Buffer.isBuffer(data) || !data.length) throw new HttpError(400, 'The file is empty.');
  const mime = sniff(data);
  if (!mime) throw new HttpError(415, 'Only PDF, JPG and PNG files are accepted.');
  mkdirSync(docsDir(), { recursive: true });
  const storageName = randomUUID();
  writeFileSync(join(docsDir(), storageName), encrypt(data));
  const filename = basename(q.name).replace(/[^\w.\- ]+/g, '_');
  const r = run(
    'INSERT INTO documents(lead_id, type, filename, mime, size, storage_name, uploaded_by) VALUES(?, ?, ?, ?, ?, ?, ?)',
    lead.id, q.type, filename, mime, data.length, storageName, req.user.id,
  );
  logActivity(lead.id, 'document', `Document uploaded: ${q.type}`, '', req.user.id);
  audit(req, 'document.upload', 'lead', lead.id, q.type);
  broadcast('leads');
  res.status(201).json({ id: r.id });
});

postsales.get('/documents/:id/file', (req, res) => {
  const d = documentFor(req.user, Number(req.params.id));
  audit(req, 'document.view', 'document', d.id, d.type);
  res.setHeader('Content-Type', d.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${d.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(decrypt(readFileSync(join(docsDir(), d.storage_name))));
});

postsales.post('/documents/:id/review', requirePermission('booking.manage'), (req, res) => {
  const d = documentFor(req.user, Number(req.params.id));
  const { status } = z.object({ status: z.enum(['verified', 'rejected']) }).parse(req.body);
  run('UPDATE documents SET status = ?, verified_by = ? WHERE id = ?', status, req.user.id, d.id);
  logActivity(d.lead_id, 'document', `Document ${status}: ${d.type}`, '', req.user.id);
  audit(req, `document.${status}`, 'document', d.id);
  broadcast('leads');
  res.json({ ok: true });
});

postsales.post('/documents/:id/drive', async (req, res) => {
  const d = documentFor(req.user, Number(req.params.id));
  const data = decrypt(readFileSync(join(docsDir(), d.storage_name)));
  const fileId = await uploadToDrive(req.user.id, { name: d.filename, mime: d.mime, data });
  run('UPDATE documents SET drive_file_id = ? WHERE id = ?', fileId, d.id);
  audit(req, 'document.drive', 'document', d.id);
  broadcast('leads');
  res.json({ ok: true });
});

/** Used when a customer's data is erased. */
export function eraseDocuments(leadId: number) {
  for (const d of all<any>('SELECT id, storage_name FROM documents WHERE lead_id = ?', leadId)) {
    rmSync(join(docsDir(), d.storage_name), { force: true });
    run('DELETE FROM documents WHERE id = ?', d.id);
  }
}
