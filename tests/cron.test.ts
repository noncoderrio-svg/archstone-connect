import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-cron-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  CRON_TOKEN: 'a-long-secret-cron-token-for-tests',
});

let base = '';
let close: () => void;
before(async () => {
  const { createApp } = await import('../server/app.ts');
  const { ensureBaseData } = await import('../server/seed.ts');
  await ensureBaseData();
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  close = () => server.close();
});
after(() => close?.());

test('the cron link runs scheduled jobs only with the right token', async () => {
  assert.equal((await fetch(`${base}/cron/tick`)).status, 404);
  assert.equal((await fetch(`${base}/cron/tick?token=wrong`)).status, 404);
  const res = await fetch(`${base}/cron/tick?token=a-long-secret-cron-token-for-tests`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});
