import * as webpush from 'web-push';
import { config } from '../config.ts';
import { all, get, getSetting, run, setSetting } from '../db.ts';
import { pushToDevices } from './fcm.ts';
import { decryptText, encryptText } from './secrets.ts';

type PhoneResult = Awaited<ReturnType<typeof pushToDevices>>;

/** Browser push keys, created once and stored encrypted. */
export function vapidPublicKey() {
  let keys = getSetting<{ publicKey: string; privateKey: string } | null>('vapid', null);
  if (!keys) {
    const generated = webpush.generateVAPIDKeys();
    keys = { publicKey: generated.publicKey, privateKey: encryptText(generated.privateKey) };
    setSetting('vapid', keys);
  }
  webpush.setVapidDetails(`mailto:${config.initialAdminEmail || 'admin@example.com'}`, keys.publicKey, decryptText(keys.privateKey));
  return keys.publicKey;
}

export function saveSubscription(userId: number, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  run(
    `INSERT INTO push_subscriptions(endpoint, user_id, keys) VALUES(?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`,
    sub.endpoint, userId, JSON.stringify(sub.keys),
  );
}

export const removeSubscription = (userId: number, endpoint: string) =>
  run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, userId);

export const hasSubscription = (userId: number) => Boolean(get('SELECT 1 AS x FROM push_subscriptions WHERE user_id = ? LIMIT 1', userId));

/** Best effort: a failed push must never stop the action that caused it. */
export async function pushToUser(userId: number, title: string, body: string, link: string, kind = '') {
  const subs = all<any>('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?', userId);
  // Titles only: lock screens are not a place for customer details.
  const safeBody = body ? 'Open Archstone Connect for details.' : '';
  const payload = JSON.stringify({ title, body: safeBody, link });
  if (subs.length) vapidPublicKey();
  const web = { devices: subs.length, sent: 0, error: '' };
  const [phone] = await Promise.allSettled([
    pushToDevices(userId, title, safeBody, link, kind),
    ...subs.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, payload).then(
        () => { web.sent += 1; },
        (e: { statusCode?: number; body?: string; message?: string }) => {
          if (e.statusCode === 404 || e.statusCode === 410) run('DELETE FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
          web.error = `${e.statusCode ?? ''} ${e.body || e.message || ''}`.trim();
        },
      ),
    ),
  ]);
  const phoneResult = phone.status === 'fulfilled' ? phone.value as PhoneResult : { sent: 0, failed: 1, devices: 1, error: String(phone.reason?.message ?? phone.reason) };
  // `web` covers the installed web app and browsers, which do not go through Firebase.
  return { ...phoneResult, web };
}