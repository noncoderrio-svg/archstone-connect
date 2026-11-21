import { Router } from 'express';
import { z } from 'zod';
import { HttpError, requirePermission } from '../auth.ts';
import { config } from '../config.ts';
import { all, get, run, setSetting } from '../db.ts';
import { audit } from '../services/core.ts';
import { AGENTS } from '../services/marketing/agents.ts';
import { MARKET_KNOWLEDGE, companyNotes } from '../services/marketing/knowledge.ts';
import { brain } from '../services/marketing/llm.ts';
import { adsLive, adsSimulated, checkAds } from '../services/marketing/metaAds.ts';
import { ask, decide, planBrief, report, requestSwitch, review, snapshot, syncInsights } from '../services/marketing/pipeline.ts';
import { assertFeature } from '../services/workplace.ts';

export const marketing = Router();
const use = requirePermission('marketing.use');
const approve = requirePermission('marketing.approve');

marketing.use('/marketing', (_req, _res, next) => { assertFeature('marketing'); next(); });

const json = (text: string) => { try { return JSON.parse(text); } catch { return {}; } };

/** The team, what each agent last did, and what is connected. */
marketing.get('/marketing/team', use, (_req, res) => {
  const last = all<any>(`SELECT agent, status, provider, model, simulated, error, created_at FROM mkt_runs WHERE id IN (SELECT MAX(id) FROM mkt_runs GROUP BY agent)`);
  const counts = all<any>('SELECT agent, COUNT(*) AS runs FROM mkt_runs GROUP BY agent');
  res.json({
    agents: AGENTS.map((a) => ({ ...a, uses: a.brain === 'rules' ? 'rules' : brain(a.brain), runs: counts.find((c) => c.agent === a.key)?.runs ?? 0, last: last.find((l) => l.agent === a.key) ?? null })),
    connections: {
      claude: Boolean(config.anthropic.key), gemini: Boolean(config.gemini.key),
      meta_ads: adsLive(), meta_ads_simulated: adsSimulated(), meta_leads: Boolean(get('SELECT 1 AS x FROM meta_pages WHERE enabled = 1')) || Boolean(config.metaPageToken),
      n8n: Boolean(config.automation.key), demo: config.demoMode,
    },
    pending: get<{ n: number }>(`SELECT COUNT(*) n FROM mkt_actions WHERE status = 'pending'`)!.n,
  });
});

/** A read-only test against Meta: nothing is created or changed. */
marketing.post('/marketing/check-meta', approve, async (req, res) => {
  const result = await checkAds();
  audit(req, 'marketing.check_meta', 'settings', '', result.account);
  res.json(result);
});

// ---------- What the team knows ----------
marketing.get('/marketing/knowledge', use, (_req, res) => res.json({ built_in: MARKET_KNOWLEDGE, notes: companyNotes() }));

marketing.put('/marketing/knowledge', approve, (req, res) => {
  const { notes } = z.object({ notes: z.string().max(8000) }).parse(req.body);
  setSetting('mkt_company_notes', notes.trim());
  audit(req, 'marketing.knowledge', 'settings', '', `${notes.trim().length} characters`);
  res.json({ ok: true });
});

// ---------- Briefs and drafts ----------
marketing.get('/marketing/briefs', use, (_req, res) => {
  res.json({
    briefs: all<any>(`SELECT b.*, p.name AS project FROM mkt_briefs b JOIN projects p ON p.id = b.project_id ORDER BY b.id DESC LIMIT 100`),
    projects: all<any>(`SELECT id, name, location, (rera_number != '') AS has_rera FROM projects ORDER BY name`),
  });
});

marketing.post('/marketing/briefs', use, (req, res) => {
  const b = z.object({
    project_id: z.number().int(),
    title: z.string().trim().min(3).max(80),
    goal: z.string().trim().max(300).default(''),
    budget_inr: z.number().min(1000, 'The budget must be at least ₹1,000.').max(50_000_000),
    days: z.number().int().min(3).max(90),
    notes: z.string().trim().max(2000).default(''),
  }).parse(req.body);
  if (!get('SELECT 1 AS x FROM projects WHERE id = ?', b.project_id)) throw new HttpError(404, 'Project not found.');
  const { id } = run('INSERT INTO mkt_briefs(project_id, title, goal, budget_inr, days, notes, created_by) VALUES(?, ?, ?, ?, ?, ?, ?)', b.project_id, b.title, b.goal, b.budget_inr, b.days, b.notes, req.user.id);
  audit(req, 'marketing.brief', 'mkt_brief', id, `${b.title}, ₹${b.budget_inr}`);
  res.status(201).json({ id });
});

/** Starts the team on a brief. The work continues in the background; the screen follows it live. */
marketing.post('/marketing/briefs/:id/plan', use, (req, res) => {
  const id = Number(req.params.id);
  const brief = get<any>('SELECT status FROM mkt_briefs WHERE id = ?', id);
  if (!brief) throw new HttpError(404, 'Brief not found.');
  if (brief.status === 'planning') throw new HttpError(409, 'The team is already working on this brief.');
  if (get(`SELECT 1 AS x FROM mkt_plans WHERE brief_id = ? AND status NOT IN ('draft','blocked')`, id)) throw new HttpError(409, 'This campaign is already in Meta. Write a new brief for a new campaign.');
  run(`DELETE FROM mkt_actions WHERE status = 'pending' AND plan_id IN (SELECT id FROM mkt_plans WHERE brief_id = ?)`, id);
  audit(req, 'marketing.plan', 'mkt_brief', id);
  void planBrief(id).catch((e) => console.error('Marketing plan failed:', (e as Error).message));
  res.status(202).json({ ok: true });
});

marketing.get('/marketing/briefs/:id', use, (req, res) => {
  const id = Number(req.params.id);
  const brief = get<any>(`SELECT b.*, p.name AS project FROM mkt_briefs b JOIN projects p ON p.id = b.project_id WHERE b.id = ?`, id);
  if (!brief) throw new HttpError(404, 'Brief not found.');
  // The newest answer from each agent for this brief.
  const runs = all<any>(`SELECT * FROM mkt_runs WHERE id IN (SELECT MAX(id) FROM mkt_runs WHERE brief_id = ? GROUP BY agent) ORDER BY id`, id);
  const plan = get<any>('SELECT * FROM mkt_plans WHERE brief_id = ? ORDER BY id DESC LIMIT 1', id);
  res.json({
    brief,
    work: runs.map((r) => ({ agent: r.agent, status: r.status, provider: r.provider, model: r.model, simulated: Boolean(r.simulated), error: r.error, at: r.created_at, output: json(r.output) })),
    plan: plan ? { ...plan, payload: json(plan.payload), issues: json(plan.issues), meta_ids: undefined, simulated: Boolean(plan.simulated) } : null,
  });
});

marketing.delete('/marketing/briefs/:id', use, (req, res) => {
  const id = Number(req.params.id);
  if (get(`SELECT 1 AS x FROM mkt_plans WHERE brief_id = ? AND status NOT IN ('draft','blocked')`, id)) throw new HttpError(409, 'This campaign is in Meta, so its record is kept.');
  run('DELETE FROM mkt_briefs WHERE id = ?', id);
  audit(req, 'marketing.brief_delete', 'mkt_brief', id);
  res.json({ ok: true });
});

// ---------- Approvals ----------
marketing.get('/marketing/actions', use, (req, res) => {
  const rows = all<any>(`SELECT a.*, u.name AS reviewer FROM mkt_actions a LEFT JOIN users u ON u.id = a.reviewed_by ORDER BY (a.status = 'pending') DESC, a.id DESC LIMIT 100`);
  res.json({ actions: rows.map((a) => ({ ...a, payload: json(a.payload) })), can_approve: req.user.permissions.includes('marketing.approve') });
});

marketing.post('/marketing/actions/:id', approve, async (req, res) => {
  const { approve: yes } = z.object({ approve: z.boolean() }).parse(req.body);
  const id = Number(req.params.id);
  const before = get<any>('SELECT kind, campaign FROM mkt_actions WHERE id = ?', id);
  try {
    const out = await decide(id, yes, req.user.id);
    audit(req, yes ? 'marketing.approve' : 'marketing.reject', 'mkt_action', id, `${before?.kind} ${before?.campaign}: ${out.result}`.slice(0, 200));
    res.json(out);
  } catch (e) {
    audit(req, 'marketing.action_failed', 'mkt_action', id, `${before?.kind} ${before?.campaign}: ${(e as Error).message}`.slice(0, 200));
    throw e;
  }
});

/** Asks to switch a campaign on or off. It still needs an approval before anything happens. */
marketing.post('/marketing/plans/:id/switch', use, (req, res) => {
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  const id = requestSwitch(Number(req.params.id), on);
  audit(req, 'marketing.request_switch', 'mkt_plan', String(req.params.id), on ? 'on' : 'off');
  res.status(201).json({ id });
});

marketing.get('/marketing/plans', use, (_req, res) => {
  res.json({ plans: all<any>(`SELECT id, brief_id, name, status, simulated, meta_campaign_id, updated_at FROM mkt_plans WHERE status NOT IN ('draft','blocked') ORDER BY id DESC`) });
});

// ---------- Results, review and reports ----------
const days = (v: unknown) => Math.min(90, Math.max(1, Number(v) || 7));

marketing.get('/marketing/performance', use, (req, res) => res.json(snapshot(days(req.query.days))));

marketing.post('/marketing/sync', use, async (req, res) => {
  const out = await syncInsights();
  audit(req, 'marketing.sync', 'mkt_insights', '', `${out.rows} rows`);
  res.json(out);
});

marketing.post('/marketing/review', use, async (req, res) => {
  const out = await review(days(req.body?.days));
  audit(req, 'marketing.review', 'mkt_insights', '', `${out.proposed} suggestions`);
  res.json(out);
});

marketing.get('/marketing/reports', use, (_req, res) => {
  res.json({ reports: all<any>('SELECT * FROM mkt_reports ORDER BY id DESC LIMIT 30').map((r) => ({ ...r, data: json(r.data), simulated: Boolean(r.simulated) })) });
});

marketing.post('/marketing/reports', use, async (req, res) => {
  const { period } = z.object({ period: z.enum(['daily', 'weekly', 'monthly']) }).parse(req.body);
  const out = await report(period);
  audit(req, 'marketing.report', 'mkt_report', out.id, period);
  res.status(201).json(out);
});

marketing.post('/marketing/ask', use, async (req, res) => {
  const { question } = z.object({ question: z.string().trim().min(5).max(400) }).parse(req.body);
  audit(req, 'marketing.ask', 'mkt_report', '', question.slice(0, 120));
  res.json(await ask(question));
});
