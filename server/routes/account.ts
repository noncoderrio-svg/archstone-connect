import { randomBytes, createHash } from 'node:crypto';
import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { HttpError, requirePermission, verifyPassword } from '../auth.ts';
import { config, googleReady } from '../config.ts';
import { get, run } from '../db.ts';
import { alertPrefs, quietStatus, saveAlertPrefs } from '../services/alerts.ts';
import { audit, notify, visibleLead, workableLead } from '../services/core.ts';
import { deviceCount, fcmClient, fcmReady, removeDevice, saveDevice } from '../services/fcm.ts';
import { authUrl, disconnect, finishConnect, isConnected, saveContact } from '../services/google.ts';
import { hasSubscription, pushToUser, removeSubscription, saveSubscription, vapidPublicKey } from '../services/push.ts';
import { base32Encode, decryptText, encryptText, matchTotp } from '../services/secrets.ts';
import { dial, fetchRecording } from '../services/telephony.ts';
import { logActivity } from '../services/leads.ts';

export const account = Router();
export const publicGoogle = Router();

const hashCode = (code: string) => createHash('sha256').update(code.toLowerCase()).digest('hex');

account.get('/account', (req, res) => {
  const u = get<any>('SELECT totp_enabled, google_email, recovery_codes FROM users WHERE id = ?', req.user.id)!;
  res.json({
    two_factor: Boolean(u.totp_enabled),
    recovery_left: JSON.parse(u.recovery_codes).length,
    google_available: googleReady(),
    google_connected: isConnected(req.user.id),
    google_email: u.google_email,
    push_key: vapidPublicKey(),
    push_enabled: hasSubscription(req.user.id),
    alert_prefs: alertPrefs(req.user.id),
    has_phone: Boolean(get<any>('SELECT phone FROM users WHERE id = ?', req.user.id)?.phone),
    app_push_ready: fcmReady(),
    app_devices: deviceCount(req.user.id),
    quiet: quietStatus(),
  });
});

// ---------- Two-factor login ----------
account.post('/account/2fa/start', async (req, res) => {
  const secret = base32Encode(randomBytes(20));
  run('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', encryptText(secret), req.user.id);
  const uri = `otpauth://totp/${encodeURIComponent(`Archstone Connect:${req.user.email}`)}?secret=${secret}&issuer=${encodeURIComponent('Archstone Connect')}`;
  res.json({ secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
});

account.post('/account/2fa/enable', (req, res) => {
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.') }).parse(req.body);
  const u = get<any>('SELECT totp_secret FROM users WHERE id = ?', req.user.id)!;
  if (!u.totp_secret) throw new HttpError(400, 'Start set-up first.');
  const step = matchTotp(decryptText(u.totp_secret), code, 0);
  if (step === null) throw new HttpError(400, 'That code is not correct. Check the time on your phone.');
  const codes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
  run(
    'UPDATE users SET totp_enabled = 1, totp_last_step = ?, recovery_codes = ? WHERE id = ?',
    step, JSON.stringify(codes.map(hashCode)), req.user.id,
  );
  audit(req, 'auth.2fa_enabled', 'user', req.user.id);
  res.json({ recovery_codes: codes });
});

account.post('/account/2fa/disable', async (req, res) => {
  const { password } = z.object({ password: z.string() }).parse(req.body);
  const u = get<any>('SELECT password_hash FROM users WHERE id = ?', req.user.id)!;
  if (!(await verifyPassword(password, u.password_hash))) throw new HttpError(400, 'Your password is not correct.');
  run(`UPDATE users SET totp_enabled = 0, totp_secret = '', recovery_codes = '[]' WHERE id = ?`, req.user.id);
  audit(req, 'auth.2fa_disabled', 'user', req.user.id);
  res.json({ ok: true });
});

account.post('/users/:id/reset-2fa', requirePermission('user.manage'), (req, res) => {
  const id = Number(req.params.id);
  run(`UPDATE users SET totp_enabled = 0, totp_secret = '', recovery_codes = '[]' WHERE id = ?`, id);
  audit(req, 'auth.2fa_reset', 'user', id);
  res.json({ ok: true });
});

// ---------- Phone notifications ----------
account.post('/account/push', (req, res) => {
  const sub = z.object({
    endpoint: z.url().startsWith('https://'),
    keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  }).parse(req.body);
  saveSubscription(req.user.id, sub);
  res.status(201).json({ ok: true });
});

account.post('/account/push/remove', (req, res) => {
  const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body);
  removeSubscription(req.user.id, endpoint);
  res.json({ ok: true });
});

account.put('/account/alerts', (req, res) => {
  const choices = z.object({ new_lead: z.boolean(), followup: z.boolean(), overdue: z.boolean(), team: z.boolean() }).partial();
  saveAlertPrefs(req.user.id, z.object({ push: choices, whatsapp: choices }).parse(req.body));
  res.json({ ok: true });
});

/** Ignores quiet hours, and reports what really happened to the phone alert. */
account.post('/account/alerts/test', async (req, res) => {
  notify(req.user.id, 'Test alert', 'Your alerts are working.', '/followups', { kind: 'new_lead', push: false });
  const phone = await pushToUser(req.user.id, 'Test alert', 'Your alerts are working.', '/followups', 'new_lead');
  res.json({ ok: true, phone, firebase_ready: fcmReady() });
});

const deviceToken = z.object({ token: z.string().min(20).max(4096) });

/** The Android app's public Firebase settings. These are not secret: every Android app carries them. */
account.get('/account/app-firebase', (_req, res) => {
  res.json({ config: fcmClient() });
});

account.post('/account/device', (req, res) => {
  saveDevice(req.user.id, deviceToken.parse(req.body).token);
  res.status(201).json({ ok: true });
});

account.post('/account/device/remove', (req, res) => {
  removeDevice(req.user.id, deviceToken.parse(req.body).token);
  res.json({ ok: true });
});

// ---------- Calling ----------
account.post('/leads/:id/dial', requirePermission('call.office'), async (req, res) => {
  const lead = workableLead(req.user, Number(req.params.id));
  const result = await dial(lead, req.user);
  audit(req, 'call.dial', 'lead', lead.id);
  res.status(201).json(result);
});

account.get('/calls/:id/recording', async (req, res) => {
  const call = get<any>('SELECT * FROM calls WHERE id = ?', Number(req.params.id));
  if (!call?.recording_url) throw new HttpError(404, 'No recording for this call.');
  workableLead(req.user, call.lead_id);
  audit(req, 'call.recording_played', 'call', call.id);
  const file = await fetchRecording(call.recording_url);
  res.setHeader('Content-Type', file.type);
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.body);
});

// ---------- Google ----------
account.get('/google/connect', (req, res) => {
  if (!googleReady()) throw new HttpError(503, 'Google is not set up on the server yet.');
  res.json({ url: authUrl(req.user.id) });
});

account.post('/google/disconnect', (req, res) => {
  disconnect(req.user.id);
  audit(req, 'google.disconnect', 'user', req.user.id);
  res.json({ ok: true });
});

account.post('/leads/:id/google-contact', async (req, res) => {
  const lead = visibleLead(req.user, Number(req.params.id));
  if (req.user.role === 'marketing') throw new HttpError(403, 'Not available for your role.');
  await saveContact(req.user.id, lead);
  logActivity(lead.id, 'note', 'Saved to Google Contacts', '', req.user.id);
  audit(req, 'google.contact', 'lead', lead.id);
  res.json({ ok: true });
});

// Google returns here in a top-level redirect, so the session cookie is not sent
// (it is SameSite=Strict). The single-use state value identifies the user instead.
publicGoogle.get('/google/callback', async (req, res) => {
  const { state, code } = z.object({ state: z.string(), code: z.string() }).parse(req.query);
  await finishConnect(state, code);
  res.redirect(`${config.appUrl}/account?google=connected`);
});
