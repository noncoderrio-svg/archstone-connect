import { createPrivateKey, createSign } from 'node:crypto';
import { all, getSetting, nowIso, run, setSetting } from '../db.ts';
import { decryptText, encryptText } from './secrets.ts';

/** Sends Android app notifications through Firebase Cloud Messaging. */

interface ServiceAccount { project_id: string; client_email: string; private_key: string }

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
let cached: { email: string; token: string; expires: number } | null = null;

export const fcmReady = () => Boolean(getSetting('fcm_account', ''));

export function fcmProject() {
  return account()?.project_id ?? '';
}

function account(): ServiceAccount | null {
  const stored = getSetting('fcm_account', '');
  if (!stored) return null;
  try {
    return JSON.parse(decryptText(stored));
  } catch {
    return null;
  }
}

/** The key is checked here so a wrong file is refused at upload, not at the first alert. */
export function saveFcmAccount(input: ServiceAccount) {
  try {
    createPrivateKey(input.private_key);
  } catch {
    throw new Error('This file has no valid private key.');
  }
  const { project_id, client_email, private_key } = input;
  setSetting('fcm_account', encryptText(JSON.stringify({ project_id, client_email, private_key })));
  cached = null;
}

export function clearFcmAccount() {
  setSetting('fcm_account', '');
  cached = null;
}

export function saveDevice(userId: number, token: string) {
  run(
    `INSERT INTO device_tokens(token, user_id) VALUES(?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id`,
    token, userId,
  );
}

export const removeDevice = (userId: number, token: string) =>
  run('DELETE FROM device_tokens WHERE token = ? AND user_id = ?', token, userId);

export const deviceCount = (userId: number) =>
  all('SELECT token FROM device_tokens WHERE user_id = ?', userId).length;

/** Who can be reached, so an administrator can see a phone that never registered. */
export const phonesByPerson = () => all<{ name: string; phones: number; web_apps: number }>(
  `SELECT u.name,
     (SELECT COUNT(*) FROM device_tokens t WHERE t.user_id = u.id) AS phones,
     (SELECT COUNT(*) FROM push_subscriptions s WHERE s.user_id = u.id) AS web_apps
   FROM users u WHERE u.status = 'active' ORDER BY phones + web_apps DESC, u.name`,
);

/** Alerts are sent in the background, so the latest outcome is kept for Settings to show. */
function remember(result: { sent: number; failed: number; error: string }) {
  if (result.error) console.error('Phone alert failed:', result.error);
  setSetting('fcm_last', { at: nowIso(), sent: result.sent, failed: result.failed, error: result.error });
}

export const lastPhoneSend = () => getSetting<{ at: string; sent: number; failed: number; error: string } | null>('fcm_last', null);

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

async function accessToken(a: ServiceAccount) {
  if (cached && cached.email === a.client_email && cached.expires > Date.now()) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64url(JSON.stringify({ iss: a.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })),
  ].join('.');
  const signature = createSign('RSA-SHA256').update(unsigned).sign(a.private_key);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${base64url(signature)}`,
    }),
  });
  if (!res.ok) throw new Error(`Google refused the Firebase key (${res.status}).`);
  const data = await res.json() as { access_token: string; expires_in: number };
  // Renew a minute early so a token never expires in the middle of a send.
  cached = { email: a.client_email, token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

/** Returns how many of the user's phones accepted the alert. */
export async function pushToDevices(userId: number, title: string, body: string, link: string, kind = '') {
  const a = account();
  const devices = all<{ token: string }>('SELECT token FROM device_tokens WHERE user_id = ?', userId);
  const result = { sent: 0, failed: 0, devices: devices.length, error: '' };
  if (!a || !devices.length) return result;

  let bearer = '';
  try {
    bearer = await accessToken(a);
  } catch (e) {
    remember({ ...result, failed: devices.length, error: (e as Error).message });
    throw e;
  }
  await Promise.all(devices.map(async ({ token }) => {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      // Data only, so the app builds every alert itself and a tap can open the right screen.
      body: JSON.stringify({ message: { token, data: { title, body, link, kind }, android: { priority: 'HIGH' } } }),
    });
    if (res.ok) {
      result.sent += 1;
      return;
    }
    result.failed += 1;
    const detail = await res.text();
    // The app was removed or its token was replaced, so this phone can no longer be reached.
    if (res.status === 404 || detail.includes('UNREGISTERED')) run('DELETE FROM device_tokens WHERE token = ?', token);
    else result.error = `Firebase answered ${res.status}.`;
  }));
  remember(result);
  return result;
}

/** The Android app's public Firebase settings, taken from google-services.json, so the app can switch project without a rebuild. */
export interface FcmClient { project_id: string; sender_id: string; app_id: string; api_key: string }

export const ANDROID_PACKAGE = 'com.archstone.connect';

export function fcmClient(): FcmClient | null {
  const stored = getSetting<FcmClient | ''>('fcm_client', '');
  return stored || null;
}

/** Reads the app entry for this app's package from a google-services.json file. */
export function parseGoogleServices(input: any): FcmClient {
  const project_id = String(input?.project_info?.project_id ?? '');
  const sender_id = String(input?.project_info?.project_number ?? '');
  if (!project_id || !sender_id || !Array.isArray(input?.client)) throw new Error('That is not a google-services.json file.');
  const client = input.client.find((c: any) => c?.client_info?.android_client_info?.package_name === ANDROID_PACKAGE);
  if (!client) throw new Error(`This file has no Android app with the package name ${ANDROID_PACKAGE}. Add one in Firebase and download the file again.`);
  const app_id = String(client.client_info?.mobilesdk_app_id ?? '');
  const api_key = String(client.api_key?.[0]?.current_key ?? '');
  if (!/^\d+:\d+:android:[0-9a-f]+$/.test(app_id) || !api_key) throw new Error('This file is missing the app ID or API key.');
  return { project_id, sender_id, app_id, api_key };
}

export function saveFcmClient(client: FcmClient) {
  setSetting('fcm_client', client);
}

export function clearFcmClient() {
  setSetting('fcm_client', '');
}
