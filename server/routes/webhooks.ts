import { timingSafeEqual } from 'node:crypto';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import { config } from '../config.ts';
import { get } from '../db.ts';
import { ingestLead } from '../services/leads.ts';
import { pullMetaLead } from '../services/metaLeads.ts';
import { finishCall } from '../services/telephony.ts';
import { handleWebhook, sendAutomation, verifySignature } from '../services/whatsapp.ts';
import { audit } from '../services/core.ts';
import { report, review, snapshot, syncInsights } from '../services/marketing/pipeline.ts';
import { featureOn } from '../services/workplace.ts';

export const webhooks = Router();

const raw = (req: Request) => (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);

function assertMetaSignature(req: Request) {
  if (!verifySignature(raw(req), req.header('x-hub-signature-256'))) throw new HttpError(401, 'Invalid signature.');
}

const verifyHandshake = (req: Request) => {
  const q = req.query as Record<string, string>;
  if (q['hub.mode'] === 'subscribe' && config.whatsapp.verifyToken && q['hub.verify_token'] === config.whatsapp.verifyToken) {
    return q['hub.challenge'] ?? '';
  }
  throw new HttpError(403, 'Verification failed.');
};

// ---------- WhatsApp ----------
webhooks.get('/whatsapp', (req, res) => {
  res.type('text/plain').send(verifyHandshake(req));
});

webhooks.post('/whatsapp', async (req, res) => {
  assertMetaSignature(req);
  await handleWebhook(req.body);
  res.sendStatus(200);
});

async function welcome(leadId: number) {
  const lead = get<any>('SELECT * FROM leads WHERE id = ?', leadId);
  if (lead) await sendAutomation('welcome', lead).catch((e) => console.error('Welcome message failed:', e.message));
}

// ---------- Website enquiry form ----------
const websiteLead = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string().min(8).max(20),
  email: z.union([z.email(), z.literal('')]).optional(),
  message: z.string().max(2000).optional(),
  project: z.string().max(100).optional(),
  utm_source: z.string().max(100).optional(),
  utm_campaign: z.string().max(100).optional(),
  whatsapp_consent: z.boolean().optional(),
});

webhooks.post('/website', async (req, res) => {
  const expected = Buffer.from(config.websiteApiKey);
  const given = Buffer.from(req.header('x-api-key') ?? '');
  if (!expected.length) throw new HttpError(503, 'Website form is not connected yet.');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Invalid API key.');
  const b = websiteLead.parse(req.body);
  const project = b.project ? get<any>('SELECT id FROM projects WHERE name = ? COLLATE NOCASE', b.project) : undefined;
  const result = ingestLead({
    name: b.name,
    phone: b.phone,
    email: b.email,
    source: 'Website',
    project_id: project?.id,
    notes: b.message,
    utm_source: b.utm_source,
    utm_campaign: b.utm_campaign,
    wa_opt_in: b.whatsapp_consent === true,
    wa_opt_in_source: 'Website enquiry form',
  });
  if (result.created) await welcome(result.id);
  res.status(result.created ? 201 : 200).json({ id: result.id, duplicate: result.duplicate });
});

// ---------- Property portals ----------
const PORTALS: Record<string, string> = { '99acres': '99acres', magicbricks: 'MagicBricks', housing: 'Housing.com' };

/** Portals name their fields differently, so each field accepts the common spellings. */
function pick(body: Record<string, unknown>, ...names: string[]) {
  const lower = Object.fromEntries(Object.entries(body).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const value = lower[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

webhooks.post('/portal/:source', express.urlencoded({ extended: false }), async (req, res) => {
  const expected = Buffer.from(config.portalApiKey);
  const given = Buffer.from(req.header('x-api-key') ?? String(req.query.key ?? ''));
  if (!expected.length) throw new HttpError(503, 'Portal leads are not connected yet.');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Invalid API key.');
  const source = PORTALS[String(req.params.source).toLowerCase()];
  if (!source) throw new HttpError(404, 'Unknown portal.');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = pick(body, 'name', 'lead_name', 'contact_name', 'customer_name', 'buyer_name', 'full_name');
  const phone = pick(body, 'phone', 'mobile', 'mobile_number', 'contact_number', 'contact_no', 'phone_number');
  if (!name || !phone) throw new HttpError(400, 'Name and phone are required.');
  const projectName = pick(body, 'project', 'project_name', 'property_name', 'property');
  const project = projectName ? get<any>('SELECT id FROM projects WHERE name = ? COLLATE NOCASE', projectName) : undefined;
  const result = ingestLead({
    name,
    phone,
    email: pick(body, 'email', 'email_id', 'contact_email'),
    source,
    project_id: project?.id,
    notes: pick(body, 'message', 'query', 'remarks', 'comments') || (projectName ? `Enquired about ${projectName}` : ''),
  });
  res.status(result.created ? 201 : 200).json({ id: result.id, duplicate: result.duplicate });
});

// ---------- Google Ads lead forms ----------
webhooks.post('/google-ads', async (req, res) => {
  const b = req.body ?? {};
  const expected = Buffer.from(config.googleAdsKey);
  const given = Buffer.from(String(b.google_key ?? ''));
  if (!expected.length) throw new HttpError(503, 'Google Ads leads are not connected yet.');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Invalid key.');
  const field = (...ids: string[]) =>
    (b.user_column_data ?? []).find((c: any) => ids.includes(String(c.column_id)))?.string_value?.trim() ?? '';
  const name = field('FULL_NAME') || `${field('FIRST_NAME')} ${field('LAST_NAME')}`.trim();
  const phone = field('PHONE_NUMBER');
  // Google sends an empty test lead when you click "Send test data".
  if (b.is_test && !phone) return res.json({ ok: true, test: true });
  const result = ingestLead({
    name: name || 'Google Ads Lead',
    phone,
    email: field('EMAIL'),
    source: 'Google Ads',
    utm_source: 'google',
    utm_campaign: String(b.campaign_id ?? ''),
  });
  if (result.created) await welcome(result.id);
  res.status(result.created ? 201 : 200).json({ id: result.id, duplicate: result.duplicate });
});

// ---------- Telephony ----------
webhooks.post('/telephony/:token', express.urlencoded({ extended: false }), (req, res) => {
  const expected = Buffer.from(config.exotel.webhookToken);
  const given = Buffer.from(String(req.params.token));
  if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Invalid token.');
  const b = req.body ?? {};
  const duration = Number(b.ConversationDuration ?? b.Duration ?? b.DialCallDuration);
  finishCall(String(b.CallSid ?? ''), String(b.Status ?? 'failed'), Number.isFinite(duration) ? duration : null, String(b.RecordingUrl ?? ''));
  res.sendStatus(200);
});

// ---------- n8n automation ----------
// n8n may ask the AI team to do its read-and-report work. It can never approve or change a campaign.
webhooks.post('/automation/marketing', async (req, res) => {
  const expected = Buffer.from(config.automation.key);
  const given = Buffer.from(req.header('x-api-key') ?? '');
  if (!expected.length) throw new HttpError(503, 'Automation is not connected yet.');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Invalid API key.');
  if (!featureOn('marketing')) throw new HttpError(404, 'The AI marketing team is switched off.');
  const { job } = z.object({ job: z.enum(['sync', 'review', 'daily', 'weekly', 'monthly', 'status']) }).parse(req.body);
  audit(null, 'marketing.automation', 'mkt_report', '', job);
  if (job === 'sync') return res.json(await syncInsights());
  if (job === 'review') { const r = await review(7); return res.json({ headline: r.analysis.headline, proposed: r.proposed, simulated: r.simulated }); }
  if (job === 'status') { const s = snapshot(1); return res.json({ totals: s.totals, pipeline: s.pipeline, simulated: s.simulated }); }
  const r = await report(job);
  res.json({ title: r.title, status: r.status, urgent: r.urgent, next_priorities: r.next_priorities, totals: r.totals, pipeline: r.pipeline, approval_required: r.approval_required.length, simulated: r.simulated });
});

// ---------- Meta Lead Ads ----------
webhooks.get('/meta-leads', (req, res) => {
  res.type('text/plain').send(verifyHandshake(req));
});

webhooks.post('/meta-leads', async (req, res) => {
  assertMetaSignature(req);
  res.sendStatus(200); // Meta expects a fast answer; failures are logged.
  for (const entry of req.body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'leadgen') continue;
      try {
        await pullMetaLead(String(change.value.leadgen_id), change.value.page_id ? String(change.value.page_id) : undefined);
      } catch (e) {
        console.error('Meta lead failed:', (e as Error).message);
      }
    }
  }
});
