// Lead, inbox, dashboard, report and audit filters on the server.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-filters-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
let base = '';
let server: Server;
let db: any;
let admin = '';
let telecaller = '';
let telecallerId = 0;
const ids: Record<string, number> = {};

async function call(method: string, path: string, who = admin, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, set };
}

async function signIn(email: string) {
  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(` ${email} `))!;
  const current = line.trim().split(/\s+/)[2];
  const login = await call('POST', '/api/auth/login', '', { email, password: current });
  const session = login.set!.split(';')[0];
  const changed = await call('POST', '/api/auth/password', session, { current, next: NEW_PASSWORD });
  assert.equal(changed.status, 200);
  return changed.set ? changed.set.split(';')[0] : session;
}

const names = async (query: string, who = admin) => (await call('GET', `/api/leads?${query}`, who)).data.leads.map((l: any) => l.name);

before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = await signIn('owner@test.local');
  telecaller = await signIn('telecaller1@demo.archstone.test');
  telecallerId = (await call('GET', '/api/auth/me', telecaller)).data.user.id;

  const add = async (name: string, phone: string, budget: number, configuration: string) => {
    const r = await call('POST', '/api/leads', admin, { name, phone, budget_lakhs: budget, configuration, source: 'Manual' });
    assert.equal(r.status, 201);
    ids[name] = r.data.id;
  };
  await add('Zed Filter', '9711100001', 90, '2 BHK');
  await add('Yan Filter', '9711100002', 150, '3 BHK');
  await add('Xia Filter', '9711100003', 700, '4 BHK');
  db.run(`UPDATE leads SET created_at = datetime('now', '-40 days') WHERE id = ?`, ids['Zed Filter']);
  db.run(`INSERT INTO tasks(lead_id, owner_id, type, due_at) VALUES(?, ?, 'Call back', datetime('now', '-2 hours'))`, ids['Yan Filter'], telecallerId);
  db.run(`INSERT INTO tasks(lead_id, owner_id, type, due_at) VALUES(?, ?, 'Meeting', datetime('now', '+3 days'))`, ids['Xia Filter'], telecallerId);
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('budget bands and the slider limit', async () => {
  assert.deepEqual(await names('q=Filter&budget=lt100'), ['Zed Filter']);
  assert.deepEqual(await names('q=Filter&budget=100-200'), ['Yan Filter']);
  assert.deepEqual(await names('q=Filter&budget=gt500'), ['Xia Filter']);
  assert.deepEqual((await names('q=Filter&budget_max=200&sort=budget_high')), ['Yan Filter', 'Zed Filter']);
});

test('created date range', async () => {
  const from = new Date(Date.now() - 7 * 86400000).toISOString();
  const recent = await names(`q=Filter&created_from=${from}`);
  assert.ok(!recent.includes('Zed Filter'));
  assert.equal(recent.length, 2);
  const to = new Date(Date.now() - 30 * 86400000).toISOString();
  assert.deepEqual(await names(`q=Filter&created_to=${to}`), ['Zed Filter']);
});

test('task status can combine, and actions match open tasks', async () => {
  assert.deepEqual(await names('q=Filter&task=overdue'), ['Yan Filter']);
  assert.deepEqual(await names('q=Filter&task=upcoming'), ['Xia Filter']);
  assert.deepEqual(await names('q=Filter&task=none'), ['Zed Filter']);
  assert.equal((await names('q=Filter&task=overdue,upcoming')).length, 2);
  assert.deepEqual(await names('q=Filter&action=Meeting'), ['Xia Filter']);
  assert.ok((await call('GET', '/api/leads?q=Filter')).data.actions.includes('Meeting'));
});

test('sorting', async () => {
  assert.deepEqual(await names('q=Filter&sort=budget_high'), ['Xia Filter', 'Yan Filter', 'Zed Filter']);
  assert.deepEqual(await names('q=Filter&sort=name'), ['Xia Filter', 'Yan Filter', 'Zed Filter']);
  assert.deepEqual((await names('q=Filter&sort=oldest'))[0], 'Zed Filter');
});

test('an unknown sort cannot reach the database', async () => {
  const r = await call('GET', `/api/leads?sort=${encodeURIComponent('l.name; DROP TABLE leads')}`);
  assert.equal(r.status, 200);
  assert.ok(db.get('SELECT COUNT(*) n FROM leads').n > 0);
});

test('stage counts ignore the chosen stage', async () => {
  const stage = db.get('SELECT stage FROM leads WHERE id = ?', ids['Zed Filter']).stage;
  const all = (await call('GET', '/api/leads?q=Filter')).data;
  const one = (await call('GET', '/api/leads?q=Filter&stage=Booked')).data;
  assert.equal(one.total, 0);
  assert.deepEqual(one.stage_counts, all.stage_counts);
  assert.equal(all.stage_counts[stage] >= 1, true);
});

test('home type filter', async () => {
  assert.deepEqual(await names('q=Filter&configuration=3%20BHK'), ['Yan Filter']);
});

test('exports match the filters', async () => {
  const csv = (await call('GET', '/api/leads/export?q=Filter&budget=gt500')).data as string;
  assert.ok(csv.includes('Xia Filter'));
  assert.ok(!csv.includes('Yan Filter'));
});

test('filters never widen what someone may see', async () => {
  const mine = (await call('GET', '/api/leads?board=1', telecaller)).data.leads.map((l: any) => l.id);
  const everyone = (await call('GET', '/api/leads?board=1')).data.total;
  assert.ok(mine.length < everyone);
  // Even when asking for another person's leads, only leads already visible may return.
  const other = (await call('GET', '/api/users')).data.users.find((u: any) => u.role === 'closing_manager');
  const asked = (await call('GET', `/api/leads?owner=${other.id}&board=1`, telecaller)).data.leads.map((l: any) => l.id);
  assert.ok(asked.every((id: number) => mine.includes(id)));
  assert.ok((await call('GET', `/api/leads?owner=${other.id}&board=1`)).data.total >= asked.length);
});

test('auto distribute shares unassigned leads out', async () => {
  db.run(`UPDATE leads SET owner_id = NULL WHERE name LIKE '%Filter'`);
  assert.equal((await call('POST', '/api/leads/auto-distribute', telecaller)).status, 403);
  const before = (await call('GET', '/api/leads?owner=none')).data.total;
  assert.ok(before >= 3);
  const r = await call('POST', '/api/leads/auto-distribute');
  assert.equal(r.status, 200);
  assert.equal(r.data.assigned, before);
  assert.equal((await call('GET', '/api/leads?owner=none')).data.total, 0);
  const owners = db.all(`SELECT DISTINCT owner_id FROM leads WHERE name LIKE '%Filter'`);
  assert.ok(owners.length >= 2, 'round robin should use more than one telecaller');
});

test('inbox filters by project, owner and message date', async () => {
  const lead = db.get('SELECT id, project_id FROM leads WHERE project_id IS NOT NULL LIMIT 1');
  db.run(`UPDATE leads SET last_message_at = datetime('now', '-2 hours') WHERE id = ?`, lead.id);
  const hit = await call('GET', `/api/inbox?project=${lead.project_id}`);
  assert.ok(hit.data.conversations.some((c: any) => c.id === lead.id));
  const later = new Date(Date.now() + 86400000).toISOString();
  assert.equal((await call('GET', `/api/inbox?message_from=${later}`)).data.conversations.length, 0);
  const earlier = new Date(Date.now() - 86400000).toISOString();
  assert.ok((await call('GET', `/api/inbox?message_from=${earlier}`)).data.conversations.length >= 1);
});

test('dashboard narrows to a project', async () => {
  const all = (await call('GET', '/api/dashboard')).data.stats.totalLeads;
  const project = db.get('SELECT project_id, COUNT(*) n FROM leads WHERE project_id IS NOT NULL AND deleted_at IS NULL GROUP BY project_id LIMIT 1');
  const one = (await call('GET', `/api/dashboard?project=${project.project_id}`)).data.stats.totalLeads;
  assert.equal(one, project.n);
  assert.ok(one <= all);
});

test('reports narrow by source and date', async () => {
  const r = (await call('GET', '/api/reports?days=365&source=Manual')).data;
  assert.ok(r.sources.every((s: any) => s.source === 'Manual'));
  const future = new Date(Date.now() + 86400000).toISOString();
  assert.equal((await call('GET', `/api/reports?days=30&created_from=${future}`)).data.newLeads, 0);
  const file = await fetch(`${base}/api/reports/export?format=xlsx&days=30&source=Manual`, { headers: { cookie: admin } });
  assert.equal(file.status, 200);
});

test('audit log filters by area and text', async () => {
  const all = (await call('GET', '/api/audit')).data;
  assert.ok(all.groups.includes('lead'));
  const leads = (await call('GET', '/api/audit?group=lead')).data.entries;
  assert.ok(leads.length && leads.every((e: any) => e.action.startsWith('lead.')));
  assert.ok(!(await call('GET', '/api/audit?q=zzznothing')).data.entries.length);
});
