// Runs the AI marketing team. Agents may read, think, draft and suggest on their own.
// Anything that touches Meta or money becomes an action that waits for a person.
import { HttpError } from '../../auth.ts';
import { config } from '../../config.ts';
import { all, get, getSetting, minutesFromNow, nowIso, run, setSetting } from '../../db.ts';
import { broadcast, notify } from '../core.ts';
import { featureOn } from '../workplace.ts';
import { systemPrompt } from './knowledge.ts';
import {
  analystSchema, answerSchema, audienceSchema, creativeSchema, directorSchema, optimizerSchema, prompts, reporterSchema, samples, strategistSchema,
  type AgentKey, type Analyst, type Audience, type Creative, type Director, type Facts, type Optimizer, type Strategist,
} from './agents.ts';
import { IMAGE_RULE, blocked, checkCopy, safeTargeting, withRera, type Issue } from './compliance.ts';
import { generate, type Answer } from './llm.ts';
import { adsLive, adsSimulated, createPaused, fetchInsights, readBudgets, sampleInsights, setDailyBudget, setStatus, type PlanPayload } from './metaAds.ts';

const MAX_BUDGET_STEP = 20; // Percent. Larger jumps restart Meta's learning, and cost more if wrong.
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dayAgo = (n: number) => new Date(Date.now() + 330 * 60000 - n * 86400000).toISOString().slice(0, 10);
const round = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;

// ---------- Running one agent, and keeping a record of it ----------
async function work<T>(agent: AgentKey, briefId: number | null, fn: () => Promise<Answer<T>>): Promise<T> {
  const started = Date.now();
  try {
    const a = await fn();
    run('INSERT INTO mkt_runs(brief_id, agent, status, output, provider, model, simulated, ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?)', briefId, agent, 'ok', JSON.stringify(a.data), a.provider, a.model, a.simulated ? 1 : 0, Date.now() - started);
    return a.data;
  } catch (e) {
    run('INSERT INTO mkt_runs(brief_id, agent, status, error, ms) VALUES(?, ?, ?, ?, ?)', briefId, agent, 'failed', (e as Error).message.slice(0, 300), Date.now() - started);
    throw e;
  } finally {
    broadcast('marketing');
  }
}

const marketers = () => all<{ id: number }>(`SELECT id FROM users WHERE role = 'admin' AND status = 'active'`);

/** Tells n8n what happened, with totals only. Customer names and numbers never leave the CRM here. */
function emit(type: string, payload: Record<string, unknown>) {
  if (!config.automation.eventsUrl) return;
  void fetch(config.automation.eventsUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, at: nowIso(), ...payload }), signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

// ---------- Planning a campaign from a brief ----------
function factsFor(brief: any): Facts {
  const p = get<any>('SELECT * FROM projects WHERE id = ?', brief.project_id);
  if (!p) throw new HttpError(404, 'Project not found.');
  const h = get<any>(
    `SELECT COUNT(*) AS leads,
       SUM(stage NOT IN ('Not Contacted','Contacted','Unqualified','Did Not Respond','Lost')) AS qualified,
       SUM(stage IN ('Site Visit Done','Working Deal','Booked')) AS visits, SUM(stage = 'Booked') AS booked
     FROM leads WHERE deleted_at IS NULL AND source = 'Meta Ads' AND project_id = ? AND created_at >= ?`,
    p.id, minutesFromNow(-90 * 1440),
  )!;
  const lost = all<{ r: string }>(`SELECT lost_reason AS r FROM leads WHERE project_id = ? AND stage = 'Lost' AND lost_reason != '' GROUP BY lost_reason ORDER BY COUNT(*) DESC LIMIT 3`, p.id);
  return {
    project: { name: p.name, location: p.location, configuration: p.configuration, type: p.type, price_from_lakhs: p.price_from_lakhs, rera_number: p.rera_number },
    brief: { title: brief.title, goal: brief.goal, budget_inr: brief.budget_inr, days: brief.days, notes: brief.notes },
    history: { meta_leads_90d: h.leads ?? 0, qualified: h.qualified ?? 0, visits: h.visits ?? 0, booked: h.booked ?? 0, top_lost_reasons: lost.map((l) => l.r) },
  };
}

/** The Campaign Builder. No AI here: it assembles what the others decided and applies the rules. */
export function buildPlan(f: Facts, d: Director, a: Audience, s: Strategist, c: Creative) {
  const issues: Issue[] = [];
  const rera = f.project.rera_number;
  if (!rera) issues.push({ level: 'blocked', text: `${f.project.name} has no MahaRERA number. Add it under Projects before this can be advertised.` });
  const daily = Math.floor(f.brief.budget_inr / f.brief.days);
  const sets = s.adsets.slice(0, 4);
  const shares = sets.reduce((sum, x) => sum + Math.max(0, x.share_percent), 0) || 1;
  const adsets = sets.map((x) => {
    const safe = safeTargeting({ center: a.center || f.project.location, radius_km: x.radius_km, interests: x.interests });
    issues.push(...safe.issues.map((i) => ({ ...i, text: `${x.name}: ${i.text}` })));
    return { name: x.name.slice(0, 80), daily_budget_inr: Math.floor((daily * Math.max(0, x.share_percent)) / shares), targeting: safe.targeting };
  });
  if (adsets.some((x) => x.daily_budget_inr < 100)) issues.push({ level: 'warning', text: 'An ad set has under ₹100 a day, which Meta may refuse. Use fewer ad sets or a larger budget.' });
  const ads = c.ads.slice(0, 6).map((ad) => {
    const primary = withRera(ad.primary_text, rera);
    if (primary !== ad.primary_text && rera) issues.push({ level: 'fixed', text: `${ad.name}: added the MahaRERA line to the ad text.` });
    issues.push(...checkCopy(ad.headline, `${ad.name} headline`, rera), ...checkCopy(primary, `${ad.name} primary text`, rera));
    return { name: ad.name.slice(0, 80), headline: ad.headline.slice(0, 40), primary_text: primary, description: ad.description.slice(0, 30), cta: ad.cta };
  });
  issues.push({ level: 'warning', text: IMAGE_RULE });
  const payload: PlanPayload = { name: `${f.project.name} | ${f.brief.title}`.slice(0, 100), objective: s.objective, daily_budget_inr: adsets.reduce((sum, x) => sum + x.daily_budget_inr, 0), days: f.brief.days, adsets, ads };
  return { payload, issues, extras: { lead_method: s.lead_method, placements: s.placements, form_questions: s.form_questions, target_cpl_inr: d.target_cpl_inr } };
}

const setBrief = (id: number, status: string, stage: string, error = '') => {
  run('UPDATE mkt_briefs SET status = ?, stage = ?, error = ? WHERE id = ?', status, stage, error.slice(0, 300), id);
  broadcast('marketing');
};

/** Director → Audience → Strategist → Creative → Builder. Ends with a draft and a request for approval; nothing is sent to Meta. */
export async function planBrief(briefId: number) {
  const brief = get<any>('SELECT * FROM mkt_briefs WHERE id = ?', briefId);
  if (!brief) throw new HttpError(404, 'Brief not found.');
  if (brief.status === 'planning') throw new HttpError(409, 'The team is already working on this brief.');
  try {
    const f = factsFor(brief);
    const ask = <T>(agent: AgentKey, stage: string, prefer: 'claude' | 'gemini', prompt: string, schema: any, sample: () => T) => {
      setBrief(briefId, 'planning', stage);
      return work<T>(agent, briefId, () => generate<T>({ system: systemPrompt(), prompt, schema, sample, prefer }));
    };
    const d = await ask<Director>('director', 'Marketing Director is setting the strategy', 'claude', prompts.director(f), directorSchema, () => samples.director(f));
    const a = await ask<Audience>('audience', 'Audience Research is describing the buyers', 'gemini', prompts.audience(f, d), audienceSchema, () => samples.audience(f));
    const s = await ask<Strategist>('strategist', 'Meta Ads Strategist is structuring the campaign', 'claude', prompts.strategist(f, d, a), strategistSchema, () => samples.strategist(f, d, a));
    const c = await ask<Creative>('creative', 'Creative is writing the ads', 'claude', prompts.creative(f, d, a, s), creativeSchema, () => samples.creative(f));
    setBrief(briefId, 'planning', 'Campaign Builder is assembling and checking the campaign');
    const built = buildPlan(f, d, a, s, c);
    run('INSERT INTO mkt_runs(brief_id, agent, status, output, provider, model) VALUES(?, ?, ?, ?, ?, ?)', briefId, 'builder', 'ok', JSON.stringify({ ...built.extras, issues: built.issues }), 'rules', 'rules');
    run(`DELETE FROM mkt_plans WHERE brief_id = ? AND status IN ('draft','blocked')`, briefId);
    const stop = blocked(built.issues);
    const { id: planId } = run('INSERT INTO mkt_plans(brief_id, name, payload, issues, status) VALUES(?, ?, ?, ?, ?)', briefId, built.payload.name, JSON.stringify({ ...built.payload, ...built.extras }), JSON.stringify(built.issues), stop ? 'blocked' : 'draft');
    if (!stop) {
      propose({
        kind: 'create_paused', plan_id: planId, campaign: built.payload.name, source: 'builder',
        reason: 'The campaign draft is ready. Approving creates it in Meta Ads Manager with everything PAUSED, so nothing is spent.',
        payload: { data: `${built.payload.adsets.length} ad sets, ${built.payload.ads.length} ads, ₹${built.payload.daily_budget_inr} a day for ${built.payload.days} days`, expected: `About ${d.expected_leads} leads at around ₹${d.target_cpl_inr} each (an estimate).`, risk: 'None yet: a paused campaign spends nothing.', cost: '₹0 until you switch it on.' },
      });
    }
    setBrief(briefId, stop ? 'blocked' : 'planned', '');
    for (const m of marketers()) notify(m.id, stop ? 'Campaign draft needs a fix' : 'Campaign draft is ready for review', built.payload.name, '/marketing');
    return planId;
  } catch (e) {
    setBrief(briefId, 'failed', '', (e as Error).message);
    throw e;
  }
}

// ---------- Actions that wait for a person ----------
interface Proposal { kind: 'create_paused' | 'activate' | 'pause' | 'budget' | 'advice'; plan_id?: number | null; campaign: string; reason: string; source: string; payload: Record<string, unknown> }

function propose(p: Proposal) {
  // One open request of a kind per campaign is enough.
  if (get(`SELECT 1 AS x FROM mkt_actions WHERE status = 'pending' AND kind = ? AND campaign = ?`, p.kind, p.campaign)) return 0;
  const { id } = run('INSERT INTO mkt_actions(kind, plan_id, campaign, payload, reason, source) VALUES(?, ?, ?, ?, ?, ?)', p.kind, p.plan_id ?? null, p.campaign, JSON.stringify(p.payload), p.reason, p.source);
  emit('approval_needed', { kind: p.kind, campaign: p.campaign, reason: p.reason });
  broadcast('marketing');
  return id;
}

/** A person asks to switch a paused campaign on or off. Still goes through the same approval record. */
export function requestSwitch(planId: number, on: boolean) {
  const plan = get<any>('SELECT * FROM mkt_plans WHERE id = ?', planId);
  if (!plan) throw new HttpError(404, 'Campaign not found.');
  if (on && plan.status !== 'in_meta_paused' && plan.status !== 'paused') throw new HttpError(409, 'Create this campaign in Meta first.');
  if (!on && plan.status !== 'live') throw new HttpError(409, 'This campaign is not live.');
  const p = JSON.parse(plan.payload) as PlanPayload;
  return propose(on
    ? { kind: 'activate', plan_id: planId, campaign: plan.name, source: 'person', reason: 'Switch this campaign on. From this moment Meta spends money.', payload: { data: `₹${p.daily_budget_inr} a day for ${p.days} days`, expected: 'Ads start showing after Meta reviews them, usually within a day.', risk: 'Money is spent whether or not leads come.', cost: `Up to ₹${p.daily_budget_inr * p.days} in total.` } }
    : { kind: 'pause', plan_id: planId, campaign: plan.name, source: 'person', reason: 'Pause this campaign.', payload: { data: '', expected: 'Spending stops within minutes.', risk: 'Leads from this campaign stop.', cost: '₹0' } });
}

/** Carries out exactly what was approved, once. A failure is recorded, never retried silently. */
export async function decide(actionId: number, approve: boolean, userId: number) {
  const action = get<any>('SELECT * FROM mkt_actions WHERE id = ?', actionId);
  if (!action) throw new HttpError(404, 'Request not found.');
  if (action.status !== 'pending') throw new HttpError(409, `This request is already ${action.status}.`);
  const close = (status: string, result: string) => {
    run('UPDATE mkt_actions SET status = ?, result = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?', status, result.slice(0, 300), userId, nowIso(), actionId);
    broadcast('marketing');
    return { status, result };
  };
  if (!approve) return close('rejected', '');
  // Claimed first, so two clicks can never run the same action twice.
  if (!run(`UPDATE mkt_actions SET status = 'running' WHERE id = ? AND status = 'pending'`, actionId).changes) throw new HttpError(409, 'This request is already being handled.');
  const plan = action.plan_id ? get<any>('SELECT * FROM mkt_plans WHERE id = ?', action.plan_id) : null;
  const payload = JSON.parse(action.payload);
  const simulated = adsSimulated();
  const mark = (status: string) => run('UPDATE mkt_plans SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), plan.id);
  try {
    if (action.kind === 'advice') return close('done', 'Noted.');
    if (!adsLive() && !simulated) throw new HttpError(503, 'Meta Ads Manager is not connected. Add it in Settings, Integrations.');
    const ids = plan ? JSON.parse(plan.meta_ids) as { adset_ids?: string[] } : {};
    if (action.kind === 'create_paused') {
      if (!plan || plan.status !== 'draft') throw new HttpError(409, 'This draft has changed. Ask the team to plan it again.');
      const made = simulated ? { campaign_id: `sim_${plan.id}`, adset_ids: (JSON.parse(plan.payload) as PlanPayload).adsets.map((_, i) => `sim_${plan.id}_${i + 1}`) } : await createPaused(JSON.parse(plan.payload));
      run('UPDATE mkt_plans SET status = ?, meta_campaign_id = ?, meta_ids = ?, simulated = ?, updated_at = ? WHERE id = ?', 'in_meta_paused', made.campaign_id, JSON.stringify(made), simulated ? 1 : 0, nowIso(), plan.id);
      return close('done', simulated ? 'Simulated: Meta is not connected, so nothing was created.' : `Created in Meta as PAUSED (campaign ${made.campaign_id}). Add the images and lead form in Ads Manager, then switch it on here.`);
    }
    const campaignId: string = plan?.meta_campaign_id || payload.campaign_id || '';
    if (!campaignId) throw new HttpError(409, 'This campaign is not linked to Meta.');
    if (action.kind === 'activate' || action.kind === 'pause') {
      const status = action.kind === 'activate' ? 'ACTIVE' : 'PAUSED';
      if (!simulated) await setStatus(action.kind === 'activate' ? [campaignId, ...(ids.adset_ids ?? [])] : [campaignId], status);
      if (plan) mark(action.kind === 'activate' ? 'live' : 'paused');
      return close('done', `${simulated ? 'Simulated: ' : ''}Campaign is now ${status}.`);
    }
    if (action.kind === 'budget') {
      const percent = Math.max(-50, Math.min(MAX_BUDGET_STEP, Number(payload.change_percent) || 0));
      if (!ids.adset_ids?.length) throw new HttpError(409, 'Budgets for this campaign are changed in Ads Manager.');
      if (!simulated) for (const b of await readBudgets(ids.adset_ids)) await setDailyBudget(b.id, Math.round(b.daily_budget_inr * (1 + percent / 100)));
      const p = JSON.parse(plan.payload) as PlanPayload;
      const factor = 1 + percent / 100;
      p.adsets = p.adsets.map((x) => ({ ...x, daily_budget_inr: Math.round(x.daily_budget_inr * factor) }));
      p.daily_budget_inr = p.adsets.reduce((sum, x) => sum + x.daily_budget_inr, 0);
      run('UPDATE mkt_plans SET payload = ?, updated_at = ? WHERE id = ?', JSON.stringify(p), nowIso(), plan.id);
      return close('done', `${simulated ? 'Simulated: ' : ''}Daily budget changed by ${percent}% to ₹${p.daily_budget_inr}.`);
    }
    throw new HttpError(400, 'Unknown request.');
  } catch (e) {
    close('failed', (e as Error).message);
    throw e;
  }
}

// ---------- Results ----------
/** Pulls the last days of results from Meta. Demo mode without a connection fills in labelled samples. */
export async function syncInsights(days = 14) {
  if (adsLive()) {
    const rows = await fetchInsights(dayAgo(days), today());
    run('DELETE FROM mkt_insights WHERE simulated = 1');
    for (const r of rows) run('INSERT OR REPLACE INTO mkt_insights(day, campaign_id, campaign, spend, impressions, reach, clicks, leads, simulated) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0)', r.day, r.campaign_id, r.campaign, r.spend, r.impressions, r.reach, r.clicks, r.leads);
    setSetting('mkt_sync_last', nowIso());
    broadcast('marketing');
    return { rows: rows.length, simulated: false };
  }
  if (!adsSimulated()) throw new HttpError(503, 'Meta Ads Manager is not connected. Add it in Settings, Integrations.');
  const known = all<{ c: string }>(`SELECT DISTINCT utm_campaign AS c FROM leads WHERE source = 'Meta Ads' AND utm_campaign != '' AND deleted_at IS NULL LIMIT 4`).map((r) => r.c);
  const live = all<{ name: string }>(`SELECT name FROM mkt_plans WHERE status = 'live'`).map((p) => p.name);
  const names = [...new Set([...known, ...live])];
  const rows = sampleInsights(days, names.length ? names : ['Sample: 2 BHK lead forms', 'Sample: Site visit reels']);
  run('DELETE FROM mkt_insights');
  for (const r of rows) run('INSERT OR REPLACE INTO mkt_insights(day, campaign_id, campaign, spend, impressions, reach, clicks, leads, simulated) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1)', r.day, r.campaign_id, r.campaign, r.spend, r.impressions, r.reach, r.clicks, r.leads);
  setSetting('mkt_sync_last', nowIso());
  broadcast('marketing');
  return { rows: rows.length, simulated: true };
}

/** Every figure the agents may quote, calculated here from Meta's results and the CRM's own leads. */
export function snapshot(days: number) {
  const since = dayAgo(days);
  const ratio = (a: number, b: number, places = 0) => (b ? round(a / b, places) : null);
  const crm = all<any>(
    `SELECT utm_campaign AS campaign, COUNT(*) AS leads,
       SUM(stage NOT IN ('Not Contacted','Contacted','Unqualified','Did Not Respond','Lost')) AS qualified,
       SUM(stage IN ('Site Visit Done','Working Deal','Booked')) AS visits, SUM(stage = 'Booked') AS booked,
       SUM(stage IN ('Unqualified','Lost')) AS dropped
     FROM leads WHERE deleted_at IS NULL AND source = 'Meta Ads' AND utm_campaign != '' AND created_at >= ? GROUP BY utm_campaign`, `${since} 00:00:00`);
  const campaigns = all<any>(
    `SELECT campaign_id, campaign, COUNT(*) AS days, SUM(spend) AS spend, SUM(impressions) AS impressions, SUM(reach) AS reach, SUM(clicks) AS clicks, SUM(leads) AS leads, MAX(simulated) AS simulated
     FROM mkt_insights WHERE day >= ? GROUP BY campaign_id ORDER BY spend DESC`, since,
  ).map((r) => {
    const c = crm.find((x) => x.campaign === r.campaign) ?? { leads: 0, qualified: 0, visits: 0, booked: 0, dropped: 0 };
    return {
      campaign_id: r.campaign_id as string, campaign: r.campaign as string, days: r.days as number, simulated: Boolean(r.simulated),
      spend: round(r.spend), impressions: r.impressions as number, reach: r.reach as number, clicks: r.clicks as number, leads: r.leads as number,
      cpm: ratio(r.spend * 1000, r.impressions), ctr: ratio(r.clicks * 100, r.impressions, 2), cpc: ratio(r.spend, r.clicks, 1), cpl: ratio(r.spend, r.leads),
      crm: { leads: c.leads, qualified: c.qualified, visits: c.visits, booked: c.booked, dropped: c.dropped },
      qualified: c.qualified as number,
      cost_per_qualified: ratio(r.spend, c.qualified), cost_per_booking: ratio(r.spend, c.booked),
    };
  });
  const sum = (k: 'spend' | 'impressions' | 'clicks' | 'leads' | 'qualified') => campaigns.reduce((t, c) => t + (c[k] as number), 0);
  const n = (sql: string, ...p: (string | number)[]) => get<{ n: number }>(sql, ...p)!.n;
  const open = `l.deleted_at IS NULL AND l.stage NOT IN ('Booked','Lost','Unqualified')`;
  return {
    days, from: since, to: today(), simulated: campaigns.some((c) => c.simulated), synced_at: getSetting('mkt_sync_last', ''),
    totals: { spend: sum('spend'), leads: sum('leads'), cpl: ratio(sum('spend'), sum('leads')), ctr: ratio(sum('clicks') * 100, sum('impressions'), 2), qualified: sum('qualified'), cost_per_qualified: ratio(sum('spend'), sum('qualified')) },
    campaigns,
    pipeline: {
      hot_waiting: n(`SELECT COUNT(*) n FROM leads l WHERE ${open} AND l.temperature = 'Hot' AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.completed_at IS NULL)`),
      overdue_followups: n(`SELECT COUNT(*) n FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE l.deleted_at IS NULL AND t.completed_at IS NULL AND t.due_at < ?`, nowIso()),
      unassigned: n(`SELECT COUNT(*) n FROM leads l WHERE ${open} AND l.owner_id IS NULL`),
      awaiting_first_response: n(`SELECT COUNT(*) n FROM leads l WHERE ${open} AND l.first_response_at IS NULL AND l.stage = 'Not Contacted'`),
      visits_next_7_days: n(`SELECT COUNT(*) n FROM site_visits WHERE status IN ('Scheduled','Confirmed') AND scheduled_at BETWEEN ? AND ?`, nowIso(), minutesFromNow(7 * 1440)),
      pending_approvals: n(`SELECT COUNT(*) n FROM mkt_actions WHERE status = 'pending'`),
    },
  };
}
export type Snapshot = ReturnType<typeof snapshot>;

const analyse = (snap: Snapshot) => work<Analyst>('analyst', null, () => generate<Analyst>({ system: systemPrompt(), prompt: prompts.analyst(snap), schema: analystSchema, sample: () => samples.analyst(snap.campaigns), prefer: 'gemini' }));

/** Analyst, then Optimization. Suggestions that change a campaign become requests; none is carried out here. */
export async function review(days = 7) {
  const snap = snapshot(days);
  if (!snap.campaigns.length) throw new HttpError(400, 'There are no results yet. Sync results from Meta first.');
  const analysis = await analyse(snap);
  const plan = await work<Optimizer>('optimizer', null, () => generate<Optimizer>({ system: systemPrompt(), prompt: prompts.optimizer(snap, analysis), schema: optimizerSchema, sample: () => samples.optimizer(snap.campaigns, analysis) }));
  let proposed = 0;
  for (const r of plan.recommendations) {
    const row = snap.campaigns.find((c) => c.campaign === r.campaign);
    if (!row || r.action === 'keep') continue; // A campaign the model made up is ignored.
    const linked = get<any>(`SELECT id, payload FROM mkt_plans WHERE name = ? AND status IN ('live','paused','in_meta_paused')`, r.campaign);
    const percent = r.action === 'increase_budget' ? Math.min(MAX_BUDGET_STEP, Math.abs(r.change_percent) || 10) : r.action === 'decrease_budget' ? -Math.min(50, Math.abs(r.change_percent) || 10) : 0;
    const budget = r.action === 'increase_budget' || r.action === 'decrease_budget';
    const doable = (r.action === 'pause') || (budget && linked);
    const daily = linked ? (JSON.parse(linked.payload) as PlanPayload).daily_budget_inr : null;
    if (propose({
      kind: !doable ? 'advice' : budget ? 'budget' : 'pause', plan_id: linked?.id ?? null, campaign: r.campaign, source: 'optimizer',
      reason: `${r.action.replace(/_/g, ' ')}${percent ? ` by ${Math.abs(percent)}%` : ''}: ${r.problem}`,
      payload: { campaign_id: row.campaign_id, change_percent: percent, data: r.evidence, expected: r.expected_benefit, risk: r.risk, priority: r.priority, cost: percent > 0 && daily ? `About ₹${Math.round((daily * percent) / 100)} more each day.` : percent > 0 ? 'More daily spend. Change it in Ads Manager.' : '₹0' },
    })) proposed += 1;
  }
  return { analysis, recommendations: plan.recommendations, proposed, simulated: snap.simulated };
}

const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30 } as const;
export type Period = keyof typeof PERIOD_DAYS;

/** The Marketing Director's report: figures from the CRM, words from the Reporting agent. */
export async function report(period: Period) {
  const snap = snapshot(PERIOD_DAYS[period]);
  const analysis: Analyst = snap.campaigns.length ? await analyse(snap) : { headline: 'No campaign results for this period.', strong: [], weak: [], observations: [] };
  const text = await work('reporter', null, () => generate({ system: systemPrompt(), prompt: prompts.reporter(period, snap, analysis), schema: reporterSchema, sample: () => samples.reporter(period, snap.totals, analysis, snap.pipeline), prefer: 'gemini' }));
  const approvals = all<any>(`SELECT kind, campaign, reason FROM mkt_actions WHERE status = 'pending' ORDER BY id DESC LIMIT 20`);
  const done = all<any>(`SELECT kind, campaign, result FROM mkt_actions WHERE status = 'done' AND reviewed_at >= ? ORDER BY id DESC LIMIT 20`, `${snap.from} 00:00:00`);
  const data = { ...text, totals: snap.totals, campaigns: snap.campaigns, pipeline: snap.pipeline, approval_required: approvals, ai_actions: done };
  const { id } = run('INSERT INTO mkt_reports(period, from_day, to_day, data, simulated) VALUES(?, ?, ?, ?, ?)', period, snap.from, snap.to, JSON.stringify(data), snap.simulated ? 1 : 0);
  for (const m of marketers()) notify(m.id, text.title, text.status.slice(0, 140), '/marketing?tab=reports');
  emit('report', { period, title: text.title, status: text.status, next_priorities: text.next_priorities, totals: snap.totals, simulated: snap.simulated });
  broadcast('marketing');
  return { id, ...data, simulated: snap.simulated };
}

/** A plain question to the Director, answered only from the CRM's own figures. */
export async function ask(question: string) {
  const snap = snapshot(30);
  return work('director', null, () => generate({ system: systemPrompt(), prompt: prompts.ask(question, snap), schema: answerSchema, sample: () => ({ answer: `Sample answer (no AI key is connected). In the last 30 days: ₹${snap.totals.spend} spent, ${snap.totals.leads} leads${snap.totals.cpl ? `, ₹${snap.totals.cpl} per lead` : ''}; ${snap.pipeline.hot_waiting} hot leads have no follow-up planned.`, missing: [] }) }));
}

// ---------- Schedule ----------
let busy = false;

/** Hourly results, and the daily report each morning (plus weekly on Monday, monthly on the 1st). Off unless the feature is on. */
export async function marketingTick() {
  if (busy || !featureOn('marketing') || !adsLive()) return;
  busy = true;
  try {
    const last = getSetting<string>('mkt_sync_last', '');
    if (!last || last < minutesFromNow(-60)) await syncInsights();
    const now = new Date(Date.now() + 330 * 60000);
    if (now.getUTCHours() >= 9 && getSetting('mkt_report_last', '') !== today()) {
      setSetting('mkt_report_last', today());
      await report('daily');
      if (now.getUTCDay() === 1) { await review(7); await report('weekly'); }
      if (now.getUTCDate() === 1) await report('monthly');
    }
  } finally {
    busy = false;
  }
}
