// Encrypted offsite backup: who can take one, and that it really restores.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-backup-'));
const out = mkdtempSync(join(tmpdir(), 'archstone-restore-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
const PASSPHRASE = 'correct horse battery staple';
let base = '';
let server: Server;
let db: any;
let backup: any;
let scheduler: any;
let admin = '';
let tele = '';
let file = '';

const post = (path: string, body: unknown, cookie = admin) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });

async function signIn(email: string) {
  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(` ${email} `))!;
  const current = line.trim().split(/\s+/)[2];
  const session = (await post('/api/auth/login', { email, password: current }, '')).headers.get('set-cookie')!.split(';')[0];
  const changed = await post('/api/auth/password', { current, next: NEW_PASSWORD }, session);
  assert.equal(changed.status, 200);
  return changed.headers.get('set-cookie')?.split(';')[0] ?? session;
}

before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  backup = await import('../server/services/backup.ts');
  scheduler = await import('../server/services/scheduler.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = await signIn('owner@test.local');
  tele = await signIn('telecaller1@demo.archstone.test');
  mkdirSync(join(dir, 'media'), { recursive: true });
  mkdirSync(join(dir, 'documents', 'lead-1'), { recursive: true });
  writeFileSync(join(dir, 'media', 'brochure.pdf'), 'SECRET-BROCHURE-CONTENT');
  writeFileSync(join(dir, 'documents', 'lead-1', 'pan.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
  writeFileSync(join(dir, 'secret.key'), 'KEY-MATERIAL');
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  for (const d of [dir, out]) try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('only an administrator with the right password can take a backup', async () => {
  assert.equal((await post('/api/settings/backup', { password: NEW_PASSWORD, passphrase: PASSPHRASE }, tele)).status, 403);
  assert.equal((await post('/api/settings/backup', { password: 'wrong-password', passphrase: PASSPHRASE })).status, 400);
  assert.equal((await post('/api/settings/backup', { password: NEW_PASSWORD, passphrase: 'short' })).status, 400);
  assert.equal((await post('/api/settings/backup', { password: NEW_PASSWORD, passphrase: PASSPHRASE }, '')).status, 401);
});

test('a backup downloads as an encrypted file and leaves no snapshot behind', async () => {
  const res = await post('/api/settings/backup', { password: NEW_PASSWORD, passphrase: PASSPHRASE });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition')!, /\.archstonebackup/);
  const bytes = Buffer.from(await res.arrayBuffer());
  file = join(out, 'test.archstonebackup');
  writeFileSync(file, bytes);
  assert.ok(!bytes.includes('SECRET-BROCHURE-CONTENT'));
  assert.ok(!bytes.includes('KEY-MATERIAL'));
  assert.ok(!bytes.includes('SQLite format'));
  assert.ok(!readdirSync(dir).some((f) => f.startsWith('.backup-')));
  assert.ok(db.getSetting('backup_download_last', ''));
});

test('the backup restores every file and a working database', async () => {
  const target = join(out, 'good');
  const names = await backup.restoreBackup(file, PASSPHRASE, target);
  assert.ok(names.includes('archstone-connect.db'));
  assert.equal(readFileSync(join(target, 'media', 'brochure.pdf'), 'utf8'), 'SECRET-BROCHURE-CONTENT');
  assert.equal(readFileSync(join(target, 'secret.key'), 'utf8'), 'KEY-MATERIAL');
  assert.equal(readFileSync(join(target, 'documents', 'lead-1', 'pan.bin')).length, 3 * 1024 * 1024);
  const copy = new DatabaseSync(join(target, 'archstone-connect.db'), { readOnly: true });
  const count = (copy.prepare('SELECT COUNT(*) n FROM leads').get() as { n: number }).n;
  copy.close();
  assert.equal(count, db.get('SELECT COUNT(*) n FROM leads').n);
  assert.ok(!existsSync(join(target, '.restore-in-progress')));
});

test('a wrong passphrase or a damaged file restores nothing', async () => {
  const wrong = join(out, 'wrong');
  await assert.rejects(backup.restoreBackup(file, 'not the right passphrase', wrong), /wrong|damaged/);
  assert.deepEqual(readdirSync(wrong), []);

  const bytes = readFileSync(file);
  bytes[bytes.length - 100] ^= 0xff;
  const tampered = join(out, 'tampered.archstonebackup');
  writeFileSync(tampered, bytes);
  const damaged = join(out, 'damaged');
  await assert.rejects(backup.restoreBackup(tampered, PASSPHRASE, damaged), /wrong|damaged/);
  assert.deepEqual(readdirSync(damaged), []);

  const other = join(out, 'other.bin');
  writeFileSync(other, 'not a backup at all, but long enough to read a header from it safely');
  await assert.rejects(backup.restoreBackup(other, PASSPHRASE, join(out, 'other')), /not an Archstone Connect backup/);
});

test('the restore command works and protects a full folder', () => {
  const run = (...args: string[]) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'scripts/restore-backup.ts', ...args], { env: { ...process.env, BACKUP_PASSPHRASE: PASSPHRASE }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const target = join(out, 'cli');
  assert.match(run(file, target), /Restored \d+ files/);
  assert.throws(() => run(file, target), /empty folder/);
});

test('admins are reminded weekly until they keep an offsite copy', () => {
  const notes = () => db.all(`SELECT id FROM notifications WHERE title LIKE 'Download this week%'`).length;
  db.setSetting('backup_download_last', '');
  db.setSetting('backup_reminded', '');
  scheduler.remindOffsiteBackup();
  const first = notes();
  assert.ok(first >= 1);
  scheduler.remindOffsiteBackup();
  assert.equal(notes(), first, 'not more than once a week');
  db.setSetting('backup_reminded', db.minutesFromNow(-8 * 1440));
  db.setSetting('backup_download_last', db.nowIso());
  scheduler.remindOffsiteBackup();
  assert.equal(notes(), first, 'a recent download stops the reminder');
});
