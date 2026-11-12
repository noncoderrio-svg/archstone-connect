// Reporting lines: who sees what, who gets alerts, and what stays the same.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-tree-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
let base = '';
let server: Server;
let db: any;
let scheduler: any;
let hierarchy: any;
const session: Record<string, string> = {};
const ids: Record<string, number> = {};

async function call(method: string, path: string, who: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie: session[who] ?? who }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, set };
}

async function signInWith(who: string, email: string, current: string) {
  const login = await call('POST', '/api/auth/login', '', { email, password: current });
  const cookie = login.set!.split(';')[0];
  const changed = await call('POST', '/api/auth/password', cookie, { current, next: NEW_PASSWORD });
  assert.equal(changed.status, 200);
  session[who] = changed.set ? changed.set.split(';')[0] : cookie;
  ids[who] = (await call('GET', '/api/auth/me', who)).data.user.id;
}

async function signIn(who: string, email: string) {
  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(` ${email} `))!;
  await signInWith(who, email, line.trim().split(/\s+/)[2]);
}

async function addUser(who: string, role: string) {
  const email = `${who}@test.local`;
  const r = await call('POST', '/api/users', 'admin', { name: who, email, role });
  assert.equal(r.status, 201);
  await signInWith(who, email, r.data.temporaryPassword);
}

const report = (who: string, manager: string | null) => db.run('UPDATE users SET manager_id = ? WHERE id = ?', manager ? ids[manager] : null, ids[who]);
async function leadFor(who: string, phone: string) {
  const { id } = (await call('POST', '/api/leads', 'admin', { name: `Lead of ${who}`, phone, source: 'Manual' })).data;
  db.run('UPDATE leads SET owner_id = ?, presales_id = NULL WHERE id = ?', ids[who], id);
}
const seen = async (who: string) => (await call('GET', '/api/leads?board=1', who)).data.leads.map((l: any) => l.name).filter((n: string) => n.startsWith('Lead of')).sort();

before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  scheduler = await import('../server/services/scheduler.ts');
  hierarchy = await import('../server/services/hierarchy.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await signIn('admin', 'owner@test.local');
  await addUser('head', 'sourcing_manager');
  await addUser('tlA', 'closing_manager');
  await addUser('tlB', 'closing_manager');
  await addUser('agent1', 'telecaller');
  await addUser('agent2', 'closing_manager');
  await addUser('agent3', 'telecaller');
  await leadFor('agent1', '9744400001');
  await leadFor('agent2', '9744400002');
  await leadFor('agent3', '9744400003');
});

beforeEach(() => {
  db.setSetting('alert_rules', { quiet_enabled: false });
  db.run('DELETE FROM notifications');
  db.run('DELETE FROM tasks');
  for (const who of ['head', 'tlA', 'tlB', 'agent1', 'agent2', 'agent3']) report(who, null);
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

const shape = () => {
  report('tlA', 'head');
  report('tlB', 'head');
  report('agent1', 'tlA');
  report('agent2', 'tlA');
  report('agent3', 'tlB');
};

test('with no reporting lines, a Sourcing Manager sees only their own leads', async () => {
  assert.ok(!(await seen('head')).some((n: string) => n.startsWith('Lead of agent')));
  assert.deepEqual(await seen('agent1'), ['Lead of agent1']);
});

test('each level sees its own team, all the way down', async () => {
  shape();
  assert.deepEqual(await seen('tlA'), ['Lead of agent1', 'Lead of agent2']);
  assert.deepEqual(await seen('tlB'), ['Lead of agent3']);
  assert.deepEqual(await seen('head'), ['Lead of agent1', 'Lead of agent2', 'Lead of agent3']);
  assert.deepEqual(await seen('agent1'), ['Lead of agent1']);
  assert.ok((await seen('admin')).length >= 3);
});

test('a team leader cannot open a lead from another team', async () => {
  shape();
  const other = db.get(`SELECT id FROM leads WHERE name = 'Lead of agent3'`).id;
  assert.equal((await call('GET', `/api/leads/${other}`, 'tlA')).status, 404);
  assert.equal((await call('GET', `/api/leads/${other}`, 'tlB')).status, 200);
});

test('reporting lines cannot be broken or looped', async () => {
  shape();
  const body = async (who: string, manager: string) => {
    const u = (await call('GET', '/api/users', 'admin')).data.users.find((x: any) => x.id === ids[who]);
    return call('PUT', `/api/users/${ids[who]}`, 'admin', { name: u.name, email: u.email, role: u.role, manager_id: ids[manager] });
  };
  assert.equal((await body('head', 'agent1')).status, 400, 'an agent cannot be a manager');
  assert.match((await body('head', 'tlA')).data.error, /loop/);
  assert.match((await body('tlA', 'tlA')).data.error, /themselves/);
  assert.equal((await body('agent3', 'tlA')).status, 200);
  assert.deepEqual(await seen('tlA'), ['Lead of agent1', 'Lead of agent2', 'Lead of agent3']);
});

test('saving a person without the field keeps their manager', async () => {
  shape();
  const u = (await call('GET', '/api/users', 'admin')).data.users.find((x: any) => x.id === ids.agent1);
  assert.equal(u.manager_name, 'tlA');
  assert.equal((await call('PUT', `/api/users/${ids.agent1}`, 'admin', { name: u.name, email: u.email, role: u.role })).status, 200);
  assert.equal(db.get('SELECT manager_id FROM users WHERE id = ?', ids.agent1).manager_id, ids.tlA);
  assert.equal((await call('POST', '/api/users/1/move-team', 'tlA', { manager_id: null })).status, 403);
});

test('overdue follow-ups climb the chain one level at a time', () => {
  shape();
  const lead = db.get(`SELECT id FROM leads WHERE name = 'Lead of agent1'`).id;
  const task = db.run(`INSERT INTO tasks(lead_id, owner_id, type, due_at) VALUES(?, ?, 'Call back', ?)`, lead, ids.agent1, db.minutesFromNow(-150)).id;
  db.setSetting('alert_rules', { quiet_enabled: false, escalate_after_minutes: 120 });
  const got = (who: string) => db.all(`SELECT id FROM notifications WHERE user_id = ? AND title = 'Team follow-up overdue'`, ids[who]).length;
  scheduler.sendOverdueAlerts();
  scheduler.sendOverdueAlerts();
  assert.equal(got('tlA'), 1, 'direct manager first');
  assert.equal(got('head'), 0, 'not the next level yet');
  db.run('UPDATE tasks SET due_at = ? WHERE id = ?', db.minutesFromNow(-250), task);
  scheduler.sendOverdueAlerts();
  assert.equal(got('head'), 1);
  assert.equal(got('tlB'), 0, 'other teams are not bothered');
});

test('a paused manager is skipped', () => {
  shape();
  db.run(`UPDATE users SET status = 'paused' WHERE id = ?`, ids.tlA);
  assert.deepEqual(hierarchy.managerChain(ids.agent1), [ids.head]);
  db.run(`UPDATE users SET status = 'active' WHERE id = ?`, ids.tlA);
  assert.deepEqual(hierarchy.managerChain(ids.agent1), [ids.tlA, ids.head]);
});

test('a team can move to a new manager in one step', async () => {
  shape();
  const r = await call('POST', `/api/users/${ids.tlA}/move-team`, 'admin', { manager_id: ids.tlB });
  assert.equal(r.data.moved, 2);
  assert.deepEqual(await seen('tlA'), []);
  assert.deepEqual(await seen('tlB'), ['Lead of agent1', 'Lead of agent2', 'Lead of agent3']);
  assert.equal((await call('POST', `/api/users/${ids.tlB}/move-team`, 'admin', { manager_id: ids.agent1 })).status, 400);
});

test('performance and assignment stay inside the team', async () => {
  shape();
  const names = (await call('GET', '/api/performance', 'tlA')).data.agents.map((a: any) => a.name).sort();
  assert.deepEqual(names, ['agent1', 'agent2', 'tlA']);
  assert.equal((await call('GET', '/api/performance', 'tlA')).data.team_view, true);
  const lead = db.get(`SELECT id FROM leads WHERE name = 'Lead of agent1'`).id;
  assert.equal((await call('POST', '/api/leads/assign', 'tlA', { lead_ids: [lead], owner_id: ids.agent3 })).status, 403);
  assert.equal((await call('POST', '/api/leads/assign', 'tlA', { lead_ids: [lead], owner_id: ids.agent2 })).status, 200);
  db.run('UPDATE leads SET owner_id = ?, presales_id = ? WHERE id = ?', ids.agent1, ids.agent1, lead);
  assert.deepEqual((await call('GET', '/api/directory', 'tlA')).data.team_ids.sort(), [ids.tlA, ids.agent1, ids.agent2].sort());
  assert.equal((await call('GET', '/api/directory', 'admin')).data.team_ids, null);
});

test('a data-scope choice by the admin still wins', async () => {
  shape();
  db.run(`UPDATE users SET data_scope = 'own' WHERE id = ?`, ids.tlA);
  assert.deepEqual(await seen('tlA'), []);
  db.run(`UPDATE users SET data_scope = '' WHERE id = ?`, ids.tlA);
  // Editing a person signs them out, so this checks the rule directly.
  const { leadScope } = await import('../server/services/core.ts');
  const scope = leadScope({ id: ids.agent1, role: 'telecaller', data_scope: 'all', project_ids: [] } as any);
  assert.equal(scope.sql, 'l.deleted_at IS NULL');
});
