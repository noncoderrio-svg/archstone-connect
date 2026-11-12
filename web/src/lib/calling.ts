import { api } from './api.ts';

const KEY = 'archstone-call-started';

/** Marks the call as started, then hands over to the phone's dialer. */
export async function placeCall(leadId: number, phone: string) {
  await api.post(`/dialer/start/${leadId}`);
  sessionStorage.setItem(KEY, String(Date.now()));
  window.location.href = `tel:+${phone.replace(/\D/g, '')}`;
}

/** Roughly how long the person was away on the call. Capped at two hours. */
export function callSeconds() {
  const started = Number(sessionStorage.getItem(KEY));
  sessionStorage.removeItem(KEY);
  return started ? Math.min(7200, Math.round((Date.now() - started) / 1000)) : undefined;
}

export const smsLink = (phone: string, name: string) => `sms:+${phone.replace(/\D/g, '')}?body=${encodeURIComponent(`Hello ${name.split(' ')[0]}, this is Archstone.`)}`;
export const emailLink = (email: string) => `mailto:${email}?subject=${encodeURIComponent('Your enquiry with Archstone')}`;
