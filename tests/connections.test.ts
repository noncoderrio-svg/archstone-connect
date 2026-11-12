// Connection keys managed from Settings: encrypted, never shown again, live at once.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-connections-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '', WEBSITE_API_KEY: '', GOOGLE_ADS_WEBHOOK_KEY: 'key-from-server',
});

const PASSWORD = 'Str0ng-test-password';
const SECRET = 'website-secret-value-123';
let base = '';
let server: Server;
let db: any;
let connections: any;
let config: any;
let owner = '';
let telecaller = '';

async function call(method: string, path: string, cookie = '', body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], text: await res.text() };
}

async function signIn(email: string) {
  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(` ${email} `))!;
  const current = line.trim().split(/\s+/)[2];
  const first = await call('POST', '/api/auth/login', '', { email, password: current });
  await call('POST', '/api/auth/password', first.cookie, { current, next: PASSWORD });
  return (await call('POST', '/api/auth/login', '', { email, password: PASSWORD })).cookie;
}

const list = async () => JSON.parse((await call('GET', '/api/settings', owner)).text).integrations as any[];
const connection = async (key: string) => (await list()).find((c) => c.key === key);
const lead = (key: string) => call('POST', '/webhooks/website', '', { name: 'Test Buyer', phone: '9812345678' }, { 'X-Api-Key': key });

before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  connections = await import('../server/services/connections.ts');
  ({ config } = await import('../server/config.ts'));
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  owner = await signIn('owner@test.local');
  telecaller = await signIn('telecaller1@demo.archstone.test');
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('a saved key works straight away, without a restart', async () => {
  assert.equal((await lead(SECRET)).status, 503);
  assert.equal((await call('PUT', '/api/connections/website', owner, { values: { website_key: SECRET } })).status, 200);
  assert.equal((await connection('website')).connected, true);
  assert.equal((await lead('wrong-key')).status, 401);
  assert.ok((await lead(SECRET)).status < 300);
});

test('a secret is encrypted when stored and never sent back', async () => {
  const raw = db.get("SELECT value FROM settings WHERE key = 'connections'");
  assert.ok(raw && !raw.value.includes(SECRET));
  const body = (await call('GET', '/api/settings', owner)).text;
  assert.ok(!body.includes(SECRET));
  const field = (await connection('website')).fields[0];
  assert.equal(field.is_set, true);
  assert.equal(field.value, undefined);
});

test('the audit log names what changed, never the value', () => {
  const entry = db.get("SELECT detail FROM audit_log WHERE action = 'connection.update' ORDER BY id DESC LIMIT 1");
  assert.equal(entry.detail, 'Website API key');
});

test('leaving a secret blank keeps it', async () => {
  await call('PUT', '/api/connections/website', owner, { values: { website_key: '' } });
  assert.equal(config.websiteApiKey, SECRET);
});

test('a saved key survives a restart', () => {
  config.websiteApiKey = '';
  connections.applyConnections();
  assert.equal(config.websiteApiKey, SECRET);
});

test('removing a saved key goes back to the server value', async () => {
  await call('PUT', '/api/connections/google_ads', owner, { values: { google_ads_key: 'key-from-admin' } });
  assert.equal(config.googleAdsKey, 'key-from-admin');
  assert.equal((await connection('google_ads')).fields[0].removable, true);
  await call('PUT', '/api/connections/google_ads', owner, { clear: ['google_ads_key'] });
  assert.equal(config.googleAdsKey, 'key-from-server');
  assert.equal((await connection('google_ads')).fields[0].on_server, true);
});

test('ordinary settings are shown, and a number stays a number', async () => {
  await call('PUT', '/api/connections/email', owner, { values: { smtp_host: 'smtp.example.com', smtp_port: '465', smtp_from: 'crm@example.com' } });
  assert.equal(config.smtp.port, 465);
  const fields = (await connection('email')).fields;
  assert.equal(fields.find((f: any) => f.key === 'smtp_host').value, 'smtp.example.com');
  await call('PUT', '/api/connections/email', owner, { values: { smtp_port: '' } });
  assert.equal(config.smtp.port, 587);
});

test('values that would break a request are refused', async () => {
  const bad = [['gemini', { gemini_model: '../other' }], ['whatsapp', { meta_version: 'latest' }], ['whatsapp', { wa_phone_id: '12/34' }], ['telephony', { exotel_host: 'evil.com/x' }], ['website', { website_key: 'two\nlines ' }]] as const;
  for (const [key, values] of bad) assert.equal((await call('PUT', `/api/connections/${key}`, owner, { values })).status, 400, JSON.stringify(values));
});

test('one form cannot change another connection, and unknown names are ignored', async () => {
  await call('PUT', '/api/connections/gemini', owner, { values: { website_key: 'sneaked-in', made_up: 'x' } });
  assert.equal(config.websiteApiKey, SECRET);
  assert.equal((await call('PUT', '/api/connections/nothing', owner, {})).status, 404);
});

test('staff cannot change keys or see the form', async () => {
  assert.equal((await call('PUT', '/api/connections/website', telecaller, { values: { website_key: 'stolen' } })).status, 403);
  assert.equal(config.websiteApiKey, SECRET);
  assert.ok(connections.connectionList(false).every((c: any) => !('fields' in c)));
});

test('if saved keys cannot be read, the app still starts on server values', () => {
  const blob = db.getSetting('connections', '');
  db.setSetting('connections', 'not-encrypted');
  const log = console.error;
  console.error = () => undefined;
  try {
    connections.applyConnections();
  } finally {
    console.error = log;
  }
  assert.equal(config.googleAdsKey, 'key-from-server');
  assert.equal(config.websiteApiKey, '');
  db.setSetting('connections', blob);
  connections.applyConnections();
});
