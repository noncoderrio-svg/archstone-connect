import { syncTemplateStatuses } from './whatsapp.ts';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { all, db, get, getSetting, minutesFromNow, nowIso, run, setSetting } from '../db.ts';
import { alertRules, alertUser, isQuietNow, istHour } from './alerts.ts';
import { broadcast, notify, notifyUrgent } from './core.ts';
import { managerChain } from './hierarchy.ts';
import { sendFeedback } from './metaFeedback.ts';
import { syncMetaLeads } from './metaLeads.ts';
import { assignLead, logActivity, nextTelecaller } from './leads.ts';
import { emailLive, sendMail } from './mail.ts';
import { buildReport, reportPdf, reportWorkbook, summaryLine } from './reports.ts';
import { dataDir } from './secrets.ts';
import { formatIst, processQueue, queueCampaign, sendAutomation, sendToStaff } from './whatsapp.ts';
import { runIdleWorkflows } from './workflows.ts';

export function releaseExpiredHolds() {
  const expired = all<any>(`SELECT id FROM units WHERE status = 'Hold' AND hold_until <= ?`, nowIso());
  for (const u of expired) {
    run(`UPDATE units SET status = 'Available', held_by = NULL, hold_until = NULL, lead_id = NULL WHERE id = ?`, u.id);
  }
  if (expired.length) broadcast('inventory');
  return expired.length;
}

/** Alerts the owner, then their managers, when a new lead sits unanswered. */
export function checkResponseSla() {
  const minutes = getSetting('sla_minutes', 15);
  const late = all<any>(
    `SELECT id, name, owner_id FROM leads
     WHERE first_response_at IS NULL AND sla_alerted = 0 AND deleted_at IS NULL AND stage = 'Not Contacted' AND created_at <= ?`,
    minutesFromNow(-minutes),
  );
  const managers = all<any>(`SELECT id FROM users WHERE role IN ('admin','sourcing_manager') AND status = 'active'`);
  for (const lead of late) {
    run('UPDATE leads SET sla_alerted = 1 WHERE id = ?', lead.id);
    notifyUrgent(lead.owner_id, 'New lead is waiting', `${lead.name} has had no response for ${minutes} minutes`, `/leads/${lead.id}`);
    const direct = lead.owner_id ? managerChain(lead.owner_id)[0] : undefined;
    for (const m of direct ? [{ id: direct }] : managers) notify(m.id, 'Response time missed', lead.name, `/leads/${lead.id}`);
  }
  return late.length;
}

export async function sendVisitReminders() {
  const due = all<any>(
    `SELECT l.*, v.scheduled_at, v.otp, v.id AS visit_id FROM site_visits v JOIN leads l ON l.id = v.lead_id
     WHERE v.status IN ('Scheduled','Confirmed') AND v.reminder_sent = 0 AND v.scheduled_at <= ? AND v.scheduled_at > ?`,
    minutesFromNow(1440), nowIso(),
  );
  for (const row of due) {
    run('UPDATE site_visits SET reminder_sent = 1 WHERE id = ?', row.visit_id);
    const sent = await sendAutomation('visit_reminder', row, { visit_time: formatIst(row.scheduled_at), otp: row.otp });
    if (sent) logActivity(row.id, 'whatsapp', 'Site visit reminder sent');
  }
}

/** Reminds customers 3 days before a milestone, and alerts the owner once it is overdue. */
export async function sendPaymentReminders() {
  const today = nowIso().slice(0, 10);
  const soon = minutesFromNow(3 * 1440).slice(0, 10);
  const due = all<any>(
    `SELECT l.*, p.id AS payment_id, p.label, p.due_date, p.amount_lakhs, p.reminded FROM payments p
     JOIN bookings b ON b.id = p.booking_id JOIN leads l ON l.id = b.lead_id
     WHERE p.paid_at IS NULL AND b.status = 'active' AND p.reminded < 2 AND p.due_date <= ?`,
    soon,
  );
  for (const row of due) {
    if (row.due_date < today) {
      run('UPDATE payments SET reminded = 2 WHERE id = ?', row.payment_id);
      notify(row.owner_id, 'Payment overdue', row.name, `/leads/${row.id}`);
    } else if (row.reminded === 0) {
      run('UPDATE payments SET reminded = 1 WHERE id = ?', row.payment_id);
      const sent = await sendAutomation('payment_reminder', row, {
        milestone: row.label,
        amount: `₹${row.amount_lakhs} Lakhs`,
        due_date: row.due_date,
      });
      if (sent) logActivity(row.id, 'whatsapp', 'Payment reminder sent', row.label);
    }
  }
}

export async function launchScheduledCampaigns() {
  const due = all<any>(`SELECT id FROM wa_campaigns WHERE status = 'approved' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`, nowIso());
  for (const c of due) {
    try {
      queueCampaign(c.id);
    } catch (e) {
      run(`UPDATE wa_campaigns SET status = 'blocked' WHERE id = ?`, c.id);
      console.error(`Campaign ${c.id} was blocked:`, (e as Error).message);
    }
  }
}

/** Warns owners about idle leads, then moves them on if an admin has turned that on. */
export function checkInactiveLeads() {
  const alertDays = getSetting('inactive_alert_days', 3);
  const reassignDays = getSetting('auto_reassign_days', 0);
  const open = `l.deleted_at IS NULL AND l.stage NOT IN ('Booked','Lost','Unqualified','Future Prospect') AND l.owner_id IS NOT NULL`;
  if (alertDays) {
    const idle = all<any>(`SELECT l.id, l.name, l.owner_id FROM leads l WHERE ${open} AND l.inactive_alerted = 0 AND l.last_activity_at <= ?`, minutesFromNow(-alertDays * 1440));
    for (const l of idle) {
      run('UPDATE leads SET inactive_alerted = 1 WHERE id = ?', l.id);
      notify(l.owner_id, 'Lead has gone quiet', `${l.name}: no activity for ${alertDays} days`, `/leads/${l.id}`);
    }
  }
  if (reassignDays) {
    const stale = all<any>(
      `SELECT l.id, l.name, l.owner_id, l.project_id, l.language FROM leads l JOIN users u ON u.id = l.owner_id
       WHERE ${open} AND u.role = 'telecaller' AND l.stage IN ('Not Contacted','Contacted') AND l.last_activity_at <= ?`,
      minutesFromNow(-reassignDays * 1440),
    );
    for (const l of stale) {
      const next = nextTelecaller(l.project_id, l.language || undefined, l.owner_id);
      if (!next) continue;
      notify(l.owner_id, 'Lead was reassigned', `${l.name}: no activity for ${reassignDays} days`);
      assignLead(l.id, next.id, next.id, `No activity for ${reassignDays} days`);
    }
  }
}

/** A heads-up shortly before each follow-up, on the phone, in the app and on WhatsApp. */
export function sendFollowUpReminders() {
  const rules = alertRules();
  const due = all<any>(
    `SELECT t.id, t.type, t.owner_id, t.lead_id, t.due_at, l.name FROM tasks t JOIN leads l ON l.id = t.lead_id
     WHERE t.completed_at IS NULL AND t.reminded = 0 AND l.deleted_at IS NULL AND t.due_at <= ? AND t.due_at >= ?`,
    minutesFromNow(rules.reminder_minutes), minutesFromNow(-60),
  );
  for (const t of due) {
    run('UPDATE tasks SET reminded = 1 WHERE id = ?', t.id);
    alertUser(t.owner_id, 'followup', `Follow-up due: ${t.type}`, t.name, `/leads/${t.lead_id}`, {
      template: 'staff_followup', vars: { task: t.type, lead: t.name, time: formatIst(t.due_at) },
    });
  }
}

/** The people responsible for someone's follow-ups: managers, and site heads on that project. */
function managersFor(ownerId: number, projectId: number | null) {
  const people = all<{ id: number }>(
    `SELECT u.id FROM users u WHERE u.status = 'active' AND u.id != ? AND (u.role = 'sourcing_manager'
       OR (u.role = 'site_head' AND u.id IN (SELECT user_id FROM user_projects WHERE project_id = ?)))`,
    ownerId, projectId ?? 0,
  );
  return people.length ? people : all<{ id: number }>(`SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND id != ?`, ownerId);
}

/**
 * Alerts the owner when a follow-up is missed, repeats a limited number of times,
 * then tells their manager. Waits for morning during quiet hours. Follow-ups older
 * than three days appear in the morning summary instead, so upgrades cannot flood anyone.
 */
export function sendOverdueAlerts() {
  const rules = alertRules();
  if (isQuietNow(rules)) return;
  const late = all<any>(
    `SELECT t.id, t.type, t.owner_id, t.lead_id, t.due_at, t.overdue_alerts, t.last_overdue_at, t.escalated, l.name, l.project_id, u.name AS owner_name
     FROM tasks t JOIN leads l ON l.id = t.lead_id JOIN users u ON u.id = t.owner_id
     WHERE t.completed_at IS NULL AND l.deleted_at IS NULL AND u.status = 'active' AND t.due_at < ? AND t.due_at >= ?`,
    nowIso(), minutesFromNow(-3 * 1440),
  );
  const repeatBefore = minutesFromNow(-rules.overdue_repeat_minutes);

  for (const t of late) {
    const repeat = t.overdue_alerts < rules.overdue_max_alerts && (!t.last_overdue_at || t.last_overdue_at <= repeatBefore);
    if (repeat) {
      run('UPDATE tasks SET overdue_alerts = overdue_alerts + 1, last_overdue_at = ? WHERE id = ?', nowIso(), t.id);
      alertUser(t.owner_id, 'overdue', `Follow-up overdue: ${t.type}`, t.name, '/followups', {
        template: 'staff_overdue', vars: { task: t.type, lead: t.name, time: formatIst(t.due_at) },
      });
    }
    // Climbs one level each time the wait passes, starting with the person's own manager.
    const chain = managerChain(t.owner_id);
    const levels = chain.length || 1;
    const waited = rules.escalate_after_minutes > 0 && t.due_at <= minutesFromNow(-rules.escalate_after_minutes * (t.escalated + 1));
    if (waited && t.escalated < levels) {
      run('UPDATE tasks SET escalated = escalated + 1 WHERE id = ?', t.id);
      const people = chain.length ? [{ id: chain[t.escalated] }] : managersFor(t.owner_id, t.project_id);
      for (const m of people) {
        alertUser(m.id, 'team', 'Team follow-up overdue', `${t.owner_name}: ${t.name}, ${t.type}`, `/followups?owner=${t.owner_id}`);
      }
    }
  }
}

/** One message each morning with what is overdue and due today. */
export function sendMorningSummary() {
  const rules = alertRules();
  if (!rules.morning_summary || istHour() < rules.summary_hour || isQuietNow(rules)) return;
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  if (getSetting('summary_last', '') === today) return;
  setSetting('summary_last', today);
  const rows = all<any>(
    `SELECT u.id, u.name,
       SUM(t.due_at < ?) AS overdue,
       SUM(t.due_at >= ? AND date(t.due_at, '+330 minutes') = date('now', '+330 minutes')) AS today
     FROM tasks t JOIN users u ON u.id = t.owner_id JOIN leads l ON l.id = t.lead_id
     WHERE t.completed_at IS NULL AND l.deleted_at IS NULL AND u.status = 'active' GROUP BY u.id`,
    nowIso(), nowIso(),
  );
  for (const r of rows) {
    if (!r.overdue && !r.today) continue;
    alertUser(r.id, 'followup', 'Your follow-ups today', `${r.overdue} overdue, ${r.today} due today`, r.overdue ? '/followups' : '/followups?view=today', {
      template: 'staff_summary', vars: { name: r.name.split(' ')[0], overdue: String(r.overdue), today: String(r.today) },
    });
  }
}

/** Up to two gentle template nudges for leads that stopped responding. */
export async function sendFollowUpDrips() {
  const waitDays = getSetting('drip_wait_days', 3);
  const leads = all<any>(
    `SELECT * FROM leads WHERE deleted_at IS NULL AND stage IN ('Contacted','Did Not Respond') AND drip_count < 2 AND last_activity_at <= ?`,
    minutesFromNow(-waitDays * 1440),
  );
  for (const lead of leads) {
    if (await sendAutomation('follow_up', lead)) run('UPDATE leads SET drip_count = drip_count + 1 WHERE id = ?', lead.id);
  }
}

const istNow = () => new Date(Date.now() + 5.5 * 3600000);

/** Sends one report to one person by every enabled route, and records each attempt. */
export async function sendReportTo(userId: number, period: 'daily' | 'weekly') {
  const u = get<any>('SELECT id, name, email, phone, role FROM users WHERE id = ?', userId);
  if (!u) return;
  const project_ids = all<any>('SELECT project_id FROM user_projects WHERE user_id = ?', userId).map((p) => p.project_id);
  const report = buildReport({ ...u, project_ids, must_change_password: 0, two_factor: false }, period === 'daily' ? 1 : 7);
  const summary = summaryLine(report);
  const label = period === 'daily' ? 'Daily' : 'Weekly';
  const schedule = getSetting('report_schedule', REPORT_DEFAULTS);
  const record = (channel: string, status: string) =>
    run('INSERT INTO report_runs(period, user_id, channel, status, summary) VALUES(?, ?, ?, ?, ?)', period, userId, channel, status, summary);

  notify(userId, `${label} report is ready`, summary, '/reports');
  record('app', 'sent');
  if (schedule.email) {
    if (!emailLive()) record('email', 'not set up');
    else {
      try {
        const [xlsx, pdf] = await Promise.all([reportWorkbook(report), reportPdf(report, u.name)]);
        await sendMail({
          to: u.email,
          subject: `Archstone Connect ${label.toLowerCase()} report`,
          text: `${summary}\n\nThe full report is attached.`,
          attachments: [{ filename: 'archstone-report.xlsx', content: xlsx }, { filename: 'archstone-report.pdf', content: pdf }],
        });
        record('email', 'sent');
      } catch (e) {
        record('email', `failed: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }
  if (schedule.whatsapp) {
    if (!u.phone) record('whatsapp', 'no mobile number');
    else {
      record('whatsapp', await sendToStaff(u.phone, 'staff_report', { period: label, summary }).catch((e) => `failed: ${(e as Error).message.slice(0, 120)}`));
    }
  }
}

export const REPORT_DEFAULTS = { daily: false, weekly: false, hour: 9, email: true, whatsapp: false };

export async function runScheduledReports() {
  const schedule = getSetting('report_schedule', REPORT_DEFAULTS);
  const now = istNow();
  if (now.getUTCHours() < schedule.hour) return;
  const today = now.toISOString().slice(0, 10);
  const due: ('daily' | 'weekly')[] = [];
  if (schedule.daily && getSetting('report_last_daily', '') !== today) due.push('daily');
  if (schedule.weekly && now.getUTCDay() === 1 && getSetting('report_last_weekly', '') !== today) due.push('weekly');
  if (!due.length) return;
  const people = all<any>(`SELECT id FROM users WHERE role IN ('admin','sourcing_manager','site_head') AND status = 'active'`);
  for (const period of due) {
    setSetting(`report_last_${period}`, today);
    for (const p of people) await sendReportTo(p.id, period);
  }
}

/** Daily copies live on the same disk as the data, so admins are nudged to keep one elsewhere. */
export function remindOffsiteBackup() {
  const week = minutesFromNow(-7 * 1440);
  const last = getSetting<string>('backup_download_last', '');
  const reminded = getSetting<string>('backup_reminded', '');
  if ((last && last > week) || (reminded && reminded > week)) return;
  setSetting('backup_reminded', nowIso());
  const admins = all<{ id: number }>(`SELECT id FROM users WHERE role = 'admin' AND status = 'active'`);
  for (const a of admins) alertUser(a.id, 'team', 'Download this week\'s backup', last ? 'Your last offsite copy is over a week old.' : 'You have no offsite copy yet.', '/settings');
}

/** A daily copy of the database, kept for two weeks. */
export function backupDatabase() {
  if (config.dbPath === ':memory:') return;
  const today = nowIso().slice(0, 10);
  if (getSetting('backup_last', '') === today) return;
  const folder = join(dataDir(), 'backups');
  mkdirSync(folder, { recursive: true });
  const target = join(folder, `archstone-${today}.db`);
  rmSync(target, { force: true }); // VACUUM INTO will not overwrite an earlier copy.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  setSetting('backup_last', today);
  const old = readdirSync(folder).filter((f) => f.endsWith('.db')).sort().slice(0, -14);
  for (const file of old) rmSync(join(folder, file), { force: true });
}

export async function tick() {
  releaseExpiredHolds();
  checkResponseSla();
  checkInactiveLeads();
  sendFollowUpReminders();
  sendOverdueAlerts();
  sendMorningSummary();
  await runIdleWorkflows();
  void syncMetaLeads().catch((e) => console.error('Meta pull failed:', e.message));
  void sendFeedback().catch((e) => console.error('Meta feedback failed:', e.message));
  void checkPendingTemplates().catch((e) => console.error('Template status check failed:', e.message));
  await sendVisitReminders();
  await sendPaymentReminders();
  await sendFollowUpDrips();
  await launchScheduledCampaigns();
  await processQueue();
  await runScheduledReports();
  backupDatabase();
  remindOffsiteBackup();
}

let running = false;

/** While a template waits for Meta's review, asks Meta every 15 minutes, in case its webhook does not arrive. */
async function checkPendingTemplates() {
  if (!get('SELECT 1 AS x FROM wa_templates WHERE status = ? LIMIT 1', 'pending')) return;
  const last = getSetting<string>('template_sync_last', '');
  if (last && last > minutesFromNow(-15)) return;
  setSetting('template_sync_last', nowIso());
  await syncTemplateStatuses();
}

/** Runs one pass of the scheduled jobs, never two at once. Returns false if a pass was already running. */
export async function tickOnce() {
  if (running) return false;
  running = true;
  try {
    await tick();
    return true;
  } finally {
    running = false;
  }
}

export function startScheduler() {
  const timer = setInterval(() => tickOnce().catch((e) => console.error('Scheduler error:', e)), 10000);
  timer.unref();
}
