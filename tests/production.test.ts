// Starts the real server the way a host does, to prove unsafe settings are refused.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-production-'));
const PASSWORD = 'First-admin-Passw0rd';
const PORT = '4177';

const base = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ARCHSTONE_SKIP_DOTENV: '1', NODE_ENV: 'production', PORT,
  DB_PATH: join(dir, 'live.db'), DEMO_MODE: 'false', SECURE_COOKIES: 'true', APP_URL: 'https://crm.example.com',
  INITIAL_ADMIN_EMAIL: 'owner@test.local', INITIAL_ADMIN_PASSWORD: PASSWORD,
};

function start(env: Record<string, string | undefined>) {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/index.ts'], { env });
}

function refusal(env: Record<string, string | undefined>) {
  return new Promise<string>((done) => {
    const child = start(env);
    let text = '';
    child.stderr.on('data', (d) => { text += d; });
    child.on('exit', () => done(text));
  });
}

after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('unsafe production settings stop the server', async () => {
  assert.match(await refusal({ ...base, SECURE_COOKIES: 'false' }), /SECURE_COOKIES must be true/);
  assert.match(await refusal({ ...base, DEMO_MODE: 'true' }), /DEMO_MODE must be false/);
  assert.match(await refusal({ ...base, APP_URL: 'http://crm.example.com' }), /APP_URL must start with https/);
});

test('a live start has a working health check, chosen admin password and no sample data', async () => {
  const child = start(base);
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      up = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok, () => false);
    }
    assert.ok(up, 'server should start');

    const url = `http://127.0.0.1:${PORT}/api/auth/login`;
    const post = (password: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.local', password }) });
    assert.equal((await post('wrong-password-here')).status, 401);
    const login = await post(PASSWORD);
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie') ?? '';
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /HttpOnly/i);

    const me = await (await fetch(`http://127.0.0.1:${PORT}/api/auth/me`, { headers: { cookie: cookie.split(';')[0] } })).json();
    assert.equal(me.demoMode, false);
    assert.equal(me.mustSetupTwoFactor, true);
    assert.ok(me.user.must_change_password, 'the first password must be changed');

    // The chosen password must not sit in a file on the server.
    const file = join(dir, 'first-login-passwords.txt');
    if (existsSync(file)) assert.ok(!readFileSync(file, 'utf8').includes(PASSWORD));
  } finally {
    child.kill();
  }
});
