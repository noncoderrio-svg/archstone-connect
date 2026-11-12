// Phone alerts: a failure must be visible, not silent.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-phone-'));
Object.assign(process.env, { ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local' });

const PASSWORD = 'Str0ng-test-password';
const TOKEN = 'phone-token-'.repeat(4);
let base = '';
let server: Server;
let fcm: any;
let alerts: any;
let db: any;
let cookie = '';
let ownerId = 0;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, set: res.headers.get('set-cookie') ?? '', json: text.startsWith('{') ? JSON.parse(text) : null };
}

const googleAnswers = (status: number) => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => (String(url).startsWith(base) ? real(url, init) : new Response('{}', { status }))) as typeof fetch;
  return () => { globalThis.fetch = real; };
};

before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  fcm = await import('../server/services/fcm.ts');
  alerts = await import('../server/services/alerts.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const email = 'owner@test.local';
  const current = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(` ${email} `))!.trim().split(/\s+/)[2];
  cookie = (await call('POST', '/api/auth/login', { email, password: current })).set.split(';')[0];
  await call('POST', '/api/auth/password', { current, next: PASSWORD });
  cookie = (await call('POST', '/api/auth/login', { email, password: PASSWORD })).set.split(';')[0];
  ownerId = db.get('SELECT id FROM users WHERE email = ?', email).id;
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('the test alert says when no phone is registered', async () => {
  const { json } = await call('POST', '/api/account/alerts/test');
  assert.deepEqual([json.phone.devices, json.phone.sent, json.firebase_ready], [0, 0, false]);
  assert.ok(db.get(`SELECT 1 AS x FROM notifications WHERE user_id = ? AND title = 'Test alert'`, ownerId));
});

test('Settings lists who has a phone registered', async () => {
  await call('POST', '/api/account/device', { token: TOKEN });
  const { firebase } = (await call('GET', '/api/settings')).json;
  assert.equal(firebase.phones.find((p: any) => p.name === 'Administrator').phones, 1);
  assert.equal(firebase.phones.filter((p: any) => p.phones === 0).length > 0, true);
  assert.equal(JSON.stringify(firebase).includes(TOKEN), false);
});

test('a phone failure reaches the screen and is kept for Settings', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  fcm.saveFcmAccount({ project_id: 'test', client_email: 'a@test.local', private_key: privateKey });
  const restore = googleAnswers(401);
  const log = console.error;
  console.error = () => undefined;
  try {
    const { json } = await call('POST', '/api/account/alerts/test');
    assert.equal(json.phone.sent, 0);
    assert.match(json.phone.error, /refused the Firebase key/);
  } finally {
    restore();
    console.error = log;
  }
  assert.match(fcm.lastPhoneSend().error, /refused the Firebase key/);
});

test('a successful send clears the failure', async () => {
  const restore = googleAnswers(200);
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => (String(url).includes('oauth2')
    ? new Response(JSON.stringify({ access_token: 'x', expires_in: 3600 })) : real(url, init))) as typeof fetch;
  try {
    const { json } = await call('POST', '/api/account/alerts/test');
    assert.equal(json.phone.sent, 1);
  } finally {
    restore();
  }
  assert.equal(fcm.lastPhoneSend().error, '');
});

test('quiet hours are reported, including past midnight', () => {
  db.setSetting('alert_rules', { quiet_enabled: true, quiet_start: 0, quiet_end: 24 });
  assert.equal(alerts.quietStatus().now, true);
  db.setSetting('alert_rules', { quiet_enabled: false });
  assert.equal(alerts.quietStatus().now, false);
});
