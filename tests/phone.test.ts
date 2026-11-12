// Android app notifications through Firebase, with Google's servers stubbed.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-phone-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
const TOKEN = 'device-token-'.padEnd(40, 'x');
const realFetch = globalThis.fetch;
const sent: any[] = [];
let answer = { status: 200, body: '{}' };
let base = '';
let server: Server;
let db: any;
let push: any;
let adminId = 0;
let cookie = '';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceFile = {
  type: 'service_account', project_id: 'demo-project', client_email: 'bot@demo-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

async function call(method: string, path: string, body?: unknown, who = cookie) {
  const res = await realFetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, set };
}

async function signIn(email: string) {
  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(` ${email} `))!;
  const current = line.trim().split(/\s+/)[2];
  const login = await call('POST', '/api/auth/login', { email, password: current }, '');
  const session = login.set!.split(';')[0];
  const changed = await call('POST', '/api/auth/password', { current, next: NEW_PASSWORD }, session);
  assert.equal(changed.status, 200);
  return changed.set ? changed.set.split(';')[0] : session;
}

before(async () => {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }), { status: 200 });
    }
    if (href.startsWith('https://fcm.googleapis.com/')) {
      sent.push({ url: href, headers: init!.headers, body: JSON.parse(String(init!.body)) });
      return new Response(answer.body, { status: answer.status });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  push = await import('../server/services/push.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cookie = await signIn('owner@test.local');
  adminId = (await call('GET', '/api/auth/me')).data.user.id;
});

beforeEach(() => {
  sent.length = 0;
  answer = { status: 200, body: '{}' };
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('only an administrator can connect Firebase', async () => {
  const telecaller = await signIn('telecaller1@demo.archstone.test');
  assert.equal((await call('POST', '/api/settings/firebase', serviceFile, telecaller)).status, 403);
});

test('a wrong file is refused', async () => {
  assert.equal((await call('POST', '/api/settings/firebase', { type: 'authorized_user' })).status, 400);
  const bad = await call('POST', '/api/settings/firebase', { ...serviceFile, private_key: 'x'.repeat(200) });
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', '/api/settings')).data.firebase.connected, false);
});

test('a test alert explains what is missing', async () => {
  assert.equal((await call('POST', '/api/settings/firebase/test')).status, 400);
  assert.equal((await call('POST', '/api/settings/firebase', serviceFile)).status, 201);
  const noPhone = await call('POST', '/api/settings/firebase/test');
  assert.equal(noPhone.status, 400);
  assert.match(noPhone.data.error, /Android app/);
});

test('the key is stored encrypted and never returned', async () => {
  const stored = JSON.stringify(db.getSetting('fcm_account', ''));
  assert.ok(!stored.includes('PRIVATE KEY'));
  const shown = JSON.stringify((await call('GET', '/api/settings')).data);
  assert.ok(!shown.includes('PRIVATE KEY'));
  assert.ok(shown.includes('demo-project'));
});

test('alerts reach the phone without customer details', async () => {
  assert.equal((await call('POST', '/api/account/device', { token: TOKEN })).status, 201);
  assert.equal((await call('GET', '/api/account')).data.app_devices, 1);
  await push.pushToUser(adminId, 'New lead', 'Ravi Kumar 9820012345', '/leads/1');
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /projects\/demo-project\/messages:send/);
  assert.equal(sent[0].headers.Authorization, 'Bearer stub-token');
  const { token, data, android } = sent[0].body.message;
  assert.equal(token, TOKEN);
  assert.equal(android.priority, 'HIGH');
  assert.deepEqual(data, { title: 'New lead', body: 'Open Archstone Connect for details.', link: '/leads/1', kind: '' });
});

test('a test alert reports success', async () => {
  const r = await call('POST', '/api/settings/firebase/test');
  assert.equal(r.status, 200);
  assert.equal(r.data.sent, 1);
});

test('a removed app stops being contacted', async () => {
  answer = { status: 404, body: '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' };
  await push.pushToUser(adminId, 'New lead', '', '/leads/1');
  assert.equal((await call('GET', '/api/account')).data.app_devices, 0);
});

test('a phone handed to someone else moves to that person', async () => {
  await call('POST', '/api/account/device', { token: TOKEN });
  const sales = await signIn('telecaller2@demo.archstone.test');
  await call('POST', '/api/account/device', { token: TOKEN }, sales);
  assert.equal((await call('GET', '/api/account')).data.app_devices, 0);
  assert.equal((await call('GET', '/api/account', undefined, sales)).data.app_devices, 1);
  await call('POST', '/api/account/device/remove', { token: TOKEN }, sales);
  assert.equal((await call('GET', '/api/account', undefined, sales)).data.app_devices, 0);
});

test('disconnecting Firebase stops app alerts', async () => {
  await call('POST', '/api/account/device', { token: TOKEN });
  assert.equal((await call('DELETE', '/api/settings/firebase')).status, 200);
  await push.pushToUser(adminId, 'New lead', '', '/leads/1');
  assert.equal(sent.length, 0);
});
