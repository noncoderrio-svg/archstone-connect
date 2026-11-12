// A small server harness for tests: a fresh database, a running app, and signed-in people by name.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NEW_PASSWORD = 'Str0ng-test-password';

/** Must run before anything from server/ is imported, because the database path is read at import time. */
export function prepareEnv(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), `archstone-${prefix}-`));
  Object.assign(process.env, {
    ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
    WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
  });
  return dir;
}

export interface Harness {
  db: any;
  ids: Record<string, number>;
  call: (method: string, path: string, who: string, body?: unknown) => Promise<{ status: number; data: any }>;
  addUser: (who: string, role: string, projectIds?: number[]) => Promise<number>;
  stop: () => void;
}

export async function startHarness(dir: string): Promise<Harness> {
  const { createApp } = await import('../../server/app.ts');
  const { ensureBaseData } = await import('../../server/seed.ts');
  const db = await import('../../server/db.ts');
  await ensureBaseData();
  const server: Server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session: Record<string, string> = {};
  const ids: Record<string, number> = {};

  async function call(method: string, path: string, who: string, body?: unknown) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie: session[who] ?? who }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, set: res.headers.get('set-cookie') };
  }

  async function signInWith(who: string, email: string, current: string) {
    const login = await call('POST', '/api/auth/login', '', { email, password: current });
    const cookie = login.set!.split(';')[0];
    const changed = await call('POST', '/api/auth/password', cookie, { current, next: NEW_PASSWORD });
    assert.equal(changed.status, 200);
    session[who] = changed.set ? changed.set.split(';')[0] : cookie;
    ids[who] = (await call('GET', '/api/auth/me', who)).data.user.id;
  }

  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(' owner@test.local '))!;
  await signInWith('admin', 'owner@test.local', line.trim().split(/\s+/)[2]);

  async function addUser(who: string, role: string, projectIds: number[] = []) {
    const email = `${who}@test.local`;
    const r = await call('POST', '/api/users', 'admin', { name: who, email, role, project_ids: projectIds });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await signInWith(who, email, r.data.temporaryPassword);
    return ids[who];
  }

  return {
    db, ids, call, addUser,
    stop: () => {
      server.close();
      server.closeAllConnections();
      try { db.db.close(); rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
    },
  };
}
