// The Android app download: admin upload, the public page and file, and the feature switch. Throwaway people and a fake app file.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prepareEnv, startHarness, type Harness } from './helpers/harness.ts';

const dir = prepareEnv('mobileapp');
let h: Harness;

/** A stand-in APK: real APKs are ZIP files, which start with "PK". */
const fakeApk = (size = 4096) => Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(size - 4, 7)]);

async function upload(who: string, body: Buffer, version = '1.0.0') {
  const res = await fetch(`${h.base}/api/mobile-app/apk?version=${encodeURIComponent(version)}&notes=First%20release`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie: h.cookie(who) }, body: new Uint8Array(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

before(async () => {
  h = await startHarness(dir);
  await h.addUser('tc', 'telecaller');
});
after(() => h.stop());

test('before an upload: the page says coming soon, the file is missing, and the sign-in page gets nothing', async () => {
  const info = await (await fetch(`${h.base}/public/app-info`)).json();
  assert.equal(info.android, null);
  const page = await fetch(`${h.base}/app`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /not available yet/);
  assert.equal((await fetch(`${h.base}/app/download`)).status, 404);
});

test('only an administrator uploads, and only a real app file is accepted', async () => {
  assert.equal((await upload('tc', fakeApk())).status, 403);
  assert.equal((await upload('admin', Buffer.alloc(4096, 1))).status, 415, 'not a ZIP');
  const r = await upload('admin', fakeApk(), '1.0.0');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.apk.size, 4096);
  assert.ok(h.db.get(`SELECT 1 AS x FROM audit_log WHERE action = 'mobile_app.upload'`));
});

test('anyone can download the latest version, from /app/download and the old address', async () => {
  const info = await (await fetch(`${h.base}/public/app-info`)).json();
  assert.equal(info.android.version, '1.0.0');
  assert.equal(info.android.size, 4096);
  for (const path of ['/app/download', '/archstone-connect-app.apk']) {
    const res = await fetch(`${h.base}${path}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.match(res.headers.get('content-disposition') ?? '', /Archstone-Connect-1\.0\.0\.apk/);
    assert.equal(Buffer.from(await res.arrayBuffer()).length, 4096);
  }
  assert.match(await (await fetch(`${h.base}/app`)).text(), /Download for Android/);
  const qr = await fetch(`${h.base}/app/qr.svg`);
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(await qr.text(), /<svg/);

  // A new version replaces the old file.
  await upload('admin', fakeApk(8192), '1.1.0');
  const latest = await fetch(`${h.base}/app/download`);
  assert.equal(Buffer.from(await latest.arrayBuffer()).length, 8192);
});

test('the iPhone link must be https, and switching the feature off hides everything', async () => {
  assert.equal((await h.call('PUT', '/api/mobile-app/links', 'admin', { ios_url: 'http://example.com' })).status, 400);
  assert.equal((await h.call('PUT', '/api/mobile-app/links', 'admin', { ios_url: 'https://testflight.apple.com/join/abc' })).status, 200);
  assert.equal((await (await fetch(`${h.base}/public/app-info`)).json()).ios_url, 'https://testflight.apple.com/join/abc');

  await h.call('PUT', '/api/features', 'admin', { bulletin: true, duty: false, kyc: true, app: false });
  assert.deepEqual(await (await fetch(`${h.base}/public/app-info`)).json(), { android: null, ios_url: '' });
  assert.equal((await fetch(`${h.base}/app/download`)).status, 404);
  await h.call('PUT', '/api/features', 'admin', { bulletin: true, duty: false, kyc: true, app: true });

  assert.equal((await h.call('DELETE', '/api/mobile-app/apk', 'admin')).status, 200);
  assert.equal((await fetch(`${h.base}/app/download`)).status, 404);
});
