// Admin erase: refused for everyone else on the server, exact previews, customers never deleted, and booking records protected.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { prepareEnv, startHarness, type Harness } from './helpers/harness.ts';

const dir = prepareEnv('erase');
let h: Harness;
let project = 0;
let phone = 9855500000;
let unitNo = 0;

const post = (who: string, path: string, body?: unknown) => h.call('POST', path, who, body);
const del = (who: string, path: string) => h.call('DELETE', path, who);
const get = (who: string, path: string) => h.call('GET', path, who);
const count = (sql: string, ...p: unknown[]) => h.db.get(sql, ...p).n as number;
const newUnit = (projectId = project) => h.db.run(`INSERT INTO units(project_id, tower, floor, number, price_lakhs) VALUES(?, 'E', 1, ?, 50)`, projectId, `E${++unitNo}`).id as number;
async function newLead(projectId = project) {
  return (await post('admin', '/api/leads', { name: `Erase Buyer ${phone}`, phone: String(phone++), source: 'Manual', project_id: projectId })).data.id as number;
}
async function bookedFlat(withPayments = true) {
  const unit = newUnit();
  const lead = await newLead();
  const booking = (await post('admin', `/api/units/${unit}/book`, { lead_id: lead, amount_lakhs: 50 })).data.booking_id as number;
  if (withPayments) {
    const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    await h.call('PUT', `/api/bookings/${booking}/schedule`, 'admin', { items: [
      { label: 'Booking amount', due_date: day(-5), amount_lakhs: 5 },
      { label: 'Agreement', due_date: day(-1), amount_lakhs: 15 },
      { label: 'Possession', due_date: day(90), amount_lakhs: 30 },
    ] });
    const pays = h.db.all('SELECT id FROM payments WHERE booking_id = ? ORDER BY due_date', booking);
    await post('admin', `/api/payments/${pays[0].id}/paid`, { reference: 'UTR-1111' });
    await post('admin', `/api/payments/${pays[1].id}/paid`, { reference: 'UTR-2222' });
    await post('admin', `/api/payments/${pays[2].id}/followups`, { outcome: 'No answer' });
  }
  return { unit, lead, booking };
}

before(async () => {
  h = await startHarness(dir);
  project = h.db.run(`INSERT INTO projects(name) VALUES('Erase Estate')`).id;
  await h.addUser('head', 'site_head', [project]);
  await h.addUser('sourcing', 'sourcing_manager');
  await h.addUser('tele', 'telecaller');
});
after(() => h.stop());

test('every erase is refused on the server for anyone but an admin', async () => {
  const { booking } = await bookedFlat(false);
  for (const who of ['head', 'sourcing', 'tele']) {
    assert.equal((await get(who, `/api/erase/bookings/${booking}`)).status, 403, who);
    assert.equal((await post(who, `/api/erase/bookings/${booking}`, { reason: 'test', confirm: 'ERASE' })).status, 403, who);
    assert.equal((await post(who, '/api/erase/units', { ids: [newUnit()] })).status, 403, who);
    assert.equal((await post(who, `/api/erase/projects/${project}`, { confirm_name: 'Erase Estate' })).status, 403, who);
    assert.equal((await del(who, '/api/erase/visits/1')).status, 403, who);
    assert.equal((await del(who, '/api/erase/approvals/1')).status, 403, who);
    assert.equal((await del(who, '/api/erase/documents/1')).status, 403, who);
  }
});

test('erasing an active booking shows exactly what goes, then frees the flat and moves the customer back one stage', async () => {
  const { unit, lead, booking } = await bookedFlat();
  const preview = (await get('admin', `/api/erase/bookings/${booking}`)).data;
  assert.equal(preview.removes.payment_stages, 3);
  assert.equal(preview.removes.receipts, 2);
  assert.equal(preview.removes.receipts_lakhs, 20);
  assert.equal(preview.removes.followups, 1);
  assert.match(preview.flat, /available again/);
  assert.match(preview.customer, /Booked to Working Deal/);

  assert.equal((await post('admin', `/api/erase/bookings/${booking}`, { reason: 'Entered twice', confirm: 'erase' })).status, 400, 'ERASE must be typed exactly');
  assert.equal((await post('admin', `/api/erase/bookings/${booking}`, { reason: '', confirm: 'ERASE' })).status, 400, 'a reason is required');
  assert.equal((await post('admin', `/api/erase/bookings/${booking}`, { reason: 'Entered twice', confirm: 'ERASE' })).status, 200);

  assert.equal(count('SELECT COUNT(*) n FROM bookings WHERE id = ?', booking), 0);
  assert.equal(count('SELECT COUNT(*) n FROM payments WHERE booking_id = ?', booking), 0);
  assert.equal(h.db.get('SELECT status, lead_id FROM units WHERE id = ?', unit).status, 'Available');
  const customer = h.db.get('SELECT stage, deleted_at FROM leads WHERE id = ?', lead);
  assert.equal(customer.stage, 'Working Deal');
  assert.equal(customer.deleted_at, null, 'the customer is never deleted');
  const log = h.db.get(`SELECT detail FROM audit_log WHERE action = 'erase.booking' ORDER BY id DESC LIMIT 1`).detail;
  assert.match(log, /3 payment stages, 2 receipts worth ₹20L, 1 follow-up notes/);
  assert.match(log, /Entered twice/);
});

test('erasing a cancelled booking does not touch the flat', async () => {
  const { unit, lead, booking } = await bookedFlat(false);
  assert.equal((await post('admin', `/api/bookings/${booking}/cancel`, { reason: 'Buyer withdrew' })).status, 200);
  // Someone else holds the flat now.
  const other = await newLead();
  await post('admin', `/api/units/${unit}/hold`, { lead_id: other });
  const before = h.db.get('SELECT * FROM units WHERE id = ?', unit);
  const preview = (await get('admin', `/api/erase/bookings/${booking}`)).data;
  assert.match(preview.flat, /not touched/);
  assert.equal((await post('admin', `/api/erase/bookings/${booking}`, { reason: 'Clean up', confirm: 'ERASE' })).status, 200);
  assert.deepEqual(h.db.get('SELECT * FROM units WHERE id = ?', unit), before);
  assert.equal(h.db.get('SELECT stage FROM leads WHERE id = ?', lead).stage, 'Working Deal', 'cancelling already moved them; erase leaves them');
});

test('a booking\'s commission goes with it, and "Cancel booking" still keeps the record', async () => {
  const partner = h.db.run(`INSERT INTO partners(name, commission_percent) VALUES('Erase Broker', 2)`).id;
  const lead = await newLead();
  h.db.run('UPDATE leads SET partner_id = ? WHERE id = ?', partner, lead);
  const unit = newUnit();
  const booking = (await post('admin', `/api/units/${unit}/book`, { lead_id: lead, amount_lakhs: 100 })).data.booking_id;
  assert.equal(count('SELECT COUNT(*) n FROM commissions WHERE booking_id = ?', booking), 1);
  assert.equal((await post('admin', `/api/erase/partners/${partner}`)).status, 409, 'a booking depends on this partner');
  assert.match((await post('admin', `/api/erase/partners/${partner}`)).data.error, /Erase the booking/);
  const kept = await bookedFlat(false);
  await post('admin', `/api/bookings/${kept.booking}/cancel`, { reason: 'Keep the record' });
  assert.equal(count('SELECT COUNT(*) n FROM bookings WHERE id = ?', kept.booking), 1, 'cancel keeps the record');
  await post('admin', `/api/erase/bookings/${booking}`, { reason: 'Test', confirm: 'ERASE' });
  assert.equal(count('SELECT COUNT(*) n FROM commissions WHERE booking_id = ?', booking), 0);
  assert.equal((await post('admin', `/api/erase/partners/${partner}`)).status, 200, 'with the booking gone, the partner can go');
  assert.equal(h.db.get('SELECT partner_id, deleted_at FROM leads WHERE id = ?', lead).partner_id, null, 'customer kept, without the partner credit');
});

test('deleting a partner removes their contact log and keeps their customers', async () => {
  const partner = h.db.run(`INSERT INTO partners(name) VALUES('Plain Broker')`).id;
  h.db.run(`INSERT INTO partner_contacts(partner_id, kind) VALUES(?, 'Call'), (?, 'Meeting')`, partner, partner);
  const lead = await newLead();
  h.db.run('UPDATE leads SET partner_id = ? WHERE id = ?', partner, lead);
  const preview = (await get('admin', `/api/erase/partners/${partner}`)).data;
  assert.deepEqual([preview.contacts, preview.customers, preview.commissions], [2, 1, 0]);
  assert.equal((await post('admin', `/api/erase/partners/${partner}`)).status, 200);
  assert.equal(count('SELECT COUNT(*) n FROM partner_contacts WHERE partner_id = ?', partner), 0);
  assert.equal(count('SELECT COUNT(*) n FROM leads WHERE id = ? AND deleted_at IS NULL', lead), 1);
});

test('flats: one or many can be deleted, but not one with a booking record', async () => {
  const a = newUnit();
  const b = newUnit();
  const { unit: booked } = await bookedFlat(false);
  const preview = (await post('admin', '/api/erase/units/preview', { ids: [a, b, booked] })).data;
  assert.equal(preview.count, 3);
  assert.equal(preview.blocked.length, 1);
  const refused = await post('admin', '/api/erase/units', { ids: [a, b, booked] });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /Erase the booking first/);
  assert.equal(count(`SELECT COUNT(*) n FROM units WHERE id IN (${a}, ${b})`), 2, 'nothing deleted when one is refused');
  assert.equal((await post('admin', '/api/erase/units', { ids: [a, b] })).data.deleted, 2);
  assert.equal(count(`SELECT COUNT(*) n FROM units WHERE id IN (${a}, ${b})`), 0);
});

test('a project goes with its flats and site visits; its customers stay without a project', async () => {
  const p = h.db.run(`INSERT INTO projects(name) VALUES('Old Phase')`).id;
  const unit = newUnit(p);
  const lead = await newLead(p);
  h.db.run(`INSERT INTO site_visits(lead_id, project_id, scheduled_at, otp) VALUES(?, ?, datetime('now'), '1')`, lead, p);
  const preview = (await get('admin', `/api/erase/projects/${p}`)).data;
  assert.deepEqual([preview.units, preview.visits, preview.customers, preview.bookings], [1, 1, 1, 0]);
  assert.equal((await post('admin', `/api/erase/projects/${p}`, { confirm_name: 'old phase' })).status, 400, 'the name must match exactly');
  assert.equal((await post('admin', `/api/erase/projects/${p}`, { confirm_name: 'Old Phase' })).status, 200);
  assert.equal(count('SELECT COUNT(*) n FROM units WHERE id = ?', unit), 0);
  assert.equal(count('SELECT COUNT(*) n FROM site_visits WHERE project_id = ?', p), 0);
  const kept = h.db.get('SELECT project_id, deleted_at FROM leads WHERE id = ?', lead);
  assert.deepEqual([kept.project_id, kept.deleted_at], [null, null]);
  assert.match(h.db.get(`SELECT detail FROM audit_log WHERE action = 'erase.project' ORDER BY id DESC LIMIT 1`).detail, /1 flats and 1 site visits/);
});

test('a project with a booking record is refused', async () => {
  await bookedFlat(false);
  const r = await post('admin', `/api/erase/projects/${project}`, { confirm_name: 'Erase Estate' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Erase the booking/);
});

test('a calling list can go keeping its numbers, or move the uncalled ones to Deleted leads', async () => {
  const make = async (name: string) => (await post('admin', '/api/dialer/lists', { name, agent_ids: [h.ids.tele], rows: [0, 1, 2, 3].map(() => ({ phone: String(phone++) })) })).data.id;
  const keep = await make('Keep numbers');
  const keptLeads = h.db.all('SELECT id FROM leads WHERE call_list_id = ?', keep).map((l: any) => l.id);
  assert.equal((await post('admin', `/api/erase/call-lists/${keep}`, { mode: 'keep' })).status, 200);
  assert.equal(count(`SELECT COUNT(*) n FROM leads WHERE id IN (${keptLeads}) AND deleted_at IS NULL AND call_list_id IS NULL`), 4);

  const move = await make('Move uncalled');
  const leads = h.db.all('SELECT id FROM leads WHERE call_list_id = ? ORDER BY id', move).map((l: any) => l.id);
  h.db.run(`INSERT INTO activities(lead_id, type, title, actor_id) VALUES(?, 'call', 'Call: Busy', ?)`, leads[0], h.ids.tele);
  assert.deepEqual([(await get('admin', `/api/erase/call-lists/${move}`)).data.numbers, (await get('admin', `/api/erase/call-lists/${move}`)).data.uncalled], [4, 3]);
  assert.equal((await post('admin', `/api/erase/call-lists/${move}`, { mode: 'move_uncalled' })).data.moved_to_deleted, 3);
  assert.equal(h.db.get('SELECT deleted_at FROM leads WHERE id = ?', leads[0]).deleted_at, null, 'a called number stays');
  const deleted = (await get('admin', '/api/leads-deleted')).data.leads.map((l: any) => l.id);
  for (const id of leads.slice(1)) assert.ok(deleted.includes(id), 'in Deleted leads');
  assert.equal((await post('admin', `/api/leads/${leads[1]}/restore`)).status, 200, 'and can be restored');
  assert.equal(count('SELECT COUNT(*) n FROM call_lists WHERE id IN (?, ?)', keep, move), 0);
});

test('a site visit can be deleted; an approval only if no booking depends on it', async () => {
  const lead = await newLead();
  const visit = h.db.run(`INSERT INTO site_visits(lead_id, project_id, scheduled_at, otp) VALUES(?, ?, datetime('now'), '1')`, lead, project).id;
  assert.equal((await del('admin', `/api/erase/visits/${visit}`)).status, 200);
  assert.equal(count('SELECT COUNT(*) n FROM site_visits WHERE id = ?', visit), 0);

  const unit = newUnit();
  const req = await post('head', '/api/approvals', { type: 'booking', lead_id: lead, unit_id: unit, amount_lakhs: 50 });
  await post('admin', `/api/approvals/${req.data.id}/review`, { approve: true });
  const blocked = await del('admin', `/api/erase/approvals/${req.data.id}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /Erase the booking first/);
  const discount = await post('head', '/api/approvals', { type: 'discount', lead_id: lead, unit_id: newUnit(), amount_lakhs: 50, discount_percent: 1 });
  assert.equal((await del('admin', `/api/erase/approvals/${discount.data.id}`)).status, 200);
});

test('one customer file is deleted from disk and from the record; the customer stays', async () => {
  const lead = await newLead();
  const docsDir = join(dir, 'documents');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, 'erase-me'), 'x');
  const doc = h.db.run(`INSERT INTO documents(lead_id, type, filename, mime, size, storage_name) VALUES(?, 'PAN', 'pan.pdf', 'application/pdf', 1, 'erase-me')`, lead).id;
  assert.equal((await del('admin', `/api/erase/documents/${doc}`)).status, 200);
  assert.equal(existsSync(join(docsDir, 'erase-me')), false, 'gone from disk');
  assert.equal(count('SELECT COUNT(*) n FROM documents WHERE id = ?', doc), 0);
  assert.equal(count('SELECT COUNT(*) n FROM leads WHERE id = ? AND deleted_at IS NULL', lead), 1);
  assert.ok(h.db.get(`SELECT 1 AS x FROM audit_log WHERE action = 'erase.document' AND entity_id = ?`, String(doc)));
});
