// The admin's view of every WhatsApp number, and chats that happen on staff phones.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-chats-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  META_APP_SECRET: 'app-secret', WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
});

const NEW_PASSWORD = 'Str0ng-test-password';
const realFetch = globalThis.fetch;
let base = '';
let server: Server;
let db: any;
let wa: any;
let admin = '';
let tele = '';
let teleId = 0;
let numA = 0;
let numB = 0;
let phone = 9100000000;
const metaCalls: { url: string; body: string }[] = [];
let metaStatus = 200;

async function call(method: string, path: string, who = admin, body?: unknown) {
  const res = await realFetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie: who }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, set };
}

async function signIn(email: string) {
  const line = readFileSync(join(dir, 'first-login-passwords.txt'), 'utf8').split('\n').find((l) => l.includes(` ${email} `))!;
  const current = line.trim().split(/\s+/)[2];
  const session = (await call('POST', '/api/auth/login', '', { email, password: current })).set!.split(';')[0];
  const changed = await call('POST', '/api/auth/password', session, { current, next: NEW_PASSWORD });
  return changed.set ? changed.set.split(';')[0] : session;
}

function webhook(payload: object) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
  return realFetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature }, body: raw });
}

const newPhone = () => String(phone += 1);
const inbound = (from: string, phoneId: string, id: string, body: string) => webhook({
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneId }, contacts: [{ wa_id: from, profile: { name: 'Real Customer' } }], messages: [{ from, id, type: 'text', text: { body } }] } }] }],
});
const echo = (to: string, phoneId: string, id: string, fields: object) => webhook({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba', changes: [{ field: 'smb_message_echoes', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '919000000001', phone_number_id: phoneId },
    contacts: [{ wa_id: to, profile: { name: 'Phone Customer' } }],
    message_echoes: [{ from: '919000000001', to, id, timestamp: '1760000000', ...fields }],
  } }] }],
});
const list = async (q = '', who = admin) => (await call('GET', `/api/conversations${q}`, who)).data;
const leadOf = (p: string) => db.get('SELECT * FROM leads WHERE phone = ?', `+91${p}`);

before(async () => {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith('https://graph.facebook.com/')) {
      metaCalls.push({ url: String(url), body: String(init?.body) });
      return new Response('{"messaging_product":"whatsapp","request_id":"1"}', { status: metaStatus });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  db = await import('../server/db.ts');
  wa = await import('../server/services/whatsapp.ts');
  await ensureBaseData();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = await signIn('owner@test.local');
  tele = await signIn('telecaller1@demo.archstone.test');
  teleId = db.get(`SELECT id FROM users WHERE email = 'telecaller1@demo.archstone.test'`).id;
  db.run('DELETE FROM wa_numbers');
  numA = db.run(`INSERT INTO wa_numbers(label, display_number, phone_number_id, user_id) VALUES('Rahul line', '+919000000001', 'demo-a', ?)`, teleId).id;
  numB = db.run(`INSERT INTO wa_numbers(label, display_number, phone_number_id) VALUES('Office line', '+919000000002', 'demo-b')`).id;
});

beforeEach(() => {
  metaCalls.length = 0;
  metaStatus = 200;
  db.run(`UPDATE wa_numbers SET phone_app = 0, history_status = ''`);
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
  server?.closeAllConnections();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

test('only monitors can read all chats', async () => {
  assert.equal((await call('GET', '/api/conversations', tele)).status, 403);
  const p = newPhone();
  await inbound(`91${p}`, 'demo-a', 'wamid.perm', 'hello');
  assert.equal((await call('GET', `/api/conversations/${leadOf(p).id}?number=${numA}`, tele)).status, 403);
});

test('one customer on two numbers shows as two conversations, each with its own messages', async () => {
  db.run('UPDATE wa_numbers SET phone_app = 1'); // Keeps the greeting bot out of what these tests compare.
  const p = newPhone();
  await inbound(`91${p}`, 'demo-a', 'wamid.two1', 'asking Rahul');
  await inbound(`91${p}`, 'demo-b', 'wamid.two2', 'asking the office');
  const id = leadOf(p).id;
  const rows = (await list(`?q=${p}`)).conversations.filter((c: any) => c.lead_id === id);
  assert.deepEqual(rows.map((c: any) => c.number_label).sort(), ['Office line', 'Rahul line']);
  const thread = (await call('GET', `/api/conversations/${id}?number=${numA}`)).data;
  assert.deepEqual(thread.messages.map((m: any) => m.body), ['asking Rahul']);
  assert.deepEqual(thread.other_numbers.map((o: any) => o.label), ['Office line']);
});

test('number filter, cards and tabs agree', async () => {
  const p = newPhone();
  await inbound(`91${p}`, 'demo-b', 'wamid.card1', 'card test');
  const all = await list();
  const only = await list(`?number=${numB}`);
  assert.ok(only.conversations.every((c: any) => c.num === numB));
  assert.equal(all.numbers.find((n: any) => n.id === numB).chats, only.tabs.all);
  assert.equal(all.numbers.find((n: any) => n.id === numB).waiting, only.tabs.awaiting);
});

test('a chat waits until a person answers: bots and broadcasts do not count', async () => {
  const p = newPhone();
  await inbound(`91${p}`, 'demo-a', 'wamid.wait1', 'any update?');
  const lead = leadOf(p);
  const row = async () => (await list(`?q=${p}`)).conversations[0];
  assert.ok((await row()).waiting_since);
  db.run(`INSERT INTO wa_messages(lead_id, direction, body, status, number_id) VALUES(?, 'out', 'Auto reply', 'sent', ?)`, lead.id, numA);
  assert.ok((await row()).waiting_since, 'an automatic reply is not an answer');
  db.run(`INSERT INTO wa_messages(lead_id, direction, body, status, number_id, actor_id) VALUES(?, 'out', 'Yes, tomorrow', 'sent', ?, ?)`, lead.id, numA, teleId);
  const answered = await row();
  assert.equal(answered.waiting_since, null);
  assert.equal(answered.replied_by, 'Demo Telecaller One');
});

test('slow chats are flagged after an hour', async () => {
  const p = newPhone();
  await inbound(`91${p}`, 'demo-a', 'wamid.slow1', 'hello?');
  const id = leadOf(p).id;
  assert.ok(!(await list('?status=slow')).conversations.some((c: any) => c.lead_id === id));
  db.run(`UPDATE wa_messages SET created_at = datetime('now', '-2 hours') WHERE lead_id = ?`, id);
  assert.ok((await list('?status=slow')).conversations.some((c: any) => c.lead_id === id));
});

test('search finds words inside any message, and shows the matching one', async () => {
  const p = newPhone();
  await inbound(`91${p}`, 'demo-a', 'wamid.find1', 'What is the possession date for tower B?');
  await inbound(`91${p}`, 'demo-a', 'wamid.find2', 'thanks');
  const r = await list('?q=possession');
  const row = r.conversations.find((c: any) => c.lead_id === leadOf(p).id);
  assert.match(row.found, /possession date/);
  assert.equal((await list('?q=100%25_impossible')).total, 0, 'wildcards are treated as plain text');
});

test('staff filter covers the number owner and the lead owner', async () => {
  const r = await list(`?staff=${teleId}`);
  assert.ok(r.conversations.length > 0);
  assert.ok(r.conversations.every((c: any) => c.num === numA || c.owner_id === teleId || c.replied_by));
});

test('broadcast-only contacts do not bury real conversations', async () => {
  const { id } = db.run(`INSERT INTO leads(name, phone, source) VALUES('Broadcast Only', '+919888800001', 'Manual')`);
  const owner = db.get('SELECT id FROM users LIMIT 1').id;
  const t = db.get('SELECT id FROM wa_templates LIMIT 1').id;
  const c = db.run(`INSERT INTO wa_campaigns(name, template_id, created_by) VALUES('Offer', ?, ?)`, t, owner).id;
  db.run(`INSERT INTO wa_messages(lead_id, direction, body, status, campaign_id, actor_id, number_id) VALUES(?, 'out', 'Offer', 'sent', ?, ?, ?)`, id, c, owner, numB);
  assert.ok(!(await list('?limit=500')).conversations.some((x: any) => x.lead_id === id));
});

test('reading a chat leaves unread counts alone and is recorded once per sitting', async () => {
  const p = newPhone();
  await inbound(`91${p}`, 'demo-a', 'wamid.read1', 'unread please');
  const lead = leadOf(p);
  db.run('UPDATE leads SET owner_id = ? WHERE id = ?', teleId, lead.id);
  await call('GET', `/api/conversations/${lead.id}?number=${numA}`);
  await call('GET', `/api/conversations/${lead.id}?number=${numA}`);
  assert.equal(leadOf(p).unread_count, 1);
  const views = db.all(`SELECT * FROM audit_log WHERE action = 'conversation.view' AND entity_id = ?`, String(lead.id));
  assert.equal(views.length, 1);
  assert.equal(views[0].detail, 'Rahul line');
});

test('masked roles stay masked and cannot search by phone', async () => {
  const p = newPhone();
  await inbound(`91${p}`, 'demo-a', 'wamid.mask1', 'mask me');
  const before = db.getSetting('mask_phone_roles', ['marketing']);
  db.setSetting('mask_phone_roles', ['admin']);
  const r = await list('?q=mask me');
  assert.ok(!JSON.stringify(r).includes(p));
  assert.equal((await list(`?q=${p}`)).total, 0);
  db.setSetting('mask_phone_roles', before);
});

test('a message sent from the phone app joins the chat, stops the wait, and is not repeated', async () => {
  const p = newPhone();
  await inbound(`91${p}`, 'demo-a', 'wamid.echo0', 'is it available?');
  const lead = leadOf(p);
  await echo(`91${p}`, 'demo-a', 'wamid.echo1', { type: 'text', text: { body: 'Yes, come on Sunday' } });
  await echo(`91${p}`, 'demo-a', 'wamid.echo1', { type: 'text', text: { body: 'Yes, come on Sunday' } });
  const thread = (await call('GET', `/api/conversations/${lead.id}?number=${numA}`)).data;
  const sent = thread.messages.filter((m: any) => m.source === 'phone');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, 'Yes, come on Sunday');
  assert.equal(sent[0].sender, 'Demo Telecaller One');
  const row = (await list(`?q=${p}`)).conversations[0];
  assert.equal(row.waiting_since, null);
  assert.equal(leadOf(p).unread_count, 0);
  assert.ok(leadOf(p).first_response_at);
});

test('a phone chat with a new person makes a quiet lead without consent or alerts', async () => {
  const p = newPhone();
  const alerts = db.get('SELECT COUNT(*) AS n FROM notifications').n;
  await echo(`91${p}`, 'demo-a', 'wamid.new1', { type: 'image', image: { caption: 'Floor plan' } });
  const lead = leadOf(p);
  assert.equal(lead.owner_id, teleId);
  assert.equal(lead.wa_opt_in, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM notifications').n, alerts);
  assert.equal(db.get('SELECT body FROM wa_messages WHERE wa_id = ?', 'wamid.new1').body, 'Floor plan');
});

test('a phone-only number gets no automatic replies from the CRM', async () => {
  await echo(`91${newPhone()}`, 'demo-b', 'wamid.auto1', { type: 'text', text: { body: 'hi' } });
  assert.equal(db.get('SELECT phone_app FROM wa_numbers WHERE id = ?', numB).phone_app, 1, 'an echo marks the number');
  const p = newPhone();
  await inbound(`91${p}`, 'demo-b', 'wamid.auto2', 'hello, is anyone there?');
  const sent = db.all(`SELECT 1 FROM wa_messages WHERE lead_id = ? AND direction = 'out'`, leadOf(p).id);
  assert.equal(sent.length, 0);
});

test('edits and deletions from the phone are kept on record', async () => {
  const p = newPhone();
  await echo(`91${p}`, 'demo-a', 'wamid.ed1', { type: 'text', text: { body: 'Price is 90 lakh' } });
  await echo(`91${p}`, 'demo-a', 'wamid.ed2', { type: 'edit', edit: { original_message_id: 'wamid.ed1', message: { type: 'text', text: { body: 'Price is 95 lakh' } } } });
  assert.equal(db.get('SELECT body FROM wa_messages WHERE wa_id = ?', 'wamid.ed1').body, 'Price is 95 lakh');
  assert.ok(db.get(`SELECT 1 AS x FROM activities WHERE lead_id = ? AND body = 'Was: Price is 90 lakh'`, leadOf(p).id));
  await echo(`91${p}`, 'demo-a', 'wamid.ed3', { type: 'revoke', revoke: { original_message_id: 'wamid.ed1' } });
  const m = db.get('SELECT body, status FROM wa_messages WHERE wa_id = ?', 'wamid.ed1');
  assert.deepEqual({ ...m }, { body: 'Price is 95 lakh', status: 'revoked' });
  wa.applyStatus('wamid.ed1', 'read');
  assert.equal(db.get('SELECT status FROM wa_messages WHERE wa_id = ?', 'wamid.ed1').status, 'revoked');
});

test('past chats import in time order, without alerts, and a late import cannot hide a waiting customer', async () => {
  db.run('UPDATE wa_numbers SET phone_app = 1'); // Keeps the greeting bot out of what these tests compare.
  const p = newPhone();
  await inbound(`91${p}`, 'demo-a', 'wamid.hist0', 'new message today');
  const lead = leadOf(p);
  const old = String(Math.floor(Date.now() / 1000) - 5 * 86400);
  const alerts = db.get('SELECT COUNT(*) AS n FROM notifications').n;
  const history = (progress: number) => webhook({
    entry: [{ changes: [{ field: 'history', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '919000000001', phone_number_id: 'demo-a' },
      history: [{ metadata: { phase: 1, chunk_order: 1, progress }, threads: [{ id: `91${p}`, messages: [
        { from: `91${p}`, from_user_id: 'u1', id: 'wamid.hist1', timestamp: old, type: 'text', text: { body: 'Old question' }, history_context: { status: 'READ' } },
        { from: '919000000001', to: `91${p}`, id: 'wamid.hist2', timestamp: String(Number(old) + 60), type: 'text', text: { body: 'Old answer' }, history_context: { status: 'READ' } },
        { from: '919000000001', to: `91${p}`, id: 'wamid.hist3', timestamp: String(Number(old) + 120), type: 'media_placeholder', history_context: { status: 'SENT' } },
      ] }] }],
    } }] }],
  });
  await history(40);
  assert.equal(db.get('SELECT history_status FROM wa_numbers WHERE id = ?', numA).history_status, 'importing 40%');
  await history(100);
  assert.equal(db.get('SELECT history_status FROM wa_numbers WHERE id = ?', numA).history_status, 'done');
  const thread = (await call('GET', `/api/conversations/${lead.id}?number=${numA}`)).data;
  assert.deepEqual(thread.messages.map((m: any) => m.body), ['Old question', 'Old answer', '[media placeholder]', 'new message today']);
  assert.deepEqual(thread.messages.map((m: any) => m.direction), ['in', 'out', 'out', 'in']);
  const row = (await list(`?q=${p}`)).conversations[0];
  assert.equal(row.last_body, 'new message today');
  assert.ok(row.waiting_since, 'the customer is still waiting');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM notifications').n, alerts);
  assert.equal(leadOf(p).unread_count, 1);
});

test('the inbox keeps imported history in time order too', async () => {
  db.run('UPDATE wa_numbers SET phone_app = 1'); // Keeps the greeting bot out of what these tests compare.
  const p = newPhone();
  await inbound(`91${p}`, 'demo-a', 'wamid.box1', 'latest words');
  const lead = leadOf(p);
  db.run(`INSERT INTO wa_messages(lead_id, direction, body, status, number_id, created_at) VALUES(?, 'in', 'older words', 'received', ?, datetime('now', '-9 days'))`, lead.id, numA);
  const box = (await call('GET', `/api/inbox/${lead.id}`)).data;
  assert.deepEqual(box.messages.map((m: any) => m.body).slice(-2), ['older words', 'latest words']);
});

test('a business that declined to share history is shown, not retried', async () => {
  await webhook({ entry: [{ changes: [{ field: 'history', value: { metadata: { phone_number_id: 'demo-a' }, history: [{ errors: [{ code: 2593109, title: 'History sync is turned off by the business from the WhatsApp Business App' }] }] } }] }] });
  assert.equal(db.get('SELECT history_status FROM wa_numbers WHERE id = ?', numA).history_status, 'declined');
});

test('asking Meta for past chats needs a connected number and goes contacts first', async () => {
  assert.equal((await call('POST', `/api/wa-numbers/${numA}/history-sync`)).status, 400);
  assert.equal(metaCalls.length, 0);
  assert.equal((await call('POST', `/api/wa-numbers/${numA}/history-sync`, tele)).status, 403);
  const { encryptText } = await import('../server/services/secrets.ts');
  const id = db.run(`INSERT INTO wa_numbers(label, display_number, phone_number_id, token) VALUES('Real', '+919000000003', '1234567890', ?)`, encryptText('real-token-value')).id;
  assert.equal((await call('POST', `/api/wa-numbers/${id}/history-sync`)).status, 200);
  assert.deepEqual(metaCalls.map((c) => JSON.parse(c.body).sync_type), ['smb_app_state_sync', 'history']);
  assert.ok(metaCalls[0].url.endsWith('/1234567890/smb_app_data'));
  assert.equal(db.get('SELECT history_status FROM wa_numbers WHERE id = ?', id).history_status, 'requested');
  metaStatus = 400;
  assert.equal((await call('POST', `/api/wa-numbers/${id}/history-sync`)).status, 502);
});

test('saving a number keeps the phone setting', async () => {
  const body = { label: 'Saved', display_number: '+919000000004', phone_number_id: 'demo-saved', daily_limit: 100, status: 'active', phone_app: true };
  const { id } = (await call('POST', '/api/wa-numbers', admin, body)).data;
  assert.equal((await call('GET', '/api/wa-numbers')).data.numbers.find((n: any) => n.id === id).phone_app, 1);
  await call('PUT', `/api/wa-numbers/${id}`, admin, { ...body, phone_app: false });
  assert.equal((await call('GET', '/api/wa-numbers')).data.numbers.find((n: any) => n.id === id).phone_app, 0);
});
