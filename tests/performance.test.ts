// Agent follow-up performance, its filters, and who may see it.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-perf-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
let base = '';
let server: Server;
let db: any;
let perf: any;
let admin = '';
let tele = '';
let teleId = 0;
let otherId = 0;
let leadId = 0;
let projectId = 0;

async function call(path: string, who = admin) {
  const res = await fetch(base + path, { headers: { cookie: who } });
  return { status: res.status, data: await res.json() };
}

async function signIn(email: string) {
  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(` ${email} `))!;
  const current = line.trim().split(/\s+/)[2];
  const post = (path: string, body: unknown, cookie = '') => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  const session = (await post('/api/auth/login', { email, password: current })).headers.get('set-cookie')!.split(';')[0];
  const changed = await post('/api/auth/password', { current, next: NEW_PASSWORD }, session);
  assert.equal(changed.status, 200);
  return changed.headers.get('set-cookie')?.split(';')[0] ?? session;
}

const addTask = (due: string, done: string | null) => db.run(
  `INSERT INTO tasks(lead_id, owner_id, type, due_at, completed_at) VALUES(?, ?, 'Call back', datetime('now', ?), ${done ? `datetime('now', ?)` : 'NULL'})`,
  ...(done ? [leadId, teleId, due, done] : [leadId, teleId, due]),
);

before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  perf = await import('../server/services/performance.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = await signIn('owner@test.local');
  tele = await signIn('telecaller1@demo.archstone.test');
  teleId = (await call('/api/auth/me', tele)).data.user.id;
  otherId = db.get(`SELECT id FROM users WHERE email = 'telecaller2@demo.archstone.test'`).id;
  const lead = db.get('SELECT id, project_id FROM leads WHERE project_id IS NOT NULL LIMIT 1');
  leadId = lead.id;
  projectId = lead.project_id;
  db.run('DELETE FROM tasks');
  addTask('-5 hours', '-295 minutes'); // Five minutes after it was due: on time.
  addTask('-4 hours', '-1 hours'); // Three hours late.
  addTask('-3 hours', null); // Missed.
  addTask('+1 day', null); // Still to come.
  addTask('-60 days', '-60 days'); // Outside the period.
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('follow-ups are sorted into on time, late and missed', async () => {
  const to = new Date(Date.now() + 2 * 86400000).toISOString();
  const { agents, totals } = (await call(`/api/performance?created_to=${to}`)).data;
  const a = agents.find((x: any) => x.id === teleId);
  assert.equal(a.due, 4);
  assert.equal(a.on_time, 1);
  assert.equal(a.late, 1);
  assert.equal(a.missed, 1);
  assert.equal(a.pending, 1);
  assert.equal(a.on_time_rate, 33);
  assert.ok(a.avg_delay_minutes >= 170 && a.avg_delay_minutes <= 190);
  assert.equal(totals.missed, 1);
  assert.equal(totals.on_time_rate, 33);
});

test('the period, agent and project filters narrow the numbers', async () => {
  const from = new Date(Date.now() - 90 * 86400000).toISOString();
  const wide = (await call(`/api/performance?created_from=${from}`)).data.agents.find((x: any) => x.id === teleId);
  assert.equal(wide.on_time, 2);
  const one = (await call(`/api/performance?owner=${teleId}`)).data.agents;
  assert.deepEqual(one.map((a: any) => a.id), [teleId]);
  const otherProject = db.get('SELECT id FROM projects WHERE id != ? LIMIT 1', projectId).id;
  assert.equal((await call(`/api/performance?owner=${teleId}&project=${otherProject}`)).data.agents[0].due, 0);
  assert.equal((await call(`/api/performance?role=closing_manager`)).data.agents.every((a: any) => a.role === 'closing_manager'), true);
});

test('agents see only themselves, even if they ask for someone else', async () => {
  const mine = (await call('/api/performance', tele)).data;
  assert.equal(mine.team_view, false);
  assert.deepEqual(mine.agents.map((a: any) => a.id), [teleId]);
  const asked = (await call(`/api/performance?owner=${otherId}`, tele)).data;
  assert.deepEqual(asked.agents.map((a: any) => a.id), [teleId]);
});

test('snoozing is counted, so it cannot hide a delay', async () => {
  const task = addTask('+3 hours', null);
  db.run('UPDATE tasks SET snoozes = 2 WHERE id = ?', task.id);
  const to = new Date(Date.now() + 2 * 86400000).toISOString();
  const a = (await call(`/api/performance?owner=${teleId}&created_to=${to}`)).data.agents[0];
  assert.equal(a.moved, 2);
});

test('the score weighs follow-ups most and skips missing parts', () => {
  assert.equal(perf.activityScore(100, 100, 100), 100);
  assert.equal(perf.activityScore(100, 0, 0), 50);
  assert.equal(perf.activityScore(0, 100, 100), 50);
  assert.equal(perf.activityScore(80, null, null), 80);
  assert.equal(perf.activityScore(null, null, null), null);
  assert.equal(perf.activityScore(null, null, 100), null, 'no work means no score, not a perfect one');
});

test('deleted leads do not count against anyone', async () => {
  const to = new Date(Date.now() + 2 * 86400000).toISOString();
  const before = (await call(`/api/performance?owner=${teleId}&created_to=${to}`)).data.agents[0].missed;
  db.run('UPDATE leads SET deleted_at = ? WHERE id = ?', db.nowIso(), leadId);
  assert.equal((await call(`/api/performance?owner=${teleId}&created_to=${to}`)).data.agents[0].missed, before - 1);
  db.run('UPDATE leads SET deleted_at = NULL WHERE id = ?', leadId);
});
