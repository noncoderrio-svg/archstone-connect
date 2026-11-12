import { useEffect, useState } from 'react';
import { ApiError, api } from './api.ts';

const KEY = 'archstone-offline-queue';
interface Queued { path: string; body: unknown }

const read = (): Queued[] => JSON.parse(localStorage.getItem(KEY) ?? '[]');
const write = (items: Queued[]) => {
  localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new Event('offline-queue'));
};

/**
 * Posts now, or saves the action to send later if there is no connection.
 * Only use for actions safe to replay, such as call logs and notes.
 */
export async function postOrQueue(path: string, body: unknown): Promise<'sent' | 'queued'> {
  try {
    await api.post(path, body);
    return 'sent';
  } catch (e) {
    if (e instanceof ApiError) throw e; // The server answered, so this is a real refusal.
    write([...read(), { path, body }]);
    return 'queued';
  }
}

export async function flushQueue() {
  const items = read();
  const remaining: Queued[] = [];
  for (const item of items) {
    try {
      await api.post(item.path, item.body);
    } catch (e) {
      if (!(e instanceof ApiError)) remaining.push(item); // Still offline. Refused items are dropped.
    }
  }
  if (items.length) write(remaining);
}

export function useConnection() {
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(() => read().length);
  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      setPending(read().length);
      if (navigator.onLine) void flushQueue();
    };
    const count = () => setPending(read().length);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    window.addEventListener('offline-queue', count);
    void flushQueue();
    // "Online" can be true while the server is unreachable, so keep retrying.
    const retry = setInterval(() => { if (read().length) void flushQueue(); }, 30000);
    return () => {
      clearInterval(retry);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      window.removeEventListener('offline-queue', count);
    };
  }, []);
  return { online, pending };
}

export async function clearOfflineData() {
  if ('caches' in window) await caches.delete('archstone-data-v1');
}
