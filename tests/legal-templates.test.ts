// Public privacy and data deletion pages, and checking template review status straight from Meta.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prepareEnv, startHarness, type Harness } from './helpers/harness.ts';

const dir = prepareEnv('legal');
Object.assign(process.env, {
  WHATSAPP_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '111', WHATSAPP_BUSINESS_ACCOUNT_ID: '222',
  PRIVACY_CONTACT_EMAIL: 'privacy@archstone.test', WHATSAPP_DISPLAY_NUMBER: '919999900000',
});

let h: Harness;
let base = '';
const realFetch = globalThis.fetch;
let metaTemplates: any[] = [];
const metaCalls: string[] = [];

before(async () => {
  // Calls to Meta are answered here; calls to the test server go through.
  globalThis.fetch = (async (url: any, init: any) => {
    const target = String(url);
    if (target.startsWith('https://graph.facebook.com/')) {
      metaCalls.push(target);
      return new Response(JSON.stringify({ data: metaTemplates }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (!base && target.includes('/api/auth/login')) base = new URL(target).origin;
    return realFetch(url, init);
  }) as typeof fetch;
  h = await startHarness(dir);
  await h.addUser('tele', 'telecaller');
});
after(() => { globalThis.fetch = realFetch; h.stop(); });

test('the privacy and data deletion pages open without signing in, with the contact details', async () => {
  for (const path of ['/privacy', '/data-deletion']) {
    const r = await realFetch(base + path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    const html = await r.text();
    assert.match(html, /Archstone Realty/);
    assert.match(html, /privacy@archstone\.test/);
    assert.match(html, /wa\.me\/919999900000/);
  }
  assert.match(await (await realFetch(base + '/data-deletion')).text(), /within 30 days/);
});

test('"Check status with Meta" brings in approvals and rejections for submitted templates only', async () => {
  const add = (name: string, status: string) => h.db.run(`INSERT INTO wa_templates(name, category, language, body, status) VALUES(?, 'UTILITY', 'en', 'Hello there, a test.', ?)`, name, status);
  add('waiting_one', 'pending');
  add('waiting_two', 'pending');
  add('not_sent', 'draft');
  metaTemplates = [
    { name: 'waiting_one', status: 'APPROVED', rejected_reason: 'NONE' },
    { name: 'waiting_two', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' },
    { name: 'not_sent', status: 'APPROVED' },
    { name: 'only_on_meta', status: 'APPROVED' },
  ];
  const r = await h.call('POST', '/api/templates/sync', 'admin');
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.checked, r.data.changed], [4, 2]);
  const status = (name: string) => h.db.get('SELECT status, reject_reason FROM wa_templates WHERE name = ?', name);
  assert.deepEqual({ ...status('waiting_one') }, { status: 'approved', reject_reason: '' });
  assert.deepEqual({ ...status('waiting_two') }, { status: 'rejected', reject_reason: 'INVALID_FORMAT' });
  assert.equal(status('not_sent').status, 'draft', 'a template never submitted is left alone');
  assert.ok(!h.db.get(`SELECT 1 AS x FROM wa_templates WHERE name = 'only_on_meta'`), 'nothing is created from Meta');
  assert.ok(metaCalls.at(-1)!.includes('/222/message_templates'), 'asks the right WhatsApp account');
  assert.equal((await h.call('POST', '/api/templates/sync', 'admin')).data.changed, 0, 'a second check changes nothing');
  assert.equal((await h.call('POST', '/api/templates/sync', 'tele')).status, 403, 'needs the template permission');
});
