// Meta Marketing API for the AI team: read results, and create campaigns that start PAUSED.
// Nothing here runs unless a person approved the action first (see pipeline.ts).
import { HttpError } from '../../auth.ts';
import { config } from '../../config.ts';
import type { Targeting } from './compliance.ts';

export const adsLive = () => Boolean(config.metaAds.token && config.metaAds.accountId);
/** Without a connection, demo mode pretends, and labels everything it made as simulated. */
export const adsSimulated = () => !adsLive() && config.demoMode;

const base = () => `https://graph.facebook.com/${config.metaAds.apiVersion}`;
const account = () => `act_${config.metaAds.accountId}`;

async function graph(method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}) {
  if (!adsLive()) throw new HttpError(503, 'Meta Ads Manager is not connected. Add it in Settings, Integrations.');
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') body.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const url = `${base()}/${path}${method === 'GET' && [...body].length ? `?${body}` : ''}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${config.metaAds.token}`, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: method === 'POST' ? body.toString() : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HttpError(504, 'Meta could not be reached.');
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Meta refused: ${String(data?.error?.error_user_msg ?? data?.error?.message ?? res.status).slice(0, 240)}`);
  return data;
}

/** A safe, read-only test of the connection: can we see the account, and which permissions does the token hold? */
export async function checkAds() {
  const acct = await graph('GET', account(), { fields: 'name,account_status,currency,timezone_name' });
  const granted: string[] = await graph('GET', 'me/permissions').then((p) => (p.data ?? []).filter((x: any) => x.status === 'granted').map((x: any) => x.permission)).catch(() => []);
  const need = ['ads_read', 'ads_management'];
  return {
    account: acct.name as string,
    active: acct.account_status === 1,
    currency: acct.currency as string,
    timezone: acct.timezone_name as string,
    permissions: granted,
    missing: granted.length ? need.filter((n) => !granted.includes(n)) : [],
    page_set: Boolean(config.metaAds.pageId),
  };
}

export interface InsightRow { day: string; campaign_id: string; campaign: string; spend: number; impressions: number; reach: number; clicks: number; leads: number }

const LEAD_ACTIONS = ['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped'];

/** One row per campaign per day. */
export async function fetchInsights(since: string, until: string): Promise<InsightRow[]> {
  const rows: InsightRow[] = [];
  let page: any = await graph('GET', `${account()}/insights`, {
    level: 'campaign', time_increment: 1, limit: 500,
    fields: 'campaign_id,campaign_name,spend,impressions,reach,inline_link_clicks,actions',
    time_range: { since, until },
  });
  for (let guard = 0; page && guard < 20; guard += 1) {
    for (const r of page.data ?? []) {
      const lead = LEAD_ACTIONS.map((t) => (r.actions ?? []).find((a: any) => a.action_type === t)).find(Boolean);
      rows.push({
        day: r.date_start, campaign_id: String(r.campaign_id), campaign: r.campaign_name ?? '',
        spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, reach: Number(r.reach) || 0,
        clicks: Number(r.inline_link_clicks) || 0, leads: Number(lead?.value) || 0,
      });
    }
    const next: string | undefined = page.paging?.next;
    if (!next) break;
    page = await fetch(next, { headers: { Authorization: `Bearer ${config.metaAds.token}` }, signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => null);
  }
  return rows;
}

/** Believable sample figures for demo mode, the same every time for a given day and campaign. */
export function sampleInsights(days: number, campaigns: string[]): InsightRow[] {
  const rows: InsightRow[] = [];
  const noise = (seed: string) => { let h = 7; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 9973; return h / 9973; };
  campaigns.forEach((campaign, i) => {
    for (let d = days; d >= 1; d -= 1) {
      const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
      const n = noise(day + campaign);
      const spend = Math.round(900 + n * 900 + i * 250);
      const impressions = Math.round(spend * (7 + n * 3));
      const clicks = Math.round(impressions * (0.008 + n * 0.012));
      rows.push({ day, campaign_id: `sim_${i + 1}`, campaign, spend, impressions, reach: Math.round(impressions * 0.8), clicks, leads: Math.round(spend / (320 + i * 240 + n * 150)) });
    }
  });
  return rows;
}

export interface PlanPayload {
  name: string;
  objective: string;
  daily_budget_inr: number;
  days: number;
  adsets: { name: string; daily_budget_inr: number; targeting: Targeting }[];
  ads: { name: string; headline: string; primary_text: string; description: string; cta: string }[];
}

/**
 * Meta wants a city it knows. Housing ads may not target a neighbourhood on its own,
 * so a locality such as "Andheri East" becomes its city plus a radius.
 */
async function findCity(name: string) {
  const found = await graph('GET', 'search', { type: 'adgeolocation', q: name, country_code: 'IN', location_types: ['city', 'subcity', 'neighborhood'], limit: 5 });
  const places: any[] = found.data ?? [];
  const city = places.find((p) => p.type === 'city');
  const key = city?.key ?? places.find((p) => p.primary_city_id)?.primary_city_id;
  if (!key) throw new HttpError(400, `Meta does not know the place "${name}". Use a city name such as Mumbai or Thane.`);
  return String(key);
}

/**
 * Creates the campaign and its ad sets in Meta, all PAUSED, declared as housing ads.
 * Money can only be spent after a second approval switches them on.
 */
export async function createPaused(plan: PlanPayload) {
  if (!config.metaAds.pageId) throw new HttpError(400, 'Add your Facebook Page ID under Meta Ads Manager in Settings first.');
  const campaign = await graph('POST', `${account()}/campaigns`, {
    name: plan.name, objective: plan.objective, status: 'PAUSED',
    // Optional in India, but declared on purpose: Meta then enforces the same open-to-everyone rules we do.
    special_ad_categories: ['HOUSING'], special_ad_category_country: ['IN'],
    is_adset_budget_sharing_enabled: false,
  });
  const adsets: string[] = [];
  const start = new Date(Date.now() + 3600_000);
  for (const set of plan.adsets) {
    const where = { cities: [{ key: await findCity(set.targeting.center), radius: set.targeting.radius_km, distance_unit: 'kilometer' }] };
    const created = await graph('POST', `${account()}/adsets`, {
      name: set.name, campaign_id: campaign.id, status: 'PAUSED',
      daily_budget: Math.round(set.daily_budget_inr * 100), // Meta counts in paise.
      billing_event: 'IMPRESSIONS', optimization_goal: 'LEAD_GENERATION', destination_type: 'ON_AD',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      promoted_object: { page_id: config.metaAds.pageId },
      start_time: start.toISOString(), end_time: new Date(start.getTime() + plan.days * 86400000).toISOString(),
      targeting: { geo_locations: { ...where, location_types: ['home', 'recent'] }, age_min: 18, age_max: 65, targeting_automation: { advantage_audience: 0 } },
    });
    adsets.push(String(created.id));
  }
  return { campaign_id: String(campaign.id), adset_ids: adsets };
}

/** Changes the status, then reads it back, so "done" always means Meta agrees. */
export async function setStatus(ids: string[], status: 'ACTIVE' | 'PAUSED') {
  for (const id of ids) await graph('POST', id, { status });
  const now = (await graph('GET', ids[0], { fields: 'status' })).status;
  if (now !== status) throw new HttpError(502, `Meta still shows this campaign as ${now}.`);
}

export const setDailyBudget = (adsetId: string, inr: number) => graph('POST', adsetId, { daily_budget: Math.round(inr * 100) });

export const readBudgets = async (adsetIds: string[]) =>
  Promise.all(adsetIds.map(async (id) => ({ id, daily_budget_inr: (Number((await graph('GET', id, { fields: 'daily_budget' })).daily_budget) || 0) / 100 })));
