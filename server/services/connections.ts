import { HttpError } from '../auth.ts';
import { config, googleReady, telephonyLive, whatsappLive } from '../config.ts';
import { getSetting, setSetting } from '../db.ts';
import { emailLive } from './mail.ts';
import { decryptText, encryptText } from './secrets.ts';

/**
 * Keys an administrator manages from Settings. Saved values sit encrypted in the
 * database and are copied into `config`, so the rest of the app needs no changes
 * and a new key works straight away. A server environment value is the fallback.
 * Settings the app needs before it can start, such as APP_URL, stay on the server.
 */
interface Field {
  key: string;
  label: string;
  path: string;
  secret?: boolean;
  generate?: boolean;
  digits?: boolean;
  hint?: string;
  placeholder?: string;
  pattern?: RegExp;
  rule?: string;
}

const DIGITS = { pattern: /^\d+$/, rule: 'use digits only.' };
const HOST = { pattern: /^[a-z0-9.-]+$/i, rule: 'enter a server name, without https://.' };

const FIELDS: Field[] = [
  { key: 'wa_token', label: 'Access token', path: 'whatsapp.token', secret: true, hint: 'A permanent System User token. Numbers with no token of their own use this one.' },
  { key: 'wa_phone_id', label: 'Phone number ID', path: 'whatsapp.phoneNumberId', ...DIGITS },
  { key: 'wa_business_id', label: 'WhatsApp Business account ID', path: 'whatsapp.businessAccountId', ...DIGITS },
  { key: 'wa_display', label: 'Your WhatsApp number', path: 'whatsappDisplayNumber', digits: true, placeholder: '919876543210', hint: 'With country code. Used for hoarding QR codes.' },
  { key: 'meta_app_id', label: 'Meta app ID', path: 'metaAppId', ...DIGITS, hint: 'Needed to submit templates with an image, document or video.' },
  { key: 'meta_version', label: 'Meta API version', path: 'whatsapp.apiVersion', pattern: /^v\d+\.\d+$/, rule: 'use the form v21.0.' },
  { key: 'wa_verify', label: 'Verify token', path: 'whatsapp.verifyToken', secret: true, generate: true, hint: 'Enter the same token in Meta when you add the webhook address.' },
  { key: 'meta_secret', label: 'Meta app secret', path: 'whatsapp.appSecret', secret: true, hint: 'Used to confirm that replies and leads really came from Meta.' },
  { key: 'website_key', label: 'Website API key', path: 'websiteApiKey', secret: true, generate: true, hint: 'Your website sends this in the X-Api-Key header, from its server.' },
  { key: 'meta_page_token', label: 'Page access token', path: 'metaPageToken', secret: true, hint: 'Only for a page not added in Lead Routing. Pages added there have their own token.' },
  { key: 'portal_key', label: 'Portal API key', path: 'portalApiKey', secret: true, generate: true, hint: 'Portals send this in the X-Api-Key header. The address can end in 99acres, magicbricks or housing.' },
  { key: 'exotel_sid', label: 'Account SID', path: 'exotel.sid' },
  { key: 'exotel_key', label: 'API key', path: 'exotel.apiKey', secret: true },
  { key: 'exotel_token', label: 'API token', path: 'exotel.apiToken', secret: true },
  { key: 'exotel_host', label: 'API server', path: 'exotel.subdomain', ...HOST },
  { key: 'exotel_caller', label: 'Office number (caller ID)', path: 'exotel.callerId', pattern: /^\+?\d+$/, rule: 'use digits only.' },
  { key: 'exotel_webhook', label: 'Call update token', path: 'exotel.webhookToken', secret: true, generate: true, hint: 'Part of the private address Exotel uses to report finished calls.' },
  { key: 'google_id', label: 'Client ID', path: 'google.clientId' },
  { key: 'google_secret', label: 'Client secret', path: 'google.clientSecret', secret: true },
  { key: 'gemini_key', label: 'API key', path: 'gemini.key', secret: true, hint: 'From Google AI Studio.' },
  { key: 'gemini_model', label: 'Model', path: 'gemini.model', pattern: /^[\w.-]+$/, rule: 'use a model name such as gemini-3.8-flash.', hint: 'Leave empty to use gemini-3.8-flash.' },
  { key: 'smtp_host', label: 'Mail server', path: 'smtp.host', placeholder: 'smtp.gmail.com', ...HOST },
  { key: 'smtp_port', label: 'Port', path: 'smtp.port', pattern: /^\d{1,5}$/, rule: 'use a number such as 587.' },
  { key: 'smtp_user', label: 'Username', path: 'smtp.user' },
  { key: 'smtp_pass', label: 'Password', path: 'smtp.pass', secret: true, hint: 'For Gmail, use an app password.' },
  { key: 'smtp_from', label: 'Send from', path: 'smtp.from', placeholder: 'Archstone <crm@yourcompany.com>' },
  { key: 'google_ads_key', label: 'Webhook key', path: 'googleAdsKey', secret: true, generate: true, hint: 'Enter the same key in your Google Ads lead form.' },
];

const fieldBy = new Map(FIELDS.map((f) => [f.key, f]));
const KEY = 'connections';

const read = (path: string) => String(path.split('.').reduce((box: any, part) => box[part], config));
function write(path: string, value: string) {
  const parts = path.split('.');
  const last = parts.pop()!;
  const box: any = parts.reduce((b: any, part) => b[part], config);
  box[last] = typeof box[last] === 'number' ? Number(value) : value;
}

// What the server started with, so removing a saved value goes back to it.
const fromServer = Object.fromEntries(FIELDS.map((f) => [f.key, read(f.path)]));

function saved(): Record<string, string> {
  const blob = getSetting<string>(KEY, '');
  if (!blob) return {};
  try {
    return JSON.parse(decryptText(blob));
  } catch {
    // Happens if the encryption key changed. The app must still start.
    console.error('Saved connection keys could not be read, so server values are in use.');
    return {};
  }
}

/** Runs at start-up and after every save. */
export function applyConnections() {
  const values = saved();
  for (const f of FIELDS) write(f.path, values[f.key] ?? fromServer[f.key]);
}

const CONNECTIONS = [
  {
    key: 'whatsapp', name: 'WhatsApp Cloud API', fields: ['wa_token', 'wa_phone_id', 'wa_business_id', 'wa_display', 'meta_app_id', 'meta_version'],
    connected: whatsappLive, detail: () => (whatsappLive() ? 'Sending real messages' : 'Messages stay simulated until this is connected'),
  },
  {
    key: 'webhook', name: 'WhatsApp replies webhook', fields: ['wa_verify', 'meta_secret'], address: '/webhooks/whatsapp',
    connected: () => Boolean(config.whatsapp.verifyToken && config.whatsapp.appSecret),
  },
  {
    key: 'website', name: 'Website enquiry form', fields: ['website_key'], address: '/webhooks/website',
    connected: () => Boolean(config.websiteApiKey),
  },
  {
    key: 'meta', name: 'Meta Lead Ads', fields: ['meta_page_token', 'meta_secret'], address: '/webhooks/meta-leads',
    connected: () => Boolean(config.metaPageToken && config.whatsapp.appSecret),
  },
  {
    key: 'portal', name: 'Property portals', fields: ['portal_key'], address: '/webhooks/portal/99acres',
    connected: () => Boolean(config.portalApiKey),
  },
  {
    key: 'telephony', name: 'Exotel click-to-call', fields: ['exotel_sid', 'exotel_key', 'exotel_token', 'exotel_host', 'exotel_caller', 'exotel_webhook'],
    connected: telephonyLive, detail: () => (telephonyLive() ? 'Calls connect through your office number' : 'Calls stay simulated until this is connected'),
  },
  {
    key: 'google', name: 'Google Calendar, Contacts and Drive', fields: ['google_id', 'google_secret'], address: '/api/google/callback', addressLabel: 'Redirect URL',
    connected: googleReady,
  },
  {
    key: 'gemini', name: 'Gemini AI', fields: ['gemini_key', 'gemini_model'],
    connected: () => Boolean(config.gemini.key), detail: () => (config.gemini.key ? config.gemini.model : 'Add a key to turn on AI drafts'),
  },
  {
    key: 'email', name: 'Email (SMTP)', fields: ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from'],
    connected: emailLive, detail: () => (emailLive() ? config.smtp.host : 'Add mail settings to send reports and alerts'),
  },
  {
    key: 'google_ads', name: 'Google Ads lead forms', fields: ['google_ads_key'], address: '/webhooks/google-ads',
    connected: () => Boolean(config.googleAdsKey),
  },
];

/** Secret values never leave the server. The screen only learns whether one is set. */
function fieldStatus(key: string, values: Record<string, string>) {
  const f = fieldBy.get(key)!;
  const { label, secret, generate, hint, placeholder } = f;
  const common = { key, label, secret: Boolean(secret), generate: Boolean(generate), hint, placeholder };
  if (!secret) return { ...common, value: read(f.path) };
  return { ...common, is_set: Boolean(read(f.path)), removable: key in values, on_server: !(key in values) && Boolean(fromServer[key]) };
}

/** Everyone who opens Settings sees the status. Only an administrator gets the form. */
export function connectionList(canEdit: boolean) {
  const values = canEdit ? saved() : {};
  return CONNECTIONS.map((c) => {
    const address = c.address ? `${config.appUrl}${c.address}` : '';
    return {
      key: c.key,
      name: c.name,
      connected: c.connected(),
      detail: c.detail?.() ?? (c.addressLabel ? `${c.addressLabel}: ${address}` : address),
      ...(canEdit ? { address, address_label: c.addressLabel ?? 'Address', fields: c.fields.map((f) => fieldStatus(f, values)) } : {}),
    };
  });
}

/**
 * A blank secret keeps the current one, because the form cannot show it.
 * A blank ordinary value, or a secret listed in `clear`, goes back to the server value.
 * Returns the labels that changed, never the values.
 */
export function saveConnection(key: string, input: Record<string, string>, clear: string[] = []) {
  const connection = CONNECTIONS.find((c) => c.key === key);
  if (!connection) throw new HttpError(404, 'Unknown connection.');
  const values = saved();
  const changed: string[] = [];
  for (const name of connection.fields) {
    const f = fieldBy.get(name)!;
    const before = values[name];
    const text = (f.digits ? (input[name] ?? '').replace(/\D/g, '') : input[name] ?? '').trim();
    if (clear.includes(name) || (!text && !f.secret && name in input)) delete values[name];
    else if (text) {
      if (/[\r\n]/.test(text)) throw new HttpError(400, `${f.label} must be on one line.`);
      if (f.pattern && !f.pattern.test(text)) throw new HttpError(400, `${f.label}: ${f.rule}`);
      if (text === fromServer[name]) delete values[name];
      else values[name] = text;
    }
    if (values[name] !== before) changed.push(f.label);
  }
  if (changed.length) {
    setSetting(KEY, encryptText(JSON.stringify(values)));
    applyConnections();
  }
  return changed;
}
