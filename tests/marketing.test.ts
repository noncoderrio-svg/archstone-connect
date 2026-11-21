// The AI marketing team: what it may do alone, and what must wait for a person. Meta is stubbed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prepareEnv, startHarness, type Harness } from './helpers/harness.ts';

const dir = prepareEnv('marketing');
Object.assign(process.env, { AUTOMATION_API_KEY: 'n8n-test-key', ANTHROPIC_API_KEY: '', META_ADS_TOKEN: '', META_AD_ACCOUNT_ID: '' });

let h: Harness;
let pipeline: typeof import('../server/services/marketing/pipeline.ts');
let rules: typeof import('../server/services/marketing/compliance.ts');
let config: any;
let projectId = 0;
const realFetch = globalThis.fetch;
const meta: { method: string; url: string; body: URLSearchParams }[] = [];

const features = (marketing: boolean) => h.call('PUT', '/api/features', 'admin', { bulletin: true, duty: false, app: true, kyc: true, marketing });
const brief = async (extra: object = {}) => (await h.call('POST', '/api/marketing/briefs', 'admin', { project_id: projectId, title: 'Diwali leads', goal: 'Site visits', budget_inr: 42000, days: 14, ...extra })).data.id as number;
const pending = async (kind: string) => (await h.call('GET', '/api/marketing/actions', 'admin')).data.actions.find((a: any) => a.kind === kind && a.status === 'pending');

before(async () => {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith('https://graph.facebook.com/')) return realFetch(url, init);
    const method = init?.method ?? 'GET';
    meta.push({ method, url: u, body: new URLSearchParams(String(init?.body ?? '')) });
    const reply = (o: object) => new Response(JSON.stringify(o), { status: 200 });
    if (u.includes('/search')) return reply({ data: [{ key: '1018367', type: 'neighborhood', name: 'Andheri East', primary_city_id: 1035921 }] });
    if (u.includes('/insights')) return reply({ data: [{ date_start: '2026-11-20', campaign_id: '900', campaign_name: 'Live one', spend: '5000', impressions: '40000', reach: '30000', inline_link_clicks: '400', actions: [{ action_type: 'lead', value: '10' }] }] });
    if (method === 'GET') return reply({ status: meta.filter((m) => m.method === 'POST' && m.body.get('status')).at(-1)?.body.get('status') ?? 'PAUSED', daily_budget: '100000' });
    return reply({ id: String(700 + meta.length) });
  }) as typeof fetch;
  h = await startHarness(dir);
  pipeline = await import('../server/services/marketing/pipeline.ts');
  rules = await import('../server/services/marketing/compliance.ts');
  config = (await import('../server/config.ts')).config;
  await h.addUser('caller', 'telecaller');
  projectId = h.db.get('SELECT id FROM projects ORDER BY id LIMIT 1').id;
  h.db.run(`UPDATE projects SET rera_number = 'P51800012345' WHERE id = ?`, projectId);
});

after(() => {
  globalThis.fetch = realFetch;
  h.stop();
});

test('the team is off until an administrator switches it on, and is not for everyone', async () => {
  assert.equal((await h.call('GET', '/api/marketing/team', 'admin')).status, 404);
  assert.equal((await features(true)).status, 200);
  const team = await h.call('GET', '/api/marketing/team', 'admin');
  assert.equal(team.status, 200);
  assert.equal(team.data.agents.length, 8);
  assert.equal((await h.call('GET', '/api/marketing/team', 'caller')).status, 403);
});

test('rules in code widen the area, drop personal targeting and block bad promises', () => {
  const t = rules.safeTargeting({ center: 'Andheri East', radius_km: 5, interests: ['Real estate', 'Hindu festivals', 'Married women', 'Home loan'] });
  assert.equal(t.targeting.radius_km, 25);
  assert.deepEqual(t.targeting.interests, ['Real estate', 'Home loan']);
  assert.equal(t.targeting.age_min, 18);
  assert.equal(t.targeting.genders, 'all');
  assert.equal(t.issues.filter((i) => i.level === 'fixed').length, 3);
  assert.ok(rules.blocked(rules.checkCopy('Guaranteed 12% rental return every year', 'Ad primary text', 'P518')));
  assert.ok(rules.blocked(rules.checkCopy('Homes for Jain families only', 'Ad headline', '')));
  assert.ok(rules.blocked(rules.checkCopy('A lovely home in Powai', 'Ad primary text', 'P518')), 'the MahaRERA number is required');
  assert.equal(rules.checkCopy('A lovely home in Powai. MahaRERA No: P518', 'Ad primary text', 'P518').length, 0);
});

test('a brief becomes a checked draft and one request for approval, with nothing sent to Meta', async () => {
  const id = await brief();
  await pipeline.planBrief(id);
  const view = (await h.call('GET', `/api/marketing/briefs/${id}`, 'admin')).data;
  assert.equal(view.brief.status, 'planned');
  assert.deepEqual(view.work.map((w: any) => w.agent), ['director', 'audience', 'strategist', 'creative', 'builder']);
  assert.ok(view.work.slice(0, 4).every((w: any) => w.simulated), 'without an AI key, demo work is labelled as simulated');
  assert.equal(view.plan.status, 'draft');
  const p = view.plan.payload;
  assert.ok(p.daily_budget_inr * p.days <= 42000, 'the team may divide the budget, never raise it');
  assert.ok(p.adsets.every((s: any) => s.targeting.radius_km >= 25 && s.targeting.age_min === 18 && s.targeting.age_max === 65));
  assert.ok(p.ads.every((a: any) => a.primary_text.includes('P51800012345') && a.headline.length <= 40));
  assert.ok(await pending('create_paused'));
  assert.equal(meta.length, 0);
});

test('a project without a MahaRERA number cannot be advertised', async () => {
  const other = h.db.get('SELECT id FROM projects WHERE id != ? LIMIT 1', projectId).id;
  h.db.run(`UPDATE projects SET rera_number = '' WHERE id = ?`, other);
  const id = await brief({ project_id: other, title: 'No number' });
  await pipeline.planBrief(id);
  const view = (await h.call('GET', `/api/marketing/briefs/${id}`, 'admin')).data;
  assert.equal(view.brief.status, 'blocked');
  assert.equal(view.plan.status, 'blocked');
  assert.ok(view.plan.issues.some((i: any) => i.level === 'blocked' && i.text.includes('MahaRERA')));
  assert.ok(!(await h.call('GET', '/api/marketing/actions', 'admin')).data.actions.some((a: any) => a.campaign.includes('No number')));
});

test('only an approver can approve, and each request runs once', async () => {
  h.db.run(`INSERT INTO user_permissions(user_id, action, allowed) VALUES(?, 'marketing.use', 1)`, h.ids.caller);
  const action = await pending('create_paused');
  assert.equal((await h.call('POST', `/api/marketing/actions/${action.id}`, 'caller', { approve: true })).status, 403);
  const done = await h.call('POST', `/api/marketing/actions/${action.id}`, 'admin', { approve: true });
  assert.equal(done.status, 200);
  assert.match(done.data.result, /^Simulated/);
  assert.equal(meta.length, 0, 'with Meta not connected, demo mode never calls Meta');
  assert.equal((await h.call('POST', `/api/marketing/actions/${action.id}`, 'admin', { approve: true })).status, 409);
  assert.ok(h.db.get(`SELECT 1 AS x FROM audit_log WHERE action = 'marketing.approve'`));
});

test('with Meta connected, a campaign is created PAUSED and going live needs its own approval', async () => {
  Object.assign(config.metaAds, { token: 'system-user-token', accountId: '123', pageId: '456' });
  const id = await brief({ title: 'Real Meta' });
  await pipeline.planBrief(id);
  const create = await pending('create_paused');
  assert.equal((await h.call('POST', `/api/marketing/actions/${create.id}`, 'admin', { approve: true })).status, 200);
  const posts = meta.filter((m) => m.method === 'POST');
  assert.ok(posts.length >= 2);
  assert.ok(posts.every((m) => m.body.get('status') === 'PAUSED'), 'everything created starts paused');
  const campaign = posts.find((m) => m.url.endsWith('/act_123/campaigns'))!;
  assert.equal(campaign.body.get('special_ad_categories'), '["HOUSING"]');
  assert.ok(meta.every((m) => m.url.includes('/v27.0/')));
  const adset = posts.find((m) => m.url.endsWith('/act_123/adsets'))!;
  const targeting = JSON.parse(adset.body.get('targeting')!);
  assert.equal(targeting.age_min, 18);
  assert.equal(targeting.genders, undefined);
  assert.equal(targeting.geo_locations.cities[0].key, '1035921');
  assert.ok(targeting.geo_locations.cities[0].radius >= 25);
  assert.ok(!JSON.stringify(Object.fromEntries(adset.body)).includes('system-user-token'), 'the token travels in the header only');

  const plan = h.db.get(`SELECT id, status FROM mkt_plans WHERE name LIKE '%Real Meta'`);
  assert.equal(plan.status, 'in_meta_paused');
  assert.equal((await h.call('POST', `/api/marketing/plans/${plan.id}/switch`, 'caller', { on: true })).status, 201, 'anyone on the team may ask');
  assert.ok(!meta.some((m) => m.body.get('status') === 'ACTIVE'), 'asking changes nothing');
  const go = await pending('activate');
  assert.match(go.payload.cost, /₹/);
  assert.equal((await h.call('POST', `/api/marketing/actions/${go.id}`, 'admin', { approve: true })).status, 200);
  assert.ok(meta.some((m) => m.body.get('status') === 'ACTIVE'));
  assert.equal(h.db.get('SELECT status FROM mkt_plans WHERE id = ?', plan.id).status, 'live');
});

test('results come from Meta, figures from the CRM, and suggestions wait for approval', async () => {
  h.db.run(`INSERT INTO leads(name, phone, source, stage, utm_campaign) VALUES('Q One', '+919800000001', 'Meta Ads', 'Qualified', 'Live one'), ('B Two', '+919800000002', 'Meta Ads', 'Booked', 'Live one')`);
  assert.deepEqual((await h.call('POST', '/api/marketing/sync', 'admin')).data, { rows: 1, simulated: false });
  const perf = (await h.call('GET', '/api/marketing/performance?days=30', 'admin')).data;
  const row = perf.campaigns[0];
  assert.deepEqual([row.spend, row.leads, row.cpl, row.cpm, row.ctr, row.cpc], [5000, 10, 500, 125, 1, 12.5]);
  assert.deepEqual([row.crm.qualified, row.crm.booked, row.cost_per_qualified, row.cost_per_booking], [2, 1, 2500, 5000]);
  const before = meta.length;
  const reviewed = await h.call('POST', '/api/marketing/review', 'admin', { days: 30 });
  assert.equal(reviewed.status, 200);
  assert.equal(meta.length, before, 'a review reads and suggests; it never changes a campaign');
  const made = await h.call('POST', '/api/marketing/reports', 'admin', { period: 'weekly' });
  assert.equal(made.status, 201);
  assert.equal(made.data.next_priorities.length, 3);
  assert.equal(typeof made.data.pipeline.overdue_followups, 'number');
  assert.equal((await h.call('GET', '/api/marketing/reports', 'admin')).data.reports.length, 1);
  assert.equal((await h.call('POST', '/api/marketing/ask', 'admin', { question: 'Which campaign is best?' })).status, 200);
});

test('n8n needs the key, and can report but never approve', async () => {
  const send = (key: string, job: string) => realFetch(`${h.base}/webhooks/automation/marketing`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key }, body: JSON.stringify({ job }) });
  assert.equal((await send('wrong', 'status')).status, 401);
  const ok = await send('n8n-test-key', 'status');
  assert.equal(ok.status, 200);
  const body: any = await ok.json();
  assert.equal(typeof body.pipeline.hot_waiting, 'number');
  assert.ok(!JSON.stringify(body).includes('+9198'), 'no customer details leave through automation');
  assert.equal((await send('n8n-test-key', 'approve')).status, 400);
});
