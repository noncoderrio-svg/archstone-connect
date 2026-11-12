// Third wave: reports, AI, rich templates, calendar, automation and audit gaps.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-extras-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1',
  DB_PATH: join(dir, 'test.db'),
  DEMO_MODE: 'true',
  INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WEBSITE_API_KEY: 'web-key',
  META_APP_SECRET: 'app-secret',
  GOOGLE_ADS_WEBHOOK_KEY: 'ads-key',
  WHATSAPP_DISPLAY_NUMBER: '919800000000',
  WHATSAPP_TOKEN: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  GEMINI_API_KEY: '',
  SMTP_HOST: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
let server: Server;
let base = '';
let db: any;
let config: any;
let scheduler: any;
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

const websiteLead = (phone: string, extra: Record<string, unknown> = {}) =>
  new Client().call('POST', '/webhooks/website', { name: 'Web Lead', phone, ...extra }, { 'x-api-key': 'web-key' });

const inbound = (phone: string, text: string, id: string) => {
  const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ id, from: phone, type: 'text', text: { body: text } }] } }] }] });
  return realFetch(`${base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}` },
    body,
  });
};

const me = async (c: Client) => (await c.get('/api/auth/me')).data.user;

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
  db.run('DELETE FROM wa_numbers'); // Demo numbers always stay simulated, and these tests check live sending.
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  users.admin = await signIn('owner@test.local');
  users.tele1 = await signIn('telecaller1@demo.archstone.test');
  users.tele2 = await signIn('telecaller2@demo.archstone.test');
  users.sales1 = await signIn('sales1@demo.archstone.test');
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

// ---------- Exports ----------
test('reports export as real Excel and PDF files, limited by role, and logged', async () => {
  const xlsx = await users.admin.get('/api/reports/export?format=xlsx&days=30');
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.data.subarray(0, 2).toString(), 'PK', 'an xlsx is a zip file');
  const pdf = await users.admin.get('/api/reports/export?format=pdf&days=30');
  assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.data.length > 1000);
  assert.equal((await users.tele1.get('/api/reports/export?format=pdf')).status, 403);

  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(xlsx.data);
  assert.deepEqual(book.worksheets.map((s) => s.name).slice(0, 3), ['Sales funnel', 'Sources', 'Projects']);

  const head = await users.head.get('/api/reports/export?format=xlsx');
  const headBook = new ExcelJS.Workbook();
  await headBook.xlsx.load(head.data);
  const sources = headBook.getWorksheet('Sources')!;
  assert.ok(!String(sources.getRow(1).values).includes('Spend'), 'a site head does not see ad spend');
  assert.ok((await users.admin.get('/api/audit')).data.entries.some((e: any) => e.action === 'report.export'));
});

test('Excel lead import and export work, and formulas stay as plain text', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Leads');
  sheet.addRow(['Name', 'Phone', 'Budget Lakhs']);
  sheet.addRow(['Excel Buyer', '9811122233', 95]);
  const file = Buffer.from(await book.xlsx.writeBuffer());

  assert.equal((await users.admin.call('POST', '/api/leads/parse-xlsx', Buffer.from('not excel'), { 'Content-Type': 'application/octet-stream' })).status, 415);
  const parsed = await users.admin.call('POST', '/api/leads/parse-xlsx', file, { 'Content-Type': 'application/octet-stream' });
  assert.equal(parsed.data.rows[0].name, 'Excel Buyer');
  assert.equal(parsed.data.rows[0].budget_lakhs, '95');
  const done = await users.admin.post('/api/leads/import', { rows: parsed.data.rows });
  assert.equal(done.data.created, 1);

  await users.admin.post('/api/leads', { name: '=SUM(A1)', phone: '9811122234' });
  const out = await users.admin.get('/api/leads/export.xlsx');
  const check = new ExcelJS.Workbook();
  await check.xlsx.load(out.data);
  const values = check.worksheets[0].getColumn(1).values as unknown[];
  assert.ok(values.includes('=SUM(A1)'), 'kept as text, not a formula object');
  assert.equal((await users.tele1.get('/api/leads/export.xlsx')).status, 403);
});

// ---------- Scheduled reports ----------
test('scheduled reports stay off by default, send once a day, and record each route honestly', async () => {
  const runs = () => db.all('SELECT * FROM report_runs');
  await scheduler.runScheduledReports();
  assert.equal(runs().length, 0, 'off until an admin turns them on');

  db.setSetting('report_schedule', { daily: true, weekly: false, hour: 0, email: true, whatsapp: true });
  await scheduler.runScheduledReports();
  await scheduler.runScheduledReports();
  const after1 = runs();
  const appRuns = after1.filter((r: any) => r.channel === 'app');
  assert.equal(appRuns.length, 3, 'admin, manager and site head, once each');
  assert.ok(after1.some((r: any) => r.channel === 'email' && r.status === 'not set up'), 'no fake success without email set up');
  assert.ok(after1.some((r: any) => r.channel === 'whatsapp' && r.status === 'no mobile number'));
  const note = (await users.manager.get('/api/notifications')).data.notifications[0];
  assert.match(note.title, /Daily report/);
  db.setSetting('report_schedule', { daily: false, weekly: false, hour: 9, email: true, whatsapp: false });
});

test('email reports attach both files, through the mail server settings', async () => {
  const net = await import('node:net');
  const received: string[] = [];
  const smtp = net.createServer((socket) => {
    let inData = false;
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString();
      received.push(text);
      if (inData) {
        if (text.endsWith('\r\n.\r\n')) { inData = false; socket.write('250 OK\r\n'); }
        return;
      }
      if (/^EHLO/i.test(text)) socket.write('250 test\r\n');
      else if (/^DATA/i.test(text)) { inData = true; socket.write('354 go\r\n'); }
      else if (/^QUIT/i.test(text)) socket.end('221 bye\r\n');
      else socket.write('250 OK\r\n');
    });
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  Object.assign(config.smtp, { host: '127.0.0.1', port: (smtp.address() as any).port, from: 'crm@test.local' });
  db.setSetting('report_schedule', { daily: false, weekly: false, hour: 9, email: true, whatsapp: false });
  try {
    const sent = await users.admin.post('/api/reports/send-now', { period: 'weekly' });
    assert.equal(sent.status, 200);
    const all = received.join('');
    assert.match(all, /archstone-report\.xlsx/);
    assert.match(all, /archstone-report\.pdf/);
    assert.ok(db.all(`SELECT * FROM report_runs WHERE channel = 'email' AND status = 'sent'`).length >= 1);
  } finally {
    Object.assign(config.smtp, { host: '', from: '' });
    smtp.close();
  }
});

// ---------- AI and insights ----------
test('messages are read for sentiment and intent, in English and Hindi', async () => {
  const { classifyMessage } = await import('../server/services/insight.ts');
  assert.deepEqual(classifyMessage('What is the price of 2 BHK?'), { sentiment: 'neutral', intent: 'price' });
  assert.equal(classifyMessage('कीमत क्या है').intent, 'price');
  assert.equal(classifyMessage('This is too expensive, very disappointed').sentiment, 'negative');

  const { data } = await websiteLead('9822200001', { whatsapp_consent: true });
  await inbound('919822200001', 'Can I book a site visit, I am interested', 'x.1');
  const lead = (await users.admin.get(`/api/leads/${data.id}`)).data.lead;
  assert.equal(lead.intent, 'site visit');
  assert.equal(lead.sentiment, 'positive');
});

test('next best action follows the lead, without AI', async () => {
  const { data } = await websiteLead('9822200002');
  assert.equal((await users.admin.get(`/api/leads/${data.id}/next-action`)).data.action, 'Call now');
  await inbound('919822200002', 'What is the price?', 'x.2');
  const a = (await users.admin.get(`/api/leads/${data.id}/next-action`)).data;
  assert.equal(a.action, 'Reply on WhatsApp about price');
});

test('AI questions use only figures the person may see, and are off without a key', async () => {
  assert.equal((await users.admin.post('/api/ai/ask', { question: 'Which source gave the most bookings?' })).status, 503);
  assert.equal((await users.tele1.post('/api/ai/ask', { question: 'Which source gave the most bookings?' })).status, 403);
  config.gemini.key = 'test-key';
  fake = (url) => url.includes('generativelanguage')
    ? Response.json({ candidates: [{ content: { parts: [{ text: 'Website gave the most.' }] } }] })
    : Response.json({});
  try {
    const r = await users.head.post('/api/ai/ask', { question: 'Which source gave the most bookings?' });
    assert.equal(r.data.answer, 'Website gave the most.');
    const sent = JSON.parse(outbound.filter((o) => o.url.includes('generativelanguage')).at(-1)!.init.body);
    const prompt = sent.contents[0].parts[0].text;
    assert.ok(!prompt.includes('Lakeside Towers'), 'other projects never reach the AI for a site head');
    assert.ok(!prompt.includes('+91'), 'no customer phone numbers are sent');
  } finally {
    config.gemini.key = '';
    fake = null;
  }
});

test('daily brief and targets reflect the person\'s own work', async () => {
  const brief = (await users.tele1.get('/api/brief')).data;
  assert.ok(brief.items.length > 0);
  const tele = await me(users.tele1);
  assert.equal((await users.tele1.put(`/api/users/${tele.id}/target`, { calls: 100, visits: 5, bookings: 1 })).status, 403);
  assert.equal((await users.manager.put(`/api/users/${tele.id}/target`, { calls: 100, visits: 5, bookings: 1 })).status, 200);
  const lead = (await users.tele1.get('/api/leads')).data.leads[0];
  await users.tele1.post(`/api/leads/${lead.id}/call`, { disposition: 'Connected' });
  const p = (await users.tele1.get('/api/brief')).data.progress;
  assert.equal(p.target.calls, 100);
  assert.equal(p.calls, 1);
  assert.equal(p.streak, 1);
  assert.equal(p.connect_rate, 100);
  assert.equal((await users.tele1.get('/api/targets')).status, 403);
  assert.ok((await users.manager.get('/api/targets')).data.people.length >= 4);
});

// ---------- Templates ----------
test('rich templates are validated, then reach Meta with media and buttons', async () => {
  const base2 = { name: 'rich_offer', category: 'MARKETING', language: 'en', body: 'Hello {{name}}, see {{project}}. Reply STOP to opt out.' };
  assert.equal((await users.admin.post('/api/templates', { ...base2, header_type: 'IMAGE' })).status, 400);
  assert.equal((await users.admin.post('/api/templates', { ...base2, header_type: 'IMAGE', header_url: 'http://x.test/a.jpg' })).status, 400);
  assert.equal((await users.admin.post('/api/templates', { ...base2, buttons: [{ type: 'URL', text: 'Open', value: 'x' }] })).status, 400);
  const made = await users.admin.post('/api/templates', {
    ...base2, header_type: 'IMAGE', header_url: 'https://media.test/a.jpg',
    buttons: [{ type: 'QUICK_REPLY', text: 'Book a visit' }, { type: 'URL', text: 'View project', value: 'https://archstone.test' }],
  });
  assert.equal(made.status, 201);

  Object.assign(config.whatsapp, { token: 'tok', phoneNumberId: '123', businessAccountId: 'waba' });
  config.metaAppId = 'app1';
  fake = (url: string) => {
    if (url.includes('media.test')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
    if (url.includes('/app1/uploads')) return Response.json({ id: 'upload:1' });
    if (url.includes('upload:1')) return Response.json({ h: 'handle-1' });
    if (url.includes('message_templates')) return Response.json({ id: 't1' });
    if (url.includes('/123/messages')) return Response.json({ messages: [{ id: 'wamid.rich' }] });
    return Response.json({});
  };
  try {
    assert.equal((await users.admin.post(`/api/templates/${made.data.id}/submit`)).status, 200);
    const sent = JSON.parse(outbound.find((o) => o.url.includes('message_templates'))!.init.body);
    assert.deepEqual(sent.components[0], { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['handle-1'] } });
    assert.equal(sent.components[1].text, 'Hello {{1}}, see {{2}}. Reply STOP to opt out.');
    assert.equal(sent.components[2].buttons[1].url, 'https://archstone.test');

    db.run(`UPDATE wa_templates SET status = 'approved' WHERE id = ?`, made.data.id);
    const { data } = await websiteLead('9822200003', { whatsapp_consent: true });
    const r = await users.admin.post(`/api/inbox/${data.id}/template`, { template_id: made.data.id });
    assert.equal(r.status, 201);
    const payload = JSON.parse(outbound.filter((o) => o.url.includes('/123/messages')).at(-1)!.init.body);
    assert.deepEqual(payload.template.components[0].parameters[0], { type: 'image', image: { link: 'https://media.test/a.jpg' } });
    const thread = (await users.admin.get(`/api/inbox/${data.id}`)).data.messages.at(-1);
    assert.equal(thread.media_url, 'https://media.test/a.jpg');
  } finally {
    Object.assign(config.whatsapp, { token: '', phoneNumberId: '', businessAccountId: '' });
    config.metaAppId = '';
    fake = null;
  }
});

test('a brochure can be sent inside the reply window only', async () => {
  const projects = (await users.admin.get('/api/projects')).data.projects;
  const square = projects.find((p: any) => p.name === 'Harbour Square');
  const { data } = await websiteLead('9822200004', { project: 'Harbour Square', whatsapp_consent: true });
  assert.equal((await users.admin.post(`/api/inbox/${data.id}/brochure`)).status, 422);
  await users.admin.put(`/api/projects/${square.id}`, { ...square, brochure_url: 'https://archstone.test/b.pdf' });
  assert.equal((await users.admin.post(`/api/inbox/${data.id}/brochure`)).status, 422, 'window is closed');
  await inbound('919822200004', 'Share details', 'x.4');
  assert.equal((await users.admin.post(`/api/inbox/${data.id}/brochure`)).status, 201);
});

// ---------- Calendar, filters ----------
test('saved filters are private, and the calendar respects lead access', async () => {
  assert.equal((await users.tele1.post('/api/saved-filters', { name: 'My hot leads', query: 'temperature=Hot' })).status, 201);
  assert.equal((await users.tele2.get('/api/saved-filters')).data.filters.length, 0);
  const mine = (await users.tele1.get('/api/saved-filters')).data.filters[0];
  await users.tele2.call('DELETE', `/api/saved-filters/${mine.id}`);
  assert.equal((await users.tele1.get('/api/saved-filters')).data.filters.length, 1, 'another user cannot delete it');

  const { data } = await websiteLead('9822200005', { project: 'Skyline Residences' });
  const owner = (await users.admin.get(`/api/leads/${data.id}`)).data.lead.owner_id;
  const tele = (await me(users.tele1)).id === owner ? users.tele1 : users.tele2;
  const other = tele === users.tele1 ? users.tele2 : users.tele1;
  const when = new Date(Date.now() + 86400000).toISOString().slice(0, 19).replace('T', ' ');
  await tele.post(`/api/leads/${data.id}/tasks`, { type: 'Call back', due_at: when, notes: 'calendar test' });
  const range = `from=${when.slice(0, 10)}&to=${when.slice(0, 10)}`;
  assert.ok((await tele.get(`/api/calendar?${range}`)).data.events.some((e: any) => e.lead_id === data.id));
  assert.ok(!(await other.get(`/api/calendar?${range}`)).data.events.some((e: any) => e.lead_id === data.id));
});

// ---------- Automation ----------
test('idle leads alert their owner once, and move only when auto-reassign is on', async () => {
  const { data } = await websiteLead('9822200006');
  const before = (await users.admin.get(`/api/leads/${data.id}`)).data.lead.owner_id;
  db.run(`UPDATE leads SET stage = 'Contacted', first_response_at = last_activity_at, last_activity_at = '2020-01-01 00:00:00' WHERE id = ?`, data.id);
  scheduler.checkInactiveLeads();
  scheduler.checkInactiveLeads();
  const alerts = db.all(`SELECT * FROM notifications WHERE user_id = ? AND title = 'Lead has gone quiet' AND body LIKE 'Web Lead%'`, before);
  assert.ok(alerts.length >= 1);
  assert.equal(db.get('SELECT inactive_alerted FROM leads WHERE id = ?', data.id).inactive_alerted, 1);
  assert.equal(db.get('SELECT owner_id FROM leads WHERE id = ?', data.id).owner_id, before, 'not moved by default');

  db.setSetting('auto_reassign_days', 2);
  scheduler.checkInactiveLeads();
  db.setSetting('auto_reassign_days', 0);
  assert.notEqual(db.get('SELECT owner_id FROM leads WHERE id = ?', data.id).owner_id, before);
});

test('workload routing gives new leads to whoever has fewest', async () => {
  const t1 = await me(users.tele1);
  const t2 = await me(users.tele2);
  db.setSetting('routing_mode', 'workload');
  db.run('UPDATE leads SET owner_id = ? WHERE owner_id = ?', t1.id, t2.id);
  const { data } = await websiteLead('9822200007');
  db.setSetting('routing_mode', 'round_robin');
  assert.equal(db.get('SELECT owner_id FROM leads WHERE id = ?', data.id).owner_id, t2.id);
});

test('follow-up drip sends at most twice, only with consent', async () => {
  const projects = (await users.admin.get('/api/projects')).data.projects;
  const square = projects.find((p: any) => p.name === 'Harbour Square');
  await users.admin.put(`/api/projects/${square.id}`, { ...square, brochure_url: '', rera_number: 'TEST-ONLY' });
  db.run(`UPDATE wa_templates SET status = 'approved' WHERE name = 'follow_up_nudge'`);
  const yes = (await websiteLead('9822200008', { project: 'Harbour Square', whatsapp_consent: true })).data.id;
  const no = (await websiteLead('9822200009', { project: 'Harbour Square' })).data.id;
  for (const id of [yes, no]) db.run(`UPDATE leads SET stage = 'Contacted', last_activity_at = '2020-01-01 00:00:00' WHERE id = ?`, id);
  for (let i = 0; i < 4; i++) {
    await scheduler.sendFollowUpDrips();
    db.run(`UPDATE leads SET last_activity_at = '2020-01-01 00:00:00' WHERE id = ?`, yes);
  }
  const count = (id: number) => db.all(`SELECT id FROM wa_messages WHERE lead_id = ? AND body LIKE '%tried reaching%'`, id).length;
  assert.equal(count(yes), 2);
  assert.equal(count(no), 0);
});

test('the daily WhatsApp limit holds back sending', async () => {
  db.setSetting('wa_daily_limit', 1);
  const projects = (await users.admin.get('/api/projects')).data.projects;
  const square = projects.find((p: any) => p.name === 'Harbour Square');
  const template = db.get(`SELECT id FROM wa_templates WHERE name = 'follow_up_nudge'`);
  const a = await users.admin.post('/api/campaigns', { name: 'Limited', template_id: template.id, project_id: square.id, segment: {} });
  const go = a;
  assert.ok(go.data.queued >= 2);
  await scheduler.tick();
  const left = db.all(`SELECT id FROM wa_messages WHERE campaign_id = ? AND status = 'queued'`, a.data.id).length;
  db.setSetting('wa_daily_limit', 1000);
  assert.equal(left, go.data.queued - Math.max(0, 1 - db.all(`SELECT id FROM wa_messages WHERE campaign_id IS NOT NULL AND campaign_id != ?`, a.data.id).length));
});

test('a daily backup is made, once, and can be opened', async () => {
  db.setSetting('backup_last', '');
  scheduler.backupDatabase();
  scheduler.backupDatabase();
  const files = readdirSync(join(dir, 'backups'));
  assert.equal(files.length, 1);
  assert.ok(existsSync(join(dir, 'backups', files[0])));
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(join(dir, 'backups', files[0]), { readOnly: true });
  assert.ok((copy.prepare('SELECT COUNT(*) n FROM leads').get() as any).n > 0);
  copy.close();
});

// ---------- Smaller gaps ----------
test('Google Ads webhook checks its key and creates a lead', async () => {
  const c = new Client();
  const payload = { google_key: 'ads-key', campaign_id: 77, user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Ads Buyer' }, { column_id: 'PHONE_NUMBER', string_value: '+91 98222 00010' }] };
  assert.equal((await c.call('POST', '/webhooks/google-ads', { ...payload, google_key: 'no' })).status, 401);
  const r = await c.call('POST', '/webhooks/google-ads', payload);
  assert.equal(r.status, 201);
  const lead = (await users.admin.get(`/api/leads/${r.data.id}`)).data.lead;
  assert.equal(lead.source, 'Google Ads');
  assert.equal((await c.call('POST', '/webhooks/google-ads', { google_key: 'ads-key', is_test: true })).status, 200);
});

test('hoarding QR codes carry the project, which the chatbot picks up', async () => {
  const projects = (await users.admin.get('/api/projects')).data.projects;
  const dar = projects.find((p: any) => p.name === 'Parkview Heights');
  const r = (await users.admin.get(`/api/projects/${dar.id}/qr`)).data;
  assert.match(r.qr, /^data:image\/png/);
  assert.ok(r.link.startsWith('https://wa.me/919800000000'));
  const text = decodeURIComponent(r.link.split('text=')[1]);
  await inbound('919822200011', text, 'x.qr');
  const lead = (await users.admin.get('/api/leads?q=919822200011')).data.leads[0];
  assert.equal(lead.project_name, 'Parkview Heights');
});

test('chatbot speaks Hindi and passes the lead to a telecaller who does', async () => {
  const t1 = await me(users.tele1);
  const t2 = await me(users.tele2);
  const list = (await users.admin.get('/api/users')).data.users;
  const update = (u: any, languages: string[]) => users.admin.put(`/api/users/${u.id}`, { name: u.name, email: u.email, role: u.role, phone: u.phone ?? '', project_ids: [], languages });
  await update(list.find((u: any) => u.id === t1.id), ['en']);
  await update(list.find((u: any) => u.id === t2.id), ['hi']);

  await inbound('919822200012', 'Hi', 'x.h1');
  const lead = (await users.admin.get('/api/leads?q=919822200012')).data.leads[0];
  db.run('UPDATE leads SET owner_id = ? WHERE id = ?', t1.id, lead.id);
  await inbound('919822200012', '2', 'x.h2');
  const messages = (await users.admin.get(`/api/inbox/${lead.id}`)).data.messages;
  assert.match(messages.at(-1).body, /प्रोजेक्ट/);
  assert.equal(db.get('SELECT owner_id FROM leads WHERE id = ?', lead.id).owner_id, t2.id);
  assert.equal(db.get('SELECT language FROM leads WHERE id = ?', lead.id).language, 'hi');
});

test('staff can sign in with their mobile number', async () => {
  const sales = await me(users.sales1);
  db.run('UPDATE users SET phone = ? WHERE id = ?', '+91 98765 43210', sales.id);
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { email: '9876543210', password: NEW_PASSWORD })).status, 200);
  assert.equal((await me(c)).id, sales.id);
  assert.equal((await new Client().post('/api/auth/login', { email: '9876543211', password: NEW_PASSWORD })).status, 401);
});

test('deleted leads can be listed and restored by an admin only', async () => {
  const { data } = await websiteLead('9822200013');
  await users.admin.call('DELETE', `/api/leads/${data.id}`);
  assert.equal((await users.sales1.get('/api/leads-deleted')).status, 403);
  assert.ok((await users.admin.get('/api/leads-deleted')).data.leads.some((l: any) => l.id === data.id));
  await users.admin.post(`/api/leads/${data.id}/restore`);
  assert.equal((await users.admin.get(`/api/leads/${data.id}`)).status, 200);
});

test('check-in records location, sign-in history is private, and Qualified works as a call result', async () => {
  const sales = await me(users.sales1);
  const { data } = await websiteLead('9822200014', { project: 'Skyline Residences' });
  await users.admin.post('/api/leads/assign', { lead_ids: [data.id], owner_id: sales.id });
  await users.sales1.post(`/api/leads/${data.id}/call`, { disposition: 'Qualified' });
  assert.equal((await users.admin.get(`/api/leads/${data.id}`)).data.lead.stage, 'Qualified');

  const projects = (await users.admin.get('/api/projects')).data.projects;
  const bliss = projects.find((p: any) => p.name === 'Skyline Residences');
  const when = new Date(Date.now() + 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const visit = await users.sales1.post('/api/visits', { lead_id: data.id, project_id: bliss.id, scheduled_at: when });
  const otp = db.get('SELECT otp FROM site_visits WHERE id = ?', visit.data.id).otp;
  await users.sales1.post(`/api/visits/${visit.data.id}/checkin`, { otp, latitude: 19.07, longitude: 72.88 });
  const row = db.get('SELECT latitude, longitude FROM site_visits WHERE id = ?', visit.data.id);
  assert.equal(row.latitude, 19.07);

  const logins = (await users.sales1.get('/api/account/logins')).data;
  assert.ok(logins.logins.length >= 1);
  assert.ok(logins.sessions >= 1);
});

test('reports compare projects, and campaigns show visits and bookings', async () => {
  const r = (await users.admin.get('/api/reports')).data;
  assert.ok(r.projects.length > 0);
  assert.ok('revenue_lakhs' in r.projects[0]);
  const c = (await users.admin.get('/api/campaigns')).data.campaigns[0];
  assert.ok('visits' in c && 'bookings' in c);
  db.setSetting('wa_cost_per_message', 0.8);
  const preview = (await users.admin.post('/api/campaigns/preview', { segment: {} })).data;
  assert.equal(preview.estimated_cost, Math.round(0.8 * preview.eligible));
});

test('the API limits abusive request rates', async () => {
  const c = new Client();
  let blocked = 0;
  for (let round = 0; round < 8; round++) {
    await Promise.all(Array.from({ length: 50 }, async () => {
      const r = await c.call('POST', '/webhooks/website', { name: 'x', phone: '1' }, { 'x-api-key': 'no' });
      if (r.status === 429) blocked++;
    }));
  }
  assert.ok(blocked > 0);
});
