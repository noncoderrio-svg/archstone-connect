// Targets by role: who may set them, what each role is measured on, the capped "target met" score, and the telecaller ranking.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prepareEnv, startHarness, type Harness } from './helpers/harness.ts';

const dir = prepareEnv('targets');
let h: Harness;
let project = 0;
let other = 0;
let phone = 9844400000;

const put = (who: string, id: number, body: unknown) => h.call('PUT', `/api/users/${id}/target`, who, body);
const leadFor = (owner: string, presales: string | null, projectId = project) =>
  h.db.run(`INSERT INTO leads(name, phone, owner_id, presales_id, project_id) VALUES('L', ?, ?, ?, ?)`, `+91${phone++}`, h.ids[owner], presales ? h.ids[presales] : null, projectId).id as number;
const call = (who: string, lead: number) => h.db.run(`INSERT INTO activities(lead_id, type, title, actor_id) VALUES(?, 'call', 'Call: Connected', ?)`, lead, h.ids[who]);
const qualify = (lead: number, actor: string) => h.db.run(`INSERT INTO activities(lead_id, type, title, actor_id) VALUES(?, 'stage', 'Stage: Contacted → Qualified', ?)`, lead, h.ids[actor]);
const visit = (lead: number, host: string | null = null, projectId = project) =>
  h.db.run(`INSERT INTO site_visits(lead_id, project_id, host_id, scheduled_at, status, otp) VALUES(?, ?, ?, datetime('now'), 'Completed', '1')`, lead, projectId, host ? h.ids[host] : null);
const book = (lead: number, amount = 50, projectId = project) => {
  const unit = h.db.run(`INSERT INTO units(project_id, floor, number) VALUES(?, 1, ?)`, projectId, `U${phone++}`).id;
  return h.db.run('INSERT INTO bookings(lead_id, unit_id, amount_lakhs) VALUES(?, ?, ?)', lead, unit, amount).id as number;
};

before(async () => {
  h = await startHarness(dir);
  project = h.db.run(`INSERT INTO projects(name) VALUES('Target Towers')`).id;
  other = h.db.run(`INSERT INTO projects(name) VALUES('Far Away')`).id;
  await h.addUser('teleA', 'telecaller');
  await h.addUser('teleB', 'telecaller');
  await h.addUser('teleC', 'telecaller');
  await h.addUser('closer', 'closing_manager');
  await h.addUser('sourcer', 'sourcing_manager');
  await h.addUser('payer', 'payment_followup', [project]);
  await h.addUser('head', 'site_head', [project]);
  // The demo telecallers would join the ranking, so they are paused for these tests.
  h.db.run(`UPDATE users SET status = 'paused' WHERE email LIKE ? AND role = 'telecaller'`, '%@demo.archstone.test');
});
after(() => h.stop());

test('target met averages each goal, capped at 100%, and no target means no score', async () => {
  const { targetMet } = await import('../shared/domain.ts');
  assert.equal(targetMet([{ target: 100, actual: 500 }, { target: 10, actual: 0 }]), 50, 'a huge number cannot hide a missed goal');
  assert.equal(targetMet([{ target: 100, actual: 50 }, { target: 10, actual: 10 }]), 75);
  assert.equal(targetMet([{ target: 0, actual: 50 }, { target: 4, actual: 1 }]), 25, 'goals without a target are left out');
  assert.equal(targetMet([{ target: 0, actual: 50 }]), null);
  assert.equal(targetMet([]), null);
});

test('each role is measured on its own goals', async () => {
  const { ROLE_GOALS } = await import('../shared/domain.ts');
  assert.deepEqual(ROLE_GOALS.telecaller, ['calls', 'qualified', 'visits']);
  assert.deepEqual(ROLE_GOALS.closing_manager, ['calls', 'visits', 'bookings']);
  assert.deepEqual(ROLE_GOALS.sourcing_manager, ['partner_contacts', 'partner_visits', 'partner_bookings']);
  assert.deepEqual(ROLE_GOALS.payment_followup, ['payment_followups', 'collected_lakhs']);
  assert.deepEqual(ROLE_GOALS.site_head, ['visits', 'bookings', 'collected_lakhs']);
});

test('only an admin sets targets, and only goals of the person\'s role', async () => {
  for (const who of ['head', 'sourcer', 'closer', 'teleA']) assert.equal((await put(who, h.ids.teleA, { goals: { calls: 10 } })).status, 403, who);
  assert.equal((await put('admin', h.ids.teleA, { goals: { bookings: 3 } })).status, 400, 'bookings is not a telecaller goal');
  assert.equal((await put('admin', h.ids.teleA, { goals: { calls: 4, qualified: 2, visits: 2 } })).status, 200);
  assert.equal((await put('admin', h.ids.admin, { goals: { calls: 1 } })).status, 400, 'admins have no targets');
});

test('a telecaller gets credit for leads they own and leads they passed on', async () => {
  const own = leadFor('teleA', 'teleA');
  const passed = leadFor('closer', 'teleA');
  for (let i = 0; i < 8; i++) call('teleA', own);
  qualify(own, 'teleA');
  qualify(passed, 'teleA');
  visit(passed, 'closer');
  const r = (await h.call('GET', '/api/targets', 'admin')).data.people.find((p: any) => p.name === 'teleA');
  const by = Object.fromEntries(r.goals.map((g: any) => [g.key, g]));
  assert.deepEqual([by.calls.actual, by.qualified.actual, by.visits.actual], [8, 2, 1]);
  // Calls 8/4 caps at 100, qualified 2/2 is 100, visits 1/2 is 50: (100 + 100 + 50) / 3.
  assert.equal(r.score, 83);
});

test('the other roles are measured on their own work', async () => {
  // Sourcing Manager: partner contacts, and visits and bookings from their partners.
  const partner = h.db.run(`INSERT INTO partners(name, manager_id) VALUES('Broker', ?)`, h.ids.sourcer).id;
  await h.call('POST', `/api/partners/${partner}/contacts`, 'sourcer', { kind: 'Call' });
  const pl = leadFor('closer', null);
  h.db.run('UPDATE leads SET partner_id = ? WHERE id = ?', partner, pl);
  visit(pl, 'closer');
  const booking = book(pl, 80);
  // Payment Follow-up: follow-ups logged and money collected on their projects.
  const payment = h.db.run(`INSERT INTO payments(booking_id, label, due_date, amount_lakhs) VALUES(?, 'Booking amount', date('now'), 8)`, booking).id;
  const unpaid = h.db.run(`INSERT INTO payments(booking_id, label, due_date, amount_lakhs) VALUES(?, 'Agreement', date('now'), 72)`, booking).id;
  await h.call('POST', `/api/payments/${unpaid}/followups`, 'payer', { outcome: 'No answer' });
  await h.call('POST', `/api/payments/${payment}/paid`, 'payer', { reference: 'UTR-100200' });
  // Something on another project does not count for the Site Head or Payment Follow-up.
  book(leadFor('closer', null, other), 99, other);
  const people = (await h.call('GET', '/api/targets', 'admin')).data.people;
  const goals = (name: string) => Object.fromEntries(people.find((p: any) => p.name === name).goals.map((g: any) => [g.key, g.actual]));
  assert.deepEqual(goals('sourcer'), { partner_contacts: 1, partner_visits: 1, partner_bookings: 1 });
  assert.deepEqual(goals('payer'), { payment_followups: 1, collected_lakhs: 8 });
  assert.deepEqual(goals('head'), { visits: 2, bookings: 1, collected_lakhs: 8 }, 'only their own project');
  assert.equal(goals('closer').visits, 2, 'visits they hosted');
});

test('targets show on the person\'s own dashboard and on the performance page', async () => {
  const brief = (await h.call('GET', '/api/brief', 'teleA')).data.progress;
  assert.equal(brief.score, 83);
  assert.deepEqual(brief.goals.map((g: any) => g.key), ['calls', 'qualified', 'visits']);
  const perf = (await h.call('GET', '/api/performance', 'admin')).data.agents.find((a: any) => a.name === 'teleA');
  assert.equal(perf.target_score, 83);
  const none = (await h.call('GET', '/api/brief', 'teleB')).data.progress;
  assert.equal(none.score, null, 'no target set, no score');
});

test('a manager sees their team\'s targets but cannot change them', async () => {
  h.db.run('UPDATE users SET manager_id = ? WHERE id = ?', h.ids.closer, h.ids.teleB);
  const r = (await h.call('GET', '/api/targets', 'closer')).data;
  assert.equal(r.can_edit, false);
  assert.deepEqual(r.people.map((p: any) => p.name).sort(), ['closer', 'teleB']);
  assert.equal((await h.call('GET', '/api/targets', 'payer')).status, 403);
});

test('top telecallers: bookings, then site visits, then qualified leads, then calls', async () => {
  // teleB: one booking on a lead they passed on. teleC: no bookings but many calls. teleA: no bookings, one visit.
  const passed = leadFor('closer', 'teleB');
  book(passed);
  const c = leadFor('teleC', 'teleC');
  for (let i = 0; i < 30; i++) call('teleC', c);
  const top = (await h.call('GET', '/api/dashboard', 'admin')).data.top_telecallers.map((t: any) => t.name);
  assert.deepEqual(top.slice(0, 3), ['teleB', 'teleA', 'teleC']);
  const headTop = (await h.call('GET', '/api/dashboard', 'head')).data.top_telecallers;
  assert.ok(Array.isArray(headTop), 'a Site Head sees it too');
  assert.equal((await h.call('GET', '/api/dashboard', 'closer')).data.top_telecallers, null, 'not on other dashboards');
});
