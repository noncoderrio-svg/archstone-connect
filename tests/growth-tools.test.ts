// Matching homes, workflow rules, the buyer page and duplicate merge.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-tools-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
let base = '';
let server: Server;
let db: any;
let matching: any;
let workflows: any;
let admin = '';
let tele = '';
let teleId = 0;
let projectId = 0;

async function call(method: string, path: string, who = admin, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie: who }, body: body === undefined ? undefined : JSON.stringify(body) });
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

const newLead = async (name: string, phone: string, extra: object = {}) =>
  (await call('POST', '/api/leads', admin, { name, phone, source: 'Manual', owner_id: teleId, ...extra })).data.id as number;
const settle = () => new Promise((r) => setTimeout(r, 200));

before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  matching = await import('../server/services/matching.ts');
  workflows = await import('../server/services/workflows.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = await signIn('owner@test.local');
  tele = await signIn('telecaller1@demo.archstone.test');
  teleId = (await call('GET', '/api/auth/me', tele)).data.user.id;
  projectId = db.get('SELECT id FROM projects LIMIT 1').id;
  db.run('DELETE FROM units WHERE project_id = ? AND status = ?', projectId, 'Available');
  const add = (number: string, configuration: string, price: number) =>
    db.run(`INSERT INTO units(project_id, tower, floor, number, configuration, price_lakhs, status) VALUES(?, 'Z', 1, ?, ?, ?, 'Available')`, projectId, number, configuration, price);
  add('Z1', '2 BHK', 95);
  add('Z2', '3 BHK', 150);
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('scoring respects budget and home size', () => {
  const unit = { project_id: 1, configuration: '2 BHK', price_lakhs: 100, location: 'Kurla West' } as any;
  const lead = { budget_lakhs: 100, configuration: '2 BHK', preferred_location: 'kurla', project_id: 1 };
  assert.equal(matching.scoreHome(lead, unit).score, 100);
  assert.equal(matching.scoreHome({ ...lead, budget_lakhs: 80 }, unit), null, 'over budget');
  assert.ok(matching.scoreHome({ ...lead, budget_lakhs: 95 }, unit).reasons.includes('Slightly over budget'));
  assert.equal(matching.scoreHome({ ...lead, configuration: '3 BHK' }, unit), null, 'wrong size');
  assert.equal(matching.scoreHome({ budget_lakhs: null, configuration: '', preferred_location: '', project_id: null }, unit), null);
});

test('a lead sees matching homes, and a project sees matching buyers within scope', async () => {
  const id = await newLead('Match Buyer', '9733300001', { budget_lakhs: 100, configuration: '2 BHK' });
  const homes = (await call('GET', `/api/leads/${id}/matches`, tele)).data.homes;
  assert.ok(homes.some((h: any) => h.number === 'Z1'));
  assert.ok(!homes.some((h: any) => h.number === 'Z2'));
  const buyers = (await call('GET', `/api/projects/${projectId}/buyers`, tele)).data.buyers;
  assert.ok(buyers.some((b: any) => b.id === id));
  const other = await signIn('telecaller2@demo.archstone.test');
  assert.ok(!(await call('GET', `/api/projects/${projectId}/buyers`, other)).data.buyers.some((b: any) => b.id === id));
  assert.equal((await call('GET', `/api/leads/${id}/matches`, other)).status >= 403, true);
});

test('only an administrator manages rules, and incomplete rules are refused', async () => {
  const rule = { name: 'Blocked', trigger: 'lead_created', action: 'create_task', config: {} };
  assert.equal((await call('POST', '/api/workflows', tele, rule)).status, 403);
  assert.equal((await call('POST', '/api/workflows', admin, { ...rule, action: 'add_label' })).status, 400);
  assert.equal((await call('POST', '/api/workflows', admin, { ...rule, trigger: 'stage_changed' })).status, 400);
});

test('a new lead rule creates a follow-up, only for matching leads', async () => {
  const r = await call('POST', '/api/workflows', admin, { name: 'Website call', trigger: 'lead_created', conditions: { source: 'Website' }, action: 'create_task', config: { task_type: 'Rule call', after_minutes: 5 } });
  assert.equal(r.status, 201);
  const web = await newLead('Web Rule', '9733300002', { source: 'Website' });
  const manual = await newLead('Manual Rule', '9733300003');
  await settle();
  assert.equal(db.get(`SELECT COUNT(*) n FROM tasks WHERE lead_id = ? AND type = 'Rule call'`, web).n, 1);
  assert.equal(db.get(`SELECT COUNT(*) n FROM tasks WHERE lead_id = ? AND type = 'Rule call'`, manual).n, 0);
  assert.equal((await call('GET', '/api/workflows')).data.rules.find((x: any) => x.id === r.data.id).runs, 1);
  await call('DELETE', `/api/workflows/${r.data.id}`);
});

test('a stage rule adds a label, and an off rule does nothing', async () => {
  const on = await call('POST', '/api/workflows', admin, { name: 'Tag qualified', trigger: 'stage_changed', conditions: { stage: 'Qualified' }, action: 'add_label', config: { label: 'Priority' } });
  const off = await call('POST', '/api/workflows', admin, { name: 'Off rule', enabled: false, trigger: 'stage_changed', conditions: { stage: 'Qualified' }, action: 'add_label', config: { label: 'Never' } });
  const id = await newLead('Stage Rule', '9733300004');
  const { changeStage } = await import('../server/services/leads.ts');
  changeStage(db.get('SELECT * FROM leads WHERE id = ?', id), 'Qualified', null);
  await settle();
  const labels = JSON.parse(db.get('SELECT labels FROM leads WHERE id = ?', id).labels);
  assert.ok(labels.includes('Priority'));
  assert.ok(!labels.includes('Never'));
  await call('DELETE', `/api/workflows/${on.data.id}`);
  await call('DELETE', `/api/workflows/${off.data.id}`);
});

test('an idle rule runs once until the lead wakes up', async () => {
  const r = await call('POST', '/api/workflows', admin, { name: 'Wake', trigger: 'lead_idle', conditions: { days: 5 }, action: 'notify_owner', config: { text: 'Quiet lead' } });
  const id = await newLead('Idle Rule', '9733300005');
  db.run(`UPDATE leads SET last_activity_at = datetime('now', '-6 days') WHERE id = ?`, id);
  await workflows.runIdleWorkflows();
  await workflows.runIdleWorkflows();
  assert.equal(db.get(`SELECT COUNT(*) n FROM workflow_runs WHERE rule_id = ? AND lead_id = ?`, r.data.id, id).n, 1);
  await call('DELETE', `/api/workflows/${r.data.id}`);
});

test('a WhatsApp rule still obeys consent', async () => {
  const template = db.get(`SELECT id FROM wa_templates WHERE category = 'MARKETING' LIMIT 1`);
  db.run(`UPDATE wa_templates SET status = 'approved' WHERE id = ?`, template.id);
  const r = await call('POST', '/api/workflows', admin, { name: 'Promo', trigger: 'lead_created', action: 'send_template', config: { template_id: template.id } });
  const id = await newLead('No Consent', '9733300006');
  await settle();
  assert.equal(db.get(`SELECT COUNT(*) n FROM wa_messages WHERE lead_id = ?`, id).n, 0, 'neither the rule nor the welcome may reach them');
  await call('DELETE', `/api/workflows/${r.data.id}`);
});

test('the buyer page is private, limited and can be turned off', async () => {
  const lead = await newLead('Buyer Portal', '9733300007');
  const unit = db.get(`SELECT id FROM units WHERE number = 'Z2'`).id;
  const { id: booking } = db.run(`INSERT INTO bookings(lead_id, unit_id, amount_lakhs) VALUES(?, ?, 150)`, lead, unit);
  db.run(`INSERT INTO payments(booking_id, label, due_date, amount_lakhs) VALUES(?, 'Booking amount', '2026-12-01', 15)`, booking);

  assert.equal((await call('POST', `/api/bookings/${booking}/portal`, tele)).status >= 403, true);
  const first = (await call('POST', `/api/bookings/${booking}/portal`)).data.url as string;
  const token = first.split('/buyer/')[1];
  assert.ok(token.length >= 30);
  assert.ok(!JSON.stringify(db.get('SELECT portal_hash FROM bookings WHERE id = ?', booking)).includes(token), 'only a hash is stored');

  const page = await call('GET', `/public/buyer/${token}`, '');
  assert.equal(page.status, 200);
  assert.equal(page.data.buyer, 'Buyer');
  assert.equal(page.data.payments.length, 1);
  assert.ok(!JSON.stringify(page.data).includes('9733300007'), 'no phone number on the page');

  assert.equal((await call('GET', '/public/buyer/wrong-token-here', '')).status, 404);
  const second = (await call('POST', `/api/bookings/${booking}/portal`)).data.url as string;
  assert.equal((await call('GET', `/public/buyer/${token}`, '')).status, 404, 'a new link stops the old one');
  assert.equal((await call('DELETE', `/api/bookings/${booking}/portal`)).status, 200);
  assert.equal((await call('GET', `/public/buyer/${second.split('/buyer/')[1]}`, '')).status, 404);
});

test('duplicates are found and merged without losing history', async () => {
  const keep = await newLead('Rahul Twin', '9733300008', { email: 'twin@test.local' });
  const other = await newLead('rahul  twin', '9733300009', { budget_lakhs: 120, configuration: '2 BHK' });
  db.run(`INSERT INTO tasks(lead_id, owner_id, type, due_at) VALUES(?, ?, 'Call back', datetime('now', '+1 day'))`, other, teleId);
  await call('POST', `/api/leads/${other}/labels`, admin, { labels: ['Twin'] });

  assert.equal((await call('GET', '/api/leads-duplicates', tele)).status, 403);
  const groups = (await call('GET', '/api/leads-duplicates')).data.groups;
  assert.ok(groups.some((g: any) => g.leads.some((l: any) => l.id === keep) && g.leads.some((l: any) => l.id === other)));

  assert.equal((await call('POST', '/api/leads/merge', admin, { keep_id: keep, merge_id: keep })).status, 400);
  assert.equal((await call('POST', '/api/leads/merge', tele, { keep_id: keep, merge_id: other })).status, 403);
  assert.equal((await call('POST', '/api/leads/merge', admin, { keep_id: keep, merge_id: other })).status, 200);

  const kept = db.get('SELECT * FROM leads WHERE id = ?', keep);
  assert.equal(kept.budget_lakhs, 120);
  assert.equal(kept.configuration, '2 BHK');
  assert.equal(kept.wa_opt_in, 0, 'consent is not copied');
  assert.equal(db.get(`SELECT COUNT(*) n FROM tasks WHERE lead_id = ?`, keep).n, 1);
  assert.equal(db.get(`SELECT COUNT(*) n FROM tasks WHERE lead_id = ?`, other).n, 0);
  assert.equal(db.get('SELECT merged_into FROM leads WHERE id = ?', other).merged_into, keep);
  assert.ok(!(await call('GET', '/api/leads-deleted')).data.leads.some((l: any) => l.id === other));
  assert.equal((await call('POST', `/api/leads/${other}/restore`)).status, 400);

  // A new enquiry from the merged number joins the kept lead.
  const again = await call('POST', '/api/leads', admin, { name: 'Rahul Again', phone: '9733300009', source: 'Website' });
  assert.equal(again.data.id, keep);
  assert.equal(db.get('SELECT deleted_at FROM leads WHERE id = ?', other).deleted_at !== null, true);
});
