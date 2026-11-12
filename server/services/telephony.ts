import { randomBytes } from 'node:crypto';
import { HttpError, type SessionUser } from '../auth.ts';
import { config, telephonyLive } from '../config.ts';
import { get, getSetting, run } from '../db.ts';
import { broadcast } from './core.ts';
import { logActivity, markResponded, rescore } from './leads.ts';

const basicAuth = () => `Basic ${Buffer.from(`${config.exotel.apiKey}:${config.exotel.apiToken}`).toString('base64')}`;
const exotelUrl = (path: string) => `https://${config.exotel.subdomain}/v1/Accounts/${config.exotel.sid}${path}`;

const TERMINAL = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];
const label = (seconds: number) => `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

/** Records the outcome of a call, whichever route it arrives by. Safe to call twice. */
export function finishCall(providerId: string, status: string, durationSeconds: number | null, recordingUrl: string) {
  const call = get<any>('SELECT * FROM calls WHERE provider_id = ?', providerId);
  if (!call || TERMINAL.includes(call.status)) return false;
  const normalized = status.toLowerCase().replace(/_/g, '-');
  run(
    'UPDATE calls SET status = ?, duration_seconds = ?, recording_url = ? WHERE id = ?',
    normalized, durationSeconds, recordingUrl, call.id,
  );
  const spoke = normalized === 'completed' && Boolean(durationSeconds);
  logActivity(call.lead_id, 'call', spoke ? `Call: Connected, ${label(durationSeconds!)}` : `Call: ${normalized}`, '', call.user_id);
  if (spoke) markResponded(call.lead_id);
  rescore(call.lead_id);
  broadcast('leads');
  return true;
}

/** Rings the staff member's phone, then connects them to the customer. */
export async function dial(lead: any, user: SessionUser) {
  if (lead.do_not_contact) throw new HttpError(422, 'This contact is marked do not contact.');
  if (!user.phone) throw new HttpError(422, 'Add your mobile number to your Team profile first.');

  if (!telephonyLive()) {
    const providerId = `demo.${randomBytes(9).toString('hex')}`;
    const { id } = run('INSERT INTO calls(lead_id, user_id, provider_id, simulated) VALUES(?, ?, ?, 1)', lead.id, user.id, providerId);
    setTimeout(() => finishCall(providerId, 'completed', 95, ''), 1500).unref();
    return { id, simulated: true };
  }

  const form = new URLSearchParams({
    From: user.phone,
    To: lead.phone,
    CallerId: config.exotel.callerId,
    Record: getSetting('record_calls', false) ? 'true' : 'false',
    StatusCallback: `${config.appUrl}/webhooks/telephony/${config.exotel.webhookToken}`,
    StatusCallbackEvents: 'terminal',
    StatusCallbackContentType: 'application/json',
  });
  const res = await fetch(exotelUrl('/Calls/connect.json'), {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, data?.RestException?.Message ?? 'The phone service could not place this call.');
  const { id } = run('INSERT INTO calls(lead_id, user_id, provider_id) VALUES(?, ?, ?)', lead.id, user.id, data.Call?.Sid);
  return { id, simulated: false };
}

export async function fetchRecording(url: string) {
  const res = await fetch(url, { headers: { Authorization: basicAuth() } });
  if (!res.ok) throw new HttpError(502, 'The recording is not available.');
  return { type: res.headers.get('content-type') ?? 'audio/mpeg', body: Buffer.from(await res.arrayBuffer()) };
}
