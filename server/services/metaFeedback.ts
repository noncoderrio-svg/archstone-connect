import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { all, get, getSetting, minutesFromNow, nowIso, run, setSetting, tx } from '../db.ts';
import { decryptText } from './secrets.ts';

/**
 * Tells Meta what became of its leads, so it can look for more people who buy
 * rather than people who only fill in forms. Nothing is sent until an admin turns it on.
 */
export interface FeedbackSettings {
  enabled: boolean;
  dataset_id: string;
  token: string;
  test_event_code: string;
  target: string;
  mapping: Record<string, string>;
  privacy_confirmed: boolean;
}

/** Stages in buying order. Reaching one means the earlier ones happened too. */
export const FUNNEL = ['Contacted', 'Qualified', 'Site Visit Scheduled', 'Site Visit Done', 'Working Deal', 'Booked'];
const ENDINGS = ['Unqualified', 'Lost'];

export const FEEDBACK_DEFAULTS: FeedbackSettings = {
  enabled: false,
  dataset_id: '',
  token: '',
  test_event_code: '',
  target: 'Qualified',
  privacy_confirmed: false,
  mapping: {
    Contacted: 'Contacted', Qualified: 'Qualified', 'Site Visit Scheduled': 'Site Visit Scheduled', 'Site Visit Done': 'Site Visit Done',
    'Working Deal': 'Working Deal', Booked: 'Converted', Unqualified: 'Disqualified', Lost: 'Disqualified',
  },
};

export const feedbackSettings = (): FeedbackSettings => ({ ...FEEDBACK_DEFAULTS, ...getSetting<Partial<FeedbackSettings>>('meta_feedback', {}) });

const MAX_ATTEMPTS = 5;
const BATCH = 200;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Works out which events each lead has earned. Each one is only ever queued once. */
export function queueFeedback() {
  const { mapping } = feedbackSettings();
  const leads = all<{ id: number; stage: string }>(
    `SELECT l.id, l.stage FROM leads l JOIN meta_seen s ON s.lead_id = l.id
     WHERE l.deleted_at IS NULL AND l.created_at >= ? GROUP BY l.id`,
    minutesFromNow(-90 * 1440),
  );
  let queued = 0;
  tx(() => {
    const add = (leadId: number, event: string) => {
      if (event) queued += run('INSERT OR IGNORE INTO meta_events(lead_id, event_name) VALUES(?, ?)', leadId, event).changes;
    };
    for (const lead of leads) {
      add(lead.id, 'Lead'); // Meta asks for the raw lead too, or it cannot match the later stages.
      const reached = FUNNEL.indexOf(lead.stage);
      for (const stage of FUNNEL.slice(0, reached + 1)) add(lead.id, mapping[stage]);
      if (ENDINGS.includes(lead.stage)) add(lead.id, mapping[lead.stage]);
    }
  });
  return queued;
}

function eventFor(row: any) {
  const digits = String(row.phone).replace(/\D/g, '');
  const user: Record<string, unknown> = { lead_id: row.meta_lead_id, ph: [hash(digits)] };
  if (row.email) user.em = [hash(String(row.email).trim().toLowerCase())];
  return {
    event_name: row.event_name,
    event_time: Math.floor(new Date(`${row.created_at.replace(' ', 'T')}Z`).getTime() / 1000),
    action_source: 'system_generated',
    user_data: user,
    custom_data: { event_source: 'crm', lead_event_source: 'Archstone Connect' },
  };
}

/** Meta IDs are too long for a JavaScript number, so the digits go in as written. */
const asRawNumbers = (json: string) => json.replace(/"lead_id":"(\d+)"/g, '"lead_id":$1');

let sending = false;

export async function sendFeedback(force = false) {
  const settings = feedbackSettings();
  const ready = settings.enabled && settings.privacy_confirmed && settings.dataset_id && settings.token;
  const last = getSetting<string>('meta_feedback_last', '');
  if (!ready || sending || (!force && last && last > minutesFromNow(-60))) return { sent: 0, failed: 0 };
  sending = true;
  setSetting('meta_feedback_last', nowIso());
  try {
    queueFeedback();
    // Meta refuses very old events, so these stop retrying instead of failing forever.
    run(`UPDATE meta_events SET status = 'expired' WHERE status IN ('pending','failed') AND created_at < ?`, minutesFromNow(-7 * 1440));
    // Leads without a real Meta ID cannot be matched, so they never go out.
    run(`UPDATE meta_events SET status = 'skipped' WHERE status = 'pending' AND lead_id NOT IN (SELECT lead_id FROM meta_seen WHERE meta_lead_id GLOB '[0-9]*' AND length(meta_lead_id) BETWEEN 10 AND 20)`);
    const token = decryptText(settings.token);
    let sent = 0;
    let failed = 0;
    for (;;) {
      const rows = all<any>(
        `SELECT e.id, e.event_name, e.created_at, l.phone, l.email,
           (SELECT s.meta_lead_id FROM meta_seen s WHERE s.lead_id = e.lead_id ORDER BY s.created_at LIMIT 1) AS meta_lead_id
         FROM meta_events e JOIN leads l ON l.id = e.lead_id
         WHERE e.status IN ('pending','failed') AND e.attempts < ? AND l.deleted_at IS NULL
         ORDER BY e.id LIMIT ?`,
        MAX_ATTEMPTS, BATCH,
      );
      if (!rows.length) break;
      const ids = rows.map((r) => r.id);
      const marks = ids.map(() => '?').join(',');
      const body = asRawNumbers(JSON.stringify({
        data: rows.map(eventFor),
        ...(settings.test_event_code ? { test_event_code: settings.test_event_code } : {}),
      }));
      let problem = '';
      try {
        const res = await fetch(`https://graph.facebook.com/${config.whatsapp.apiVersion}/${settings.dataset_id}/events`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body,
        });
        if (!res.ok) problem = ((await res.json().catch(() => ({}))) as any)?.error?.message ?? `Meta error ${res.status}`;
      } catch (e) {
        problem = (e as Error).message;
      }
      if (problem) {
        run(`UPDATE meta_events SET status = 'failed', attempts = attempts + 1, error = ? WHERE id IN (${marks})`, problem.slice(0, 200), ...ids);
        failed += ids.length;
        break; // The next run tries again, rather than repeating a failing request now.
      }
      run(`UPDATE meta_events SET status = 'sent', attempts = attempts + 1, error = '', sent_at = ? WHERE id IN (${marks})`, nowIso(), ...ids);
      sent += ids.length;
    }
    return { sent, failed };
  } finally {
    sending = false;
  }
}

/** The numbers Meta cares about, so problems show up before the campaign suffers. */
export function feedbackStats() {
  const settings = feedbackSettings();
  const since = minutesFromNow(-30 * 1440);
  const count = (sql: string, ...p: (string | number)[]) => get<{ n: number }>(sql, ...p)!.n;
  const leads = count(`SELECT COUNT(DISTINCT l.id) n FROM leads l JOIN meta_seen s ON s.lead_id = l.id WHERE l.created_at >= ? AND l.deleted_at IS NULL`, since);
  const covered = count(`SELECT COUNT(DISTINCT e.lead_id) n FROM meta_events e JOIN leads l ON l.id = e.lead_id WHERE e.status = 'sent' AND l.created_at >= ?`, since);
  const targetEvent = settings.mapping[settings.target] ?? settings.target;
  const reached = count(`SELECT COUNT(DISTINCT e.lead_id) n FROM meta_events e JOIN leads l ON l.id = e.lead_id WHERE e.event_name = ? AND l.created_at >= ?`, targetEvent, since);
  const status = (s: string) => count('SELECT COUNT(*) n FROM meta_events WHERE status = ?', s);
  return {
    leads_30_days: leads,
    coverage: leads ? Math.round((covered / leads) * 100) : null,
    target_rate: leads ? Math.round((reached / leads) * 100) : null,
    sent: status('sent'),
    pending: status('pending'),
    failed: status('failed'),
    expired: status('expired'),
    last_error: get<{ error: string }>(`SELECT error FROM meta_events WHERE status = 'failed' AND error != '' ORDER BY id DESC LIMIT 1`)?.error ?? '',
    last_sent_at: get<{ t: string | null }>('SELECT MAX(sent_at) t FROM meta_events')!.t,
  };
}
