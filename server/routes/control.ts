// Admin control room: permissions, WhatsApp numbers, property files, monitoring, and the assistant.
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { z } from 'zod';
import { ACTIONS, ROLES, type Action, type Role, PERMISSIONS } from '../../shared/domain.ts';
import { HttpError, assertCan, permissionsFor, requirePermission } from '../auth.ts';
import { config } from '../config.ts';
import { all, get, getSetting, nowIso, run, setSetting, tx } from '../db.ts';
import { askAssistant, writeTemplate } from '../services/ai.ts';
import { type ConversationQuery, conversationThread, listConversations } from '../services/conversations.ts';
import { audit, visibleLead, workableLead } from '../services/core.ts';
import { buildReport } from '../services/reports.ts';
import { dataDir, encryptText } from '../services/secrets.ts';
import { requestHistorySync, sendMediaMessage } from '../services/whatsapp.ts';

export const control = Router();
export const publicMedia = Router();

const actionList = z.array(z.string().refine((a) => (ACTIONS as string[]).includes(a), 'Unknown permission.'));

// ---------- Permissions ----------
control.get('/permissions', requirePermission('user.manage'), (_req, res) => {
  const saved = getSetting<Partial<Record<Role, Action[]>>>('role_permissions', {});
  res.json({
    roles: Object.fromEntries(ROLES.map((r) => [r, r === 'admin' ? ACTIONS : saved[r] ?? PERMISSIONS[r]])),
  });
});

control.put('/permissions/role/:role', requirePermission('user.manage'), (req, res) => {
  const role = z.enum(ROLES).parse(req.params.role);
  if (role === 'admin') throw new HttpError(400, 'Admins always keep every permission.');
  const { actions } = z.object({ actions: actionList }).parse(req.body);
  setSetting('role_permissions', { ...getSetting('role_permissions', {}), [role]: actions });
  audit(req, 'permissions.role', 'role', role, `${actions.length} permissions`);
  res.json({ ok: true });
});

control.get('/users/:id/permissions', requirePermission('user.manage'), (req, res) => {
  const u = get<any>('SELECT id, role, data_scope FROM users WHERE id = ?', Number(req.params.id));
  if (!u) throw new HttpError(404, 'User not found.');
  res.json({
    data_scope: u.data_scope,
    effective: permissionsFor(u.id, u.role),
    overrides: all('SELECT action, allowed FROM user_permissions WHERE user_id = ?', u.id),
  });
});

control.put('/users/:id/permissions', requirePermission('user.manage'), (req, res) => {
  const id = Number(req.params.id);
  const b = z.object({ allow: actionList, deny: actionList, data_scope: z.enum(['', 'own', 'team', 'projects', 'all']) }).parse(req.body);
  const u = get<any>('SELECT role FROM users WHERE id = ?', id);
  if (!u) throw new HttpError(404, 'User not found.');
  if (u.role === 'admin') throw new HttpError(400, 'Admins always keep every permission.');
  tx(() => {
    run('DELETE FROM user_permissions WHERE user_id = ?', id);
    for (const a of b.allow) run('INSERT INTO user_permissions(user_id, action, allowed) VALUES(?, ?, 1)', id, a);
    for (const a of b.deny) run('INSERT INTO user_permissions(user_id, action, allowed) VALUES(?, ?, 0)', id, a);
    run('UPDATE users SET data_scope = ? WHERE id = ?', b.data_scope, id);
  });
  audit(req, 'permissions.user', 'user', id, `allow ${b.allow.length}, deny ${b.deny.length}, scope ${b.data_scope || 'default'}`);
  res.json({ ok: true });
});

// ---------- WhatsApp numbers ----------
const numberBody = z.object({
  label: z.string().trim().min(2).max(60),
  display_number: z.string().regex(/^\+\d{8,15}$/, 'Use a number like +919876543210.'),
  phone_number_id: z.string().trim().min(3).max(60),
  token: z.string().trim().max(600).optional(),
  user_id: z.number().int().nullish(),
  daily_limit: z.number().int().min(1).max(1000000),
  status: z.enum(['active', 'paused']).default('active'),
  phone_app: z.boolean().default(false),
});

control.get('/wa-numbers', requirePermission('whatsapp.monitor'), (_req, res) => {
  const today = `${nowIso().slice(0, 10)} 00:00:00`;
  res.json({
    numbers: all(
      `SELECT n.id, n.label, n.display_number, n.phone_number_id, n.user_id, n.daily_limit, n.status, n.quality, n.phone_app, n.history_status, n.token != '' AS has_token, u.name AS user_name,
        (SELECT COUNT(*) FROM wa_messages m WHERE m.number_id = n.id AND m.direction = 'out' AND m.created_at >= ?) AS sent_today,
        (SELECT COUNT(*) FROM wa_messages m WHERE m.number_id = n.id AND m.direction = 'in' AND m.created_at >= ?) AS received_today,
        (SELECT COUNT(*) FROM wa_messages m WHERE m.number_id = n.id AND m.status = 'failed' AND m.created_at >= ?) AS failed_today,
        (SELECT COUNT(*) FROM leads l WHERE l.wa_number_id = n.id AND l.deleted_at IS NULL) AS conversations
       FROM wa_numbers n LEFT JOIN users u ON u.id = n.user_id ORDER BY n.label`,
      today, today, today,
    ),
  });
});

/** Who can pick which inbox. Staff only ever see their own number here. */
control.get('/wa-numbers/mine', (req, res) => {
  const monitor = req.user.permissions.includes('whatsapp.monitor');
  res.json({
    monitor,
    numbers: all<any>(
      `SELECT n.id, n.label, n.display_number, n.user_id, u.name AS user_name FROM wa_numbers n LEFT JOIN users u ON u.id = n.user_id
       WHERE n.status = 'active' ${monitor ? '' : 'AND n.user_id = ?'} ORDER BY n.label`,
      ...(monitor ? [] : [req.user.id]),
    ),
  });
});

/** Gives a clear reason when a number or person is already in use. */
function assertNumberFree(b: z.infer<typeof numberBody>, id = 0) {
  if (get('SELECT 1 AS x FROM wa_numbers WHERE display_number = ? AND id != ?', b.display_number, id)) throw new HttpError(409, 'This WhatsApp number is already added.');
  if (get('SELECT 1 AS x FROM wa_numbers WHERE phone_number_id = ? AND id != ?', b.phone_number_id, id)) throw new HttpError(409, 'This phone number ID is already added.');
  if (b.user_id && get('SELECT 1 AS x FROM wa_numbers WHERE user_id = ? AND id != ?', b.user_id, id)) throw new HttpError(409, 'This person already has a number. Reassign that one first.');
}

control.post('/wa-numbers', requirePermission('settings.manage'), (req, res) => {
  const b = numberBody.parse(req.body);
  assertNumberFree(b);
  const r = run(
    `INSERT INTO wa_numbers(label, display_number, phone_number_id, token, user_id, daily_limit, status, phone_app) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    b.label, b.display_number, b.phone_number_id, b.token ? encryptText(b.token) : '', b.user_id ?? null, b.daily_limit, b.status, b.phone_app ? 1 : 0,
  );
  audit(req, 'wa_number.create', 'wa_number', r.id, b.display_number);
  res.status(201).json({ id: r.id });
});

control.put('/wa-numbers/:id', requirePermission('settings.manage'), (req, res) => {
  const id = Number(req.params.id);
  const b = numberBody.parse(req.body);
  assertNumberFree(b, id);
  run(
    'UPDATE wa_numbers SET label = ?, display_number = ?, phone_number_id = ?, user_id = ?, daily_limit = ?, status = ?, phone_app = ? WHERE id = ?',
    b.label, b.display_number, b.phone_number_id, b.user_id ?? null, b.daily_limit, b.status, b.phone_app ? 1 : 0, id,
  );
  if (b.token) run('UPDATE wa_numbers SET token = ? WHERE id = ?', encryptText(b.token), id);
  audit(req, 'wa_number.update', 'wa_number', id, b.display_number);
  res.json({ ok: true });
});

/** Meta allows this once, within 24 hours of connecting the number. */
control.post('/wa-numbers/:id/history-sync', requirePermission('settings.manage'), async (req, res) => {
  const id = Number(req.params.id);
  const number = get<any>('SELECT * FROM wa_numbers WHERE id = ?', id);
  if (!number) throw new HttpError(404, 'Number not found.');
  await requestHistorySync(number);
  audit(req, 'wa_number.history_sync', 'wa_number', id, number.display_number);
  res.json({ ok: true });
});

// ---------- Property files ----------
const mediaDir = () => join(dataDir(), 'media');
const MB = 1024 * 1024;
const MAX_MEDIA = 100 * MB;
/** The largest file WhatsApp accepts for each kind. */
const WHATSAPP_LIMIT: Record<string, number> = { image: 5 * MB, video: 16 * MB, document: 100 * MB };

function folderSize(folder: string): number {
  if (!existsSync(folder)) return 0;
  return readdirSync(folder, { withFileTypes: true }).reduce((sum, entry) => {
    const path = join(folder, entry.name);
    return sum + (entry.isDirectory() ? folderSize(path) : statSync(path).size);
  }, 0);
}

/** The limit stays below the real disk size, so uploads can never leave the database without room. */
const storageUse = () => ({ used: folderSize(dataDir()), limit: config.storageLimitMb * MB });
const TYPES: { mime: string; kind: string; bytes: number[]; at?: number }[] = [
  { mime: 'application/pdf', kind: 'document', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'image/jpeg', kind: 'image', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', kind: 'image', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/webp', kind: 'image', bytes: [0x57, 0x45, 0x42, 0x50], at: 8 },
  { mime: 'video/mp4', kind: 'video', bytes: [0x66, 0x74, 0x79, 0x70], at: 4 },
];
const sniff = (d: Buffer) => TYPES.find((t) => t.bytes.every((b, i) => d[(t.at ?? 0) + i] === b));
const publicUrl = (m: { token: string; filename: string }) => `${config.appUrl}/public/media/${m.token}/${encodeURIComponent(m.filename)}`;

control.get('/media', (req, res) => {
  const project = Number(req.query.project) || null;
  const rows = all<any>(
    `SELECT m.id, m.project_id, m.title, m.kind, m.filename, m.mime, m.size, m.token, m.created_at, p.name AS project_name, u.name AS uploaded_by_name
     FROM media_assets m LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN users u ON u.id = m.uploaded_by
     ${project ? 'WHERE m.project_id = ?' : ''} ORDER BY m.id DESC LIMIT 300`,
    ...(project ? [project] : []),
  );
  res.json({
    media: rows.map((m) => ({ ...m, url: publicUrl(m), preview: `/public/media/${m.token}/${encodeURIComponent(m.filename)}` })),
    storage: { ...storageUse(), max_file: MAX_MEDIA },
  });
});

control.post('/media', requirePermission('media.manage'), async (req, res) => {
  const q = z.object({
    title: z.string().trim().min(2).max(120),
    name: z.string().min(1).max(160),
    project_id: z.coerce.number().int().optional(),
  }).parse(req.query);
  const tooLarge = new HttpError(413, 'That file is over the 100 MB limit. Please compress it and try again.');
  const declared = Number(req.headers['content-length']) || 0;
  const refuse = (error: HttpError) => {
    res.setHeader('Connection', 'close');
    throw error;
  };
  if (declared > MAX_MEDIA) refuse(tooLarge);
  const { used, limit } = storageUse();
  const noRoom = new HttpError(507, 'Your storage is full. Delete old files or increase the storage limit.');
  if (limit && used + declared > limit) refuse(noRoom);

  mkdirSync(mediaDir(), { recursive: true });
  const storage = randomUUID();
  const partial = join(mediaDir(), `${storage}.part`);
  let size = 0;
  let head = Buffer.alloc(0);
  // Written to disk as it arrives, so a large file never sits in the server's memory.
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > MAX_MEDIA) return done(tooLarge);
      if (limit && used + size > limit) return done(noRoom);
      if (head.length < 16) head = Buffer.concat([head, chunk]).subarray(0, 16);
      done(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, createWriteStream(partial));
  } catch (e) {
    rmSync(partial, { force: true });
    if (e instanceof HttpError) refuse(e);
    if ((e as NodeJS.ErrnoException).code === 'ENOSPC') refuse(noRoom);
    throw e;
  }
  const type = sniff(head);
  if (!size || !type) {
    rmSync(partial, { force: true });
    throw size ? new HttpError(415, 'Use a PDF, JPG, PNG, WebP or MP4 file.') : new HttpError(400, 'The file is empty.');
  }
  renameSync(partial, join(mediaDir(), storage));
  const filename = basename(q.name).replace(/[^\w.\- ]+/g, '_');
  const r = run(
    'INSERT INTO media_assets(project_id, title, kind, filename, mime, size, storage_name, token, uploaded_by) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    q.project_id ?? null, q.title, type.kind, filename, type.mime, size, storage, randomBytes(18).toString('base64url'), req.user.id,
  );
  audit(req, 'media.upload', 'media', r.id, q.title);
  res.status(201).json({ id: r.id });
});

control.delete('/media/:id', requirePermission('media.manage'), (req, res) => {
  const m = get<any>('SELECT * FROM media_assets WHERE id = ?', Number(req.params.id));
  if (!m) throw new HttpError(404, 'File not found.');
  rmSync(join(mediaDir(), m.storage_name), { force: true });
  run('DELETE FROM media_assets WHERE id = ?', m.id);
  audit(req, 'media.delete', 'media', m.id, m.title);
  res.json({ ok: true });
});

/** Marketing files only. WhatsApp must fetch them, so the long random link is the protection. */
publicMedia.get('/media/:token/:name', (req, res) => {
  const m = get<any>('SELECT * FROM media_assets WHERE token = ?', String(req.params.token));
  if (!m) throw new HttpError(404, 'File not found.');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Content-Disposition', `inline; filename="${m.filename}"`);
  // Sent as a stream with range support, so large videos can play without downloading in full.
  res.type(m.mime).sendFile(resolve(mediaDir(), m.storage_name));
});

control.post('/inbox/:leadId/media', async (req, res) => {
  assertCan(req.user, 'whatsapp.send');
  const lead = workableLead(req.user, Number(req.params.leadId));
  const { media_id, caption } = z.object({ media_id: z.number().int(), caption: z.string().trim().max(900).optional() }).parse(req.body);
  const m = get<any>('SELECT * FROM media_assets WHERE id = ?', media_id);
  if (!m) throw new HttpError(404, 'File not found.');
  const whatsappLimit = WHATSAPP_LIMIT[m.kind];
  if (m.size > whatsappLimit) throw new HttpError(400, `WhatsApp allows ${m.kind === 'document' ? 'PDFs' : `${m.kind}s`} up to ${whatsappLimit / MB} MB. Copy this file's link from Property Files and send that instead.`);
  audit(req, 'media.send', 'lead', lead.id, m.title);
  res.status(201).json(await sendMediaMessage(lead, publicUrl(m), m.kind, caption || m.title, req.user.id));
});

// ---------- AI assistant ----------
control.post('/ai/assistant', async (req, res) => {
  assertCan(req.user, 'ai.use');
  const b = z.object({
    question: z.string().trim().min(2).max(1000),
    lead_id: z.number().int().nullish(),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(1500) })).max(8).default([]),
  }).parse(req.body);
  const lead = b.lead_id ? visibleLead(req.user, b.lead_id) : null;
  const context = {
    you: { name: req.user.name, role: req.user.role },
    projects: all('SELECT name, location, configuration, type, price_from_lakhs, rera_number, status FROM projects'),
    files: all('SELECT title, kind FROM media_assets ORDER BY id DESC LIMIT 40'),
    report: req.user.permissions.includes('reports.view') ? buildReport(req.user, 30) : undefined,
    my_open_followups: all(
      `SELECT t.type, t.due_at, l.name AS lead FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE t.owner_id = ? AND t.completed_at IS NULL ORDER BY t.due_at LIMIT 15`,
      req.user.id,
    ),
  };
  audit(req, 'ai.assistant', 'lead', lead?.id ?? '', b.question.slice(0, 120));
  res.json({ text: await askAssistant(context, lead, b.question, b.history) });
});

control.post('/ai/template', requirePermission('template.manage'), async (req, res) => {
  const b = z.object({ goal: z.string().trim().min(5).max(400), language: z.enum(['English', 'Hindi', 'Marathi']) }).parse(req.body);
  res.json({ text: await writeTemplate(b.goal, b.language) });
});

// ---------- Monitor ----------
control.get('/conversations', requirePermission('whatsapp.monitor'), (req, res) => {
  res.json(listConversations(req.user, req.query as ConversationQuery));
});

control.get('/conversations/:leadId', requirePermission('whatsapp.monitor'), (req, res) => {
  res.json(conversationThread(req, Number(req.params.leadId), Number(req.query.number ?? 0)));
});

control.get('/monitor', requirePermission('whatsapp.monitor'), (_req, res) => {
  const today = `${nowIso().slice(0, 10)} 00:00:00`;
  const staff = all<any>(
    `SELECT u.id, u.name, u.role, u.last_login_at, n.display_number,
      (SELECT COUNT(*) FROM wa_messages m WHERE m.actor_id = u.id AND m.created_at >= ?) AS messages,
      (SELECT COUNT(*) FROM activities a WHERE a.actor_id = u.id AND a.type = 'call' AND a.created_at >= ?) AS calls,
      (SELECT COUNT(*) FROM activities a WHERE a.actor_id = u.id AND a.created_at >= ?) AS actions,
      (SELECT COUNT(*) FROM wa_campaigns c WHERE c.created_by = u.id AND c.created_at >= ?) AS broadcasts,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions
     FROM users u LEFT JOIN wa_numbers n ON n.user_id = u.id WHERE u.status = 'active' ORDER BY actions DESC, u.name`,
    today, today, today, today, nowIso(),
  );
  res.json({
    staff,
    totals: get(
      `SELECT
        (SELECT COUNT(*) FROM wa_messages WHERE direction = 'out' AND created_at >= ?) AS sent,
        (SELECT COUNT(*) FROM wa_messages WHERE direction = 'in' AND created_at >= ?) AS received,
        (SELECT COUNT(*) FROM wa_messages WHERE status = 'failed' AND created_at >= ?) AS failed,
        (SELECT COUNT(*) FROM leads WHERE unread_count > 0 AND deleted_at IS NULL) AS unanswered`,
      today, today, today,
    ),
    feed: all(
      `SELECT a.id, a.type, a.title, a.created_at, u.name AS actor, l.id AS lead_id, l.name AS lead_name FROM activities a
       LEFT JOIN users u ON u.id = a.actor_id JOIN leads l ON l.id = a.lead_id ORDER BY a.id DESC LIMIT 40`,
    ),
    pending_broadcasts: all(
      `SELECT c.id, c.name, u.name AS created_by_name FROM wa_campaigns c LEFT JOIN users u ON u.id = c.created_by WHERE c.status = 'pending_approval'`,
    ),
  });
});

