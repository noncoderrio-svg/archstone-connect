// New lead, follow-up, overdue, escalation, quiet hour and snooze alerts.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-alerts-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
let base = '';
let server: Server;
let db: any;
let scheduler: any;
let alerts: any;
let admin = '';
let tele = '';
let teleId = 0;
let managerId = 0;
let leadId = 0;
const NO_QUIET = { quiet_enabled: false };

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

const titles = (userId: number) => db.all('SELECT title FROM notifications WHERE user_id = ? ORDER BY id', userId).map((n: any) => n.title);
const addTask = (due: string, type = 'Call back') => db.run('INSERT INTO tasks(lead_id, owner_id, type, due_at) VALUES(?, ?, ?, ?)', leadId, teleId, type, due).id;
const rules = (patch: object) => db.setSetting('alert_rules', { ...NO_QUIET, ...patch });

before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  scheduler = await import('../server/services/scheduler.ts');
  alerts = await import('../server/services/alerts.ts');
  db = await import('../server/db.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = await signIn('owner@test.local');
  tele = await signIn('telecaller1@demo.archstone.test');
  teleId = (await call('GET', '/api/auth/me', tele)).data.user.id;
  managerId = db.get(`SELECT id FROM users WHERE role = 'sourcing_manager'`).id;
  leadId = (await call('GET', '/api/leads', tele)).data.leads[0].id;
});

beforeEach(() => {
  db.run('DELETE FROM notifications');
  db.run('DELETE FROM tasks');
  rules({});
  db.setSetting('summary_last', '');
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('a new lead alerts its owner straight away', async () => {
  const r = await call('POST', '/api/leads', admin, { name: 'Alert Lead', phone: '9722200001', owner_id: teleId, source: 'Manual' });
  assert.equal(r.status, 201);
  const note = db.get(`SELECT * FROM notifications WHERE user_id = ? AND title = 'New lead assigned'`, teleId);
  assert.equal(note.kind, 'new_lead');
  assert.equal(note.link, `/leads/${r.data.id}`);
});

test('the reminder time can be changed', () => {
  addTask(db.minutesFromNow(40));
  scheduler.sendFollowUpReminders();
  assert.equal(titles(teleId).length, 0);
  rules({ reminder_minutes: 60 });
  scheduler.sendFollowUpReminders();
  assert.deepEqual(titles(teleId), ['Follow-up due: Call back']);
});

test('a missed follow-up alerts, repeats on schedule, then stops', () => {
  const id = addTask(db.minutesFromNow(-5));
  rules({ overdue_max_alerts: 2, overdue_repeat_minutes: 30, escalate_after_minutes: 0 });
  scheduler.sendOverdueAlerts();
  scheduler.sendOverdueAlerts();
  assert.equal(titles(teleId).length, 1, 'no repeat before the wait is over');
  db.run('UPDATE tasks SET last_overdue_at = ? WHERE id = ?', db.minutesFromNow(-31), id);
  scheduler.sendOverdueAlerts();
  assert.equal(titles(teleId).length, 2);
  db.run('UPDATE tasks SET last_overdue_at = ? WHERE id = ?', db.minutesFromNow(-31), id);
  scheduler.sendOverdueAlerts();
  assert.equal(titles(teleId).length, 2, 'stops at the limit');
  assert.equal(db.get('SELECT kind FROM notifications WHERE user_id = ?', teleId).kind, 'overdue');
});

test('a long-missed follow-up reaches the manager once', () => {
  addTask(db.minutesFromNow(-180));
  rules({ escalate_after_minutes: 120 });
  scheduler.sendOverdueAlerts();
  scheduler.sendOverdueAlerts();
  assert.equal(titles(managerId).filter((t: string) => t === 'Team follow-up overdue').length, 1);
});

test('very old follow-ups do not flood anyone after an upgrade', () => {
  addTask(db.minutesFromNow(-10 * 1440));
  scheduler.sendOverdueAlerts();
  assert.equal(titles(teleId).length, 0);
});

test('completed follow-ups stay silent', async () => {
  const id = addTask(db.minutesFromNow(-5));
  await call('POST', `/api/tasks/${id}/complete`, tele);
  scheduler.sendOverdueAlerts();
  assert.equal(titles(teleId).length, 0);
});

test('quiet hours cover overnight ranges and hold back overdue alerts', () => {
  const night = { quiet_enabled: true, quiet_start: 21, quiet_end: 8 };
  assert.equal(alerts.isQuietNow(night, 23), true);
  assert.equal(alerts.isQuietNow(night, 3), true);
  assert.equal(alerts.isQuietNow(night, 8), false);
  assert.equal(alerts.isQuietNow(night, 12), false);
  assert.equal(alerts.isQuietNow({ ...night, quiet_start: 13, quiet_end: 15 }, 14), true);
  assert.equal(alerts.isQuietNow({ ...night, quiet_enabled: false }, 23), false);

  addTask(db.minutesFromNow(-5));
  const hour = alerts.istHour();
  rules({ quiet_enabled: true, quiet_start: hour, quiet_end: (hour + 2) % 24 });
  scheduler.sendOverdueAlerts();
  assert.equal(titles(teleId).length, 0);
  rules({});
  scheduler.sendOverdueAlerts();
  assert.equal(titles(teleId).length, 1);
});

test('the morning summary goes once a day, only to people with work', () => {
  addTask(db.minutesFromNow(-30));
  rules({ summary_hour: 0 });
  scheduler.sendMorningSummary();
  scheduler.sendMorningSummary();
  const notes = db.all(`SELECT * FROM notifications WHERE title = 'Your follow-ups today'`);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].user_id, teleId);
  assert.match(notes[0].body, /^1 overdue/);
});

test('the follow-ups page sorts work into tabs and hides other people', async () => {
  addTask(db.minutesFromNow(-30));
  addTask(db.minutesFromNow(3 * 1440));
  const r = (await call('GET', '/api/followups?view=overdue', tele)).data;
  assert.equal(r.tasks.length, 1);
  assert.equal(r.counts.overdue, 1);
  assert.equal(r.counts.upcoming, 1);
  assert.equal((await call('GET', '/api/followups/summary', tele)).data.overdue, 1);
  const other = await signIn('telecaller2@demo.archstone.test');
  assert.equal((await call('GET', '/api/followups/summary', other)).data.overdue, 0);
});

test('snoozing restarts reminders and refuses the past', async () => {
  const id = addTask(db.minutesFromNow(-30));
  scheduler.sendOverdueAlerts();
  assert.equal((await call('POST', `/api/tasks/${id}/snooze`, tele, { due_at: '2020-01-01 10:00:00' })).status, 400);
  assert.equal((await call('POST', `/api/tasks/${id}/snooze`, tele, {})).status, 400);
  assert.equal((await call('POST', `/api/tasks/${id}/snooze`, tele, { minutes: 60 })).status, 200);
  const task = db.get('SELECT * FROM tasks WHERE id = ?', id);
  assert.equal(task.overdue_alerts, 0);
  assert.equal(task.reminded, 0);
  assert.equal((await call('GET', '/api/followups/summary', tele)).data.overdue, 0);
});

test('someone else cannot snooze a follow-up on a lead they cannot work', async () => {
  const id = addTask(db.minutesFromNow(30));
  const other = await call('GET', '/api/auth/me', tele);
  assert.ok(other.data.user);
  const marketing = await signIn('payments@demo.archstone.test');
  assert.equal((await call('POST', `/api/tasks/${id}/snooze`, marketing, { minutes: 30 })).status >= 403, true);
});

test('personal choices are saved, and only an administrator sets the rules', async () => {
  assert.equal((await call('PUT', '/api/account/alerts', tele, { push: { overdue: false }, whatsapp: { new_lead: false } })).status, 200);
  assert.deepEqual((await call('GET', '/api/account', tele)).data.alert_prefs.push, { overdue: false });
  const good = { reminder_minutes: 30, overdue_repeat_minutes: 60, overdue_max_alerts: 3, escalate_after_minutes: 120, quiet_enabled: true, quiet_start: 21, quiet_end: 8, morning_summary: true, summary_hour: 9, whatsapp_new_lead: true, whatsapp_followup: true, whatsapp_overdue: true };
  assert.equal((await call('PUT', '/api/settings/alerts', tele, good)).status, 403);
  assert.equal((await call('PUT', '/api/settings/alerts', admin, good)).status, 200);
  assert.equal((await call('GET', '/api/settings')).data.settings.alert_rules.reminder_minutes, 30);
  assert.equal((await call('PUT', '/api/settings/alerts', admin, { ...good, quiet_start: 99 })).status, 400);
});

test('lock screen text carries no customer details', async () => {
  const fs = readFileSync('server/services/whatsapp.ts', 'utf8');
  assert.ok(!fs.includes('`WhatsApp from ${lead.name}`'));
  const task = addTask(db.minutesFromNow(-5));
  scheduler.sendOverdueAlerts();
  const lead = db.get('SELECT name FROM leads WHERE id = ?', leadId);
  const note = db.get('SELECT title FROM notifications WHERE user_id = ?', teleId);
  assert.ok(task);
  assert.ok(!note.title.includes(lead.name));
});
