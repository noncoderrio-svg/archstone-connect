// Campaign mapping, automatic assignment and the Meta lead pipeline, with Meta stubbed.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-routing-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '', WHATSAPP_VERIFY_TOKEN: 'verify-token', META_APP_SECRET: 'app-secret', META_PAGE_TOKEN: 'env-token-value-long-enough',
});

const NEW_PASSWORD = 'Str0ng-test-password';
const realFetch = globalThis.fetch;
let base = '';
let server: Server;
let db: any;
let meta: any;
let admin = '';
let tele = '';
let teleId = 0;
let t2 = 0;
let s1 = 0;
let phone = 9755500000;
const graph: Record<string, any> = {};
const asked: string[] = [];

async function call(method: string, path: string, who = admin, body?: unknown) {
  const res = await realFetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie: who }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, set };
}

async function signIn(email: string) {
  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(` ${email} `))!;
  const current = line.trim().split(/\s+/)[2];
  const session = (await call('POST', '/api/auth/login', '', { email, password: current })).set!.split(';')[0];
  const changed = await call('POST', '/api/auth/password', session, { current, next: NEW_PASSWORD });
  return changed.set ? changed.set.split(';')[0] : session;
}

const metaLead = (id: string, extra: object = {}) => ({
  id, created_time: '2026-11-07T10:00:00+0000', campaign_name: '44 West November', adset_name: 'Mumbai 30+', ad_name: 'Reel A', form_id: 'form1', platform: 'ig',
  field_data: [{ name: 'full_name', values: ['Asha Rao'] }, { name: 'phone_number', values: [`+91${phone += 1}`] }, { name: 'email', values: ['asha@test.local'] }, { name: 'budget_range', values: ['1 to 2 Cr'] }],
  ...extra,
});

const rule = (b: object) => call('POST', '/api/routing/rules', admin, { name: 'Rule', user_ids: [teleId, t2], ...b });
const owner = (name: string) => db.get('SELECT owner_id, utm_campaign, adset, ad, form_name, notes, project_id, source FROM leads WHERE name = ? ORDER BY id DESC', name);

before(async () => {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.startsWith('https://graph.facebook.com/')) {
      asked.push(href);
      const path = decodeURIComponent(href.split(/v[\d.]+\//)[1]);
      const key = Object.keys(graph).sort((a, b) => b.length - a.length).find((k) => path.startsWith(k));
      if (!key) return new Response(JSON.stringify({ error: { message: 'Unknown object' } }), { status: 400 });
      return new Response(JSON.stringify(graph[key]), { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  meta = await import('../server/services/metaLeads.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = await signIn('owner@test.local');
  tele = await signIn('telecaller1@demo.archstone.test');
  teleId = (await call('GET', '/api/auth/me', tele)).data.user.id;
  t2 = db.get(`SELECT id FROM users WHERE email = 'telecaller2@demo.archstone.test'`).id;
  s1 = db.get(`SELECT id FROM users WHERE role = 'sales' LIMIT 1`).id;
});

beforeEach(() => {
  db.run('DELETE FROM lead_routes');
  db.run('DELETE FROM meta_pages');
  for (const k of Object.keys(graph)) delete graph[k];
  asked.length = 0;
  graph.form1 = { name: 'Site visit form' };
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('only an administrator manages routing, and rules need a match and people', async () => {
  assert.equal((await call('GET', '/api/routing', tele)).status, 403);
  assert.equal((await rule({ name: 'Empty' })).status, 400);
  assert.equal((await rule({ match_campaign: '44', user_ids: [] })).status, 400);
  assert.equal((await rule({ match_campaign: '44' })).status, 201);
});

test('a Meta lead is saved with its campaign, ad and answers, then mapped to the right person', async () => {
  const project = db.get('SELECT id FROM projects LIMIT 1').id;
  await rule({ match_campaign: '44 west', project_id: project, user_ids: [s1] });
  await meta.saveMetaLead(metaLead('m1'), 'Site visit form');
  const l = owner('Asha Rao');
  assert.equal(l.owner_id, s1);
  assert.equal(l.project_id, project);
  assert.equal(l.source, 'Meta Ads');
  assert.equal(l.utm_campaign, '44 West November');
  assert.equal(l.adset, 'Mumbai 30+');
  assert.equal(l.ad, 'Reel A');
  assert.equal(l.form_name, 'Site visit form');
  assert.match(l.notes, /budget range: 1 to 2 Cr/);
});

test('leads take turns, and a paused person is skipped', async () => {
  await rule({ match_campaign: 'Turns', user_ids: [teleId, t2] });
  const got: number[] = [];
  for (const [i, m] of ['t1', 't2', 't3'].entries()) {
    await meta.saveMetaLead(metaLead(m, { campaign_name: 'Turns', field_data: [{ name: 'full_name', values: [`Turn ${i}`] }, { name: 'phone_number', values: [`+91${phone += 1}`] }] }));
    got.push(owner(`Turn ${i}`).owner_id);
  }
  assert.deepEqual(got, [teleId, t2, teleId]);
  db.run(`UPDATE users SET status = 'paused' WHERE id = ?`, t2);
  await meta.saveMetaLead(metaLead('t4', { campaign_name: 'Turns', field_data: [{ name: 'full_name', values: ['Turn 4'] }, { name: 'phone_number', values: [`+91${phone += 1}`] }] }));
  assert.equal(owner('Turn 4').owner_id, teleId);
  db.run(`UPDATE users SET status = 'active' WHERE id = ?`, t2);
});

test('the first matching rule wins, by order', async () => {
  await rule({ name: 'Broad', priority: 50, match_source: 'Meta Ads', user_ids: [teleId] });
  await rule({ name: 'Narrow', priority: 10, match_campaign: 'Special', user_ids: [s1] });
  await meta.saveMetaLead(metaLead('p1', { campaign_name: 'Special offer', field_data: [{ name: 'full_name', values: ['Priority One'] }, { name: 'phone_number', values: [`+91${phone += 1}`] }] }));
  assert.equal(owner('Priority One').owner_id, s1);
});

test('the same Meta lead is never saved twice', async () => {
  const lead = metaLead('dup1');
  const first = await meta.saveMetaLead(lead);
  assert.ok(first);
  assert.equal(await meta.saveMetaLead(lead), null);
  assert.equal(db.get(`SELECT COUNT(*) n FROM meta_seen WHERE meta_lead_id = 'dup1'`).n, 1);
});

test('a lead with no phone is refused without creating anything', async () => {
  await assert.rejects(meta.saveMetaLead(metaLead('nop', { field_data: [{ name: 'full_name', values: ['No Phone'] }] })), /no phone/);
  assert.equal(owner('No Phone'), undefined);
});

test('the instant webhook needs a real Meta signature, then pulls the lead', async () => {
  graph.lead55 = metaLead('lead55', { field_data: [{ name: 'full_name', values: ['Web Hook'] }, { name: 'phone_number', values: [`+91${phone += 1}`] }] });
  const body = JSON.stringify({ entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'lead55', page_id: '123456' } }] }] });
  const post = (signature: string) => realFetch(`${base}/webhooks/meta-leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature }, body });
  assert.equal((await post('sha256=bad')).status, 401);
  assert.equal(owner('Web Hook'), undefined);
  const signature = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
  assert.equal((await post(signature)).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(owner('Web Hook').form_name, 'Site visit form');
});

test('a page connects only if Meta accepts it, and its token is stored encrypted', async () => {
  assert.equal((await call('POST', '/api/meta-pages', admin, { page_id: '999999', token: 'x'.repeat(30) })).status, 400);
  graph['111222'] = { name: 'Archstone Page' };
  const r = await call('POST', '/api/meta-pages', admin, { page_id: '111222', token: 'secret-token-value-1234567890' });
  assert.equal(r.status, 201);
  assert.equal(r.data.name, 'Archstone Page');
  assert.ok(!db.get('SELECT token FROM meta_pages WHERE id = ?', r.data.id).token.includes('secret-token'));
  const shown = JSON.stringify((await call('GET', '/api/routing')).data);
  assert.ok(!shown.includes('secret-token'));
  assert.equal((await call('POST', '/api/meta-pages', admin, { page_id: '111222', token: 'secret-token-value-1234567890' })).status, 409);
});

test('the 15-minute pull recovers missed leads and reports failures', async () => {
  graph['333444'] = { name: 'Pull Page' };
  const { id } = (await call('POST', '/api/meta-pages', admin, { page_id: '333444', token: 'secret-token-value-1234567890' })).data;
  graph['333444/leadgen_forms'] = { data: [{ id: 'formA', name: 'Form A' }] };
  graph['formA/leads'] = { data: [metaLead('missed1', { field_data: [{ name: 'full_name', values: ['Missed Lead'] }, { name: 'phone_number', values: [`+91${phone += 1}`] }] })] };
  assert.equal((await call('POST', `/api/meta-pages/${id}/sync`)).data.saved, 1);
  assert.equal(owner('Missed Lead').form_name, 'Form A');
  assert.equal((await call('POST', `/api/meta-pages/${id}/sync`)).data.saved, 0, 'nothing is saved twice');
  assert.equal(db.get('SELECT leads_pulled FROM meta_pages WHERE id = ?', id).leads_pulled, 1);

  delete graph['333444/leadgen_forms'];
  delete graph['333444'];
  db.setSetting('meta_sync_last', '');
  await meta.syncMetaLeads();
  assert.match(db.get('SELECT last_error FROM meta_pages WHERE id = ?', id).last_error, /Unknown object/);
});

test('waiting leads can be shared out, and campaigns show their mapping', async () => {
  const id = (await call('POST', '/api/leads', admin, { name: 'Waiting One', phone: `+91${phone += 1}` })).data.id;
  db.run(`UPDATE leads SET owner_id = NULL, presales_id = NULL, utm_campaign = 'Backlog Campaign' WHERE id = ?`, id);
  const before = (await call('GET', '/api/routing')).data.campaigns.find((c: any) => c.campaign === 'Backlog Campaign');
  assert.equal(before.rule, null);
  await rule({ name: 'Backlog', match_campaign: 'Backlog', user_ids: [s1] });
  const r = await call('POST', '/api/routing/apply');
  assert.ok(r.data.assigned >= 1);
  assert.equal(db.get('SELECT owner_id FROM leads WHERE id = ?', id).owner_id, s1);
  const data = (await call('GET', '/api/routing')).data;
  assert.equal(data.campaigns.find((c: any) => c.campaign === 'Backlog Campaign').rule, 'Backlog');
});

test('campaign filters narrow step by step, within what someone may see', async () => {
  await meta.saveMetaLead(metaLead('f1', { campaign_name: 'Filter Camp', adset_name: 'Set A', ad_name: 'Ad 1', field_data: [{ name: 'full_name', values: ['Filter One'] }, { name: 'phone_number', values: [`+91${phone += 1}`] }] }));
  await meta.saveMetaLead(metaLead('f2', { campaign_name: 'Filter Camp', adset_name: 'Set B', ad_name: 'Ad 2', field_data: [{ name: 'full_name', values: ['Filter Two'] }, { name: 'phone_number', values: [`+91${phone += 1}`] }] }));
  const names = async (q: string) => (await call('GET', `/api/leads?${q}`)).data.leads.map((l: any) => l.name);
  assert.equal((await names('campaign=Filter%20Camp')).length, 2);
  assert.deepEqual(await names('campaign=Filter%20Camp&adset=Set%20A'), ['Filter One']);
  const facets = (await call('GET', '/api/leads-campaigns?campaign=Filter%20Camp&adset=Set%20B')).data;
  assert.deepEqual(facets.adsets, ['Set A', 'Set B']);
  assert.deepEqual(facets.ads, ['Ad 2']);
  assert.ok(!(await call('GET', '/api/leads-campaigns', tele)).data.campaigns.includes('Backlog Campaign'));
});

test('a lead can be found by its ID, and call results filter the list', async () => {
  const lead = db.get(`SELECT id FROM leads WHERE name = 'Filter One'`);
  assert.deepEqual((await call('GET', `/api/leads?q=${lead.id}`)).data.leads.map((l: any) => l.id).includes(lead.id), true);
  assert.equal((await call('POST', `/api/leads/${lead.id}/call`, admin, { disposition: 'Low Budget', notes: 'Wants under 80L' })).status, 200);
  const rows = (await call('GET', '/api/leads?disposition=Low%20Budget')).data.leads;
  assert.deepEqual(rows.map((l: any) => l.id), [lead.id]);
  assert.equal(rows[0].last_comment, 'Wants under 80L');
});

test('form answers fill the requirement, including budget ranges', async () => {
  assert.equal(meta.budgetLakhs('₹1.60_cr_-_₹1.85_cr'), 185);
  assert.equal(meta.budgetLakhs('80 lakhs'), 80);
  assert.equal(meta.budgetLakhs('60-75 Lac'), 75);
  assert.equal(meta.budgetLakhs('Not sure'), null);
  assert.equal(meta.budgetLakhs('2'), null, 'a bare number has no unit, so it is not guessed');
  await meta.saveMetaLead(metaLead('ans1', { field_data: [
    { name: 'full_name', values: ['Form Answers'] }, { name: 'phone_number', values: [`+91${phone += 1}`] },
    { name: 'what_configuration_are_you_looking_for?', values: ['2_bhk_'] }, { name: 'what_is_your_tentative_budget?', values: ['₹1.60_cr_-_₹1.85_cr'] },
    { name: 'phone_number_verified', values: ['false'] },
  ] }));
  const l = db.get(`SELECT configuration, budget_lakhs, notes FROM leads WHERE name = 'Form Answers'`);
  assert.equal(l.configuration, '2 BHK');
  assert.equal(l.budget_lakhs, 185);
  assert.ok(!l.notes.includes('verified'));
});

test('call result tabs keep their counts, and the unassigned count shows', async () => {
  const data = (await call('GET', '/api/leads?disposition=Low%20Budget')).data;
  assert.equal(data.result_counts['Low Budget'], 1);
  assert.equal(typeof data.unassigned, 'number');
  const other = (await call('GET', '/api/leads?disposition=Busy')).data;
  assert.equal(other.total, 0);
  assert.equal(other.result_counts['Low Budget'], 1);
});

test('manager notes stay hidden from agents', async () => {
  const lead = (await call('GET', '/api/leads', tele)).data.leads[0];
  assert.equal((await call('POST', `/api/leads/${lead.id}/manager-note`, tele, { body: 'Should fail' })).status, 403);
  assert.equal((await call('POST', `/api/leads/${lead.id}/manager-note`, admin, { body: 'Push this one hard' })).status, 201);
  const has = (r: any) => JSON.stringify(r.data).includes('Push this one hard');
  assert.ok(has(await call('GET', `/api/leads/${lead.id}`, admin)));
  assert.ok(!has(await call('GET', `/api/leads/${lead.id}`, tele)));
  assert.ok(!has(await call('GET', '/api/leads', tele)));
  assert.ok(!has(await call('GET', '/api/leads', admin)), 'the list column shows agent comments only');
});

test('buyer details are saved, and unknown fields are refused', async () => {
  const lead = db.get(`SELECT id FROM leads WHERE name = 'Filter Two'`);
  assert.equal((await call('PATCH', `/api/leads/${lead.id}`, admin, { profile: { purpose: 'Investment', funding: 'Loan' } })).status, 200);
  assert.equal((await call('PATCH', `/api/leads/${lead.id}`, admin, { profile: { best_time: 'Evening' } })).status, 200);
  assert.deepEqual(JSON.parse(db.get('SELECT profile FROM leads WHERE id = ?', lead.id).profile), { purpose: 'Investment', funding: 'Loan', best_time: 'Evening' });
  assert.equal((await call('PATCH', `/api/leads/${lead.id}`, admin, { profile: { made_up: 'x' } })).status, 400);
});

test('the email is found whatever the form calls it, and stays out of the notes', async () => {
  for (const [name, i] of [['email', 1], ['Email Address', 2], ['work_email', 3], ['email_id', 4], ['E-mail', 5], ['your_contact', 6]] as [string, number][]) {
    const number = `+91${phone += 1}`;
    await meta.saveMetaLead({ id: `mail${i}`, field_data: [{ name: 'full_name', values: ['Mail Test'] }, { name: 'phone_number', values: [number] }, { name, values: [` buyer${i}@test.local `] }] });
    const lead = db.get('SELECT email, notes FROM leads WHERE phone = ?', number);
    assert.equal(lead.email, `buyer${i}@test.local`, name);
    assert.ok(!lead.notes.includes('@'), name);
  }
});

test('an answer that is not an email stays a note', async () => {
  const number = `+91${phone += 1}`;
  await meta.saveMetaLead({ id: 'mail7', field_data: [{ name: 'phone_number', values: [number] }, { name: 'email_preference', values: ['Weekly'] }] });
  const lead = db.get('SELECT email, notes FROM leads WHERE phone = ?', number);
  assert.equal(lead.email, '');
  assert.match(lead.notes, /Weekly/);
});

test('an existing lead gains a missing email, but a saved one is never replaced', async () => {
  const number = `+91${phone += 1}`;
  const form = (id: string, email: string) => ({ id, field_data: [{ name: 'phone_number', values: [number] }, { name: 'email', values: [email] }] });
  const { id } = db.run(`INSERT INTO leads(name, phone, source) VALUES('Had No Email', ?, 'Manual')`, number);
  await meta.saveMetaLead(form('mail8', 'first@test.local'));
  assert.equal(db.get('SELECT email FROM leads WHERE id = ?', id).email, 'first@test.local');
  await meta.saveMetaLead(form('mail9', 'second@test.local'));
  assert.equal(db.get('SELECT email FROM leads WHERE id = ?', id).email, 'first@test.local');
});