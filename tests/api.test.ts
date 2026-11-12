import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-test-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1',
  DB_PATH: join(dir, 'test.db'),
  DEMO_MODE: 'true',
  INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WEBSITE_API_KEY: 'test-website-key',
  WHATSAPP_VERIFY_TOKEN: 'verify-me',
  META_APP_SECRET: 'app-secret',
  WHATSAPP_TOKEN: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  GEMINI_API_KEY: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
let server: Server;
let base = '';
let tick: () => Promise<void>;
const users: Record<string, Client> = {};

class Client {
  cookie = '';
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: this.cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* CSV or plain text */ }
    return { status: res.status, data };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b: unknown = {}) => this.call('POST', p, b);
}

const passwords = () => {
  const map: Record<string, string> = {};
  for (const line of readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n')) {
    const [, email, password] = line.trim().split(/\s+/);
    if (email?.includes('@')) map[email] = password;
  }
  return map;
};

async function signIn(email: string) {
  const c = new Client();
  const current = passwords()[email];
  assert.equal((await c.post('/api/auth/login', { email, password: current })).status, 200);
  assert.equal((await c.post('/api/auth/password', { current, next: NEW_PASSWORD })).status, 200);
  return c;
}

const signed = (body: string) => `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;

async function metaPost(path: string, payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature ?? signed(body) },
    body,
  });
}

const inbound = (phone: string, text: string, id: string, name = 'Test Person') => ({
  entry: [{ changes: [{ field: 'messages', value: {
    contacts: [{ wa_id: phone, profile: { name } }],
    messages: [{ id, from: phone, type: 'text', text: { body: text } }],
  } }] }],
});

async function websiteLead(phone: string, extra: Record<string, unknown> = {}) {
  const res = await new Client().call('POST', '/webhooks/website', { name: 'Web Lead', phone, ...extra }, { 'x-api-key': 'test-website-key' });
  return res;
}

before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  tick = (await import('../server/services/scheduler.ts')).tick;
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  users.admin = await signIn('owner@test.local');
  users.tele1 = await signIn('telecaller1@demo.archstone.test');
  users.tele2 = await signIn('telecaller2@demo.archstone.test');
  users.sales1 = await signIn('closing1@demo.archstone.test');
  users.sales2 = await signIn('closing2@demo.archstone.test');
  users.head = await signIn('sitehead@demo.archstone.test');
  users.payments = await signIn('payments@demo.archstone.test');
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold the database file. */ }
});

// ---------- Sign-in ----------
test('wrong and unknown logins are rejected, with no account hints', async () => {
  const c = new Client();
  const a = await c.post('/api/auth/login', { email: 'nobody@test.local', password: 'x' });
  const b = await c.post('/api/auth/login', { email: 'owner@test.local', password: 'wrong' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.data.error, b.data.error);
});

test('repeated wrong passwords lock the attempt', async () => {
  const c = new Client();
  for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { email: 'lock@test.local', password: 'x' });
  assert.equal((await c.post('/api/auth/login', { email: 'lock@test.local', password: 'x' })).status, 429);
});

test('API needs a session, and a temporary password must be replaced first', async () => {
  assert.equal((await new Client().get('/api/leads')).status, 401);
  const c = new Client();
  const email = 'manager@demo.archstone.test';
  await c.post('/api/auth/login', { email, password: passwords()[email] });
  assert.equal((await c.get('/api/leads')).status, 403);
});

// ---------- Permissions ----------
test('a telecaller cannot reach another telecaller\'s lead through list or direct id', async () => {
  const mine = await users.tele1.get('/api/leads');
  const theirs = await users.tele2.get('/api/leads');
  assert.ok(mine.data.leads.length > 0);
  const theirId = theirs.data.leads[0].id;
  assert.ok(!mine.data.leads.some((l: any) => l.id === theirId));
  assert.equal((await users.tele1.get(`/api/leads/${theirId}`)).status, 404);
  assert.equal((await users.tele1.post(`/api/leads/${theirId}/note`, { body: 'hello' })).status, 404);
  assert.equal((await users.tele1.get(`/api/inbox/${theirId}`)).status, 404);
});

test('lower roles cannot use admin functions or export data', async () => {
  for (const c of [users.tele1, users.sales1]) {
    assert.equal((await c.get('/api/users')).status, 403);
    assert.equal((await c.get('/api/settings')).status, 403);
    assert.equal((await c.get('/api/leads/export')).status, 403);
    assert.equal((await c.get('/api/audit')).status, 403);
    assert.equal((await c.post('/api/leads/assign', { lead_ids: [1], owner_id: 1 })).status, 403);
    assert.equal((await c.call('PUT', '/api/users/1', { name: 'Me', email: 'me@test.local', role: 'admin' })).status, 403);
  }
});

test('nobody can change their own role, and user lists never contain password data', async () => {
  const me = (await users.admin.get('/api/auth/me')).data.user;
  const r = await users.admin.call('PUT', `/api/users/${me.id}`, { name: 'Owner', email: me.email, role: 'closing_manager' });
  assert.equal(r.status, 400);
  const list = await users.admin.get('/api/users');
  assert.ok(!JSON.stringify(list.data).includes('scrypt'));
  assert.ok(!JSON.stringify(list.data).includes('password_hash'));
});

test('a site head sees only leads on their own projects', async () => {
  const { data } = await users.head.get('/api/leads');
  assert.ok(data.leads.length > 0);
  assert.ok(data.leads.every((l: any) => ['Skyline Residences', 'Harbour Square'].includes(l.project_name)));
});

test('Payment Follow-up sees only buyers with a booking, and cannot work other leads', async () => {
  const { data } = await users.payments.get('/api/leads');
  assert.equal(data.leads.length, 0, 'no bookings yet, so no buyers to see');
  const any = (await users.admin.get('/api/leads')).data.leads[0];
  assert.equal((await users.payments.post(`/api/leads/${any.id}/note`, { body: 'x' })).status, 404);
  const csv = await users.admin.get('/api/leads/export');
  assert.ok(String(csv.data).includes('+9190000'));
});

test('pausing a user ends their session immediately', async () => {
  const created = await users.admin.post('/api/users', { name: 'Temp Staff', email: 'temp@test.local', role: 'telecaller' });
  const c = new Client();
  await c.post('/api/auth/login', { email: 'temp@test.local', password: created.data.temporaryPassword });
  await c.post('/api/auth/password', { current: created.data.temporaryPassword, next: NEW_PASSWORD });
  assert.equal((await c.get('/api/leads')).status, 200);
  await users.admin.post(`/api/users/${created.data.id}/status`, { status: 'paused' });
  assert.equal((await c.get('/api/leads')).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { email: 'temp@test.local', password: NEW_PASSWORD })).status, 401);
});

// ---------- Lead capture ----------
test('website webhook needs its key, creates an assigned lead and de-duplicates', async () => {
  const bad = await new Client().call('POST', '/webhooks/website', { name: 'X Y', phone: '9811111111' }, { 'x-api-key': 'wrong' });
  assert.equal(bad.status, 401);
  const first = await websiteLead('98111 11111', { project: 'Skyline Residences', whatsapp_consent: true });
  assert.equal(first.status, 201);
  const again = await websiteLead('+919811111111');
  assert.equal(again.data.duplicate, true);
  assert.equal(again.data.id, first.data.id);
  const lead = (await users.admin.get(`/api/leads/${first.data.id}`)).data;
  assert.ok(lead.lead.owner_id, 'lead is auto-assigned');
  assert.ok(lead.timeline.some((a: any) => a.title.includes('Enquired again')));
});

test('invalid phone numbers are refused', async () => {
  assert.equal((await websiteLead('12345')).status, 400);
});

test('a telecaller hands a lead to sales with notes intact', async () => {
  const { data } = await users.tele1.get('/api/leads');
  const lead = data.leads.find((l: any) => l.stage === 'Not Contacted') ?? data.leads[0];
  const dir = (await users.tele1.get('/api/directory')).data.users;
  const sales = dir.find((u: any) => u.role === 'closing_manager');
  const res = await users.tele1.post(`/api/leads/${lead.id}/handoff`, { sales_id: sales.id, notes: 'Keen on 2 BHK, call in evening' });
  assert.equal(res.status, 200);
  const after = (await users.admin.get(`/api/leads/${lead.id}`)).data;
  assert.equal(after.lead.owner_id, sales.id);
  assert.ok(after.timeline.some((a: any) => a.body.includes('Keen on 2 BHK')));
  assert.equal((await users.tele1.get(`/api/leads/${lead.id}`)).status, 200, 'telecaller keeps sight of the lead');
});

// ---------- WhatsApp ----------
test('webhook verification and signature checks hold', async () => {
  const ok = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc`);
  assert.equal(await ok.text(), 'abc');
  const bad = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc`);
  assert.equal(bad.status, 403);
  const forged = await metaPost('/webhooks/whatsapp', inbound('919822222222', 'hi', 'wamid.forged'), 'sha256=00');
  assert.equal(forged.status, 401);
  const search = await users.admin.get('/api/leads?q=919822222222');
  assert.equal(search.data.total, 0);
});

test('a WhatsApp reply reaches the right lead timeline and notifies the owner, once', async () => {
  const { data: created } = await websiteLead('9833333333', { whatsapp_consent: true });
  const msg = inbound('919833333333', 'Is it ready to move?', 'wamid.one');
  assert.equal((await metaPost('/webhooks/whatsapp', msg)).status, 200);
  assert.equal((await metaPost('/webhooks/whatsapp', msg)).status, 200); // Meta retries.
  const lead = (await users.admin.get(`/api/leads/${created.id}`)).data;
  assert.equal(lead.timeline.filter((a: any) => a.body === 'Is it ready to move?').length, 1);
  assert.equal(lead.lead.unread_count, 1);
  const owner = lead.lead.owner_id;
  const dir = (await users.admin.get('/api/directory')).data.users.find((u: any) => u.id === owner);
  assert.equal(dir.role, 'telecaller');
});

test('free-form messages only work inside the 24-hour window', async () => {
  const { data: closed } = await websiteLead('9844444444', { whatsapp_consent: true });
  const res = await users.admin.post(`/api/inbox/${closed.id}/text`, { body: 'Hello' });
  assert.equal(res.status, 422);
  assert.match(res.data.error, /24-hour/);
  await metaPost('/webhooks/whatsapp', inbound('919844444444', 'Hi', 'wamid.two'));
  assert.equal((await users.admin.post(`/api/inbox/${closed.id}/text`, { body: 'Hello' })).status, 201);
});

test('STOP opts a contact out and blocks all further messages', async () => {
  const { data } = await websiteLead('9855555555', { whatsapp_consent: true });
  await metaPost('/webhooks/whatsapp', inbound('919855555555', 'STOP', 'wamid.stop'));
  const res = await users.admin.post(`/api/inbox/${data.id}/text`, { body: 'Please reconsider' });
  assert.equal(res.status, 422);
  const lead = (await users.admin.get(`/api/leads/${data.id}`)).data.lead;
  assert.ok(lead.wa_opted_out_at);
  assert.equal(lead.wa_opt_in, 0);
});

test('template edits lose approval, and bad variables are refused', async () => {
  const bad = await users.admin.post('/api/templates', { name: 'bad_vars', category: 'MARKETING', language: 'en', body: 'Hello {{nope}} there friend' });
  assert.equal(bad.status, 400);
  const made = await users.admin.post('/api/templates', { name: 'test_offer', category: 'MARKETING', language: 'en', body: 'Hello {{name}}, new offer. Reply STOP to opt out.' });
  await users.admin.post(`/api/templates/${made.data.id}/submit`);
  await users.admin.call('PUT', `/api/templates/${made.data.id}`, { name: 'test_offer', category: 'MARKETING', language: 'en', body: 'Hello {{name}}, changed offer. Reply STOP to opt out.' });
  const list = (await users.admin.get('/api/templates')).data.templates;
  assert.equal(list.find((t: any) => t.name === 'test_offer').status, 'draft');
  await users.admin.post(`/api/templates/${made.data.id}/submit`);
});

test('campaign needs approval and a MahaRERA number, and skips ineligible contacts', async () => {
  const projects = (await users.admin.get('/api/projects')).data.projects;
  const square = projects.find((p: any) => p.name === 'Harbour Square');
  const template = (await users.admin.get('/api/templates')).data.templates.find((t: any) => t.name === 'test_offer');
  const body = { name: 'Square offer', template_id: template.id, project_id: square.id, segment: {} };

  const created = await users.tele1.post('/api/campaigns', body);
  assert.equal(created.status, 201);
  assert.equal((await users.tele1.post(`/api/campaigns/${created.data.id}/approve`, { approve: true })).status, 403);

  const blocked = await users.admin.post(`/api/campaigns/${created.data.id}/approve`, { approve: true });
  assert.equal(blocked.status, 422);
  assert.match(blocked.data.error, /MahaRERA/);
  const stillPending = (await users.admin.get('/api/campaigns')).data.campaigns.find((c: any) => c.id === created.data.id);
  assert.equal(stillPending.status, 'pending_approval', 'a blocked campaign is not marked approved');

  await users.admin.call('PUT', `/api/projects/${square.id}`, { ...square, rera_number: 'TEST-ONLY-123', brochure_url: '', verify_note: '' });
  // Admins may broadcast directly, so this one needs no separate approval.
  const ok = await users.admin.post('/api/campaigns', { ...body, name: 'Square offer 2' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.direct, true);
  assert.ok(ok.data.queued > 0);
  const second = { id: ok.data.id };
  await tick();
  const done = (await users.admin.get('/api/campaigns')).data.campaigns.find((c: any) => c.id === second.id);
  assert.equal(done.status, 'sent');
  assert.equal(done.sent, ok.data.queued);
  assert.equal(done.simulated, 1, 'demo sends are labelled as simulated');
});

// ---------- Inventory and bookings ----------
test('two people cannot book the same unit', async () => {
  const projects = (await users.admin.get('/api/projects')).data.projects;
  const bliss = projects.find((p: any) => p.name === 'Skyline Residences');
  const unit = (await users.admin.get(`/api/projects/${bliss.id}/units`)).data.units[0];
  const a = await websiteLead('9866666661', { project: 'Skyline Residences' });
  const b = await websiteLead('9866666662', { project: 'Skyline Residences' });
  const salesUser = (await users.sales1.get('/api/auth/me')).data.user;
  await users.admin.post('/api/leads/assign', { lead_ids: [a.data.id, b.data.id], owner_id: salesUser.id });

  // Closing Managers cannot book, so the Site Head asks. A second request for the same flat is refused at once.
  const r1 = await users.head.post('/api/approvals', { type: 'booking', lead_id: a.data.id, unit_id: unit.id, amount_lakhs: 95 });
  const r2 = await users.head.post('/api/approvals', { type: 'booking', lead_id: b.data.id, unit_id: unit.id, amount_lakhs: 95 });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 409);
  assert.equal((await users.admin.post(`/api/approvals/${r1.data.id}/review`, { approve: true })).status, 200);
  assert.equal((await users.head.post('/api/approvals', { type: 'booking', lead_id: b.data.id, unit_id: unit.id, amount_lakhs: 95 })).status, 409, 'booked flats cannot be requested');
  assert.equal((await users.sales1.post(`/api/units/${unit.id}/hold`, { lead_id: b.data.id })).status, 409);
  assert.equal((await users.admin.get(`/api/leads/${a.data.id}`)).data.lead.stage, 'Booked');
  assert.equal((await users.admin.get(`/api/leads/${b.data.id}`)).data.lead.stage, 'Not Contacted');
});

test('bookings cannot be faked by changing the stage, or approved by the requester', async () => {
  const a = await websiteLead('9866666663', { project: 'Skyline Residences' });
  assert.equal((await users.admin.post(`/api/leads/${a.data.id}/stage`, { stage: 'Booked' })).status, 400);
  const sales = (await users.sales1.get('/api/auth/me')).data.user;
  await users.admin.post('/api/leads/assign', { lead_ids: [a.data.id], owner_id: sales.id });
  const bliss = (await users.admin.get('/api/projects')).data.projects.find((p: any) => p.name === 'Skyline Residences');
  const unit = (await users.admin.get(`/api/projects/${bliss.id}/units`)).data.units.find((u: any) => u.status === 'Available');
  const big = await users.sales1.post('/api/approvals', { type: 'discount', lead_id: a.data.id, unit_id: unit.id, amount_lakhs: 90, discount_percent: 5 });
  assert.equal((await users.sales1.post(`/api/approvals/${big.data.id}/review`, { approve: true })).status, 403);
  const head = await users.head.post(`/api/approvals/${big.data.id}/review`, { approve: true });
  assert.equal(head.status, 403);
  assert.match(head.data.error, /admin/);
});

test('a held unit releases itself when the time runs out', async () => {
  const bliss = (await users.admin.get('/api/projects')).data.projects.find((p: any) => p.name === 'Skyline Residences');
  const unit = (await users.admin.get(`/api/projects/${bliss.id}/units`)).data.units.find((u: any) => u.status === 'Available');
  const a = await websiteLead('9866666664', { project: 'Skyline Residences' });
  assert.equal((await users.admin.post(`/api/units/${unit.id}/hold`, { lead_id: a.data.id })).status, 200);
  const { run } = await import('../server/db.ts');
  run(`UPDATE units SET hold_until = '2000-01-01 00:00:00' WHERE id = ?`, unit.id);
  await tick();
  const after = (await users.admin.get(`/api/projects/${bliss.id}/units`)).data.units.find((u: any) => u.id === unit.id);
  assert.equal(after.status, 'Available');
});

test('site visit check-in needs the right code', async () => {
  const a = await websiteLead('9877777777', { project: 'Skyline Residences', whatsapp_consent: true });
  const sales = (await users.sales2.get('/api/auth/me')).data.user;
  await users.admin.post('/api/leads/assign', { lead_ids: [a.data.id], owner_id: sales.id });
  const bliss = (await users.admin.get('/api/projects')).data.projects.find((p: any) => p.name === 'Skyline Residences');
  const when = new Date(Date.now() + 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const visit = await users.sales2.post('/api/visits', { lead_id: a.data.id, project_id: bliss.id, scheduled_at: when });
  assert.equal(visit.status, 201);
  assert.equal(visit.data.whatsapp_sent, true);
  assert.ok(!JSON.stringify(await users.sales2.get('/api/visits')).includes('"otp"'));
  assert.equal((await users.sales2.post(`/api/visits/${visit.data.id}/checkin`, { otp: '000000' })).status, 400);
  assert.equal((await users.sales2.post(`/api/visits/${visit.data.id}/checkin`, { override_reason: 'phone dead' })).status, 403);
  const inbox = (await users.admin.get(`/api/inbox/${a.data.id}`)).data.messages;
  const code = inbox.map((m: any) => m.body.match(/\b\d{6}\b/)?.[0]).find(Boolean);
  assert.equal((await users.sales2.post(`/api/visits/${visit.data.id}/checkin`, { otp: code })).status, 200);
});

// ---------- Reports and privacy ----------
test('dashboard and reports load for each permitted role', async () => {
  for (const c of Object.values(users)) assert.equal((await c.get('/api/dashboard')).status, 200);
  assert.equal((await users.admin.get('/api/reports')).status, 200);
  assert.equal((await users.tele1.get('/api/reports')).status, 403);
  const head = await users.head.get('/api/reports');
  assert.equal(head.data.canSeeSpend, false);
});

test('erasing a contact removes their identity, and is logged', async () => {
  const { data } = await websiteLead('9888888888');
  assert.equal((await users.admin.post(`/api/leads/${data.id}/erase`)).status, 200);
  const search = await users.admin.get('/api/leads?q=9888888888');
  assert.equal(search.data.total, 0);
  const audit = await users.admin.get('/api/audit');
  assert.ok(audit.data.entries.some((e: any) => e.action === 'lead.erase'));
});

test('seeded text keeps its rupee sign and arrows intact', async () => {
  const projects = (await users.admin.get('/api/projects')).data.projects;
  assert.ok(projects.find((p: any) => p.name === 'Skyline Residences').verify_note.includes('₹90'));
  const lead = (await users.admin.get('/api/leads')).data.leads[0];
  await users.admin.post(`/api/leads/${lead.id}/stage`, { stage: 'Future Prospect' });
  const timeline = (await users.admin.get(`/api/leads/${lead.id}`)).data.timeline;
  assert.ok(timeline.some((a: any) => a.title.includes('→ Future Prospect')));
});

test('exported cells cannot run as spreadsheet formulas', async () => {
  await users.admin.post('/api/leads', { name: '=HYPERLINK("x")', phone: '9899999999' });
  const csv = await users.admin.get('/api/leads/export');
  assert.ok(String(csv.data).includes(`"'=HYPERLINK`));
});
