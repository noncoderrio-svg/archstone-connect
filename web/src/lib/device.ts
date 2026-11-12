import { api } from './api.ts';

/** The Android app adds these to the page. They do not exist in a normal browser. */
declare global {
  interface Window {
    ArchstoneApp?: { pushToken: () => string; takeLink: () => string; configureFirebase?: (json: string) => void };
    archstoneOpen?: (link: string) => void;
  }
}

export const inAndroidApp = () => Boolean(window.ArchstoneApp);

/** Only paths inside this system may be opened from a notification. */
export const safeLink = (link: string) => (/^\/(?!\/)/.test(link) ? link : '');

export const takeNotificationLink = () => safeLink(window.ArchstoneApp?.takeLink() ?? '');

/** Firebase can take a while to issue a token on first launch, or on a slow network. */
async function waitForToken() {
  for (let i = 0; i < 60; i += 1) {
    const token = window.ArchstoneApp?.pushToken();
    if (token) return token;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return '';
}

/** Hands the app the Firebase settings an admin uploaded, so the project can change without an app update. */
async function configureFirebase() {
  if (!window.ArchstoneApp?.configureFirebase) return; // Older app builds use the settings built into them.
  const { config } = await api.get('/account/app-firebase').catch(() => ({ config: null }));
  window.ArchstoneApp.configureFirebase(config ? JSON.stringify(config) : '');
}

/** Returns 'ok', or why this phone could not be registered. */
export async function registerDevice() {
  if (!inAndroidApp()) return 'not-app';
  await configureFirebase();
  const token = await waitForToken();
  if (!token) return 'no-token';
  return api.post('/account/device', { token }).then(() => 'ok', () => 'failed');
}

/** Also registers on return to the app, in case the first try had no signal. */
export function keepDeviceRegistered() {
  void registerDevice();
  const onShow = () => { if (document.visibilityState === 'visible') void registerDevice(); };
  document.addEventListener('visibilitychange', onShow);
  return () => document.removeEventListener('visibilitychange', onShow);
}

export async function unregisterDevice() {
  const token = window.ArchstoneApp?.pushToken();
  if (token) await api.post('/account/device/remove', { token }).catch(() => undefined);
}
