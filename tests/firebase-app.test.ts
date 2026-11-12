import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-fcmapp-'));
Object.assign(process.env, { ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local' });

const file = (pkg: string) => ({
  project_info: { project_number: '123456789012', project_id: 'archstone-crm' },
  client: [{
    client_info: { mobilesdk_app_id: '1:123456789012:android:abc123def456', android_client_info: { package_name: pkg } },
    api_key: [{ current_key: 'AIzaTestKey' }],
  }],
});

test('google-services.json is read for this app, and can be replaced and removed', async () => {
  const { parseGoogleServices, saveFcmClient, fcmClient, clearFcmClient } = await import('../server/services/fcm.ts');
  assert.throws(() => parseGoogleServices({}), /not a google-services/);
  assert.throws(() => parseGoogleServices(file('com.other.app')), /package name/);
  const client = parseGoogleServices(file('com.archstone.connect'));
  assert.deepEqual(client, { project_id: 'archstone-crm', sender_id: '123456789012', app_id: '1:123456789012:android:abc123def456', api_key: 'AIzaTestKey' });
  saveFcmClient(client);
  assert.equal(fcmClient()?.project_id, 'archstone-crm');
  saveFcmClient({ ...client, project_id: 'archstone-new' });
  assert.equal(fcmClient()?.project_id, 'archstone-new');
  clearFcmClient();
  assert.equal(fcmClient(), null);
});
