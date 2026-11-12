// Bulk calling files: split by typed counts then equally, one notification per person, and re-splitting uncalled numbers.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prepareEnv, startHarness, type Harness } from './helpers/harness.ts';

const dir = prepareEnv('calling');
let h: Harness;
let phoneSeed = 9100000000;

const rows = (n: number) => Array.from({ length: n }, () => ({ phone: String(phoneSeed++), name: 'Cold contact' }));
const owners = (listId: number) => Object.fromEntries(h.db.all('SELECT owner_id, COUNT(*) n FROM leads WHERE call_list_id = ? GROUP BY owner_id', listId).map((r: any) => [r.owner_id, r.n]));
const notes = (who: string) => h.db.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ?', h.ids[who]).n;
const upload = (body: unknown, who = 'admin') => h.call('POST', '/api/dialer/lists', who, body);

before(async () => {
  h = await startHarness(dir);
  for (const who of ['t1', 't2', 't3', 't4']) await h.addUser(who, 'telecaller');
  await h.addUser('lead', 'closing_manager');
  await h.addUser('pay', 'payment_followup');
});
after(() => h.stop());

test('the splitter fills typed counts first, then shares the rest equally', async () => {
  const { splitter } = await import('../server/routes/dialer.ts');
  const next = splitter([1, 2, 3], { 1: 5, 2: 1 });
  const got = Array.from({ length: 12 }, () => next());
  const count = (id: number) => got.filter((x) => x === id).length;
  assert.deepEqual([count(1), count(2), count(3)], [7, 3, 2], '5 and 1 by count, then 6 shared equally');
  const plain = splitter([1, 2], {});
  assert.deepEqual(Array.from({ length: 4 }, () => plain()), [1, 2, 1, 2]);
});

test('a 6,000 number file is split by the counts typed in, the rest equally, and each person is told once', async () => {
  const before = { t1: notes('t1'), t2: notes('t2'), t3: notes('t3') };
  const started = Date.now();
  const r = await upload({ name: 'Expo 6000', agent_ids: [h.ids.t1, h.ids.t2, h.ids.t3], counts: { [h.ids.t1]: 3000, [h.ids.t2]: 1000 }, rows: rows(6000) });
  const seconds = (Date.now() - started) / 1000;
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.added, 6000);
  const by = owners(r.data.id);
  // 3000 and 1000 by count, then the last 2000 shared equally between all three.
  assert.equal(by[h.ids.t1], 3000 + 667);
  assert.equal(by[h.ids.t2], 1000 + 667);
  assert.equal(by[h.ids.t3], 666);
  assert.equal(notes('t1') - before.t1, 1, 'one notification, not one per number');
  assert.equal(notes('t2') - before.t2, 1);
  assert.equal(notes('t3') - before.t3, 1);
  assert.ok(seconds < 60, `took ${seconds}s`);
});

test('with no counts, everything is shared equally', async () => {
  const r = await upload({ name: 'Equal', agent_ids: [h.ids.t1, h.ids.t2, h.ids.t3, h.ids.t4], rows: rows(10) });
  assert.deepEqual(Object.values(owners(r.data.id)).sort(), [2, 2, 3, 3]);
});

test('numbers only go to people who work leads', async () => {
  const r = await upload({ name: 'Wrong people', agent_ids: [h.ids.pay], rows: rows(3) });
  assert.equal(r.status, 400);
});

test('re-split moves only uncalled numbers, equally, and tells each person once', async () => {
  const list = (await upload({ name: 'Resplit me', agent_ids: [h.ids.t1], rows: rows(10) })).data.id;
  const leads = h.db.all('SELECT id FROM leads WHERE call_list_id = ? ORDER BY id', list).map((l: any) => l.id);
  // t1 has already called three of them.
  for (const id of leads.slice(0, 3)) h.db.run(`INSERT INTO activities(lead_id, type, title, actor_id) VALUES(?, 'call', 'Call: Busy', ?)`, id, h.ids.t1);
  const people = (await h.call('GET', `/api/dialer/lists/${list}/people`, 'admin')).data.people;
  assert.deepEqual(people.map((p: any) => [p.name, p.total, p.uncalled]), [['t1', 10, 7]]);
  const before = { t1: notes('t1'), t2: notes('t2'), t3: notes('t3') };
  const r = await h.call('POST', `/api/dialer/lists/${list}/resplit`, 'admin', { from_ids: [h.ids.t1], to_ids: [h.ids.t2, h.ids.t3] });
  assert.equal(r.status, 200);
  assert.equal(r.data.moved, 7);
  const by = owners(list);
  assert.equal(by[h.ids.t1], 3, 'called numbers stay with their caller');
  assert.deepEqual([by[h.ids.t2], by[h.ids.t3]].sort(), [3, 4]);
  for (const id of leads.slice(0, 3)) assert.equal(h.db.get('SELECT owner_id FROM leads WHERE id = ?', id).owner_id, h.ids.t1);
  assert.equal(notes('t2') - before.t2, 1);
  assert.equal(notes('t3') - before.t3, 1);
  assert.equal(notes('t1') - before.t1, 1, 'the person who lost numbers is told once too');
});

test('re-split by count moves only the numbers asked for and leaves the rest', async () => {
  const list = (await upload({ name: 'By count', agent_ids: [h.ids.t1, h.ids.t2], rows: rows(20) })).data.id;
  const r = await h.call('POST', `/api/dialer/lists/${list}/resplit`, 'admin', {
    from_ids: [h.ids.t1, h.ids.t2], to_ids: [h.ids.t3, h.ids.t4], mode: 'count', counts: { [h.ids.t3]: 5, [h.ids.t4]: 2 },
  });
  assert.equal(r.data.moved, 7);
  assert.equal(r.data.left, 13);
  const by = owners(list);
  assert.equal(by[h.ids.t3], 5);
  assert.equal(by[h.ids.t4], 2);
  assert.equal(by[h.ids.t1] + by[h.ids.t2], 13);
});

test('re-split needs the reassign permission, and a team manager moves numbers only within their team', async () => {
  const list = (await upload({ name: 'Team only', agent_ids: [h.ids.t1], rows: rows(4) })).data.id;
  assert.equal((await h.call('POST', `/api/dialer/lists/${list}/resplit`, 't1', { from_ids: [h.ids.t1], to_ids: [h.ids.t2] })).status, 403);
  h.db.run('UPDATE users SET manager_id = ? WHERE id IN (?, ?)', h.ids.lead, h.ids.t1, h.ids.t2);
  const outside = await h.call('POST', `/api/dialer/lists/${list}/resplit`, 'lead', { from_ids: [h.ids.t1], to_ids: [h.ids.t3] });
  assert.equal(outside.status, 400, 't3 is not in their team');
  const inside = await h.call('POST', `/api/dialer/lists/${list}/resplit`, 'lead', { from_ids: [h.ids.t1], to_ids: [h.ids.t2] });
  assert.equal(inside.status, 200);
  assert.equal(inside.data.moved, 4);
  h.db.run('UPDATE users SET manager_id = NULL WHERE id IN (?, ?)', h.ids.t1, h.ids.t2);
});
