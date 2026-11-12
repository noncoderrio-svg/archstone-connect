import { lazy, type ComponentType } from 'react';

const KEY = 'archstone-reloaded-after-update';

/** A page left open across an update asks for files that no longer exist, so it reloads once. */
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() => load().catch((error) => {
    if (sessionStorage.getItem(KEY)) throw error; // Already tried, so this is a real failure.
    sessionStorage.setItem(KEY, '1');
    location.reload();
    return new Promise<{ default: T }>(() => undefined);
  }));
}

/** Allows the reload again later, once this version has loaded properly. */
export const pageLoadSettled = () => setTimeout(() => sessionStorage.removeItem(KEY), 30000);
