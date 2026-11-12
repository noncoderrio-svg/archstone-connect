// Hold and book rights: who may hold or book a flat, one-step admin bookings, approvals, and changing a flat's customer.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prepareEnv, startHarness, type Harness } from './helpers/harness.ts';

const dir = prepareEnv('booking');
let h: Harness;
let project = 0;
let unitNo = 0;

const as = (who: string) => ({
  post: (path: string, body?: unknown) => h.call('POST', path, who, body),
  get: (path: string) => h.call('GET', path, who),
});

async function newUnit() {
  unitNo++;
  return h.db.run(`INSERT INTO units(project_id, tower, floor, number, price_lakhs) VALUES(?, 'A', 1, ?, 80)`, project, `R${unitNo}`).id as number;
}
async function newLead(owner: string, phone: string) {
  const { id } = (await as('admin').post('/api/leads', { name: `Buyer ${phone}`, phone, source: 'Manual', project_id: project })).data;
  h.db.run('UPDATE leads SET owner_id = ?, presales_id = NULL WHERE id = ?', h.ids[owner], id);
  return id as number;
}
const unit = (id: number) => h.db.get('SELECT * FROM units WHERE id = ?', id);

before(async () => {
  h = await startHarness(dir);
  project = h.db.run(`INSERT INTO projects(name) VALUES('Rights Tower')`).id;
  await h.addUser('head', 'site_head', [project]);
  await h.addUser('sourcing', 'sourcing_manager');
  await h.addUser('closing', 'closing_manager');
  await h.addUser('tele', 'telecaller');
  await h.addUser('payments', 'payment_followup', [project]);
});
after(() => h.stop());

test('hold and book are permissions, with the agreed defaults for each role', async () => {
  const perms = (await as('admin').get('/api/permissions')).data.roles;
  for (const r of ['site_head', 'sourcing_manager', 'closing_manager', 'telecaller']) assert.ok(perms[r].includes('unit.hold'), `${r} may hold`);
  for (const r of ['site_head', 'sourcing_manager']) assert.ok(perms[r].includes('unit.book'), `${r} may book`);
  for (const r of ['closing_manager', 'telecaller', 'payment_followup']) assert.ok(!perms[r].includes('unit.book'), `${r} may not book`);
  assert.ok(!perms.payment_followup.includes('unit.hold'));
});

test('a telecaller can hold a flat for their own lead, Payment Follow-up cannot', async () => {
  const u = await newUnit();
  const lead = await newLead('tele', '9811100001');
  assert.equal((await as('payments').post(`/api/units/${u}/hold`, { lead_id: lead })).status, 403);
  assert.equal((await as('tele').post(`/api/units/${u}/hold`, { lead_id: lead })).status, 200);
  assert.equal(unit(u).status, 'Hold');
  assert.equal(unit(u).held_by, h.ids.tele);
});

test('the hold right follows the permission, not a hard-coded role list', async () => {
  const u = await newUnit();
  const lead = await newLead('tele', '9811100002');
  await h.call('PUT', `/api/users/${h.ids.tele}/permissions`, 'admin', { allow: [], deny: ['unit.hold'], data_scope: '' });
  assert.equal((await as('tele').post(`/api/units/${u}/hold`, { lead_id: lead })).status, 403);
  await h.call('PUT', `/api/users/${h.ids.tele}/permissions`, 'admin', { allow: [], deny: [], data_scope: '' });
  assert.equal((await as('tele').post(`/api/units/${u}/hold`, { lead_id: lead })).status, 200);
});

test('an admin books a flat in one step', async () => {
  const u = await newUnit();
  const lead = await newLead('closing', '9811100003');
  const r = await as('admin').post(`/api/units/${u}/book`, { lead_id: lead, amount_lakhs: 78 });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'booked');
  assert.equal(unit(u).status, 'Booked');
  assert.equal(h.db.get('SELECT stage FROM leads WHERE id = ?', lead).stage, 'Booked');
  assert.equal(h.db.get('SELECT amount_lakhs FROM bookings WHERE id = ?', r.data.booking_id).amount_lakhs, 78);
});

test('anyone else\'s booking goes for approval, and only someone else may approve it', async () => {
  const u = await newUnit();
  const lead = await newLead('sourcing', '9811100004');
  const r = await as('sourcing').post(`/api/units/${u}/book`, { lead_id: lead, amount_lakhs: 80 });
  assert.equal(r.status, 202);
  assert.equal(r.data.status, 'pending');
  assert.equal(unit(u).status, 'Available', 'nothing is booked until approved');
  const again = await as('sourcing').post(`/api/units/${u}/book`, { lead_id: lead, amount_lakhs: 80 });
  assert.equal(again.status, 409, 'one request per flat at a time');
  assert.equal((await as('sourcing').post(`/api/approvals/${r.data.approval_id}/review`, { approve: true })).status, 403, 'not their own request');
  assert.equal((await as('head').post(`/api/approvals/${r.data.approval_id}/review`, { approve: true })).status, 200);
  assert.equal(unit(u).status, 'Booked');
});

test('Closing Managers and Telecallers cannot book, by either route', async () => {
  const u = await newUnit();
  const lead = await newLead('closing', '9811100005');
  assert.equal((await as('closing').post(`/api/units/${u}/book`, { lead_id: lead, amount_lakhs: 80 })).status, 403);
  assert.equal((await as('closing').post('/api/approvals', { type: 'booking', lead_id: lead, unit_id: u, amount_lakhs: 80 })).status, 403);
  const discount = await as('closing').post('/api/approvals', { type: 'discount', lead_id: lead, unit_id: u, amount_lakhs: 80, discount_percent: 1 });
  assert.equal(discount.status, 201, 'discount requests are unchanged');
});

test('a held flat\'s customer can be changed by its holder or an inventory manager only', async () => {
  const u = await newUnit();
  const first = await newLead('tele', '9811100006');
  const second = await newLead('tele', '9811100007');
  const other = await newLead('closing', '9811100008');
  await as('tele').post(`/api/units/${u}/hold`, { lead_id: first });
  assert.equal((await as('closing').post(`/api/units/${u}/customer`, { lead_id: other })).status, 403, 'not the holder, no inventory right');
  assert.equal((await as('tele').post(`/api/units/${u}/customer`, { lead_id: second })).status, 200);
  assert.equal(unit(u).lead_id, second);
  assert.equal((await as('head').post(`/api/units/${u}/customer`, { lead_id: first })).status, 200, 'site head manages inventory');
  assert.equal(unit(u).lead_id, first);
});

test('a booked flat needs the booking right, and a flat with a booking record keeps its buyer', async () => {
  const u = await newUnit();
  const buyer = await newLead('closing', '9811100009');
  const other = await newLead('closing', '9811100010');
  await as('admin').post(`/api/units/${u}/book`, { lead_id: buyer, amount_lakhs: 80 });
  assert.equal((await as('closing').post(`/api/units/${u}/customer`, { lead_id: other })).status, 403);
  const kept = await as('admin').post(`/api/units/${u}/customer`, { lead_id: other });
  assert.equal(kept.status, 409);
  assert.match(kept.data.error, /keeps its buyer/);
  // A flat marked booked without a booking record (for example, sold before the CRM) can be given a customer.
  const legacy = await newUnit();
  h.db.run(`UPDATE units SET status = 'Booked' WHERE id = ?`, legacy);
  assert.equal((await as('closing').post(`/api/units/${legacy}/customer`, { lead_id: other })).status, 403);
  assert.equal((await as('sourcing').post(`/api/units/${legacy}/customer`, { lead_id: await newLead('sourcing', '9811100011') })).status, 200);
});

test('an available flat has no customer to change', async () => {
  const u = await newUnit();
  const lead = await newLead('closing', '9811100012');
  assert.equal((await as('admin').post(`/api/units/${u}/customer`, { lead_id: lead })).status, 409);
});
