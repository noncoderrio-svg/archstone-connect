// Payment follow-up: states, the per-project page, the stages strip, the follow-up log, and what Payment Follow-up may do.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prepareEnv, startHarness, type Harness } from './helpers/harness.ts';

const dir = prepareEnv('payments');
let h: Harness;
const proj: Record<string, number> = {};
const pay: Record<string, number> = {};
const book: Record<string, number> = {};

const istDay = (offset: number) => new Date(Date.now() + 330 * 60000 + offset * 86400000).toISOString().slice(0, 10);
const get = (who: string, path: string) => h.call('GET', path, who);
const post = (who: string, path: string, body?: unknown) => h.call('POST', path, who, body);

async function booking(project: number, name: string, phone: string, amount: number) {
  const unit = h.db.run(`INSERT INTO units(project_id, tower, floor, number, price_lakhs) VALUES(?, 'A', 1, ?, ?)`, project, phone.slice(-3), amount).id;
  const lead = (await post('admin', '/api/leads', { name, phone, source: 'Manual', project_id: project })).data.id;
  const r = await post('admin', `/api/units/${unit}/book`, { lead_id: lead, amount_lakhs: amount });
  assert.equal(r.data.status, 'booked');
  return r.data.booking_id as number;
}

before(async () => {
  h = await startHarness(dir);
  proj.main = h.db.run(`INSERT INTO projects(name) VALUES('Collect Court')`).id;
  proj.other = h.db.run(`INSERT INTO projects(name) VALUES('Elsewhere')`).id;
  await h.addUser('payer', 'payment_followup', [proj.main]);
  await h.addUser('closer', 'closing_manager');
  book.a = await booking(proj.main, 'Asha Buyer', '9833300001', 100);
  book.b = await booking(proj.main, 'Bina Buyer', '9833300002', 50);
  book.c = await booking(proj.main, 'Chetan NoPlan', '9833300003', 70);
  book.x = await booking(proj.other, 'Other Project', '9833300004', 60);
  // Asha: booking paid, agreement overdue, slab due in 3 days, possession later.
  const schedule = (id: number, items: unknown[]) => h.call('PUT', `/api/bookings/${id}/schedule`, 'admin', { items });
  assert.equal((await schedule(book.a, [
    { label: 'Booking amount', due_date: istDay(-30), amount_lakhs: 10 },
    { label: 'Agreement', due_date: istDay(-2), amount_lakhs: 20 },
    { label: 'First slab', due_date: istDay(3), amount_lakhs: 30 },
    { label: 'Possession', due_date: istDay(60), amount_lakhs: 40 },
  ])).status, 200);
  assert.equal((await schedule(book.b, [
    { label: 'Booking amount', due_date: istDay(-10), amount_lakhs: 5 },
    { label: 'Agreement', due_date: istDay(-1), amount_lakhs: 45 },
  ])).status, 200);
  await schedule(book.x, [{ label: 'Booking amount', due_date: istDay(-5), amount_lakhs: 60 }]);
  const ids = (id: number) => h.db.all('SELECT id, label FROM payments WHERE booking_id = ? ORDER BY due_date', id);
  for (const p of ids(book.a)) pay[`a:${p.label}`] = p.id;
  for (const p of ids(book.b)) pay[`b:${p.label}`] = p.id;
  pay.x = ids(book.x)[0].id;
  assert.equal((await post('admin', `/api/payments/${pay['a:Booking amount']}/paid`, { reference: 'UTR123456' })).status, 200);
});
after(() => h.stop());

test('a payment is Received, Overdue, Due in 7 days or Upcoming', async () => {
  const { paymentState } = await import('../server/routes/payments.ts');
  const today = '2026-11-12';
  const week = '2026-11-19';
  assert.equal(paymentState({ paid_at: '2026-11-01 10:00:00', due_date: '2026-10-01' }, today, week), 'Received');
  assert.equal(paymentState({ paid_at: null, due_date: '2026-11-11' }, today, week), 'Overdue');
  assert.equal(paymentState({ paid_at: null, due_date: '2026-11-12' }, today, week), 'Due in 7 days', 'due today is not yet overdue');
  assert.equal(paymentState({ paid_at: null, due_date: '2026-11-19' }, today, week), 'Due in 7 days');
  assert.equal(paymentState({ paid_at: null, due_date: '2026-11-20' }, today, week), 'Upcoming');
});

test('the project page lists every active booking with its stages in order, and the summary numbers', async () => {
  const r = await get('payer', '/api/payments/dashboard');
  assert.equal(r.status, 200);
  const d = r.data;
  assert.deepEqual(d.projects.map((p: any) => p.name), ['Collect Court'], 'only their assigned project');
  assert.deepEqual(d.bookings.map((b: any) => b.lead_name), ['Asha Buyer', 'Bina Buyer', 'Chetan NoPlan']);
  const asha = d.bookings.find((b: any) => b.lead_name === 'Asha Buyer');
  assert.deepEqual(asha.stages.map((s: any) => [s.label, s.state]), [
    ['Booking amount', 'Received'], ['Agreement', 'Overdue'], ['First slab', 'Due in 7 days'], ['Possession', 'Upcoming'],
  ]);
  assert.equal(asha.current_stage, 'Agreement');
  assert.equal(d.summary.overdue_lakhs, 20 + 5 + 45);
  assert.equal(d.summary.due_week_lakhs, 30);
  assert.equal(d.summary.collected_month_lakhs, 10);
  assert.equal(d.summary.without_schedule, 1);
});

test('the stages strip counts received and overdue, and the pending amount, for each stage name', async () => {
  const { stages } = (await get('payer', '/api/payments/dashboard')).data;
  const by = Object.fromEntries(stages.map((s: any) => [s.label, s]));
  assert.deepEqual([by['Booking amount'].received, by['Booking amount'].overdue, by['Booking amount'].pending_lakhs], [1, 1, 5]);
  assert.deepEqual([by.Agreement.received, by.Agreement.overdue, by.Agreement.pending_lakhs], [0, 2, 65]);
  assert.equal(stages[0].label, 'Booking amount', 'earliest stage first');
});

test('Payment Follow-up cannot open another project or its payments', async () => {
  assert.equal((await get('payer', `/api/payments/dashboard?project=${proj.other}`)).status, 404);
  assert.equal((await get('payer', `/api/payments/${pay.x}/followups`)).status, 404);
  assert.equal((await post('payer', `/api/payments/${pay.x}/paid`, { reference: 'UTR999999' })).status, 404);
  assert.equal((await get('closer', '/api/payments/dashboard')).status, 403, 'needs the follow-up permission');
});

test('a follow-up records the outcome, notes and promised date, and shows on the customer timeline', async () => {
  const id = pay['a:Agreement'];
  assert.equal((await post('payer', `/api/payments/${id}/followups`, { outcome: 'Maybe later' })).status, 400, 'only the listed outcomes');
  assert.equal((await post('payer', `/api/payments/${id}/followups`, { outcome: 'Promised to pay' })).status, 400, 'a promise needs a date');
  assert.equal((await post('payer', `/api/payments/${id}/followups`, { outcome: 'No answer', notes: 'Phone switched off' })).status, 201);
  assert.equal((await post('payer', `/api/payments/${id}/followups`, { outcome: 'Promised to pay', notes: 'Will transfer on Friday', promised_on: istDay(2) })).status, 201);
  const { followups } = (await get('payer', `/api/payments/${id}/followups`)).data;
  assert.deepEqual(followups.map((f: any) => f.outcome), ['Promised to pay', 'No answer']);
  assert.equal(followups[0].user_name, 'payer');
  const latest = (await get('payer', '/api/payments/dashboard')).data.bookings[0].stages[1];
  assert.equal(latest.last_outcome, 'Promised to pay');
  assert.equal(latest.promised_on, istDay(2));
  const lead = h.db.get('SELECT lead_id FROM bookings WHERE id = ?', book.a).lead_id;
  assert.ok(h.db.get(`SELECT 1 AS x FROM activities WHERE lead_id = ? AND title = 'Payment follow-up: Agreement'`, lead));
});

test('Payment Follow-up marks a payment received with a receipt, but cannot change schedules or handover', async () => {
  const r = await post('payer', `/api/payments/${pay['b:Agreement']}/paid`, { reference: 'CHQ-004411' });
  assert.equal(r.status, 200);
  assert.match(r.data.receipt_number, /^AS-\d{4}-\d{5}$/, 'new receipts use the Archstone prefix');
  assert.equal((await post('payer', `/api/payments/${pay['b:Agreement']}/followups`, { outcome: 'Other' })).status, 409, 'nothing to chase once received');
  assert.equal((await h.call('PUT', `/api/bookings/${book.b}/schedule`, 'payer', { items: [{ label: 'All', due_date: istDay(1), amount_lakhs: 5 }] })).status, 403);
  assert.equal((await post('payer', `/api/bookings/${book.b}/handover`, { status: 'Agreement' })).status, 403);
  const lead = h.db.get('SELECT lead_id FROM bookings WHERE id = ?', book.b).lead_id;
  assert.equal((await get('payer', `/api/leads/${lead}`)).status, 200, 'can view the buyer');
  assert.equal((await post('payer', `/api/leads/${lead}/note`, { body: 'x' })).status, 403, 'cannot work the lead');
});
