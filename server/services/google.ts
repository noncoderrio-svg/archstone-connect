import { randomBytes } from 'node:crypto';
import { HttpError } from '../auth.ts';
import { config } from '../config.ts';
import { get, run } from '../db.ts';
import { decryptText, encryptText } from './secrets.ts';

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/drive.file',
];
const redirectUri = () => `${config.appUrl}/api/google/callback`;

// State links Google's redirect back to the person who started it. Single use, 10 minutes.
const pending = new Map<string, { userId: number; expires: number }>();

export function authUrl(userId: number) {
  const state = randomBytes(24).toString('hex');
  pending.set(state, { userId, expires: Date.now() + 600000 });
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES.join(' '),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...body }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, 'Google did not accept the sign-in.');
  return data;
}

const store = (userId: number, tokens: { access: string; refresh: string; expires: number }, email?: string) => {
  run('UPDATE users SET google_tokens = ? WHERE id = ?', encryptText(JSON.stringify(tokens)), userId);
  if (email !== undefined) run('UPDATE users SET google_email = ? WHERE id = ?', email, userId);
};

export async function finishConnect(state: string, code: string) {
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || entry.expires < Date.now()) throw new HttpError(400, 'This Google sign-in has expired. Please try again.');
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  const email = t.id_token ? JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()).email ?? '' : '';
  store(entry.userId, { access: t.access_token, refresh: t.refresh_token ?? '', expires: Date.now() + t.expires_in * 1000 }, email);
}

export const disconnect = (userId: number) => run(`UPDATE users SET google_tokens = '', google_email = '' WHERE id = ?`, userId);

export const isConnected = (userId: number) => Boolean(get<any>('SELECT google_tokens FROM users WHERE id = ?', userId)?.google_tokens);

async function accessToken(userId: number) {
  const row = get<any>('SELECT google_tokens FROM users WHERE id = ?', userId);
  if (!row?.google_tokens) throw new HttpError(409, 'Connect your Google account first, from My Account.');
  const tokens = JSON.parse(decryptText(row.google_tokens));
  if (tokens.expires > Date.now() + 60000) return tokens.access as string;
  if (!tokens.refresh) throw new HttpError(409, 'Please connect your Google account again.');
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh });
  store(userId, { access: t.access_token, refresh: tokens.refresh, expires: Date.now() + t.expires_in * 1000 });
  return t.access_token as string;
}

async function googleFetch(userId: number, url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken(userId)}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, data?.error?.message ?? 'Google could not complete this.');
  return data;
}

const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** Adds a site visit to the host's calendar. Customer details stay minimal. */
export async function addVisitToCalendar(userId: number, visit: { summary: string; location: string; startUtc: string }) {
  const start = new Date(`${visit.startUtc.replace(' ', 'T')}Z`);
  const end = new Date(start.getTime() + 3600000);
  const data = await googleFetch(userId, CALENDAR, {
    method: 'POST',
    body: JSON.stringify({
      summary: visit.summary,
      location: visit.location,
      start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' },
      end: { dateTime: end.toISOString(), timeZone: 'Asia/Kolkata' },
    }),
  });
  return data.id as string;
}

export const removeVisitFromCalendar = (userId: number, eventId: string) =>
  fetchDelete(userId, `${CALENDAR}/${encodeURIComponent(eventId)}`);

async function fetchDelete(userId: number, url: string) {
  await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${await accessToken(userId)}` } });
}

export const saveContact = (userId: number, lead: { name: string; phone: string; email: string }) =>
  googleFetch(userId, 'https://people.googleapis.com/v1/people:createContact', {
    method: 'POST',
    body: JSON.stringify({
      names: [{ unstructuredName: lead.name }],
      phoneNumbers: [{ value: lead.phone }],
      emailAddresses: lead.email ? [{ value: lead.email }] : [],
    }),
  });

export async function uploadToDrive(userId: number, file: { name: string; mime: string; data: Buffer }) {
  const boundary = `archstone${randomBytes(8).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ name: file.name })}\r\n--${boundary}\r\nContent-Type: ${file.mime}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const data = await googleFetch(userId, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return data.id as string;
}
