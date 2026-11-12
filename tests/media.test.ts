// Large property files, the storage guard, and playing them back.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-media-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '', STORAGE_LIMIT_MB: '150',
});

const NEW_PASSWORD = 'Str0ng-test-password';
const MB = 1024 * 1024;
let base = '';
let server: Server;
let db: any;
let admin = '';

const pdf = (size: number) => { const b = Buffer.alloc(size, 1); b.write('%PDF-1.7'); return b; };
const mp4 = (size: number) => { const b = Buffer.alloc(size, 2); b.write('ftypisom', 4); return b; };

async function upload(file: Buffer, title = 'Brochure', name = 'brochure.pdf') {
  try {
    const res = await fetch(`${base}/api/media?title=${title}&name=${name}`, { method: 'POST', headers: { cookie: admin, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(file) });
    return { status: res.status, data: await res.json() };
  } catch {
    return { status: 0, data: {} }; // The server closed the connection on a refused file.
  }
}

async function json(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { cookie: admin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(' owner@test.local '))!;
  const current = line.trim().split(/\s+/)[2];
  const post = (path: string, body: unknown, cookie = '') => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  const session = (await post('/api/auth/login', { email: 'owner@test.local', password: current })).headers.get('set-cookie')!.split(';')[0];
  const changed = await post('/api/auth/password', { current, next: NEW_PASSWORD }, session);
  admin = changed.headers.get('set-cookie')?.split(';')[0] ?? session;
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('a 60 MB brochure uploads, and only its real size is recorded', async () => {
  const r = await upload(pdf(60 * MB));
  assert.equal(r.status, 201);
  assert.equal(db.get('SELECT size FROM media_assets WHERE id = ?', r.data.id).size, 60 * MB);
  assert.ok(!readdirSync(join(dir, 'media')).some((f) => f.endsWith('.part')));
});

test('files over 100 MB are refused with a clear reason', async () => {
  const r = await upload(pdf(101 * MB));
  assert.ok([0, 413].includes(r.status));
  if (r.status) assert.match(r.data.error, /100 MB/);
});

test('files that only pretend to be brochures are refused and leave nothing behind', async () => {
  const r = await upload(Buffer.from('<html><script>alert(1)</script></html>'.repeat(10)), 'Fake', 'fake.pdf');
  assert.equal(r.status, 415);
  assert.ok(!readdirSync(join(dir, 'media')).some((f) => f.endsWith('.part')));
});

test('storage use is reported', async () => {
  const { storage } = (await json('GET', '/api/media')).data;
  assert.equal(storage.limit, 150 * MB);
  assert.ok(storage.used >= 60 * MB);
  assert.equal(storage.max_file, 100 * MB);
});

test('the storage guard stops uploads before the disk fills', async () => {
  assert.equal((await upload(pdf(70 * MB), 'Second', 'second.pdf')).status, 201);
  const r = await upload(pdf(40 * MB), 'Third', 'third.pdf');
  assert.ok([0, 507].includes(r.status));
  if (r.status) assert.match(r.data.error, /storage is full/i);
  assert.ok(!readdirSync(join(dir, 'media')).some((f) => f.endsWith('.part')));
  assert.equal(db.get(`SELECT COUNT(*) n FROM media_assets WHERE title = 'Third'`).n, 0);
});

test('deleting a file frees the space', async () => {
  const rows = (await json('GET', '/api/media')).data.media;
  for (const m of rows) assert.equal((await json('DELETE', `/api/media/${m.id}`)).status, 200);
  assert.ok((await json('GET', '/api/media')).data.storage.used < 20 * MB);
});

test('large files stream, with range requests for video', async () => {
  const r = await upload(mp4(20 * MB), 'Tour', 'tour.mp4');
  assert.equal(r.status, 201);
  const m = (await json('GET', '/api/media')).data.media[0];
  const part = await fetch(base + m.preview, { headers: { range: 'bytes=0-1023' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-type'), 'video/mp4');
  assert.equal((await part.arrayBuffer()).byteLength, 1024);
});

test('a video too large for WhatsApp explains what to do instead', async () => {
  const m = (await json('GET', '/api/media')).data.media[0];
  const lead = db.get('SELECT id FROM leads LIMIT 1');
  const r = await json('POST', `/api/inbox/${lead.id}/media`, { media_id: m.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /16 MB.*link/);
});
