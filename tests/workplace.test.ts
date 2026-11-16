// Feature switches, the bulletin bar, duty-aware assignment and KYC numbers. Throwaway people in a temporary database.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { aadhaarValid, panValid, verhoeffValid } from '../shared/domain.ts';
import { prepareEnv, startHarness, type Harness } from './helpers/harness.ts';

const dir = prepareEnv('workplace');
let h: Harness;
let leads: any;
let workplace: any;

const as = (who: string) => ({
  get: (path: string) => h.call('GET', path, who),
  post: (path: string, body?: unknown) => h.call('POST', path, who, body),
  put: (path: string, body?: unknown) => h.call('PUT', path, who, body),
  del: (path: string) => h.call('DELETE', path, who),
});
const istToday = () => new Date(Date.now() + 330 * 60000);
const todayDate = () => istToday().toISOString().slice(0, 10);
const todayWeekday = () => istToday().getUTCDay();
const shiftDay = (days: number) => new Date(Date.now() + 330 * 60000 + days * 86400000).toISOString().slice(0, 10);
const allOn = { bulletin: true, duty: true, kyc: true };

/** A made-up 12-digit number with a correct Verhoeff check digit, as real Aadhaar numbers have. */
function fakeAadhaar(start: string) {
  for (let d = 0; d < 10; d++) if (verhoeffValid(start + d)) return start + d;
  throw new Error('no check digit');
}

before(async () => {
  h = await startHarness(dir);
  leads = await import('../server/services/leads.ts');
  workplace = await import('../server/services/workplace.ts');
  await h.addUser('cm', 'closing_manager');
  await h.addUser('t1', 'telecaller');
  await h.addUser('t2', 'telecaller');
  h.db.run('UPDATE users SET manager_id = ? WHERE id = ?', h.ids.cm, h.ids.t1);
  // Only our two throwaway telecallers take leads here.
  h.db.run(`UPDATE users SET status = 'paused' WHERE role = 'telecaller' AND id NOT IN (?, ?)`, h.ids.t1, h.ids.t2);
});
after(() => h.stop());

test('only an administrator sees and changes the feature switches, and the session reports them', async () => {
  assert.equal((await as('cm').get('/api/features')).status, 403);
  assert.equal((await as('cm').put('/api/features', allOn)).status, 403);
  const before = await as('admin').get('/api/features');
  assert.equal(before.status, 200);
  assert.equal(before.data.features.duty, false, 'duty-aware assignment starts off');
  assert.equal((await as('admin').put('/api/features', { ...allOn, duty: false, bulletin: false })).status, 200);
  assert.deepEqual((await as('t1').get('/api/auth/me')).data.features, { bulletin: false, duty: false, kyc: true });
  assert.equal((await as('cm').get('/api/duty')).status, 404, 'a switched-off feature cannot be reached by a direct link');
  assert.deepEqual((await as('t1').get('/api/bulletins/current')).data.bulletins, []);
  const log = h.db.get(`SELECT detail FROM audit_log WHERE action = 'settings.features' ORDER BY id DESC`);
  assert.match(log.detail, /bulletin off/);
});

test('bulletins reach only the chosen roles, only between their dates, and only admins write them', async () => {
  await as('admin').put('/api/features', allOn);
  const today = todayDate();
  const made = await as('admin').post('/api/bulletins', { text: 'Diwali offer: 2% off this week', kind: 'offer', starts_on: today, ends_on: shiftDay(3), roles: ['telecaller'] });
  assert.equal(made.status, 201);
  await as('admin').post('/api/bulletins', { text: 'Last month target was met', kind: 'target', starts_on: shiftDay(-10), ends_on: shiftDay(-1) });
  assert.equal((await as('admin').post('/api/bulletins', { text: 'Backwards dates', starts_on: today, ends_on: shiftDay(-1) })).status, 400);
  assert.equal((await as('t1').post('/api/bulletins', { text: 'Not allowed', starts_on: today, ends_on: today })).status, 403);

  assert.deepEqual((await as('t1').get('/api/bulletins/current')).data.bulletins.map((b: any) => b.text), ['Diwali offer: 2% off this week']);
  assert.deepEqual((await as('cm').get('/api/bulletins/current')).data.bulletins, [], 'not for closing managers, and the old one has ended');

  // An admin can hide the bar from one person.
  await as('admin').put(`/api/users/${h.ids.t2}/permissions`, { allow: [], deny: ['bulletin.view'], data_scope: '' });
  assert.deepEqual((await as('t2').get('/api/bulletins/current')).data.bulletins, []);
  await as('admin').put(`/api/users/${h.ids.t2}/permissions`, { allow: [], deny: [], data_scope: '' });
});

test('new leads go to people on duty; when nobody is on duty a lead is still assigned', async () => {
  await as('admin').put('/api/features', allOn);
  const off = [todayWeekday()];
  assert.equal((await as('admin').put(`/api/duty/users/${h.ids.t1}`, { weekly_off: off, shift_start: '', shift_end: '' })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal(leads.nextTelecaller()?.id, h.ids.t2, 't1 is on their weekly off');
  assert.equal(workplace.offDutyNow(h.ids.t1), true, 'phone alerts pause on a day off');

  await as('admin').put(`/api/duty/users/${h.ids.t2}`, { weekly_off: off, shift_start: '', shift_end: '' });
  assert.ok([h.ids.t1, h.ids.t2].includes(leads.nextTelecaller()?.id), 'everyone off: fall back to the normal rule');

  // With the feature off, duty is ignored altogether.
  await as('admin').put('/api/features', { ...allOn, duty: false });
  assert.equal(workplace.offDutyNow(h.ids.t1), false);
  await as('admin').put('/api/features', allOn);
  for (const who of ['t1', 't2']) await as('admin').put(`/api/duty/users/${h.ids[who]}`, { weekly_off: [], shift_start: '', shift_end: '' });
});

test('shifts: outside the shift someone is off duty, and a night shift wraps past midnight', () => {
  const at = Date.parse('2026-11-18T05:30:00Z'); // 11:00 in India, a Wednesday
  assert.equal(workplace.dutyState({ id: -1, weekly_off: '', shift_start: '09:30', shift_end: '18:30' }, at), 'on');
  assert.equal(workplace.dutyState({ id: -1, weekly_off: '', shift_start: '14:00', shift_end: '22:00' }, at), 'off_shift');
  assert.equal(workplace.dutyState({ id: -1, weekly_off: '', shift_start: '20:00', shift_end: '12:00' }, at), 'on');
  assert.equal(workplace.dutyState({ id: -1, weekly_off: '3', shift_start: '', shift_end: '' }, at), 'weekly_off');
});

test('managers set duty only for their own team, and staff cannot set it at all', async () => {
  const body = { weekly_off: [0], shift_start: '10:00', shift_end: '19:00' };
  assert.equal((await as('cm').put(`/api/duty/users/${h.ids.t1}`, body)).status, 200);
  assert.equal((await as('cm').put(`/api/duty/users/${h.ids.t2}`, body)).status, 403);
  assert.equal((await as('t1').put(`/api/duty/users/${h.ids.t1}`, body)).status, 403);
  assert.equal((await as('cm').put(`/api/duty/users/${h.ids.t1}`, { weekly_off: [], shift_start: '10:00', shift_end: '' })).status, 400);
  const list = (await as('cm').get('/api/duty')).data.people;
  assert.deepEqual(list.map((p: any) => p.id), [h.ids.t1], 'a manager sees only their team');
  await as('cm').put(`/api/duty/users/${h.ids.t1}`, { weekly_off: [], shift_start: '', shift_end: '' });
});

test('marking someone absent hands today\'s and overdue follow-ups to a colleague, and keeps later ones', async () => {
  const lead = (await as('admin').post('/api/leads', { name: 'Absent Owner Buyer', phone: '9876500011', source: 'Manual' })).data.id;
  h.db.run('UPDATE leads SET owner_id = ? WHERE id = ?', h.ids.t1, lead);
  const due = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const overdue = h.db.run('INSERT INTO tasks(lead_id, owner_id, due_at) VALUES(?, ?, ?)', lead, h.ids.t1, due(-60 * 30)).id;
  const later = h.db.run('INSERT INTO tasks(lead_id, owner_id, due_at) VALUES(?, ?, ?)', lead, h.ids.t1, due(60 * 24 * 3)).id;

  const r = await as('cm').post('/api/duty/absences', { user_id: h.ids.t1, reason: 'Sick' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.to.id, h.ids.t2);
  assert.equal(h.db.get('SELECT owner_id FROM tasks WHERE id = ?', overdue).owner_id, h.ids.t2);
  assert.equal(h.db.get('SELECT owner_id FROM tasks WHERE id = ?', later).owner_id, h.ids.t1, 'future follow-ups stay with the owner');
  assert.equal(h.db.get('SELECT owner_id FROM leads WHERE id = ?', lead).owner_id, h.ids.t1, 'leads move only when asked');
  assert.ok(h.db.get(`SELECT 1 AS x FROM notifications WHERE user_id = ? AND title = 'Follow-ups handed to you'`, h.ids.t2));
  assert.equal(workplace.dutyStateOf(h.ids.t1), 'absent');
  assert.equal(leads.nextTelecaller()?.id, h.ids.t2);

  // Asked to move leads as well.
  const again = await as('admin').post('/api/duty/absences', { user_id: h.ids.t1, hand_over_leads: true, to_user_id: h.ids.t2 });
  assert.equal(again.data.leads, 1);
  assert.equal(h.db.get('SELECT owner_id FROM leads WHERE id = ?', lead).owner_id, h.ids.t2);

  assert.equal((await as('cm').del(`/api/duty/absences/${h.ids.t1}/${todayDate()}`)).status, 200);
  assert.equal(workplace.dutyStateOf(h.ids.t1), 'on');
});

test('KYC: Aadhaar is checked and kept as the last 4 digits only; PAN is format-checked; numbers never ride along with the lead', async () => {
  assert.ok(panValid('ABCPE1234F'));
  assert.ok(!panValid('ABCDE12345'));
  const aadhaar = fakeAadhaar('23456789012');
  assert.ok(aadhaarValid(aadhaar));
  const wrong = aadhaar.slice(0, 11) + ((Number(aadhaar[11]) + 1) % 10);
  assert.ok(!aadhaarValid(wrong));

  const lead = (await as('admin').post('/api/leads', { name: 'KYC Buyer', phone: '9876500022', source: 'Manual' })).data.id;
  assert.equal((await as('admin').put(`/api/leads/${lead}/kyc`, { aadhaar: wrong })).status, 400);
  assert.equal((await as('admin').put(`/api/leads/${lead}/kyc`, { pan: 'ABCDE12345' })).status, 400);
  assert.equal((await as('admin').put(`/api/leads/${lead}/kyc`, { aadhaar: `${aadhaar.slice(0, 4)} ${aadhaar.slice(4, 8)} ${aadhaar.slice(8)}`, pan: 'abcpe1234f' })).status, 200);

  const row = h.db.get('SELECT * FROM leads WHERE id = ?', lead);
  assert.ok(!JSON.stringify(row).includes(aadhaar), 'the full Aadhaar is stored nowhere');
  assert.ok(!JSON.stringify(row).includes('ABCPE1234F'), 'PAN is encrypted');
  assert.ok(!JSON.stringify(h.db.all('SELECT detail FROM audit_log')).includes(aadhaar));

  const kyc = (await as('admin').get(`/api/leads/${lead}/kyc`)).data;
  assert.equal(kyc.pan, 'ABCPE1234F');
  assert.equal(kyc.aadhaar, `XXXX XXXX ${aadhaar.slice(-4)}`);

  const detail = (await as('admin').get(`/api/leads/${lead}`)).data;
  assert.ok(!Object.keys(detail.lead).some((k) => k.startsWith('kyc_')));

  // The same Aadhaar on a second customer is spotted.
  const twin = (await as('admin').post('/api/leads', { name: 'KYC Twin', phone: '9876500033', source: 'Manual' })).data.id;
  await as('admin').put(`/api/leads/${twin}/kyc`, { aadhaar });
  assert.deepEqual((await as('admin').get(`/api/leads/${twin}/kyc`)).data.aadhaar_also_on, [lead]);
});

test('KYC permission and the log of who opened a lead', async () => {
  const lead = (await as('admin').post('/api/leads', { name: 'Private Buyer', phone: '9876500044', source: 'Manual' })).data.id;
  h.db.run('UPDATE leads SET owner_id = ? WHERE id = ?', h.ids.t2, lead);
  const doc = h.db.run(`INSERT INTO documents(lead_id, type, filename, mime, size, storage_name) VALUES(?, 'PAN', 'pan.pdf', 'application/pdf', 4, 'not-there')`, lead).id;

  await as('admin').put(`/api/users/${h.ids.t2}/permissions`, { allow: [], deny: ['kyc.view'], data_scope: '' });
  assert.equal((await as('t2').get(`/api/leads/${lead}/kyc`)).status, 403);
  assert.equal((await as('t2').get(`/api/documents/${doc}/file`)).status, 403);
  await as('admin').put(`/api/users/${h.ids.t2}/permissions`, { allow: [], deny: [], data_scope: '' });

  await as('t2').get(`/api/leads/${lead}`);
  await as('t2').get(`/api/leads/${lead}`);
  const views = h.db.all(`SELECT 1 FROM audit_log WHERE action = 'lead.view' AND actor_id = ? AND entity_id = ?`, h.ids.t2, String(lead));
  assert.equal(views.length, 1, 'repeat opens within 30 minutes are logged once');

  await as('admin').put('/api/features', { ...allOn, kyc: false });
  assert.equal((await as('admin').get(`/api/leads/${lead}/kyc`)).status, 404);
  await as('admin').put('/api/features', allOn);
});
