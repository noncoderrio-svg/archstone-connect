import { existsSync } from 'node:fs';

if (existsSync('.env') && !process.env.ARCHSTONE_SKIP_DOTENV) process.loadEnvFile('.env');

/** Google retires older model names; gemini-2.5-flash stopped working for new keys in 2026. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

const env = (key: string, fallback = '') => process.env[key]?.trim() || fallback;

export const config = {
  production: env('NODE_ENV') === 'production',
  initialAdminPassword: env('INITIAL_ADMIN_PASSWORD'),
  storageLimitMb: Number(env('STORAGE_LIMIT_MB', '0')),
  port: Number(env('PORT', '4000')),
  appUrl: env('APP_URL', 'http://localhost:4000').replace(/\/$/, ''),
  dbPath: env('DB_PATH', 'data/archstone-connect.db'),
  secureCookies: env('SECURE_COOKIES') === 'true',
  demoMode: env('DEMO_MODE', 'true') === 'true',
  initialAdminEmail: env('INITIAL_ADMIN_EMAIL').toLowerCase(),
  websiteApiKey: env('WEBSITE_API_KEY'),
  /** Shown on the public privacy and data deletion pages. */
  privacyContactEmail: env('PRIVACY_CONTACT_EMAIL'),
  /** Secret for /cron/tick, which a host's cron job calls to run reminders and backups. Empty turns the link off. */
  cronToken: env('CRON_TOKEN'),
  whatsapp: {
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    businessAccountId: env('WHATSAPP_BUSINESS_ACCOUNT_ID'),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
    appSecret: env('META_APP_SECRET'),
    apiVersion: env('META_API_VERSION', 'v21.0'),
  },
  metaPageToken: env('META_PAGE_TOKEN'),
  gemini: { key: env('GEMINI_API_KEY'), model: env('GEMINI_MODEL', DEFAULT_GEMINI_MODEL) },
  portalApiKey: env('PORTAL_API_KEY'),
  secretKey: env('SECRET_KEY'),
  exotel: {
    sid: env('EXOTEL_SID'),
    apiKey: env('EXOTEL_API_KEY'),
    apiToken: env('EXOTEL_API_TOKEN'),
    subdomain: env('EXOTEL_SUBDOMAIN', 'api.exotel.com'),
    callerId: env('EXOTEL_CALLER_ID'),
    webhookToken: env('TELEPHONY_WEBHOOK_TOKEN'),
  },
  google: { clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET') },
  metaAppId: env('META_APP_ID'),
  whatsappDisplayNumber: env('WHATSAPP_DISPLAY_NUMBER').replace(/\D/g, ''),
  googleAdsKey: env('GOOGLE_ADS_WEBHOOK_KEY'),
  /** Claude, an optional second brain for the AI marketing team. */
  anthropic: { key: env('ANTHROPIC_API_KEY'), model: env('ANTHROPIC_MODEL', 'claude-opus-5-5') },
  /** Meta Marketing API: a System User token with ads_read and ads_management, never a personal token. */
  metaAds: { apiVersion: env('META_ADS_API_VERSION', 'v27.0'), token: env('META_ADS_TOKEN'), accountId: env('META_AD_ACCOUNT_ID').replace(/^act_/, ''), pageId: env('META_ADS_PAGE_ID'), instagramId: env('META_ADS_INSTAGRAM_ID') },
  /** n8n calls /webhooks/automation with this key, and the CRM posts marketing events to the address. */
  automation: { key: env('AUTOMATION_API_KEY'), eventsUrl: env('AUTOMATION_EVENTS_URL') },
  smtp: {
    host: env('SMTP_HOST'),
    port: Number(env('SMTP_PORT', '587')),
    user: env('SMTP_USER'),
    pass: env('SMTP_PASSWORD'),
    from: env('SMTP_FROM'),
  },
};

export const whatsappLive = () => Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);
export const telephonyLive = () => Boolean(config.exotel.sid && config.exotel.apiKey && config.exotel.apiToken && config.exotel.callerId);
export const googleReady = () => Boolean(config.google.clientId && config.google.clientSecret);
