import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.ts';

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  last_assigned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL DEFAULT '',
  configuration TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'Residential',
  price_from_lakhs REAL,
  rera_number TEXT NOT NULL DEFAULT '',
  brochure_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ongoing',
  verify_note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS user_projects (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, project_id)
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'Manual',
  stage TEXT NOT NULL DEFAULT 'Not Contacted',
  project_id INTEGER REFERENCES projects(id),
  configuration TEXT NOT NULL DEFAULT '',
  budget_lakhs REAL,
  preferred_location TEXT NOT NULL DEFAULT '',
  timeline TEXT NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES users(id),
  presales_id INTEGER REFERENCES users(id),
  score INTEGER NOT NULL DEFAULT 0,
  temperature TEXT NOT NULL DEFAULT 'Cold',
  score_reason TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  lost_reason TEXT NOT NULL DEFAULT '',
  utm_source TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  wa_opt_in INTEGER NOT NULL DEFAULT 0,
  wa_opt_in_source TEXT NOT NULL DEFAULT '',
  wa_opt_in_at TEXT,
  wa_opted_out_at TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  last_inbound_at TEXT,
  last_message_at TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  first_response_at TEXT,
  sla_alerted INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_presales ON leads(presales_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_project ON leads(project_id);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  actor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'Call',
  due_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id, completed_at);
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  tower TEXT NOT NULL DEFAULT 'A',
  floor INTEGER NOT NULL,
  number TEXT NOT NULL,
  configuration TEXT NOT NULL DEFAULT '',
  carpet_sqft REAL,
  price_lakhs REAL,
  status TEXT NOT NULL DEFAULT 'Available',
  held_by INTEGER REFERENCES users(id),
  hold_until TEXT,
  lead_id INTEGER REFERENCES leads(id),
  UNIQUE (project_id, tower, number)
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  unit_id INTEGER REFERENCES units(id),
  amount_lakhs REAL,
  discount_percent REAL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER NOT NULL REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS site_visits (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  host_id INTEGER REFERENCES users(id),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Scheduled',
  otp TEXT NOT NULL,
  pickup INTEGER NOT NULL DEFAULT 0,
  rating INTEGER,
  feedback TEXT NOT NULL DEFAULT '',
  checked_in_at TEXT,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wa_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'MARKETING',
  language TEXT NOT NULL DEFAULT 'en',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  reject_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wa_campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  template_id INTEGER NOT NULL REFERENCES wa_templates(id),
  project_id INTEGER REFERENCES projects(id),
  segment TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_at TEXT,
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  template_id INTEGER REFERENCES wa_templates(id),
  campaign_id INTEGER REFERENCES wa_campaigns(id),
  status TEXT NOT NULL,
  wa_id TEXT UNIQUE,
  error TEXT NOT NULL DEFAULT '',
  simulated INTEGER NOT NULL DEFAULT 0,
  actor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wa_lead ON wa_messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_wa_status ON wa_messages(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_campaign_once ON wa_messages(campaign_id, lead_id) WHERE campaign_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS automations (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  template_id INTEGER REFERENCES wa_templates(id)
);
CREATE TABLE IF NOT EXISTS ad_spend (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  spend_date TEXT NOT NULL,
  amount_inr REAL NOT NULL,
  created_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'dialling',
  duration_seconds INTEGER,
  recording_url TEXT NOT NULL DEFAULT '',
  simulated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  type TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  uploaded_by INTEGER REFERENCES users(id),
  verified_by INTEGER REFERENCES users(id),
  drive_file_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  firm TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  rera_agent_number TEXT NOT NULL DEFAULT '',
  commission_percent REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  unit_id INTEGER NOT NULL REFERENCES units(id),
  approval_id INTEGER REFERENCES approvals(id),
  amount_lakhs REAL NOT NULL,
  discount_percent REAL NOT NULL DEFAULT 0,
  handover_status TEXT NOT NULL DEFAULT 'Booking',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  label TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount_lakhs REAL NOT NULL,
  paid_at TEXT,
  reference TEXT NOT NULL DEFAULT '',
  receipt_number TEXT UNIQUE,
  reminded INTEGER NOT NULL DEFAULT 0,
  recorded_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS commissions (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
  percent REAL NOT NULL,
  amount_lakhs REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS redevelopment (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  scheme TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  area_sqft REAL,
  tenements INTEGER,
  stage TEXT NOT NULL DEFAULT 'Identified',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES users(id),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS redevelopment_log (
  id INTEGER PRIMARY KEY,
  deal_id INTEGER NOT NULL REFERENCES redevelopment(id),
  body TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS device_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meta_events (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  UNIQUE (lead_id, event_name)
);
CREATE TABLE IF NOT EXISTS lead_routes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  match_source TEXT NOT NULL DEFAULT '',
  match_campaign TEXT NOT NULL DEFAULT '',
  match_adset TEXT NOT NULL DEFAULT '',
  match_ad TEXT NOT NULL DEFAULT '',
  match_form TEXT NOT NULL DEFAULT '',
  project_id INTEGER,
  user_ids TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'round_robin',
  next_index INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS meta_pages (
  id INTEGER PRIMARY KEY,
  page_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  leads_pulled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta_seen (
  meta_lead_id TEXT PRIMARY KEY,
  lead_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workflow_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '{}',
  action TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  runs INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  rule_id INTEGER NOT NULL REFERENCES workflow_rules(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL,
  occasion TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rule_id, lead_id, occasion)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keys TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/** Adds a column to an existing database, so upgrades keep all current data. */
function addColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('leads', 'bot_state', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'bot_tries', 'INTEGER NOT NULL DEFAULT 0');
addColumn('leads', 'partner_id', 'INTEGER REFERENCES partners(id)');
addColumn('users', 'totp_secret', `TEXT NOT NULL DEFAULT ''`);
addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'totp_last_step', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'recovery_codes', `TEXT NOT NULL DEFAULT '[]'`);
addColumn('users', 'google_tokens', `TEXT NOT NULL DEFAULT ''`);
addColumn('users', 'google_email', `TEXT NOT NULL DEFAULT ''`);
addColumn('projects', 'gst_percent', 'REAL');
addColumn('projects', 'stamp_duty_percent', 'REAL');
addColumn('projects', 'registration_lakhs', 'REAL');
addColumn('projects', 'other_charges_lakhs', 'REAL');
addColumn('site_visits', 'google_event_id', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'sentiment', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'intent', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'language', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'drip_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('leads', 'inactive_alerted', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'languages', `TEXT NOT NULL DEFAULT ''`);
addColumn('wa_templates', 'header_type', `TEXT NOT NULL DEFAULT 'NONE'`);
addColumn('wa_templates', 'header_url', `TEXT NOT NULL DEFAULT ''`);
addColumn('wa_templates', 'buttons', `TEXT NOT NULL DEFAULT '[]'`);
addColumn('wa_messages', 'media_url', `TEXT NOT NULL DEFAULT ''`);
addColumn('wa_messages', 'media_type', `TEXT NOT NULL DEFAULT ''`);
addColumn('projects', 'call_script', `TEXT NOT NULL DEFAULT ''`);
addColumn('projects', 'objections', `TEXT NOT NULL DEFAULT ''`);
addColumn('site_visits', 'latitude', 'REAL');
addColumn('site_visits', 'longitude', 'REAL');

addColumn('calls', 'pending', 'INTEGER NOT NULL DEFAULT 0');
addColumn('leads', 'call_list_id', 'INTEGER');
addColumn('tasks', 'reminded', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'manager_id', 'INTEGER');
addColumn('leads', 'adset', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'ad', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'form_name', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'last_disposition', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'profile', `TEXT NOT NULL DEFAULT '{}'`);
addColumn('leads', 'merged_into', 'INTEGER');
addColumn('bookings', 'portal_hash', `TEXT NOT NULL DEFAULT ''`);
addColumn('tasks', 'snoozes', 'INTEGER NOT NULL DEFAULT 0');
addColumn('tasks', 'overdue_alerts', 'INTEGER NOT NULL DEFAULT 0');
addColumn('tasks', 'last_overdue_at', 'TEXT');
addColumn('tasks', 'escalated', 'INTEGER NOT NULL DEFAULT 0');
addColumn('notifications', 'kind', `TEXT NOT NULL DEFAULT ''`);
addColumn('users', 'alert_prefs', `TEXT NOT NULL DEFAULT '{}'`);
addColumn('users', 'data_scope', `TEXT NOT NULL DEFAULT ''`);
addColumn('users', 'team', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'wa_number_id', 'INTEGER');
addColumn('wa_messages', 'number_id', 'INTEGER');
addColumn('wa_messages', 'source', `TEXT NOT NULL DEFAULT ''`);
addColumn('sessions', 'remember', 'INTEGER NOT NULL DEFAULT 0');
addColumn('wa_campaigns', 'number_id', 'INTEGER');
addColumn('ad_spend', 'campaign', `TEXT NOT NULL DEFAULT ''`);

db.exec(`
CREATE TABLE IF NOT EXISTS call_lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  PRIMARY KEY (user_id, action)
);
CREATE TABLE IF NOT EXISTS wa_numbers (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  display_number TEXT NOT NULL UNIQUE,
  phone_number_id TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL DEFAULT '',
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  daily_limit INTEGER NOT NULL DEFAULT 250,
  status TEXT NOT NULL DEFAULT 'active',
  quality TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS saved_filters (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS targets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  bookings INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);
CREATE TABLE IF NOT EXISTS report_runs (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
addColumn('wa_numbers', 'phone_app', 'INTEGER NOT NULL DEFAULT 0');
addColumn('wa_numbers', 'history_status', `TEXT NOT NULL DEFAULT ''`);
addColumn('partners', 'manager_id', 'INTEGER REFERENCES users(id)');
addColumn('partners', 'area', `TEXT NOT NULL DEFAULT ''`);
addColumn('partners', 'next_contact_on', 'TEXT');
addColumn('partners', 'last_contact_at', 'TEXT');
addColumn('targets', 'goals', `TEXT NOT NULL DEFAULT '{}'`);

db.exec(`
CREATE TABLE IF NOT EXISTS partner_contacts (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  next_contact_on TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_partner_contacts ON partner_contacts(partner_id);
CREATE TABLE IF NOT EXISTS payment_followups (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  user_id INTEGER REFERENCES users(id),
  outcome TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  promised_on TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_followups ON payment_followups(payment_id);
CREATE TABLE IF NOT EXISTS absences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  marked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS bulletins (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'news',
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  roles TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
addColumn('users', 'weekly_off', `TEXT NOT NULL DEFAULT ''`);
addColumn('users', 'shift_start', `TEXT NOT NULL DEFAULT ''`);
addColumn('users', 'shift_end', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'kyc_pan_enc', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'kyc_aadhaar_last4', `TEXT NOT NULL DEFAULT ''`);
addColumn('leads', 'kyc_aadhaar_hash', `TEXT NOT NULL DEFAULT ''`);

type Row = Record<string, any>;
type Params = SQLInputValue[];

export const all = <T = Row>(sql: string, ...p: Params) => db.prepare(sql).all(...p) as T[];
export const get = <T = Row>(sql: string, ...p: Params) => db.prepare(sql).get(...p) as T | undefined;
export const run = (sql: string, ...p: Params) => {
  const r = db.prepare(sql).run(...p);
  return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
};

let depth = 0;
/** Runs fn in a transaction. Nested calls join the outer transaction. */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

export const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
/** Stored UTC timestamp (`YYYY-MM-DD HH:MM:SS`), offset by minutes from now. */
export const minutesFromNow = (m: number) => new Date(Date.now() + m * 60000).toISOString().slice(0, 19).replace('T', ' ');

export const getSetting = <T>(key: string, fallback: T): T => {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return row ? (JSON.parse(row.value) as T) : fallback;
};
export const setSetting = (key: string, value: unknown) =>
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
