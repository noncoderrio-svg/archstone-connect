import { useEffect, useState } from 'react';

/**
 * "Install app" support. The site is a full web app (manifest + service worker), so phones can
 * install it from the browser with no APK. Chrome fires `beforeinstallprompt` once, early, so it is
 * captured at startup and kept until a button asks for it.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as InstallPromptEvent;
  notify();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  notify();
});

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
/** iPhone and iPad Safari have no install prompt; people use Share, then Add to Home Screen. */
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const toBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

export const webPushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Asks for permission and registers this device for notifications. Throws a message people can act on. */
export async function enableWebPush(publicKey: string, save: (sub: PushSubscriptionJSON) => Promise<unknown>) {
  if (!webPushSupported()) throw new Error('This browser cannot show notifications. On iPhone, add the app to your Home Screen first.');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked. Allow them for this site in your phone or browser settings, then try again.');
  const registration = await navigator.serviceWorker.ready;
  const sub = (await registration.pushManager.getSubscription())
    ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) });
  await save(sub.toJSON());
}

/** True when this device can get notifications but has not been registered. */
export async function webPushMissing() {
  if (!webPushSupported() || Notification.permission === 'denied') return false;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;
  return !(await registration.pushManager.getSubscription()) || Notification.permission !== 'granted';
}

export function useInstallApp() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const fn = () => rerender((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  const installed = isStandalone();
  return {
    /** Already running as an installed app. */
    installed,
    /** The browser can show its own install prompt right now. */
    canPrompt: !installed && deferred !== null,
    /** iPhone/iPad, where install is manual. */
    iosHint: !installed && deferred === null && isIos(),
    install: async () => {
      if (!deferred) return false;
      const event = deferred;
      deferred = null;
      await event.prompt();
      const { outcome } = await event.userChoice;
      notify();
      return outcome === 'accepted';
    },
  };
}
