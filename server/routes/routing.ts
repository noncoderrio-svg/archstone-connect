import { Router } from 'express';
import { z } from 'zod';
import { HttpError, requirePermission } from '../auth.ts';
import { config } from '../config.ts';
import { all, get, minutesFromNow, run, setSetting, tx } from '../db.ts';
import { audit, broadcast } from '../services/core.ts';
import { assignLead } from '../services/leads.ts';
import { FUNNEL, feedbackSettings, feedbackStats, sendFeedback } from '../services/metaFeedback.ts';
import { checkMetaPage, syncPage } from '../services/metaLeads.ts';
import { matchRoute, nextFromRoute, routeMatches, type Route } from '../services/routing.ts';
import { encryptText } from '../services/secrets.ts';

export const routing = Router();
const manage = requirePermission('settings.manage');

const ruleBody = z.object({
  name: z.string().trim().min(3).max(80),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(9999).default(100),
  match_source: z.string().trim().max(60).default(''),
  match_campaign: z.string().trim().max(120).default(''),
  match_adset: z.string().trim().max(120).default(''),
  match_ad: z.string().trim().max(120).default(''),
  match_form: z.string().trim().max(120).default(''),
  project_id: z.number().int().nullish(),
  user_ids: z.array(z.number().int()).min(1, 'Choose at least one person.').max(100),
  mode: z.enum(['round_robin', 'workload']).default('round_robin'),
}).refine((b) => b.match_source || b.match_campaign || b.match_adset || b.match_ad || b.match_form, { message: 'Enter at least one thing to match, such as a campaign name.' });

const saved = (r: Route & { enabled: number }) => ({ ...r, user_ids: JSON.parse(r.user_ids) as number[] });

routing.get('/routing', manage, (_req, res) => {
  const since = minutesFromNow(-30 * 1440);
  const routes = all<any>('SELECT * FROM lead_routes ORDER BY priority, id');
  const rows = all<any>(
    `SELECT l.utm_campaign AS campaign, l.source, COUNT(*) AS leads, MAX(l.created_at) AS last_at,
       SUM(l.owner_id IS NULL) AS unassigned,
       SUM(l.stage IN ('Site Visit Scheduled','Site Visit Done','Working Deal','Booked')) AS visits,
       SUM(l.stage = 'Booked') AS booked
     FROM leads l WHERE l.deleted_at IS NULL AND l.utm_campaign != '' AND l.created_at >= ?
     GROUP BY l.utm_campaign, l.source ORDER BY last_at DESC LIMIT 200`,
    since,
  );
  const people = all<any>(
    `SELECT l.utm_campaign AS campaign, u.name, COUNT(*) AS leads FROM leads l JOIN users u ON u.id = l.owner_id
     WHERE l.deleted_at IS NULL AND l.utm_campaign != '' AND l.created_at >= ? GROUP BY l.utm_campaign, u.id ORDER BY leads DESC`,
    since,
  );
  const active = routes.filter((r) => r.enabled);
  const names = new Map(all<any>('SELECT id, name FROM users').map((u) => [u.id, u.name]));
  res.json({
    rules: routes.map((r) => ({ ...saved(r), people: (JSON.parse(r.user_ids) as number[]).map((id) => names.get(id) ?? 'Removed') })),
    campaigns: rows.map((c) => ({
      ...c,
      rule: active.find((r) => routeMatches(r, { source: c.source, utm_campaign: c.campaign }))?.name ?? null,
      people: people.filter((p) => p.campaign === c.campaign).slice(0, 6).map((p) => ({ name: p.name, leads: p.leads })),
    })),
    pages: all<any>('SELECT id, page_id, name, enabled, last_sync_at, last_error, leads_pulled FROM meta_pages ORDER BY name'),
    webhook_url: `${config.appUrl}/webhooks/meta-leads`,
    webhook_ready: Boolean(config.whatsapp.verifyToken && config.whatsapp.appSecret),
    unassigned: get<{ n: number }>('SELECT COUNT(*) n FROM leads WHERE owner_id IS NULL AND deleted_at IS NULL')!.n,
  });
});

routing.post('/routing/rules', manage, (req, res) => {
  const b = ruleBody.parse(req.body);
  const { id } = run(
    `INSERT INTO lead_routes(name, enabled, priority, match_source, match_campaign, match_adset, match_ad, match_form, project_id, user_ids, mode) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    b.name, b.enabled ? 1 : 0, b.priority, b.match_source, b.match_campaign, b.match_adset, b.match_ad, b.match_form, b.project_id ?? null, JSON.stringify(b.user_ids), b.mode,
  );
  audit(req, 'routing.create', 'lead_route', id, b.name);
  res.status(201).json({ id });
});

routing.put('/routing/rules/:id', manage, (req, res) => {
  const b = ruleBody.parse(req.body);
  run(
    `UPDATE lead_routes SET name = ?, enabled = ?, priority = ?, match_source = ?, match_campaign = ?, match_adset = ?, match_ad = ?, match_form = ?, project_id = ?, user_ids = ?, mode = ? WHERE id = ?`,
    b.name, b.enabled ? 1 : 0, b.priority, b.match_source, b.match_campaign, b.match_adset, b.match_ad, b.match_form, b.project_id ?? null, JSON.stringify(b.user_ids), b.mode, Number(req.params.id),
  );
  audit(req, 'routing.update', 'lead_route', String(req.params.id), b.name);
  res.json({ ok: true });
});

routing.delete('/routing/rules/:id', manage, (req, res) => {
  run('DELETE FROM lead_routes WHERE id = ?', Number(req.params.id));
  audit(req, 'routing.delete', 'lead_route', String(req.params.id));
  res.json({ ok: true });
});

/** Shares out leads already waiting, using the same rules as new ones. */
routing.post('/routing/apply', manage, (req, res) => {
  const waiting = all<any>('SELECT * FROM leads WHERE owner_id IS NULL AND deleted_at IS NULL ORDER BY created_at LIMIT 1000');
  let assigned = 0;
  tx(() => {
    for (const lead of waiting) {
      const route = matchRoute(lead);
      const person = route && nextFromRoute(route);
      if (!route || !person) continue;
      assignLead(lead.id, person.id, req.user.id, `Rule: ${route.name}`);
      if (route.project_id && !lead.project_id) run('UPDATE leads SET project_id = ? WHERE id = ?', route.project_id, lead.id);
      assigned += 1;
    }
  });
  audit(req, 'routing.apply', 'lead', '', `${assigned} leads`);
  broadcast('leads');
  res.json({ assigned, waiting: waiting.length - assigned });
});

// ---------- Meta lead feedback ----------
routing.get('/routing/feedback', manage, (_req, res) => {
  const { token, ...settings } = feedbackSettings();
  res.json({ settings: { ...settings, has_token: Boolean(token) }, stats: feedbackStats(), funnel: [...FUNNEL, 'Unqualified', 'Lost'] });
});

routing.put('/routing/feedback', manage, (req, res) => {
  const b = z.object({
    enabled: z.boolean(),
    dataset_id: z.string().trim().regex(/^\d*$/, 'The Dataset ID contains only numbers.').max(30),
    token: z.string().trim().max(1000).optional(),
    test_event_code: z.string().trim().max(40).default(''),
    target: z.string().max(40),
    mapping: z.record(z.string(), z.string().trim().max(40)),
    privacy_confirmed: z.boolean(),
  }).parse(req.body);
  const current = feedbackSettings();
  const token = b.token ? encryptText(b.token) : current.token;
  if (b.enabled && (!b.dataset_id || !token)) throw new HttpError(400, 'Add your Dataset ID and access token first.');
  if (b.enabled && !b.privacy_confirmed) throw new HttpError(400, 'Confirm your privacy notice covers this first.');
  setSetting('meta_feedback', { ...b, token });
  audit(req, 'meta_feedback.update', 'settings', '', b.enabled ? 'on' : 'off');
  res.json({ ok: true });
});

routing.post('/routing/feedback/send', manage, async (req, res) => {
  const settings = feedbackSettings();
  if (!settings.enabled) throw new HttpError(400, 'Turn on Meta feedback first.');
  const result = await sendFeedback(true);
  audit(req, 'meta_feedback.send', 'settings', '', `${result.sent} sent, ${result.failed} failed`);
  res.json(result);
});

// ---------- Meta pages ----------
const pageBody = z.object({ page_id: z.string().trim().regex(/^\d{5,30}$/, 'Enter the numeric Facebook Page ID.'), token: z.string().trim().min(20).max(1000) });

routing.post('/meta-pages', manage, async (req, res) => {
  const b = pageBody.parse(req.body);
  if (get('SELECT 1 AS x FROM meta_pages WHERE page_id = ?', b.page_id)) throw new HttpError(409, 'This page is already connected.');
  let name = '';
  try {
    name = (await checkMetaPage(b.page_id, b.token)).name ?? b.page_id;
  } catch (e) {
    throw new HttpError(400, `Meta refused this page: ${(e as Error).message}`);
  }
  const { id } = run('INSERT INTO meta_pages(page_id, name, token) VALUES(?, ?, ?)', b.page_id, name, encryptText(b.token));
  audit(req, 'meta_page.connect', 'meta_page', id, name);
  res.status(201).json({ id, name });
});

routing.delete('/meta-pages/:id', manage, (req, res) => {
  run('DELETE FROM meta_pages WHERE id = ?', Number(req.params.id));
  audit(req, 'meta_page.remove', 'meta_page', String(req.params.id));
  res.json({ ok: true });
});

routing.post('/meta-pages/:id/sync', manage, async (req, res) => {
  const page = get<any>('SELECT * FROM meta_pages WHERE id = ?', Number(req.params.id));
  if (!page) throw new HttpError(404, 'Page not found.');
  try {
    res.json({ saved: await syncPage(page) });
  } catch (e) {
    const message = (e as Error).message.slice(0, 200);
    run('UPDATE meta_pages SET last_error = ? WHERE id = ?', message, page.id);
    throw new HttpError(502, `Meta refused the request: ${message}`);
  }
});
