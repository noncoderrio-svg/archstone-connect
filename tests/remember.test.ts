// "Remember me": staying signed in without weakening sign-out.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-remember-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
});

const DAY = 86400;
const EMAIL = 'telecaller1@demo.archstone.test';
const PASSWORD = 'Str0ng-test-password';
let base = '';
let server: Server;
let db: any;

async function call(method: string, path: string, cookie = '', body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie') ?? '';
  return { status: res.status, set, cookie: set.split(';')[0], age: Number(/Max-Age=(\d+)/.exec(set)?.[1] ?? 0) };
}

const login = (remember?: boolean) => call('POST', '/api/auth/login', '', { email: EMAIL, password: PASSWORD, ...(remember === undefined ? {} : { remember }) });
const newest = () => db.get('SELECT * FROM sessions ORDER BY rowid DESC LIMIT 1');

before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(` ${EMAIL} `))!;
  const current = line.trim().split(/\s+/)[2];
  const first = await call('POST', '/api/auth/login', '', { email: EMAIL, password: current });
  await call('POST', '/api/auth/password', first.cookie, { current, next: PASSWORD });
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('without remember me, a login lasts one working day', async () => {
  assert.equal((await login()).age, 12 * 3600);
  assert.equal((await login(false)).age, 12 * 3600);
  assert.equal(newest().remember, 0);
});

test('with remember me, a login lasts 30 days', async () => {
  const r = await login(true);
  assert.equal(r.age, 30 * DAY);
  assert.match(r.set, /HttpOnly/i);
  assert.match(r.set, /SameSite=Strict/i);
  assert.equal((await call('GET', '/api/auth/me', r.cookie)).status, 200);
});

test('using the CRM renews it, but not on every request', async () => {
  const r = await login(true);
  assert.equal((await call('GET', '/api/auth/me', r.cookie)).set, '', 'a fresh login needs no renewal');
  const hash = newest().token_hash;
  db.run(`UPDATE sessions SET expires_at = datetime('now', '+10 days'), created_at = datetime('now', '-20 days') WHERE token_hash = ?`, hash);
  const used = await call('GET', '/api/auth/me', r.cookie);
  assert.ok(Math.abs(used.age - 30 * DAY) < 5);
  assert.ok(db.get('SELECT expires_at FROM sessions WHERE token_hash = ?', hash).expires_at > db.minutesFromNow(29 * 1440));
});

test('after 90 days the password is asked for again, however often it is used', async () => {
  const r = await login(true);
  const hash = newest().token_hash;
  db.run(`UPDATE sessions SET expires_at = datetime('now', '+2 days'), created_at = datetime('now', '-88 days') WHERE token_hash = ?`, hash);
  const used = await call('GET', '/api/auth/me', r.cookie);
  assert.ok(Math.abs(used.age - 2 * DAY) < 5, 'never past the limit');
  db.run(`UPDATE sessions SET expires_at = datetime('now', '-1 minute') WHERE token_hash = ?`, hash);
  assert.equal((await call('GET', '/api/auth/me', r.cookie)).status, 401);
});

test('an ordinary login is never extended', async () => {
  const r = await login(false);
  db.run(`UPDATE sessions SET expires_at = datetime('now', '+1 hour') WHERE token_hash = ?`, newest().token_hash);
  assert.equal((await call('GET', '/api/auth/me', r.cookie)).set, '');
});

test('sign out ends a remembered login straight away', async () => {
  const r = await login(true);
  await call('POST', '/api/auth/logout', r.cookie);
  assert.equal((await call('GET', '/api/auth/me', r.cookie)).status, 401);
});

test('changing the password signs out other devices and keeps this one remembered', async () => {
  const other = await login(true);
  const here = await login(true);
  const next = 'An0ther-test-password';
  const changed = await call('POST', '/api/auth/password', here.cookie, { current: PASSWORD, next });
  assert.equal(changed.age, 30 * DAY);
  assert.equal((await call('GET', '/api/auth/me', other.cookie)).status, 401);
  assert.equal((await call('GET', '/api/auth/me', changed.cookie)).status, 200);
  await call('POST', '/api/auth/password', changed.cookie, { current: next, next: PASSWORD });
});

test('a paused account loses a remembered login', async () => {
  const r = await login(true);
  db.run(`UPDATE users SET status = 'paused' WHERE email = ?`, EMAIL);
  assert.equal((await call('GET', '/api/auth/me', r.cookie)).status, 401);
  db.run(`UPDATE users SET status = 'active' WHERE email = ?`, EMAIL);
});
