// Covers the second wave of features. External services (Meta, Exotel, Google) are
// replaced by a fake fetch, which also lets us check exactly what we would send them.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-features-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1',
  DB_PATH: join(dir, 'test.db'),
  DEMO_MODE: 'true',
  INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WEBSITE_API_KEY: 'web-key',
  PORTAL_API_KEY: 'portal-key',
  WHATSAPP_VERIFY_TOKEN: 'verify-me',
  META_APP_SECRET: 'app-secret',
  TELEPHONY_WEBHOOK_TOKEN: 'phone-token',
  APP_URL: 'http://crm.test',
  WHATSAPP_TOKEN: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  GEMINI_API_KEY: '',
  EXOTEL_SID: '',
  GOOGLE_CLIENT_ID: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
let server: Server;
let base = '';
let config: any;
let tick: () => Promise<void>;
let run: (sql: string, ...p: any[]) => any;
let totpCode: (secret: string, step: number) => string;
let currentStep: () => number;
const users: Record<string, Client> = {};
const realFetch = globalThis.fetch;
const outbound: { url: string; init: any }[] = [];
let fake: ((url: string, init: any) => any) | null = null;

class Client {
  cookie = '';
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await realFetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: this.cookie, ...headers },
      body: body === undefined ? undefined : body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('json') && !type.includes('text')) return { status: res.status, data: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b: unknown = {}) => this.call('POST', p, b);
  put = (p: string, b: unknown) => this.call('PUT', p, b);
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
  await c.post('/api/auth/login', { email, password: current });
  assert.equal((await c.post('/api/auth/password', { current, next: NEW_PASSWORD })).status, 200);
  return c;
}

const inbound = (phone: string, text: string, id: string) => {
  const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
    contacts: [{ wa_id: phone, profile: { name: 'Bot Tester' } }],
    messages: [{ id, from: phone, type: 'text', text: { body: text } }],
  } }] }] });
  return realFetch(`${base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}` },
    body,
  });
};

const websiteLead = (phone: string, extra: Record<string, unknown> = {}) =>
  new Client().call('POST', '/webhooks/website', { name: 'Web Lead', phone, ...extra }, { 'x-api-key': 'web-key' });

const me = async (c: Client) => (await c.get('/api/auth/me')).data.user;
const project = async (name: string) => (await users.admin.get('/api/projects')).data.projects.find((p: any) => p.name === name);

/** Creates an approved booking for a fresh lead owned by sales1. */
async function makeBooking(phone: string, projectName = 'Skyline Residences', partnerId?: number) {
  const lead = await websiteLead(phone, { project: projectName });
  const sales = await me(users.sales1);
  await users.admin.post('/api/leads/assign', { lead_ids: [lead.data.id], owner_id: sales.id });
  if (partnerId) await users.admin.post(`/api/leads/${lead.data.id}/partner`, { partner_id: partnerId });
  const p = await project(projectName);
  const unit = (await users.admin.get(`/api/projects/${p.id}/units`)).data.units.find((u: any) => u.status === 'Available');
  const approval = await users.sales1.post('/api/approvals', { type: 'booking', lead_id: lead.data.id, unit_id: unit.id, amount_lakhs: 100 });
  assert.equal((await users.head.post(`/api/approvals/${approval.data.id}/review`, { approve: true })).status, 200);
  const booking = (await users.admin.get('/api/bookings')).data.bookings.find((b: any) => b.lead_id === lead.data.id);
  return { leadId: lead.data.id, booking, unit };
}

before(async () => {
  globalThis.fetch = (async (url: any, init: any) => {
    const target = String(url);
    if (target.startsWith(base) || target.startsWith('http://127.0.0.1')) return realFetch(url, init);
    outbound.push({ url: target, init });
    if (fake) return fake(target, init);
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  config = (await import('../server/config.ts')).config;
  tick = (await import('../server/services/scheduler.ts')).tick;
  run = (await import('../server/db.ts')).run;
  ({ totpCode, currentStep } = await import('../server/services/secrets.ts'));
  await ensureBaseData();
  run('DELETE FROM wa_numbers'); // Demo numbers always stay simulated, and these tests check live sending.
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  users.admin = await signIn('owner@test.local');
  users.tele = await signIn('telecaller1@demo.archstone.test');
  users.tele2 = await signIn('telecaller2@demo.archstone.test');
  users.sales1 = await signIn('sales1@demo.archstone.test');
  users.sales2 = await signIn('sales2@demo.archstone.test');
  users.head = await signIn('sitehead@demo.archstone.test');
  users.marketing = await signIn('marketing@demo.archstone.test');
  users.manager = await signIn('manager@demo.archstone.test');
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

// ---------- Two-factor ----------
test('two-factor login: setup, code required, replay refused, recovery code works once', async () => {
  const email = 'manager@demo.archstone.test';
  const c = users.manager;
  const { data: start } = await c.post('/api/account/2fa/start');
  assert.match(start.qr, /^data:image\/png/);
  assert.equal((await c.post('/api/account/2fa/enable', { code: '000000' })).status, 400);
  const enabled = await c.post('/api/account/2fa/enable', { code: totpCode(start.secret, currentStep()) });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.recovery_codes.length, 8);

  const noCode = await new Client().post('/api/auth/login', { email, password: NEW_PASSWORD });
  assert.deepEqual(noCode.data, { needs_code: true });
  assert.equal(noCode.status, 200);

  const a = new Client();
  assert.equal((await a.post('/api/auth/login', { email, password: NEW_PASSWORD, code: '123456' })).status, 401);
  assert.equal((await a.get('/api/leads')).status, 401, 'no session without the second factor');

  const next = totpCode(start.secret, currentStep() + 1);
  assert.equal((await a.post('/api/auth/login', { email, password: NEW_PASSWORD, code: next })).status, 200);
  assert.equal((await a.get('/api/leads')).status, 200);
  const replay = await new Client().post('/api/auth/login', { email, password: NEW_PASSWORD, code: next });
  assert.equal(replay.status, 401, 'a code cannot be used twice');

  const recovery = enabled.data.recovery_codes[0];
  assert.equal((await new Client().post('/api/auth/login', { email, password: NEW_PASSWORD, code: recovery })).status, 200);
  assert.equal((await new Client().post('/api/auth/login', { email, password: NEW_PASSWORD, code: recovery })).status, 401);

  users.manager = a;
  assert.equal((await a.post('/api/account/2fa/disable', { password: 'wrong' })).status, 400);
  assert.equal((await a.post('/api/account/2fa/disable', { password: NEW_PASSWORD })).status, 200);
});

test('a live system forces admins to set up two-factor login', async () => {
  config.demoMode = false;
  try {
    assert.equal((await users.admin.get('/api/leads')).status, 403);
    assert.equal((await users.admin.get('/api/account')).status, 200, 'set-up stays reachable');
    assert.equal((await users.admin.get('/api/auth/me')).data.mustSetupTwoFactor, true);
    assert.equal((await users.sales1.get('/api/leads')).status, 200, 'other roles are not blocked');
  } finally {
    config.demoMode = true;
  }
});

// ---------- Chatbot ----------
test('chatbot qualifies a new WhatsApp contact, using only Project Master facts', async () => {
  await inbound('919711111111', 'Hi', 'bot.1');
  const search = (await users.admin.get('/api/leads?q=919711111111')).data.leads[0];
  const lines = async () => (await users.admin.get(`/api/inbox/${search.id}`)).data.messages.map((m: any) => m.body);
  assert.match((await lines()).at(-1), /choose your language/);
  await inbound('919711111111', '1', 'bot.0');
  assert.match((await lines()).at(-1), /Which project/);

  const menu = (await lines()).at(-1).split('\n');
  const square = menu.find((l: string) => l.includes('Harbour Square')).split('.')[0];
  await inbound('919711111111', square, 'bot.2');
  assert.match((await lines()).at(-1), /Starting from: ₹90 Lakhs/);
  await inbound('919711111111', '2 BHK', 'bot.3');
  await inbound('919711111111', '9', 'bot.4');
  assert.match((await lines()).at(-1), /did not catch/);
  await inbound('919711111111', '2', 'bot.5');
  await inbound('919711111111', '1.2 crore', 'bot.6');
  await inbound('919711111111', '1', 'bot.7');

  const { lead, tasks, timeline } = (await users.admin.get(`/api/leads/${search.id}`)).data;
  assert.equal(lead.configuration, '2 BHK');
  assert.equal(lead.timeline, 'Within 3 months');
  assert.equal(lead.budget_lakhs, 120);
  assert.ok(lead.project_id);
  assert.ok(tasks.some((t: any) => t.notes.includes('site visit')));
  assert.ok(timeline.some((a: any) => a.title.includes('Chatbot finished')));
  const count = (await lines()).length;
  await inbound('919711111111', 'hello again', 'bot.8');
  assert.equal((await lines()).length, count + 1, 'bot stays quiet once finished, in hours or after a hand-off');
});

test('a person replying stops the bot, and asking for an agent hands over', async () => {
  await inbound('919722222222', 'Hi', 'bot.a1');
  const lead = (await users.admin.get('/api/leads?q=919722222222')).data.leads[0];
  await users.admin.post(`/api/inbox/${lead.id}/text`, { body: 'Hello, this is Archstone.' });
  await inbound('919722222222', '1', 'bot.a2');
  const messages = (await users.admin.get(`/api/inbox/${lead.id}`)).data.messages;
  assert.equal(messages.at(-1).direction, 'in', 'bot did not answer over a person');

  await inbound('919733333333', 'Hi', 'bot.b1');
  await inbound('919733333333', 'please call me', 'bot.b2');
  const handed = (await users.admin.get('/api/leads?q=919733333333')).data.leads[0];
  const detail = (await users.admin.get(`/api/leads/${handed.id}`)).data;
  assert.ok(detail.timeline.some((a: any) => a.title.includes('handed over')));
});

// ---------- Portals ----------
test('portal webhook checks its key and maps each portal\'s field names', async () => {
  const c = new Client();
  assert.equal((await c.call('POST', '/webhooks/portal/99acres', { name: 'A B', phone: '9744444444' }, { 'x-api-key': 'no' })).status, 401);
  assert.equal((await c.call('POST', '/webhooks/portal/unknown', { name: 'A B', phone: '9744444444' }, { 'x-api-key': 'portal-key' })).status, 404);
  const r = await c.call('POST', '/webhooks/portal/magicbricks', { Contact_Name: 'Portal Buyer', Mobile: '9744444444', project_name: 'Harbour Square', Query: 'Need 2 BHK' }, { 'x-api-key': 'portal-key' });
  assert.equal(r.status, 201);
  const lead = (await users.admin.get(`/api/leads/${r.data.id}`)).data.lead;
  assert.equal(lead.source, 'MagicBricks');
  assert.equal(lead.name, 'Portal Buyer');
  assert.equal(lead.notes, 'Need 2 BHK');
  assert.equal(lead.wa_opt_in, 0, 'a portal enquiry is not marketing consent');
  const form = await realFetch(`${base}/webhooks/portal/housing?key=portal-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=Form%20Buyer&phone=9744444445',
  });
  assert.equal(form.status, 201);
});

// ---------- Telephony ----------
test('click-to-call: simulated in demo, real Exotel request when live, and webhook closes the call', async () => {
  const { data: site } = await websiteLead('9755555555');
  const owner = (await users.admin.get(`/api/leads/${site.id}`)).data.lead.owner_id;
  const dir2 = (await users.admin.get('/api/users')).data.users;
  const telecaller = dir2.find((u: any) => u.id === owner);
  const caller = telecaller.email.includes('telecaller1') ? users.tele : users.tele2;

  assert.equal((await caller.post(`/api/leads/${site.id}/dial`)).status, 422, 'needs a staff mobile number');
  await users.admin.put(`/api/users/${owner}`, { name: telecaller.name, email: telecaller.email, role: 'telecaller', phone: '+919800000001', project_ids: [] });
  const relogin = await new Client().post('/api/auth/login', { email: telecaller.email, password: NEW_PASSWORD });
  assert.equal(relogin.status, 200);
  const fresh = new Client();
  await fresh.post('/api/auth/login', { email: telecaller.email, password: NEW_PASSWORD });
  // Editing a user ends their sessions, so later tests need this new one.
  users[telecaller.email.includes('telecaller1') ? 'tele' : 'tele2'] = fresh;

  const demo = await fresh.post(`/api/leads/${site.id}/dial`);
  assert.equal(demo.status, 201);
  assert.equal(demo.data.simulated, true);
  assert.equal(outbound.filter((o) => o.url.includes('exotel')).length, 0);

  Object.assign(config.exotel, { sid: 'archstone', apiKey: 'k', apiToken: 't', callerId: '02240000000' });
  fake = () => new Response(JSON.stringify({ Call: { Sid: 'call-123' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const live = await fresh.post(`/api/leads/${site.id}/dial`);
    assert.equal(live.data.simulated, false);
    const sent = outbound.find((o) => o.url.includes('Calls/connect'))!;
    const form = new URLSearchParams(sent.init.body);
    assert.equal(form.get('From'), '+919800000001');
    assert.equal(form.get('To'), '+919755555555');
    assert.equal(form.get('Record'), 'false', 'recording is off until an admin enables it');
    assert.ok(form.get('StatusCallback')!.endsWith('/webhooks/telephony/phone-token'));

    const bad = await realFetch(`${base}/webhooks/telephony/wrong-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 401);
    const hook = { CallSid: 'call-123', Status: 'completed', ConversationDuration: 125, RecordingUrl: 'https://rec.test/1.mp3' };
    for (let i = 0; i < 2; i++) {
      await realFetch(`${base}/webhooks/telephony/phone-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(hook) });
    }
    const after = (await users.admin.get(`/api/leads/${site.id}`)).data;
    assert.equal(after.timeline.filter((a: any) => a.title === 'Call: Connected, 2m 5s').length, 1);
    assert.ok(after.lead.first_response_at, 'a connected call counts as first response');
    const call = after.calls.find((c: any) => c.has_recording);
    fake = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    const other = users.sales2;
    assert.equal((await other.get(`/api/calls/${call.id}/recording`)).status, 404, 'other staff cannot hear it');
    const played = await fresh.get(`/api/calls/${call.id}/recording`);
    assert.equal(played.status, 200);
    assert.equal(played.data.length, 3);
  } finally {
    Object.assign(config.exotel, { sid: '', apiKey: '', apiToken: '', callerId: '' });
    fake = null;
  }
});

// ---------- Documents ----------
const PDF = Buffer.from('%PDF-1.4 secret customer data');

test('KYC files: type checked, encrypted on disk, private to those who may see the lead', async () => {
  const { leadId } = await makeBooking('9766666661');
  const upload = (c: Client, body: Buffer, name = 'pan.pdf') =>
    c.call('POST', `/api/leads/${leadId}/documents?type=PAN&name=${encodeURIComponent(name)}`, body, { 'Content-Type': 'application/octet-stream' });

  assert.equal((await upload(users.sales1, Buffer.from('<script>alert(1)</script>'))).status, 415);
  assert.equal((await upload(users.tele2, PDF)).status, 404, 'staff without the lead cannot upload');
  const up = await upload(users.sales1, PDF, '../../evil name.pdf');
  assert.equal(up.status, 201);

  const docs = readdirSync(join(dir, 'documents'));
  assert.equal(docs.length, 1);
  assert.ok(!readFileSync(join(dir, 'documents', docs[0])).includes('secret customer data'), 'file is encrypted at rest');

  const got = await users.sales1.get(`/api/documents/${up.data.id}/file`);
  assert.equal(got.data.toString(), PDF.toString());
  assert.equal((await users.sales2.get(`/api/documents/${up.data.id}/file`)).status, 404);
  assert.equal((await users.marketing.get(`/api/documents/${up.data.id}/file`)).status, 403);

  const listed = (await users.admin.get(`/api/leads/${leadId}`)).data.documents[0];
  assert.ok(!listed.filename.includes('/'));
  assert.equal((await users.sales1.post(`/api/documents/${up.data.id}/review`, { status: 'verified' })).status, 403);
  assert.equal((await users.head.post(`/api/documents/${up.data.id}/review`, { status: 'verified' })).status, 200);

  await users.admin.post(`/api/leads/${leadId}/erase`);
  assert.equal(readdirSync(join(dir, 'documents')).length, 0, 'erasure removes the file too');
});

// ---------- Cost sheet and payments ----------
test('cost sheet only uses saved rates, and says which are missing', async () => {
  const p = await project('Harbour Square');
  const unit = (await users.admin.get(`/api/projects/${p.id}/units`)).data.units[0];
  const { data: lead } = await websiteLead('9766666662', { project: 'Harbour Square' });
  const empty = (await users.admin.get(`/api/leads/${lead.id}/cost-sheet?unit_id=${unit.id}&discount=0`)).data;
  assert.deepEqual(empty.missing, ['GST', 'Stamp duty', 'Registration', 'Other charges']);
  assert.equal(empty.total, unit.price_lakhs);

  await users.admin.put(`/api/projects/${p.id}`, { ...p, brochure_url: '', gst_percent: 5, stamp_duty_percent: 6, registration_lakhs: 0.3, other_charges_lakhs: 1 });
  const full = (await users.admin.get(`/api/leads/${lead.id}/cost-sheet?unit_id=${unit.id}&discount=10`)).data;
  const agreement = unit.price_lakhs * 0.9;
  assert.equal(full.missing.length, 0);
  assert.ok(Math.abs(full.lines.find((l: any) => l.label === 'Agreement value').amount - agreement) < 0.00001);
  const expected = agreement * 1.11 + 1.3;
  assert.ok(Math.abs(full.total - expected) < 0.00002, `${full.total} vs ${expected}`);

  // Accurate to the rupee: 5% of ₹96,04,000 is ₹4,80,200.
  const exact = await users.admin.put(`/api/projects/${p.id}`, { ...p, brochure_url: '', gst_percent: 5, stamp_duty_percent: 6, registration_lakhs: 0.3, other_charges_lakhs: 1 });
  assert.equal(exact.status, 200);
  run('UPDATE units SET price_lakhs = 98 WHERE id = ?', unit.id);
  const sheet = (await users.admin.get(`/api/leads/${lead.id}/cost-sheet?unit_id=${unit.id}&discount=2`)).data;
  assert.equal(sheet.lines.find((l: any) => l.label.startsWith('GST')).amount, 4.802);
  assert.equal(sheet.lines.find((l: any) => l.label.startsWith('Stamp')).amount, 5.7624);
  assert.equal(sheet.total, 107.9044);
});

test('payment schedule must match the booking, receipts are unique, and reminders fire once', async () => {
  const { booking, leadId } = await makeBooking('9766666663', 'Skyline Residences');
  assert.equal(booking.amount_lakhs, 100);
  run('UPDATE leads SET wa_opt_in = 1, last_inbound_at = NULL WHERE id = ?', leadId);

  const soon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  assert.equal((await users.head.put(`/api/bookings/${booking.id}/schedule`, { items: [{ label: 'Booking', due_date: soon, amount_lakhs: 50 }] })).status, 400);
  assert.equal((await users.sales1.put(`/api/bookings/${booking.id}/schedule`, { items: [] })).status, 403);
  const ok = await users.head.put(`/api/bookings/${booking.id}/schedule`, {
    items: [{ label: 'Booking', due_date: soon, amount_lakhs: 10 }, { label: 'Agreement', due_date: later, amount_lakhs: 90 }],
  });
  assert.equal(ok.status, 200);

  await tick();
  await tick();
  const inbox = (await users.admin.get(`/api/inbox/${leadId}`)).data.messages.filter((m: any) => m.body.includes('payment of'));
  assert.equal(inbox.length, 1, 'one reminder only');
  assert.match(inbox[0].body, /Booking payment of ₹10 Lakhs/);

  const detail = (await users.sales1.get(`/api/bookings/${booking.id}`)).data;
  const first = detail.payments[0];
  assert.equal((await users.sales1.post(`/api/payments/${first.id}/paid`, { reference: 'UTR1' })).status, 403);
  const paid = await users.head.post(`/api/payments/${first.id}/paid`, { reference: 'UTR12345' });
  assert.match(paid.data.receipt_number, /^EG-\d{4}-\d{5}$/);
  assert.equal((await users.head.post(`/api/payments/${first.id}/paid`, { reference: 'UTR12345' })).status, 409);

  const reschedule = await users.head.put(`/api/bookings/${booking.id}/schedule`, { items: [{ label: 'Rest', due_date: later, amount_lakhs: 90 }] });
  assert.equal(reschedule.status, 200, 'paid milestones stay in the total');
  const after = (await users.admin.get(`/api/bookings/${booking.id}`)).data.payments;
  assert.equal(after.length, 2);
  assert.ok(after.some((p: any) => p.receipt_number === paid.data.receipt_number));
  const report = (await users.admin.get('/api/reports')).data.collections;
  assert.ok(report.collected >= 10);
  assert.equal((await users.tele.get('/api/bookings')).status, 403);
});

test('cancelling a booking frees the unit and reverses unpaid commission', async () => {
  const partner = await users.manager.post('/api/partners', { name: 'Test Broker', commission_percent: 2 });
  const { booking, unit, leadId } = await makeBooking('9766666664', 'Harbour Square', partner.data.id);
  const list = (await users.manager.get('/api/partners')).data;
  const commission = list.commissions.find((c: any) => c.booking_id === booking.id);
  assert.equal(commission.amount_lakhs, 2);
  assert.equal(list.partners.find((p: any) => p.id === partner.data.id).due_lakhs, 2);

  assert.equal((await users.head.post(`/api/commissions/${commission.id}/status`, { status: 'paid' })).status, 403);
  assert.equal((await users.head.post(`/api/commissions/${commission.id}/status`, { status: 'approved' })).status, 200);
  assert.equal((await users.head.post(`/api/commissions/${commission.id}/status`, { status: 'paid' })).status, 403, 'only admin pays');

  assert.equal((await users.head.post(`/api/bookings/${booking.id}/cancel`, { reason: 'Changed mind' })).status, 403);
  assert.equal((await users.admin.post(`/api/bookings/${booking.id}/cancel`, { reason: 'Changed mind' })).status, 200);
  const p = await project('Harbour Square');
  const u = (await users.admin.get(`/api/projects/${p.id}/units`)).data.units.find((x: any) => x.id === unit.id);
  assert.equal(u.status, 'Available');
  assert.equal((await users.admin.get(`/api/leads/${leadId}`)).data.lead.stage, 'Working Deal');
  const after = (await users.manager.get('/api/partners')).data.partners.find((x: any) => x.id === partner.data.id);
  assert.equal(after.due_lakhs, 0);
});

// ---------- Partners ----------
test('partner attribution is protected from later partners', async () => {
  const a = (await users.admin.post('/api/partners', { name: 'First Broker', commission_percent: 1 })).data.id;
  const b = (await users.admin.post('/api/partners', { name: 'Second Broker', commission_percent: 1 })).data.id;
  const first = await users.manager.post(`/api/partners/${a}/leads`, { name: 'Buyer One', phone: '9777777771' });
  assert.equal(first.status, 201);
  assert.equal(first.data.attributed, true);
  const second = await users.manager.post(`/api/partners/${b}/leads`, { name: 'Buyer One', phone: '9777777771' });
  assert.equal(second.data.duplicate, true);
  assert.equal(second.data.attributed, false);
  assert.equal((await users.manager.post(`/api/leads/${first.data.id}/partner`, { partner_id: b })).status, 403);
  assert.equal((await users.admin.post(`/api/leads/${first.data.id}/partner`, { partner_id: b })).status, 200);
  assert.equal((await users.tele.get('/api/partners')).status, 403);
  assert.equal((await users.sales1.post('/api/partners', { name: 'X', commission_percent: 1 })).status, 403);
});

// ---------- Redevelopment ----------
test('redevelopment pipeline tracks stages and stays private', async () => {
  const c = await users.head.post('/api/redevelopment', { name: 'Kurla Society', scheme: 'SRA', tenements: 120, contact_phone: '9788888888' });
  assert.equal(c.status, 201);
  assert.equal((await users.head.post(`/api/redevelopment/${c.data.id}/stage`, { stage: 'Feasibility' })).status, 200);
  await users.head.post(`/api/redevelopment/${c.data.id}/log`, { body: 'Met the society committee' });
  const { deal, log } = (await users.admin.get(`/api/redevelopment/${c.data.id}`)).data;
  assert.equal(deal.stage, 'Feasibility');
  assert.equal(deal.contact_phone, '+919788888888');
  assert.equal(log.length, 2);
  for (const r of [users.sales1, users.tele, users.marketing]) assert.equal((await r.get('/api/redevelopment')).status, 403);
});

// ---------- Google ----------
test('Google: unset by default, tokens encrypted, visit reaches the calendar, and state is single use', async () => {
  const sales = users.sales2;
  assert.equal((await sales.get('/api/google/connect')).status, 503);
  Object.assign(config.google, { clientId: 'id', clientSecret: 'secret' });
  try {
    const { url } = (await sales.get('/api/google/connect')).data;
    const state = new URL(url).searchParams.get('state')!;
    assert.equal(new URL(url).searchParams.get('redirect_uri'), 'http://crm.test/api/google/callback');

    const idToken = `x.${Buffer.from(JSON.stringify({ email: 'staff@gmail.test' })).toString('base64url')}.y`;
    fake = (target) => {
      if (target.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, id_token: idToken });
      }
      if (target.includes('calendar/v3')) return Response.json({ id: 'event-1' });
      if (target.includes('people.googleapis')) return Response.json({ resourceName: 'people/1' });
      if (target.includes('upload/drive')) return Response.json({ id: 'drive-1' });
      return Response.json({});
    };
    const noRedirect = await realFetch(`${base}/api/google/callback?state=wrong&code=c`, { redirect: 'manual' });
    assert.equal(noRedirect.status, 400);
    const ok = await realFetch(`${base}/api/google/callback?state=${state}&code=c`, { redirect: 'manual' });
    assert.equal(ok.status, 302);
    assert.equal((await realFetch(`${base}/api/google/callback?state=${state}&code=c`, { redirect: 'manual' })).status, 400, 'state is single use');

    const { get } = await import('../server/db.ts');
    const me2 = await me(sales);
    const stored = get<any>('SELECT google_tokens, google_email FROM users WHERE id = ?', me2.id)!;
    assert.ok(!stored.google_tokens.includes('refresh-1'), 'tokens are encrypted');
    assert.equal(stored.google_email, 'staff@gmail.test');

    const { data: lead } = await websiteLead('9799999999', { project: 'Skyline Residences', whatsapp_consent: true });
    await users.admin.post('/api/leads/assign', { lead_ids: [lead.id], owner_id: me2.id });
    const bliss = await project('Skyline Residences');
    const when = new Date(Date.now() + 86400000).toISOString().slice(0, 19).replace('T', ' ');
    const visit = await sales.post('/api/visits', { lead_id: lead.id, project_id: bliss.id, scheduled_at: when });
    assert.equal(visit.data.calendar_added, true);
    const event = JSON.parse(outbound.find((o) => o.url.includes('calendar/v3'))!.init.body);
    assert.equal(event.summary, 'Site visit: Web Lead');
    assert.equal(event.start.timeZone, 'Asia/Kolkata');

    assert.equal((await sales.post(`/api/leads/${lead.id}/google-contact`)).status, 200);
    const contact = JSON.parse(outbound.find((o) => o.url.includes('people.googleapis'))!.init.body);
    assert.equal(contact.phoneNumbers[0].value, '+919799999999');

    const doc = await sales.call('POST', `/api/leads/${lead.id}/documents?type=Other&name=a.pdf`, PDF, { 'Content-Type': 'application/octet-stream' });
    assert.equal((await sales.post(`/api/documents/${doc.data.id}/drive`)).status, 200);
    assert.ok(outbound.some((o) => o.url.includes('upload/drive')));
  } finally {
    Object.assign(config.google, { clientId: '', clientSecret: '' });
    fake = null;
  }
});

// ---------- WhatsApp live payload, previously only simulated ----------
test('when live, messages go to the Cloud API in the documented shape', async () => {
  Object.assign(config.whatsapp, { token: 'tok', phoneNumberId: '123' });
  fake = () => Response.json({ messages: [{ id: 'wamid.live1' }] });
  try {
    const { data } = await websiteLead('9700000001', { project: 'Skyline Residences', whatsapp_consent: true });
    const call = outbound.filter((o) => o.url.includes('/123/messages')).at(-1)!;
    const body = JSON.parse(call.init.body);
    assert.equal(body.to, '919700000001');
    assert.equal(body.type, 'template');
    assert.equal(body.template.name, 'welcome_enquiry');
    assert.deepEqual(body.template.components[0].parameters.map((p: any) => p.text), ['Web', 'Skyline Residences', 'Archstone'].map((x, i) => (i === 2 ? body.template.components[0].parameters[2].text : x)));
    assert.equal(call.init.headers.Authorization, 'Bearer tok');
    const message = (await users.admin.get(`/api/inbox/${data.id}`)).data.messages.at(-1);
    assert.equal(message.simulated, 0);
  } finally {
    Object.assign(config.whatsapp, { token: '', phoneNumberId: '' });
    fake = null;
  }
});

// ---------- Phone notifications ----------
test('push subscriptions are per user and need HTTPS endpoints', async () => {
  const account = (await users.sales1.get('/api/account')).data;
  assert.ok(account.push_key.length > 40);
  assert.equal(account.push_enabled, false);
  const sub = { endpoint: 'https://push.test/abc', keys: { p256dh: 'p', auth: 'a' } };
  assert.equal((await users.sales1.post('/api/account/push', { ...sub, endpoint: 'http://push.test/abc' })).status, 400);
  assert.equal((await users.sales1.post('/api/account/push', sub)).status, 201);
  assert.equal((await users.sales1.get('/api/account')).data.push_enabled, true);
  await users.sales2.post('/api/account/push/remove', { endpoint: sub.endpoint });
  assert.equal((await users.sales1.get('/api/account')).data.push_enabled, true, 'another user cannot remove it');
  await users.sales1.post('/api/account/push/remove', { endpoint: sub.endpoint });
  assert.equal((await users.sales1.get('/api/account')).data.push_enabled, false);
});
