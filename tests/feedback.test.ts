// Sending lead outcomes back to Meta, with Meta stubbed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-feedback-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
const META_ID = '17441777567012505'; // 17 digits, too long for a JavaScript number.
const realFetch = globalThis.fetch;
const calls: { url: string; auth: string; body: string }[] = [];
let answer = { status: 200, body: '{"events_received":1}' };
let base = '';
let server: Server;
let db: any;
let feedback: any;
let admin = '';
let tele = '';
let leadId = 0;
let n = 1000000000000000;

const good = { enabled: true, dataset_id: '123456789', token: 'capi-secret-token-value-123456', test_event_code: '', target: 'Qualified', privacy_confirmed: true };

async function call(method: string, path: string, who = admin, body?: unknown) {
  const res = await realFetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie: who }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, set };
}

async function signIn(email: string) {
  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(` ${email} `))!;
  const current = line.trim().split(/\s+/)[2];
  const session = (await call('POST', '/api/auth/login', '', { email, password: current })).set!.split(';')[0];
  const changed = await call('POST', '/api/auth/password', session, { current, next: NEW_PASSWORD });
  return changed.set ? changed.set.split(';')[0] : session;
}

function metaLead(stage: string, metaId = String(n += 1)) {
  const { id } = db.run(`INSERT INTO leads(name, phone, email, stage, source) VALUES('Meta Person', ?, 'Buyer@Test.Local', ?, 'Meta Ads')`, `+9198${String(n).slice(-8)}`, stage);
  db.run('INSERT INTO meta_seen(meta_lead_id, lead_id) VALUES(?, ?)', metaId, id);
  return id as number;
}

const events = (id: number) => db.all('SELECT event_name, status FROM meta_events WHERE lead_id = ? ORDER BY id', id);
const save = (b: object) => call('PUT', '/api/routing/feedback', admin, { mapping: feedback.FEEDBACK_DEFAULTS.mapping, ...good, ...b });

before(async () => {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith('https://graph.facebook.com/')) {
      calls.push({ url: String(url), auth: String((init!.headers as any).Authorization), body: String(init!.body) });
      return new Response(answer.body, { status: answer.status });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  feedback = await import('../server/services/metaFeedback.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = await signIn('owner@test.local');
  tele = await signIn('telecaller1@demo.archstone.test');
});

beforeEach(() => {
  calls.length = 0;
  answer = { status: 200, body: '{"events_received":1}' };
  db.run('DELETE FROM meta_events');
  db.run('DELETE FROM meta_seen');
  db.run(`DELETE FROM leads WHERE name = 'Meta Person'`);
  db.setSetting('meta_feedback', {});
  db.setSetting('meta_feedback_last', '');
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('nothing goes to Meta until an administrator turns it on', async () => {
  metaLead('Qualified');
  assert.deepEqual(await feedback.sendFeedback(true), { sent: 0, failed: 0 });
  assert.equal(calls.length, 0);
  assert.equal((await call('GET', '/api/routing/feedback', tele)).status, 403);
  assert.equal((await save({ dataset_id: '' })).status, 400);
  assert.equal((await save({ privacy_confirmed: false })).status, 400);
  assert.equal((await save({ dataset_id: 'abc' })).status, 400);
  assert.equal((await save({})).status, 200);
});

test('the token is stored encrypted and never returned', async () => {
  await save({});
  assert.ok(!JSON.stringify(db.getSetting('meta_feedback', {})).includes('capi-secret'));
  const shown = (await call('GET', '/api/routing/feedback')).data;
  assert.equal(shown.settings.has_token, true);
  assert.ok(!JSON.stringify(shown).includes('capi-secret'));
  assert.equal(shown.settings.token, undefined);
});

test('each lead sends its whole journey, in Meta\'s format, with contact details hashed', async () => {
  const id = metaLead('Site Visit Done', META_ID);
  await save({});
  const r = await feedback.sendFeedback(true);
  assert.equal(r.sent, 5);
  assert.deepEqual(events(id).map((e: any) => e.event_name), ['Lead', 'Contacted', 'Qualified', 'Site Visit Scheduled', 'Site Visit Done']);
  assert.ok(calls[0].url.endsWith('/123456789/events'));
  assert.equal(calls[0].auth, 'Bearer capi-secret-token-value-123456');
  assert.ok(calls[0].body.includes(`"lead_id":${META_ID}`), 'the long ID must stay exact and unquoted');
  assert.ok(!calls[0].body.includes('Buyer@Test.Local'));
  assert.ok(!calls[0].body.toLowerCase().includes('buyer@test.local'));
  const event = JSON.parse(calls[0].body.replace(/"lead_id":\d+/g, '"lead_id":1')).data[0];
  assert.equal(event.action_source, 'system_generated');
  assert.equal(event.custom_data.event_source, 'crm');
  assert.equal(event.custom_data.lead_event_source, 'Archstone Connect');
  assert.deepEqual(event.user_data.em, [createHash('sha256').update('buyer@test.local').digest('hex')]);
  assert.match(event.user_data.ph[0], /^[0-9a-f]{64}$/);
});

test('an event is sent once, and new stages follow later', async () => {
  const id = metaLead('Contacted');
  await save({});
  assert.equal((await feedback.sendFeedback(true)).sent, 2);
  assert.equal((await feedback.sendFeedback(true)).sent, 0);
  db.run(`UPDATE leads SET stage = 'Booked' WHERE id = ?`, id);
  assert.equal((await feedback.sendFeedback(true)).sent, 5, 'the four stages in between, then Converted');
  assert.ok(events(id).some((e: any) => e.event_name === 'Converted'));
});

test('lost leads tell Meta too, because that teaches it what to avoid', async () => {
  const id = metaLead('Lost');
  await save({});
  await feedback.sendFeedback(true);
  assert.deepEqual(events(id).map((e: any) => e.event_name), ['Lead', 'Disqualified']);
});

test('a blank mapping is left out', async () => {
  const id = metaLead('Qualified');
  await save({ mapping: { ...feedback.FEEDBACK_DEFAULTS.mapping, Contacted: '' } });
  await feedback.sendFeedback(true);
  assert.deepEqual(events(id).map((e: any) => e.event_name), ['Lead', 'Qualified']);
});

test('a failure is kept, retried and shown', async () => {
  const id = metaLead('Contacted');
  await save({});
  answer = { status: 400, body: '{"error":{"message":"Invalid dataset"}}' };
  assert.equal((await feedback.sendFeedback(true)).failed, 2);
  assert.equal(events(id)[0].status, 'failed');
  assert.equal((await call('GET', '/api/routing/feedback')).data.stats.last_error, 'Invalid dataset');
  answer = { status: 200, body: '{}' };
  assert.equal((await feedback.sendFeedback(true)).sent, 2);
  assert.equal((await call('GET', '/api/routing/feedback')).data.stats.failed, 0);
});

test('events too old for Meta stop retrying', async () => {
  const id = metaLead('Contacted');
  feedback.queueFeedback();
  db.run(`UPDATE meta_events SET created_at = datetime('now', '-8 days') WHERE lead_id = ?`, id);
  await save({});
  await feedback.sendFeedback(true);
  assert.ok(events(id).every((e: any) => e.status === 'expired'));
});

test('leads without a real Meta ID are never sent, and test codes are included', async () => {
  const id = metaLead('Qualified', 'test-id');
  metaLead('Qualified');
  await save({ test_event_code: 'TEST123' });
  await feedback.sendFeedback(true);
  assert.ok(events(id).every((e: any) => e.status === 'skipped'));
  assert.ok(calls[0].body.includes('"test_event_code":"TEST123"'));
  assert.ok(!calls[0].body.includes('test-id'));
});

test('the health panel tracks Meta\'s targets', async () => {
  metaLead('Qualified');
  metaLead('Contacted');
  await save({});
  await feedback.sendFeedback(true);
  const { stats } = (await call('GET', '/api/routing/feedback')).data;
  assert.equal(stats.leads_30_days, 2);
  assert.equal(stats.coverage, 100);
  assert.equal(stats.target_rate, 50);
});
