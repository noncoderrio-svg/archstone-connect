// Admin control: permissions, own numbers and inboxes, broadcasts, files, assistant, monitoring.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-control-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1',
  DB_PATH: join(dir, 'test.db'),
  DEMO_MODE: 'true',
  INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WEBSITE_API_KEY: 'web-key',
  META_APP_SECRET: 'app-secret',
  APP_URL: 'https://crm.test',
  WHATSAPP_TOKEN: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  GEMINI_API_KEY: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
let server: Server;
let base = '';
let db: any;
let config: any;
let scheduler: any;
const users: Record<string, Client> = {};
const ids: Record<string, number> = {};
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

async function signIn(name: string, email: string) {
  const c = new Client();
  const current = passwords()[email];
  await c.post('/api/auth/login', { email, password: current });
  assert.equal((await c.post('/api/auth/password', { current, next: NEW_PASSWORD })).status, 200);
  users[name] = c;
  ids[name] = (await c.get('/api/auth/me')).data.user.id;
}

const inbound = (phone: string, text: string, id: string, phoneNumberId: string) => {
  const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: phoneNumberId },
    contacts: [{ wa_id: phone, profile: { name: 'Number Tester' } }],
    messages: [{ id, from: phone, type: 'text', text: { body: text } }],
  } }] }] });
  return realFetch(`${base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}` },
    body,
  });
};

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('photo')]);
const PDF = Buffer.from('%PDF-1.4 brochure');

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
  scheduler = await import('../server/services/scheduler.ts');
  db = await import('../server/db.ts');
  await ensureBaseData();
  db.run('DELETE FROM wa_numbers'); // These tests add their own numbers.
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await signIn('admin', 'owner@test.local');
  await signIn('tele1', 'telecaller1@demo.archstone.test');
  await signIn('tele2', 'telecaller2@demo.archstone.test');
  await signIn('sales1', 'closing1@demo.archstone.test');
  await signIn('marketing', 'payments@demo.archstone.test');
  await signIn('head', 'sitehead@demo.archstone.test');
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

// ---------- Permissions ----------
test('an admin can change a role, and it applies at once without a new login', async () => {
  assert.equal((await users.tele2.get('/api/reports')).status, 403);
  const { data } = await users.admin.get('/api/permissions');
  await users.admin.put('/api/permissions/role/telecaller', { actions: [...data.roles.telecaller, 'reports.view'] });
  assert.equal((await users.tele2.get('/api/reports')).status, 200);
  await users.admin.put('/api/permissions/role/telecaller', { actions: data.roles.telecaller });
  assert.equal((await users.tele2.get('/api/reports')).status, 403);
});

test('one person can be allowed or blocked apart from their role', async () => {
  const lead = (await users.tele1.get('/api/leads')).data.leads[0];
  await users.admin.put(`/api/users/${ids.tele1}/permissions`, { allow: ['reports.view'], deny: ['lead.create', 'call.office', 'whatsapp.send'], data_scope: '' });
  assert.equal((await users.tele1.get('/api/reports')).status, 200);
  assert.equal((await users.tele1.post('/api/leads', { name: 'Blocked', phone: '9700011111' })).status, 403);
  assert.equal((await users.tele1.post(`/api/leads/${lead.id}/dial`)).status, 403);
  assert.equal((await users.tele1.post(`/api/inbox/${lead.id}/text`, { body: 'hello' })).status, 403);
  assert.equal((await users.tele2.post('/api/leads', { name: 'Allowed', phone: '9700011112' })).status, 201, 'colleague unaffected');
  const me = (await users.tele1.get('/api/auth/me')).data.user;
  assert.ok(!me.permissions.includes('lead.create'), 'the app is told, so it hides the button');
  await users.admin.put(`/api/users/${ids.tele1}/permissions`, { allow: [], deny: [], data_scope: '' });
  assert.equal((await users.tele1.get('/api/reports')).status, 403);
});

test('an admin controls how many leads a person can see', async () => {
  const own = (await users.tele1.get('/api/leads')).data.total;
  await users.admin.put(`/api/users/${ids.tele1}/permissions`, { allow: [], deny: [], data_scope: 'all' });
  const wide = (await users.tele1.get('/api/leads')).data.total;
  assert.ok(wide > own);
  await users.admin.put(`/api/users/${ids.tele1}/permissions`, { allow: [], deny: [], data_scope: '' });
});

test('permissions cannot be changed by staff, and admins cannot lose theirs', async () => {
  assert.equal((await users.head.put('/api/permissions/role/sales', { actions: [] })).status, 403);
  assert.equal((await users.tele1.put(`/api/users/${ids.tele1}/permissions`, { allow: ['user.manage'], deny: [], data_scope: 'all' })).status, 403);
  assert.equal((await users.admin.put('/api/permissions/role/admin', { actions: [] })).status, 400);
  assert.equal((await users.admin.put(`/api/users/${ids.admin}/permissions`, { allow: [], deny: ['user.manage'], data_scope: '' })).status, 400);
  assert.equal((await users.admin.put('/api/permissions/role/sales', { actions: ['made.up'] })).status, 400);
  assert.ok((await users.admin.get('/api/audit')).data.entries.some((e: any) => e.action === 'permissions.user'));
});

// ---------- Own numbers ----------
test('each person has their own number, inbox and leads', async () => {
  const n1 = await users.admin.post('/api/wa-numbers', { label: 'Telecaller One', display_number: '+919000000001', phone_number_id: 'pn-1', token: 'secret-token-1', user_id: ids.tele1, daily_limit: 2 });
  const n2 = await users.admin.post('/api/wa-numbers', { label: 'Telecaller Two', display_number: '+919000000002', phone_number_id: 'pn-2', user_id: ids.tele2, daily_limit: 100 });
  assert.equal(n1.status, 201);
  const taken = await users.admin.post('/api/wa-numbers', { label: 'Second line', display_number: '+919000000003', phone_number_id: 'pn-3', user_id: ids.tele1, daily_limit: 2 });
  assert.equal(taken.status, 409, 'a clear message, not a crash');
  assert.match(taken.data.error, /already has a number/);
  ids.n1 = n1.data.id;
  ids.n2 = n2.data.id;

  const row = db.get('SELECT token FROM wa_numbers WHERE id = ?', n1.data.id);
  assert.ok(!row.token.includes('secret-token-1'), 'token is encrypted');
  const listed = await users.admin.get('/api/wa-numbers');
  assert.ok(!JSON.stringify(listed.data).includes(row.token), 'token never leaves the server');
  assert.equal(listed.data.numbers[0].has_token, 1);

  await inbound('919711100001', 'Hi from customer one', 'n.1', 'pn-1');
  await inbound('919711100002', 'Hi from customer two', 'n.2', 'pn-2');
  const one = (await users.tele1.get('/api/inbox')).data.conversations.map((c: any) => c.phone);
  const two = (await users.tele2.get('/api/inbox')).data.conversations.map((c: any) => c.phone);
  assert.ok(one.includes('+919711100001') && !one.includes('+919711100002'));
  assert.ok(two.includes('+919711100002') && !two.includes('+919711100001'));

  assert.equal((await users.tele1.get(`/api/inbox?number=${ids.n2}`)).status, 403, 'cannot open a colleague inbox');
  const lead = db.get(`SELECT id FROM leads WHERE phone = '+919711100002'`);
  assert.equal((await users.tele1.get(`/api/inbox/${lead.id}`)).status, 404);
  assert.equal((await users.tele1.get('/api/wa-numbers')).status, 403);
});

test('the admin can open every inbox, without marking it read for staff', async () => {
  const all = (await users.admin.get('/api/inbox')).data.conversations.map((c: any) => c.phone);
  assert.ok(all.includes('+919711100001') && all.includes('+919711100002'));
  const filtered = (await users.admin.get(`/api/inbox?number=${ids.n2}`)).data.conversations.map((c: any) => c.phone);
  assert.ok(filtered.includes('+919711100002') && !filtered.includes('+919711100001'));
  const lead = db.get(`SELECT id FROM leads WHERE phone = '+919711100002'`);
  await users.admin.get(`/api/inbox/${lead.id}`);
  assert.equal(db.get('SELECT unread_count FROM leads WHERE id = ?', lead.id).unread_count, 1);
  await users.tele2.get(`/api/inbox/${lead.id}`);
  assert.equal(db.get('SELECT unread_count FROM leads WHERE id = ?', lead.id).unread_count, 0);
});

test('replies go out on that person\'s own number and token', async () => {
  config.whatsapp.token = 'company-token';
  fake = (url: string) => (url.includes('/messages') ? Response.json({ messages: [{ id: `wamid.${Math.random()}` }] }) : Response.json({}));
  try {
    const one = db.get(`SELECT id FROM leads WHERE phone = '+919711100001'`);
    await users.tele1.post(`/api/inbox/${one.id}/text`, { body: 'Hello from my number' });
    let sent = outbound.filter((o) => o.url.includes('/messages')).at(-1)!;
    assert.ok(sent.url.includes('/pn-1/messages'));
    assert.equal(sent.init.headers.Authorization, 'Bearer secret-token-1');

    const two = db.get(`SELECT id FROM leads WHERE phone = '+919711100002'`);
    await users.tele2.post(`/api/inbox/${two.id}/text`, { body: 'Hello from company token' });
    sent = outbound.filter((o) => o.url.includes('/messages')).at(-1)!;
    assert.ok(sent.url.includes('/pn-2/messages'));
    assert.equal(sent.init.headers.Authorization, 'Bearer company-token');
  } finally {
    config.whatsapp.token = '';
    fake = null;
  }
});

// ---------- Broadcasts ----------
test('a telecaller can broadcast, only to their own leads, and only after approval', async () => {
  const projects = (await users.admin.get('/api/projects')).data.projects;
  for (const p of projects) await users.admin.put(`/api/projects/${p.id}`, { ...p, brochure_url: '', rera_number: 'TEST-ONLY' });
  db.run(`UPDATE wa_templates SET status = 'approved' WHERE name = 'project_offer'`);
  db.run(`UPDATE leads SET wa_opt_in = 1`);
  const template = db.get(`SELECT id FROM wa_templates WHERE name = 'project_offer'`);

  const preview = (await users.tele1.post('/api/campaigns/preview', { segment: {}, template_id: template.id })).data;
  const everyone = (await users.admin.post('/api/campaigns/preview', { segment: {}, template_id: template.id })).data;
  assert.ok(preview.matched < everyone.matched, 'preview is limited to their leads');

  const made = await users.tele1.post('/api/campaigns', { name: 'My follow-up', template_id: template.id, segment: {} });
  assert.equal(made.status, 201);
  assert.equal(made.data.direct, undefined);
  assert.equal(db.get('SELECT number_id FROM wa_campaigns WHERE id = ?', made.data.id).number_id, ids.n1, 'goes out on their number');
  assert.equal((await users.tele1.post(`/api/campaigns/${made.data.id}/approve`, { approve: true })).status, 403);
  assert.equal((await users.tele2.get('/api/campaigns')).data.campaigns.length, 0, 'colleagues cannot see it');
  assert.ok((await users.admin.get('/api/campaigns')).data.campaigns.some((c: any) => c.id === made.data.id), 'the admin can');

  const go = await users.admin.post(`/api/campaigns/${made.data.id}/approve`, { approve: true });
  assert.ok(go.data.queued > 0);
  const owners = db.all(
    `SELECT DISTINCT l.owner_id, l.presales_id FROM wa_messages m JOIN leads l ON l.id = m.lead_id WHERE m.campaign_id = ?`, made.data.id,
  );
  assert.ok(owners.every((o: any) => o.owner_id === ids.tele1 || o.presales_id === ids.tele1), 'no other staff member\'s leads');
});

test('each number stops at its own daily limit', async () => {
  const campaign = db.get(`SELECT id FROM wa_campaigns WHERE name = 'My follow-up'`);
  const queuedBefore = db.get(`SELECT COUNT(*) n FROM wa_messages WHERE campaign_id = ? AND status = 'queued'`, campaign.id).n;
  assert.ok(queuedBefore > 2);
  const { processQueue } = await import('../server/services/whatsapp.ts');
  await processQueue();
  await processQueue();
  const sent = db.get(`SELECT COUNT(*) n FROM wa_messages WHERE campaign_id = ? AND status != 'queued'`, campaign.id).n;
  assert.equal(sent, 2, 'stopped at the limit of 2');
});

test('the admin can let someone broadcast without approval', async () => {
  const template = db.get(`SELECT id FROM wa_templates WHERE name = 'project_offer'`);
  await users.admin.put(`/api/users/${ids.tele2}/permissions`, { allow: ['campaign.direct'], deny: [], data_scope: '' });
  const r = await users.tele2.post('/api/campaigns', { name: 'Direct send', template_id: template.id, segment: {} });
  assert.equal(r.data.direct, true);
  assert.equal(db.get('SELECT status FROM wa_campaigns WHERE id = ?', r.data.id).status, 'sending');
  await users.admin.put(`/api/users/${ids.tele2}/permissions`, { allow: [], deny: ['campaign.create'], data_scope: '' });
  assert.equal((await users.tele2.post('/api/campaigns', { name: 'Blocked send', template_id: template.id, segment: {} })).status, 403);
  await users.admin.put(`/api/users/${ids.tele2}/permissions`, { allow: [], deny: [], data_scope: '' });
});

// ---------- Property files ----------
test('property files upload, stay typed, and can be sent on WhatsApp', async () => {
  const upload = (c: Client, body: Buffer, q: string) => c.call('POST', `/api/media?${q}`, body, { 'Content-Type': 'application/octet-stream' });
  assert.equal((await upload(users.tele1, JPG, 'title=Photo&name=a.jpg')).status, 403, 'needs the permission');
  assert.equal((await upload(users.head, Buffer.from('<html>'), 'title=Bad&name=a.html')).status, 415);
  const jpg = await upload(users.head, JPG, 'title=Site%20photo&name=../../site.jpg');
  const pdf = await upload(users.head, PDF, 'title=Brochure&name=brochure.pdf');
  assert.equal(jpg.status, 201);

  const list = (await users.tele1.get('/api/media')).data.media;
  assert.equal(list.length, 2, 'everyone can use them');
  const image = list.find((m: any) => m.title === 'Site photo');
  assert.ok(!image.filename.includes('/'));
  assert.ok(image.url.startsWith('https://crm.test/public/media/'));

  const open = await new Client().get(image.preview);
  assert.equal(open.status, 200, 'WhatsApp can fetch it without a login');
  assert.equal((await new Client().get('/public/media/wrong-token/x.jpg')).status, 404);

  const lead = db.get(`SELECT id FROM leads WHERE phone = '+919711100001'`);
  db.run('UPDATE leads SET last_inbound_at = ? WHERE id = ?', db.nowIso(), lead.id);
  const sent = await users.tele1.post(`/api/inbox/${lead.id}/media`, { media_id: pdf.data.id });
  assert.equal(sent.status, 201);
  const msg = (await users.tele1.get(`/api/inbox/${lead.id}`)).data.messages.at(-1);
  assert.equal(msg.media_type, 'document');

  assert.equal((await users.tele1.call('DELETE', `/api/media/${jpg.data.id}`)).status, 403);
  assert.equal((await users.head.call('DELETE', `/api/media/${jpg.data.id}`)).status, 200);
  assert.equal(readdirSync(join(dir, 'media')).length, 1, 'the file is gone from disk');
});

// ---------- Assistant ----------
test('the assistant is for everyone the admin allows, and sees only their data', async () => {
  assert.equal((await users.tele1.post('/api/ai/assistant', { question: 'Hello there' })).status, 503);
  config.gemini.key = 'test-key';
  fake = (url: string) => (url.includes('generativelanguage')
    ? Response.json({ candidates: [{ content: { parts: [{ text: 'Call your hot leads first.' }] } }] })
    : Response.json({}));
  try {
    const r = await users.tele1.post('/api/ai/assistant', { question: 'What should I do?' });
    assert.equal(r.data.text, 'Call your hot leads first.');
    const prompt = JSON.parse(outbound.filter((o) => o.url.includes('generativelanguage')).at(-1)!.init.body).contents[0].parts[0].text;
    assert.ok(!prompt.includes('"report"'), 'no company report for a telecaller');

    const other = db.get(`SELECT id FROM leads WHERE phone = '+919711100002'`);
    assert.equal((await users.tele1.post('/api/ai/assistant', { question: 'Tell me about this lead', lead_id: other.id })).status, 404, 'cannot reach a colleague\'s lead through AI');

    await users.admin.put(`/api/users/${ids.tele1}/permissions`, { allow: [], deny: ['ai.use'], data_scope: '' });
    assert.equal((await users.tele1.post('/api/ai/assistant', { question: 'Hello there' })).status, 403);
    await users.admin.put(`/api/users/${ids.tele1}/permissions`, { allow: [], deny: [], data_scope: '' });

    // Newer models send their thinking as separate parts: only the answer is shown.
    fake = (url: string) => (url.includes('generativelanguage')
      ? Response.json({ candidates: [{ content: { parts: [{ text: 'planning...', thought: true }, { text: 'Visit the site today.' }] }, finishReason: 'STOP' }] })
      : Response.json({}));
    assert.equal((await users.tele1.post('/api/ai/assistant', { question: 'What next?' })).data.text, 'Visit the site today.');

    // A model Google has retired gets a plain fix, not a hang or Google's wording alone.
    fake = (url: string) => (url.includes('generativelanguage')
      ? Response.json({ error: { message: 'This model models/old-flash is no longer available to new users.' } }, { status: 404 })
      : Response.json({}));
    const retired = await users.tele1.post('/api/ai/assistant', { question: 'What next?' });
    assert.equal(retired.status, 502);
    assert.match(retired.data.error, /Settings, Integrations, Gemini AI/);
  } finally {
    config.gemini.key = '';
    fake = null;
  }
});

// ---------- Monitor ----------
test('the monitor shows all staff activity, to those allowed', async () => {
  assert.equal((await users.head.get('/api/monitor')).status, 403);
  const { data } = await users.admin.get('/api/monitor');
  assert.ok(data.totals.sent > 0);
  const row = data.staff.find((s: any) => s.id === ids.tele1);
  assert.equal(row.display_number, '+919000000001');
  assert.ok(row.messages >= 1);
  assert.ok(data.feed.length > 0);
});

test('custom pipeline stages can be added and used', async () => {
  const { data } = await users.admin.get('/api/settings');
  await users.admin.put('/api/settings', { ...data.settings, custom_stages: ['Loan Processing'] });
  const lead = (await users.admin.get('/api/leads')).data.leads[0];
  assert.equal((await users.admin.post(`/api/leads/${lead.id}/stage`, { stage: 'Loan Processing' })).status, 200);
  assert.equal((await users.admin.post(`/api/leads/${lead.id}/stage`, { stage: 'Made Up' })).status, 400);
  assert.deepEqual((await users.tele1.get('/api/directory')).data.customStages, ['Loan Processing']);
});
