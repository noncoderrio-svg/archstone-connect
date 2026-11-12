// Sourcing Manager desk: partner visibility, who is due today, the contact log, moving partners, partner leads and rankings.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prepareEnv, startHarness, type Harness } from './helpers/harness.ts';

const dir = prepareEnv('partners');
let h: Harness;
let project = 0;
const pid: Record<string, number> = {};

const get = (who: string, path = '/api/partners') => h.call('GET', path, who);
const post = (who: string, path: string, body?: unknown) => h.call('POST', path, who, body);
const names = (data: any) => data.partners.map((p: any) => p.name).sort();

before(async () => {
  h = await startHarness(dir);
  project = h.db.run(`INSERT INTO projects(name) VALUES('Partner Park')`).id;
  await h.addUser('smA', 'sourcing_manager');
  await h.addUser('smB', 'sourcing_manager');
  await h.addUser('head', 'site_head', [project]);
  await h.addUser('closer', 'closing_manager');
  await h.addUser('tele', 'telecaller');
  pid.mine = (await post('smA', '/api/partners', { name: 'A Own', firm: 'Alpha Realty', area: 'Powai', phone: '9822200001', commission_percent: 1 })).data.id;
  pid.theirs = (await post('smB', '/api/partners', { name: 'B Own', area: 'Thane', commission_percent: 1 })).data.id;
  pid.open = (await post('admin', '/api/partners', { name: 'Nobody Owns', commission_percent: 1 })).data.id;
});
after(() => h.stop());

test('a Sourcing Manager\'s new partner is theirs; an admin can leave one unassigned', () => {
  assert.equal(h.db.get('SELECT manager_id FROM partners WHERE id = ?', pid.mine).manager_id, h.ids.smA);
  assert.equal(h.db.get('SELECT manager_id FROM partners WHERE id = ?', pid.open).manager_id, null);
  assert.equal(h.db.get('SELECT area FROM partners WHERE id = ?', pid.mine).area, 'Powai');
});

test('a Sourcing Manager sees their own and unassigned partners; Admin and Site Head see all', async () => {
  assert.deepEqual(names((await get('smA')).data), ['A Own', 'Nobody Owns']);
  assert.deepEqual(names((await get('smB')).data), ['B Own', 'Nobody Owns']);
  assert.deepEqual(names((await get('admin')).data), ['A Own', 'B Own', 'Nobody Owns']);
  assert.deepEqual(names((await get('head')).data), ['A Own', 'B Own', 'Nobody Owns']);
  assert.equal((await get('smA', `/api/partners/${pid.theirs}/contacts`)).status, 404, 'another manager\'s partner is hidden');
  assert.equal((await h.call('PUT', `/api/partners/${pid.theirs}`, 'smA', { name: 'Taken', commission_percent: 1 })).status, 404);
  assert.equal((await get('closer')).status, 403, 'needs the partner permission');
});

test('due today: never contacted, or the contact-again date has arrived', async () => {
  const due = (who: string) => get(who).then((r) => r.data.partners.filter((p: any) => p.due).map((p: any) => p.name).sort());
  assert.deepEqual(await due('smA'), ['A Own', 'Nobody Owns'], 'nobody has contacted them yet');
  const tomorrow = new Date(Date.now() + 330 * 60000 + 86400000).toISOString().slice(0, 10);
  assert.equal((await post('smA', `/api/partners/${pid.mine}/contacts`, { kind: 'Call', notes: 'Shared the new price list', next_contact_on: tomorrow })).status, 201);
  assert.deepEqual(await due('smA'), ['Nobody Owns'], 'contacted, next date is tomorrow');
  // When the date arrives, they are due again.
  h.db.run(`UPDATE partners SET next_contact_on = date('now', '+330 minutes') WHERE id = ?`, pid.mine);
  assert.deepEqual(await due('smA'), ['A Own', 'Nobody Owns']);
  await post('smA', `/api/partners/${pid.open}/contacts`, { kind: 'Meeting', notes: 'Met at the office' });
  assert.ok(!(await due('smA')).includes('Nobody Owns'), 'contacted with no follow-up date: not due');
});

test('the contact log keeps each contact with notes and the next date', async () => {
  await post('smA', `/api/partners/${pid.mine}/contacts`, { kind: 'WhatsApp', notes: 'Sent the brochure' });
  await post('smA', `/api/partners/${pid.mine}/contacts`, { kind: 'Site visit', notes: 'Walked the show flat' });
  const { contacts } = (await get('smA', `/api/partners/${pid.mine}/contacts`)).data;
  assert.deepEqual(contacts.slice(0, 3).map((c: any) => c.kind), ['Site visit', 'WhatsApp', 'Call']);
  assert.equal(contacts[0].user_name, 'smA');
  assert.equal((await post('smA', `/api/partners/${pid.mine}/contacts`, { kind: 'Email' })).status, 400, 'only the four kinds');
  assert.equal((await post('smA', `/api/partners/${pid.mine}/contacts`, { kind: 'Call', next_contact_on: '2001-01-01' })).status, 400, 'no dates in the past');
});

test('only an Admin or Site Head can move a partner to another Sourcing Manager', async () => {
  assert.equal((await h.call('PUT', `/api/partners/${pid.open}/manager`, 'smA', { manager_id: h.ids.smA })).status, 403);
  assert.equal((await h.call('PUT', `/api/partners/${pid.open}/manager`, 'admin', { manager_id: h.ids.closer })).status, 400, 'must be a Sourcing Manager');
  assert.equal((await h.call('PUT', `/api/partners/${pid.open}/manager`, 'head', { manager_id: h.ids.smB })).status, 200);
  assert.deepEqual(names((await get('smA')).data), ['A Own']);
  assert.deepEqual(names((await get('smB')).data), ['B Own', 'Nobody Owns']);
  await h.call('PUT', `/api/partners/${pid.open}/manager`, 'admin', { manager_id: null });
});

test('a partner lead can pick the project and the person, or use automatic routing', async () => {
  const chosen = await post('smA', `/api/partners/${pid.mine}/leads`, { name: 'Chosen Buyer', phone: '9822200101', project_id: project, owner_id: h.ids.closer });
  assert.equal(chosen.status, 201);
  const lead = h.db.get('SELECT * FROM leads WHERE id = ?', chosen.data.id);
  assert.equal(lead.project_id, project);
  assert.equal(lead.owner_id, h.ids.closer);
  assert.equal(lead.partner_id, pid.mine);
  assert.equal(lead.source, 'Channel Partner');
  const auto = await post('smA', `/api/partners/${pid.mine}/leads`, { name: 'Routed Buyer', phone: '9822200102' });
  assert.equal(auto.status, 201);
  const routed = h.db.get('SELECT u.role FROM leads l JOIN users u ON u.id = l.owner_id WHERE l.id = ?', auto.data.id);
  assert.equal(routed.role, 'telecaller', 'automatic routing picks a telecaller');
  assert.equal((await post('smA', `/api/partners/${pid.mine}/leads`, { name: 'Bad', phone: '9822200103', owner_id: h.ids.smB + 999 })).status, 400);
  // The Sourcing Manager sees leads from their own partners even when someone else owns them.
  assert.equal((await h.call('GET', `/api/leads/${auto.data.id}`, 'smA')).status, 200);
  assert.equal((await h.call('GET', `/api/leads/${auto.data.id}`, 'smB')).status, 404);
});

test('7-day lists, bookings this month and top partners ranked by bookings, then value', async () => {
  const unit = (n: string) => h.db.run(`INSERT INTO units(project_id, tower, floor, number, price_lakhs) VALUES(?, 'P', 1, ?, 90)`, project, n).id;
  const lead = async (partner: number, phone: string) => (await post('admin', `/api/partners/${partner}/leads`, { name: `Buyer ${phone}`, phone, project_id: project })).data.id;
  // B Own: two bookings. A Own: two bookings of higher value. Nobody Owns: one.
  for (const [partner, phone, amount] of [[pid.theirs, '9822200201', 50], [pid.theirs, '9822200202', 50], [pid.mine, '9822200203', 90], [pid.mine, '9822200204', 90], [pid.open, '9822200205', 200]] as const) {
    const id = await lead(partner, phone);
    assert.equal((await post('admin', `/api/units/${unit(phone)}/book`, { lead_id: id, amount_lakhs: amount })).data.status, 'booked');
  }
  const visitLead = await lead(pid.mine, '9822200206');
  h.db.run(`INSERT INTO site_visits(lead_id, project_id, scheduled_at, status, otp) VALUES(?, ?, datetime('now', '-1 day'), 'Completed', '1234')`, visitLead, project);
  h.db.run(`INSERT INTO site_visits(lead_id, project_id, scheduled_at, status, otp) VALUES(?, ?, datetime('now', '-10 days'), 'Completed', '1234')`, visitLead, project);
  const d = (await get('admin')).data;
  assert.deepEqual(d.top_partners.map((p: any) => p.name), ['A Own', 'B Own', 'Nobody Owns'], 'two bookings beat one; equal counts go by value');
  assert.equal(d.month_bookings.length, 5);
  assert.equal(d.recent_visits.length, 1, 'only the last 7 days');
  assert.ok(d.recent_leads.length >= 6);
  // A Sourcing Manager's desk counts only what they may see.
  const mine = (await get('smA')).data;
  assert.ok(mine.month_bookings.every((b: any) => b.partner_name !== 'B Own'));
});
