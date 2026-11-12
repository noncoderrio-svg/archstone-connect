import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { SOURCES, STAGES, TEMPLATE_VARS, isViewOnly } from '../../shared/domain.ts';
import { HttpError, assertCan, permissionsFor, requirePermission } from '../auth.ts';
import { config, whatsappLive } from '../config.ts';
import { all, get, nowIso, run } from '../db.ts';
import { audit, broadcast, leadScope, notify, phoneMasked, maskPhone, visibleLead, workableLead } from '../services/core.ts';
import { clauseSql, leadFilters } from '../services/filters.ts';
import {
  audiencePreview, creatorLeadIds, queueCampaign, receiveInbound, sendBlockers, sendDocument, sendTemplate, sendText, submitTemplate, templateVars, windowOpen,
} from '../services/whatsapp.ts';

export const messaging = Router();

// ---------- Inbox ----------
messaging.get('/inbox', (req, res) => {
  const scope = leadScope(req.user);
  const q = String(req.query.q ?? '');
  // Each person's inbox is their own number. Monitors can open any number's inbox.
  const monitor = req.user.permissions.includes('whatsapp.monitor');
  const mine = get<any>('SELECT id FROM wa_numbers WHERE user_id = ?', req.user.id);
  const chosen = Number(req.query.number) || null;
  if (chosen && !monitor && chosen !== mine?.id) throw new HttpError(403, 'You can only open your own inbox.');
  const numberId = chosen ?? (monitor ? null : mine?.id ?? null);
  const numberSql = numberId ? `AND (l.wa_number_id = ${Number(numberId)} ${chosen ? '' : 'OR l.owner_id = ' + Number(req.user.id)})` : '';
  const label = String(req.query.label ?? '');
  const filter = `${q ? 'AND (l.name LIKE ? OR l.phone LIKE ?)' : ''} ${numberSql} ${label ? 'AND l.labels LIKE ?' : ''}`;
  const lastDirection = `(SELECT direction FROM wa_messages m WHERE m.lead_id = l.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1)`;
  const unread = req.query.unread === '1' ? 'AND l.unread_count > 0' : req.query.awaiting === '1' ? `AND ${lastDirection} = 'in'` : '';
  const { owner, project, stage, temperature, source } = req.query;
  const more = leadFilters({ owner, project, stage, temperature, source });
  const from = String(req.query.message_from ?? '');
  const to = String(req.query.message_to ?? '');
  if (from) { more.where.push('datetime(l.last_message_at) >= datetime(?)'); more.params.push(from); }
  if (to) { more.where.push('datetime(l.last_message_at) <= datetime(?)'); more.params.push(to); }
  const rows = all<any>(
    `SELECT l.id, l.name, l.phone, l.stage, l.temperature, l.sentiment, l.labels, l.unread_count, l.last_message_at, l.last_inbound_at, u.name AS owner_name,
       (SELECT n.label FROM wa_numbers n WHERE n.id = l.wa_number_id) AS number_label,
       (SELECT body FROM wa_messages m WHERE m.lead_id = l.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
       (SELECT direction FROM wa_messages m WHERE m.lead_id = l.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_direction
     FROM leads l LEFT JOIN users u ON u.id = l.owner_id
     WHERE ${scope.sql} AND l.last_message_at IS NOT NULL ${filter} ${unread}${clauseSql(more)}
     ORDER BY l.last_message_at DESC LIMIT 100`,
    ...scope.params, ...(q ? [`%${q}%`, `%${q}%`] : []), ...(label ? [`%${JSON.stringify(label)}%`] : []), ...more.params,
  );
  const masked = phoneMasked(req.user);
  res.json({
    conversations: rows.map((r) => ({ ...r, labels: JSON.parse(r.labels), phone: masked ? maskPhone(r.phone) : r.phone, window_open: windowOpen(r) })),
  });
});

messaging.get('/inbox/:leadId', (req, res) => {
  const lead = visibleLead(req.user, Number(req.params.leadId));
  const messages = all(
    `SELECT m.id, m.direction, m.body, m.status, m.error, m.simulated, m.created_at, m.media_url, m.media_type, m.source, t.buttons, u.name AS sender FROM wa_messages m
     LEFT JOIN users u ON u.id = m.actor_id LEFT JOIN wa_templates t ON t.id = m.template_id WHERE m.lead_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 200`,
    lead.id,
  ).reverse();
  const project = lead.project_id ? get<any>('SELECT name, brochure_url FROM projects WHERE id = ?', lead.project_id) : null;
  // Reading someone else's chat to monitor it must not hide it from them as unread.
  if (!isViewOnly(req.user.role) && lead.owner_id === req.user.id && lead.unread_count) {
    run('UPDATE leads SET unread_count = 0 WHERE id = ?', lead.id);
    broadcast('inbox');
  }
  res.json({
    lead: {
      id: lead.id,
      name: lead.name,
      phone: phoneMasked(req.user) ? maskPhone(lead.phone) : lead.phone,
      stage: lead.stage,
      wa_opt_in: lead.wa_opt_in,
      wa_opted_out_at: lead.wa_opted_out_at,
      do_not_contact: lead.do_not_contact,
      owner_id: lead.owner_id,
      labels: JSON.parse(lead.labels),
      sentiment: lead.sentiment,
      intent: lead.intent,
    },
    brochure_url: project?.brochure_url ?? '',
    notes: all(
      `SELECT a.id, a.body, a.created_at, u.name AS sender FROM activities a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.lead_id = ? AND a.type = 'note' ORDER BY a.id DESC LIMIT 50`,
      lead.id,
    ),
    window_open: windowOpen(lead),
    blockers: sendBlockers(lead),
    messages,
  });
});

messaging.post('/inbox/:leadId/brochure', async (req, res) => {
  assertCan(req.user, 'whatsapp.send');
  const lead = workableLead(req.user, Number(req.params.leadId));
  const project = lead.project_id ? get<any>('SELECT name, brochure_url FROM projects WHERE id = ?', lead.project_id) : null;
  if (!project?.brochure_url) throw new HttpError(422, 'Add a brochure link to this project first.');
  res.status(201).json(await sendDocument(lead, project.brochure_url, `${project.name} brochure`, req.user.id));
});

messaging.post('/inbox/:leadId/text', async (req, res) => {
  assertCan(req.user, 'whatsapp.send');
  const lead = workableLead(req.user, Number(req.params.leadId));
  const { body } = z.object({ body: z.string().trim().min(1).max(4096) }).parse(req.body);
  res.status(201).json(await sendText(lead, body, req.user.id));
});

messaging.post('/inbox/:leadId/template', async (req, res) => {
  assertCan(req.user, 'whatsapp.send');
  const lead = workableLead(req.user, Number(req.params.leadId));
  const { template_id } = z.object({ template_id: z.number().int() }).parse(req.body);
  res.status(201).json(await sendTemplate(lead, template_id, req.user.id));
});

/** Demo only: lets a tester play the customer. Refuses to run when WhatsApp is live. */
messaging.post('/inbox/:leadId/simulate', requirePermission('settings.manage'), async (req, res) => {
  if (whatsappLive() || !config.demoMode) throw new HttpError(403, 'Simulation is only available in demo mode.');
  const lead = visibleLead(req.user, Number(req.params.leadId));
  const { body } = z.object({ body: z.string().trim().min(1).max(1000) }).parse(req.body);
  await receiveInbound({ phone: lead.phone, body, simulated: true, numberId: lead.wa_number_id });
  res.json({ ok: true });
});

/** Demo only: a brand-new contact writes in, so the chatbot can be tried. */
messaging.post('/inbox-simulate-new', requirePermission('settings.manage'), async (_req, res) => {
  if (whatsappLive() || !config.demoMode) throw new HttpError(403, 'Simulation is only available in demo mode.');
  const phone = `+9190099${String(randomInt(10000, 100000))}`;
  await receiveInbound({ phone, name: 'Sample WhatsApp Contact', body: 'Hi', simulated: true });
  res.status(201).json({ id: get<any>('SELECT id FROM leads WHERE phone = ?', phone)?.id });
});

// ---------- Templates ----------
messaging.get('/templates', (_req, res) => {
  res.json({ templates: all('SELECT * FROM wa_templates ORDER BY status, name'), variables: TEMPLATE_VARS });
});

const templateBody = z.object({
  name: z.string().regex(/^[a-z0-9_]{3,60}$/, 'Use lowercase letters, numbers and underscores only.'),
  category: z.enum(['MARKETING', 'UTILITY']),
  language: z.enum(['en', 'hi', 'mr']),
  body: z.string().trim().min(10).max(1024),
  header_type: z.enum(['NONE', 'IMAGE', 'DOCUMENT', 'VIDEO']).default('NONE'),
  header_url: z.union([z.url().startsWith('https://', 'Media links must start with https://.'), z.literal('')]).default(''),
  buttons: z.array(z.object({
    type: z.enum(['QUICK_REPLY', 'URL', 'PHONE_NUMBER']),
    text: z.string().trim().min(1).max(25, 'Button text can be 25 characters at most.'),
    value: z.string().trim().max(200).optional(),
  })).max(3, 'Use at most 3 buttons.').default([]),
}).superRefine((t, ctx) => {
  if (t.header_type !== 'NONE' && !t.header_url) ctx.addIssue({ code: 'custom', message: 'Add a link to the media.' });
  for (const b of t.buttons) {
    if (b.type === 'URL' && !/^https:\/\//.test(b.value ?? '')) ctx.addIssue({ code: 'custom', message: 'Website buttons need an https:// link.' });
    if (b.type === 'PHONE_NUMBER' && !/^\+\d{8,15}$/.test(b.value ?? '')) ctx.addIssue({ code: 'custom', message: 'Call buttons need a number like +919876543210.' });
  }
});

const assertVars = (body: string) => {
  const bad = templateVars(body).filter((v) => !(TEMPLATE_VARS as readonly string[]).includes(v));
  if (bad.length) throw new HttpError(400, `Unknown variable: {{${bad[0]}}}`);
};

messaging.post('/templates', requirePermission('template.manage'), (req, res) => {
  const b = templateBody.parse(req.body);
  assertVars(b.body);
  if (get('SELECT 1 AS x FROM wa_templates WHERE name = ?', b.name)) throw new HttpError(409, 'A template with this name already exists.');
  const r = run(
    'INSERT INTO wa_templates(name, category, language, body, header_type, header_url, buttons, created_by) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
    b.name, b.category, b.language, b.body, b.header_type, b.header_url, JSON.stringify(b.buttons), req.user.id,
  );
  audit(req, 'template.create', 'template', r.id, b.name);
  broadcast('templates');
  res.status(201).json({ id: r.id });
});

messaging.put('/templates/:id', requirePermission('template.manage'), (req, res) => {
  const t = get<any>('SELECT * FROM wa_templates WHERE id = ?', Number(req.params.id));
  if (!t) throw new HttpError(404, 'Template not found.');
  const b = templateBody.parse(req.body);
  assertVars(b.body);
  // Meta approves exact wording, so any edit needs fresh approval.
  run(
    `UPDATE wa_templates SET name = ?, category = ?, language = ?, body = ?, header_type = ?, header_url = ?, buttons = ?, status = 'draft' WHERE id = ?`,
    b.name, b.category, b.language, b.body, b.header_type, b.header_url, JSON.stringify(b.buttons), t.id,
  );
  audit(req, 'template.update', 'template', t.id, b.name);
  broadcast('templates');
  res.json({ ok: true });
});

messaging.post('/templates/:id/submit', requirePermission('template.manage'), async (req, res) => {
  const t = get<any>('SELECT * FROM wa_templates WHERE id = ?', Number(req.params.id));
  if (!t) throw new HttpError(404, 'Template not found.');
  const result = await submitTemplate(t);
  audit(req, 'template.submit', 'template', t.id, t.name);
  broadcast('templates');
  res.json(result);
});

// ---------- Campaigns ----------
const segmentSchema = z.object({
  project_id: z.number().int().nullish(),
  stages: z.array(z.enum(STAGES)).optional(),
  sources: z.array(z.enum(SOURCES)).optional(),
  temperature: z.array(z.enum(['Hot', 'Warm', 'Cold'])).optional(),
  labels: z.array(z.string().max(30)).optional(),
  budget_min: z.number().nullish(),
  budget_max: z.number().nullish(),
  inactive_days: z.number().int().positive().nullish(),
});

messaging.post('/campaigns/preview', requirePermission('campaign.create'), (req, res) => {
  const b = z.object({ segment: segmentSchema, template_id: z.number().int().nullish() }).parse(req.body);
  res.json(audiencePreview(b.segment, b.template_id ?? null, creatorLeadIds(req.user.id)));
});

messaging.get('/campaigns', requirePermission('campaign.create'), (req, res) => {
  // Staff see their own broadcasts. Approvers and monitors see everyone's.
  const everyone = req.user.permissions.includes('campaign.approve') || req.user.permissions.includes('whatsapp.monitor');
  const scope = everyone ? '' : 'WHERE c.created_by = ?';
  res.json({
    campaigns: all(
      `SELECT c.*, t.name AS template_name, t.category, p.name AS project_name, u.name AS created_by_name,
        (SELECT display_number FROM wa_numbers n WHERE n.id = c.number_id) AS number,
        (SELECT COUNT(*) FROM wa_messages m WHERE m.campaign_id = c.id) AS total,
        (SELECT COUNT(*) FROM wa_messages m WHERE m.campaign_id = c.id AND m.status IN ('sent','delivered','read')) AS sent,
        (SELECT COUNT(*) FROM wa_messages m WHERE m.campaign_id = c.id AND m.status IN ('delivered','read')) AS delivered,
        (SELECT COUNT(*) FROM wa_messages m WHERE m.campaign_id = c.id AND m.status = 'read') AS read,
        (SELECT COUNT(*) FROM wa_messages m WHERE m.campaign_id = c.id AND m.status = 'failed') AS failed,
        (SELECT COUNT(DISTINCT r.lead_id) FROM wa_messages r JOIN wa_messages m ON m.lead_id = r.lead_id AND m.campaign_id = c.id
           WHERE r.direction = 'in' AND r.created_at >= c.sent_at) AS replied,
        (SELECT COUNT(DISTINCT v.lead_id) FROM site_visits v JOIN wa_messages m ON m.lead_id = v.lead_id AND m.campaign_id = c.id
           WHERE v.created_at >= c.sent_at) AS visits,
        (SELECT COUNT(DISTINCT b.lead_id) FROM bookings b JOIN wa_messages m ON m.lead_id = b.lead_id AND m.campaign_id = c.id
           WHERE b.status = 'active' AND b.created_at >= c.sent_at) AS bookings,
        (SELECT MAX(m.simulated) FROM wa_messages m WHERE m.campaign_id = c.id) AS simulated
       FROM wa_campaigns c JOIN wa_templates t ON t.id = c.template_id LEFT JOIN projects p ON p.id = c.project_id
       LEFT JOIN users u ON u.id = c.created_by ${scope} ORDER BY c.id DESC`,
      ...(everyone ? [] : [req.user.id]),
    ),
  });
});

messaging.post('/campaigns', requirePermission('campaign.create'), (req, res) => {
  const b = z.object({
    name: z.string().trim().min(3).max(100),
    template_id: z.number().int(),
    project_id: z.number().int().nullish(),
    segment: segmentSchema,
    scheduled_at: z.string().nullish(),
  }).parse(req.body);
  const own = get<any>(`SELECT id FROM wa_numbers WHERE user_id = ? AND status = 'active'`, req.user.id);
  const r = run(
    `INSERT INTO wa_campaigns(name, template_id, project_id, segment, status, scheduled_at, created_by, number_id) VALUES(?, ?, ?, ?, 'pending_approval', ?, ?, ?)`,
    b.name, b.template_id, b.project_id ?? null, JSON.stringify(b.segment), b.scheduled_at ?? null, req.user.id, own?.id ?? null,
  );
  audit(req, 'campaign.create', 'campaign', r.id, b.name);
  if (req.user.permissions.includes('campaign.direct')) {
    const later = b.scheduled_at && b.scheduled_at > nowIso();
    const queued = later ? 0 : queueCampaign(r.id);
    run(`UPDATE wa_campaigns SET approved_by = ?, status = CASE WHEN status = 'sending' THEN 'sending' ELSE 'approved' END WHERE id = ?`, req.user.id, r.id);
    audit(req, 'campaign.direct', 'campaign', r.id, `${b.name}: ${queued} queued`);
    broadcast('campaigns');
    return res.status(201).json({ id: r.id, queued, direct: true });
  }
  const approvers = all<any>(`SELECT id, role FROM users WHERE status = 'active'`).filter((u) => permissionsFor(u.id, u.role).includes('campaign.approve'));
  for (const a of approvers) {
    if (a.id !== req.user.id) notify(a.id, 'Broadcast needs approval', b.name, '/campaigns');
  }
  broadcast('campaigns');
  res.status(201).json({ id: r.id });
});

messaging.post('/campaigns/:id/approve', requirePermission('campaign.approve'), (req, res) => {
  const c = get<any>('SELECT * FROM wa_campaigns WHERE id = ?', Number(req.params.id));
  if (!c) throw new HttpError(404, 'Campaign not found.');
  if (c.status !== 'pending_approval') throw new HttpError(409, 'This campaign is not awaiting approval.');
  const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
  if (!approve) {
    run(`UPDATE wa_campaigns SET status = 'rejected', approved_by = ? WHERE id = ?`, req.user.id, c.id);
    audit(req, 'campaign.reject', 'campaign', c.id, c.name);
    notify(c.created_by, 'Campaign rejected', c.name, '/campaigns');
    broadcast('campaigns');
    return res.json({ ok: true });
  }
  const later = c.scheduled_at && c.scheduled_at > nowIso();
  // Queue first: if a compliance check fails, the campaign stays pending for correction.
  const queued = later ? 0 : queueCampaign(c.id);
  run(`UPDATE wa_campaigns SET approved_by = ?, status = CASE WHEN status = 'sending' THEN 'sending' ELSE 'approved' END WHERE id = ?`, req.user.id, c.id);
  audit(req, 'campaign.approve', 'campaign', c.id, `${c.name}: ${queued} queued`);
  notify(c.created_by, 'Campaign approved', c.name, '/campaigns');
  broadcast('campaigns');
  res.json({ ok: true, queued });
});

