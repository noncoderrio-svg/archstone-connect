// Calling mode, cold lists, one-click SMS and email, and follow-up reminders.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-dialer-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
let server: Server;
let base = '';
let db: any;
let scheduler: any;
const users: Record<string, Client> = {};
const ids: Record<string, number> = {};

class Client {
  cookie = '';
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b: unknown = {}) => this.call('POST', p, b);
  put = (p: string, b: unknown) => this.call('PUT', p, b);
}

async function signIn(name: string, email: string) {
  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(` ${email} `))!;
  const current = line.trim().split(/\s+/)[2];
  const c = new Client();
  await c.post('/api/auth/login', { email, password: current });
  assert.equal((await c.post('/api/auth/password', { current, next: NEW_PASSWORD })).status, 200);
  users[name] = c;
  ids[name] = (await c.get('/api/auth/me')).data.user.id;
}

before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  scheduler = await import('../server/services/scheduler.ts');
  db = await import('../server/db.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await signIn('admin', 'owner@test.local');
  await signIn('tele1', 'telecaller1@demo.archstone.test');
  await signIn('tele2', 'telecaller2@demo.archstone.test');
  await signIn('marketing', 'marketing@demo.archstone.test');
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('a cold list is cleaned, shared equally, and leaves existing leads alone', async () => {
  const existing = db.get('SELECT phone FROM leads LIMIT 1').phone;
  const rows = [
    { name: 'One', phone: '9700000001' }, { name: 'Two', phone: '9700000002' }, { name: 'Three', phone: '9700000003' }, { name: 'Four', mobile: '9700000004' },
    { name: 'Repeat', phone: '+91 97000 00001' }, { name: 'Bad', phone: '123' }, { name: 'Known', phone: existing },
  ];
  const r = await users.admin.post('/api/dialer/lists', { name: 'Expo list', agent_ids: [ids.tele1, ids.tele2], rows });
  assert.equal(r.status, 201);
  assert.equal(r.data.added, 4);
  assert.equal(r.data.repeated_in_file, 1);
  assert.equal(r.data.invalid, 1);
  assert.equal(r.data.already_in_crm, 1);
  assert.equal(r.data.per_agent[ids.tele1], 2);
  assert.equal(r.data.per_agent[ids.tele2], 2);
  assert.equal(db.get('SELECT wa_opt_in FROM leads WHERE phone = ?', '+919700000001').wa_opt_in, 0, 'a file is not consent');
  ids.list = r.data.id;
  assert.equal((await users.tele1.post('/api/dialer/lists', { name: 'No', agent_ids: [ids.tele1], rows })).status, 403);

  const mine = (await users.tele1.get('/api/dialer/lists')).data.lists[0];
  assert.equal(mine.total, 2, 'each person sees only their share');
});

test('the next lead cannot open until the call result is saved', async () => {
  const first = (await users.tele1.get(`/api/dialer/next?list=${ids.list}`)).data;
  assert.equal(first.lead.call_list_id, ids.list);
  assert.equal(first.remaining, 2);
  assert.equal((await users.tele1.post(`/api/dialer/start/${first.lead.id}`)).status, 201);

  const blocked = (await users.tele1.get(`/api/dialer/next?list=${ids.list}`)).data;
  assert.equal(blocked.pending, true);
  assert.equal(blocked.lead.id, first.lead.id, 'still the same lead, even after reopening the app');
  const other = (await users.tele1.get('/api/leads')).data.leads.find((l: any) => l.id !== first.lead.id);
  const refused = await users.tele1.post(`/api/dialer/start/${other.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /Save the result/);

  assert.equal((await users.tele1.post(`/api/leads/${first.lead.id}/call`, { disposition: 'Connected', duration_seconds: 125 })).status, 200);
  const next = (await users.tele1.get(`/api/dialer/next?list=${ids.list}`)).data;
  assert.notEqual(next.lead.id, first.lead.id);
  assert.equal(next.pending, false);
  const row = db.get('SELECT duration_seconds, status FROM calls WHERE lead_id = ?', first.lead.id);
  assert.equal(row.duration_seconds, 125);
  assert.equal(row.status, 'completed');
  assert.equal((await users.tele1.get('/api/brief')).data.progress.talk_minutes, 2);
});

test('an admin can turn enforcement off', async () => {
  const { data } = await users.admin.get('/api/settings');
  await users.admin.put('/api/settings', { ...data.settings, enforce_call_updates: false });
  const a = (await users.tele2.get(`/api/dialer/next?list=${ids.list}`)).data.lead;
  await users.tele2.post(`/api/dialer/start/${a.id}`);
  const other = (await users.tele2.get('/api/leads')).data.leads.find((l: any) => l.id !== a.id);
  assert.equal((await users.tele2.post(`/api/dialer/start/${other.id}`)).status, 201);
  await users.admin.put('/api/settings', { ...data.settings, enforce_call_updates: true });
});

test('do-not-contact leads never reach the queue, and other staff cannot call them', async () => {
  const lead = (await users.tele1.get(`/api/dialer/next?list=${ids.list}`)).data.lead;
  db.run('UPDATE leads SET do_not_contact = 1 WHERE id = ?', lead.id);
  assert.equal((await users.tele1.post(`/api/dialer/start/${lead.id}`)).status, 422);
  assert.notEqual((await users.tele1.get(`/api/dialer/next?list=${ids.list}`)).data.lead?.id, lead.id);
  assert.equal((await users.tele1.post(`/api/leads/${lead.id}/touch`, { channel: 'sms' })).status, 422);
  db.run('UPDATE leads SET do_not_contact = 0 WHERE id = ?', lead.id);
  assert.equal((await users.tele2.post(`/api/dialer/start/${lead.id}`)).status, 404);
  assert.equal((await users.marketing.post(`/api/dialer/start/${lead.id}`)).status, 403);
});

test('SMS and email taps are recorded on the timeline', async () => {
  const lead = (await users.tele1.get('/api/leads')).data.leads[0];
  assert.equal((await users.tele1.post(`/api/leads/${lead.id}/touch`, { channel: 'sms' })).status, 200);
  const t = (await users.tele1.get(`/api/leads/${lead.id}`)).data.timeline;
  assert.ok(t.some((a: any) => a.title === 'SMS opened from the app'));
});

test('labels tag chats, filter the inbox and leads, and can target a broadcast', async () => {
  assert.ok((await users.tele1.get('/api/directory')).data.labels.some((l: any) => l.name === 'Investor'));
  assert.equal((await users.tele1.put('/api/labels', { labels: [] })).status, 403);
  const { data } = await users.admin.get('/api/directory');
  assert.equal((await users.admin.put('/api/labels', { labels: [...data.labels, { name: 'Expo 2026', color: 'teal' }] })).status, 200);

  const mine = (await users.tele1.get('/api/leads')).data.leads;
  const [a, b] = mine;
  const theirs = (await users.tele2.get('/api/leads')).data.leads[0];
  assert.equal((await users.tele1.post(`/api/leads/${theirs.id}/labels`, { labels: ['Investor'] })).status, 404, 'cannot tag a colleague\'s lead');
  assert.equal((await users.tele1.post(`/api/leads/${a.id}/labels`, { labels: ['Expo 2026'] })).status, 200);
  db.run('UPDATE leads SET last_message_at = ? WHERE id IN (?, ?)', db.nowIso(), a.id, b.id);

  const filtered = (await users.tele1.get(`/api/inbox?label=${encodeURIComponent('Expo 2026')}`)).data.conversations;
  assert.deepEqual(filtered.map((c: any) => c.id), [a.id]);
  assert.deepEqual(filtered[0].labels, ['Expo 2026']);
  assert.equal((await users.tele1.get(`/api/leads?label=${encodeURIComponent('Expo 2026')}`)).data.total, 1);
  const preview = (await users.admin.post('/api/campaigns/preview', { segment: { labels: ['Expo 2026'] } })).data;
  assert.equal(preview.matched, 1);
});

test('follow-ups alert the owner once, shortly before they are due', async () => {
  const lead = (await users.tele1.get('/api/leads')).data.leads[0];
  await users.tele1.post(`/api/leads/${lead.id}/tasks`, { type: 'Call back', due_at: db.minutesFromNow(10) });
  await users.tele1.post(`/api/leads/${lead.id}/tasks`, { type: 'Meeting', due_at: db.minutesFromNow(600) });
  scheduler.sendFollowUpReminders();
  scheduler.sendFollowUpReminders();
  const notes = (await users.tele1.get('/api/notifications')).data.notifications;
  assert.equal(notes.filter((n: any) => n.title === 'Follow-up due: Call back').length, 1);
  assert.equal(notes.filter((n: any) => n.title === 'Follow-up due: Meeting').length, 0);
});
