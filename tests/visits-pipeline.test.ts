// The site visit pipeline: confirm, reschedule, check in, close with a next step. Throwaway people in a temporary database.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prepareEnv, startHarness, type Harness } from './helpers/harness.ts';

const dir = prepareEnv('visits');
let h: Harness;
let project = 0;
let phone = 9876511000;

const as = (who: string) => ({
  get: (path: string) => h.call('GET', path, who),
  post: (path: string, body?: unknown) => h.call('POST', path, who, body),
});
/** "YYYY-MM-DD HH:MM:SS" in UTC, as the app stores times. */
const utc = (minutesFromNow: number) => new Date(Date.now() + minutesFromNow * 60000).toISOString().slice(0, 19).replace('T', ' ');

async function newVisit(owner = 'cm') {
  const lead = (await as('admin').post('/api/leads', { name: `Visitor ${phone}`, phone: String(phone++), source: 'Manual', project_id: project })).data.id;
  h.db.run('UPDATE leads SET owner_id = ? WHERE id = ?', h.ids[owner], lead);
  const r = await as(owner).post('/api/visits', { lead_id: lead, project_id: project, scheduled_at: utc(60 * 24) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { lead, visit: r.data.id as number };
}
const visit = (id: number) => h.db.get('SELECT * FROM site_visits WHERE id = ?', id);

before(async () => {
  h = await startHarness(dir);
  project = h.db.run(`INSERT INTO projects(name) VALUES('Pipeline Heights')`).id;
  await h.addUser('cm', 'closing_manager', [project]);
});
after(() => h.stop());

test('confirm, then check in from Confirmed', async () => {
  const { visit: id } = await newVisit();
  assert.equal((await as('cm').post(`/api/visits/${id}/confirm`)).status, 200);
  assert.equal(visit(id).status, 'Confirmed');
  assert.ok(visit(id).confirmed_at);
  assert.equal((await as('cm').post(`/api/visits/${id}/confirm`)).status, 409, 'only once');
  const list = (await as('cm').get('/api/visits')).data.visits.find((v: any) => v.id === id);
  assert.equal(list.status, 'Confirmed');
  assert.equal(list.booked_by, 'cm');
  // visit.checkin is not a closing manager default; the admin checks in.
  assert.equal((await as('admin').post(`/api/visits/${id}/checkin`, { otp: visit(id).otp })).status, 200);
  assert.equal(visit(id).status, 'Checked In');
});

test('reschedule moves the visit and its follow-up, counts the move, and refuses past times', async () => {
  const { lead, visit: id } = await newVisit();
  await as('cm').post(`/api/visits/${id}/confirm`);
  const old = visit(id).scheduled_at;
  assert.equal((await as('cm').post(`/api/visits/${id}/reschedule`, { scheduled_at: utc(-120) })).status, 400);
  const when = utc(60 * 48);
  const r = await as('cm').post(`/api/visits/${id}/reschedule`, { scheduled_at: when, reason: 'Customer travelling' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const v = visit(id);
  assert.equal(v.scheduled_at, when);
  assert.equal(v.status, 'Scheduled', 'a new time needs confirming again');
  assert.equal(v.reschedules, 1);
  assert.equal(h.db.get(`SELECT COUNT(*) n FROM tasks WHERE lead_id = ? AND type = 'Site Visit' AND due_at = ?`, lead, old).n, 0);
  assert.equal(h.db.get(`SELECT COUNT(*) n FROM tasks WHERE lead_id = ? AND type = 'Site Visit' AND due_at = ?`, lead, when).n, 1);
  assert.ok(h.db.get(`SELECT 1 AS x FROM activities WHERE lead_id = ? AND title = 'Site visit rescheduled'`, lead));
});

test('a no-show can be rescheduled and get a follow-up call; a closed visit cannot be closed twice', async () => {
  const { lead, visit: id } = await newVisit();
  const due = utc(60 * 5);
  assert.equal((await as('cm').post(`/api/visits/${id}/complete`, { status: 'No Show', next_step: 'follow_up' })).status, 400, 'needs a time');
  assert.equal((await as('cm').post(`/api/visits/${id}/complete`, { status: 'No Show', next_step: 'follow_up', next_at: due, next_type: 'WhatsApp' })).status, 200);
  assert.ok(h.db.get(`SELECT 1 AS x FROM tasks WHERE lead_id = ? AND type = 'WhatsApp' AND due_at = ?`, lead, due));
  assert.equal((await as('cm').post(`/api/visits/${id}/complete`, { status: 'Cancelled' })).status, 409);
  assert.equal((await as('cm').post(`/api/visits/${id}/reschedule`, { scheduled_at: utc(60 * 30) })).status, 200);
  assert.equal(visit(id).status, 'Scheduled');
});

test('completing a visit with a revisit books the next visit; negotiation moves the lead to Working Deal', async () => {
  const first = await newVisit();
  await as('admin').post(`/api/visits/${first.visit}/checkin`, { otp: visit(first.visit).otp });
  const again = utc(60 * 72);
  const r = await as('cm').post(`/api/visits/${first.visit}/complete`, { status: 'Completed', rating: 4, feedback: 'Liked the 2 BHK', next_step: 'revisit', next_at: again });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(visit(first.visit).next_step, 'revisit');
  const revisit = h.db.get(`SELECT * FROM site_visits WHERE lead_id = ? AND id != ?`, first.lead, first.visit);
  assert.equal(revisit.scheduled_at, again);
  assert.equal(revisit.status, 'Scheduled');
  assert.equal(h.db.get('SELECT stage FROM leads WHERE id = ?', first.lead).stage, 'Site Visit Done');

  const second = await newVisit();
  await as('admin').post(`/api/visits/${second.visit}/checkin`, { otp: visit(second.visit).otp });
  await as('cm').post(`/api/visits/${second.visit}/complete`, { status: 'Completed', next_step: 'negotiation' });
  assert.equal(h.db.get('SELECT stage FROM leads WHERE id = ?', second.lead).stage, 'Working Deal');
});

test('a follow-up with a nonsense date is refused', async () => {
  const lead = (await as('admin').post('/api/leads', { name: 'Date Check', phone: String(phone++), source: 'Manual' })).data.id;
  assert.equal((await as('admin').post(`/api/leads/${lead}/tasks`, { type: 'Call back', due_at: 'not-a-date-at-all' })).status, 400);
  assert.equal((await as('admin').post(`/api/leads/${lead}/tasks`, { type: 'Meeting', due_at: utc(90) })).status, 201);
});
