import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ALERT_DEFAULTS, ROLES, SOURCES, isManager } from '../../shared/domain.ts';
import {
  assertNotLocked, clearFailures, createSession, destroySession, destroyUserSessions, generatePassword, hashPassword,
  HttpError, adminNeedsTwoFactor, recordFailure, requirePermission, sessionRemembered, verifyPassword,
} from '../auth.ts';
import { config, telephonyLive, whatsappLive } from '../config.ts';
import { all, db, get, getSetting, nowIso, run, setSetting, tx } from '../db.ts';
import { alertRules, quietStatus } from '../services/alerts.ts';
import { writeBackup } from '../services/backup.ts';
import { connectionList, saveConnection } from '../services/connections.ts';
import { dataDir } from '../services/secrets.ts';
import { audit, leadScope, subscribe } from '../services/core.ts';
import {
  clearFcmAccount, clearFcmClient, fcmClient, fcmProject, fcmReady, lastPhoneSend, parseGoogleServices, phonesByPerson, saveFcmAccount, saveFcmClient,
} from '../services/fcm.ts';
import { pushToUser } from '../services/push.ts';
import { assertManager, teamOf } from '../services/hierarchy.ts';
import { topTelecallers } from '../services/targets.ts';
import { clauseSql, leadFilters } from '../services/filters.ts';
import { emailLive } from '../services/mail.ts';
import { REPORT_DEFAULTS, sendReportTo } from '../services/scheduler.ts';
import { decryptText, matchTotp } from '../services/secrets.ts';

export const publicAuth = Router();
export const admin = Router();

const passwordRule = z.string().min(10, 'Use at least 10 characters.').max(128);

/** Checks an authenticator code (each usable once) or a one-time recovery code. */
function acceptSecondFactor(user: any, code: string) {
  if (/^\d{6}$/.test(code)) {
    const step = matchTotp(decryptText(user.totp_secret), code, user.totp_last_step);
    if (step === null) return false;
    run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
    return true;
  }
  const hash = createHash('sha256').update(code.toLowerCase()).digest('hex');
  const left: string[] = JSON.parse(user.recovery_codes);
  if (!left.includes(hash)) return false;
  run('UPDATE users SET recovery_codes = ? WHERE id = ?', JSON.stringify(left.filter((c) => c !== hash)), user.id);
  return true;
}

// ---------- Sign in ----------
publicAuth.post('/auth/login', async (req, res) => {
  const { email, password, code, remember } = z.object({
    email: z.string().trim().toLowerCase(),
    password: z.string().max(200),
    code: z.string().trim().max(20).optional(),
    remember: z.boolean().default(false),
  }).parse(req.body);
  const key = `${req.ip}|${email}`;
  assertNotLocked(key);
  // Staff may sign in with their email or their mobile number.
  const digits = email.replace(/\D/g, '').slice(-10);
  const user = get<any>(
    `SELECT id, password_hash, status, totp_enabled, totp_secret, totp_last_step, recovery_codes FROM users
     WHERE email = ? OR (? != '' AND length(phone) >= 10 AND substr(replace(replace(phone, ' ', ''), '-', ''), -10) = ?)`,
    email, digits.length === 10 && !email.includes('@') ? digits : '', digits,
  );
  const valid = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !valid || user.status !== 'active') {
    recordFailure(key);
    audit(null, 'auth.failed', 'user', '', email);
    throw new HttpError(401, 'Incorrect email or password.');
  }
  if (user.totp_enabled) {
    if (!code) return res.json({ needs_code: true });
    if (!acceptSecondFactor(user, code)) {
      recordFailure(key);
      audit(null, 'auth.2fa_failed', 'user', user.id);
      throw new HttpError(401, 'That code is not correct.');
    }
  }
  clearFailures(key);
  createSession(res, user.id, req.ip ?? '', remember);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
  run(`INSERT INTO audit_log(actor_id, action, entity, entity_id, ip) VALUES(?, 'auth.login', 'user', ?, ?)`, user.id, String(user.id), req.ip ?? '');
  res.json({ ok: true });
});

publicAuth.get('/meta', (_req, res) => {
  res.json({ demoMode: config.demoMode, whatsappLive: whatsappLive() });
});

// ---------- Session ----------
admin.get('/auth/me', (req, res) => {
  res.json({
    user: req.user,
    demoMode: config.demoMode,
    whatsappLive: whatsappLive(),
    telephonyLive: telephonyLive(),
    aiEnabled: Boolean(config.gemini.key),
    mustSetupTwoFactor: adminNeedsTwoFactor(req.user),
  });
});

admin.post('/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

admin.post('/auth/password', async (req, res) => {
  const b = z.object({ current: z.string(), next: passwordRule }).parse(req.body);
  const user = get<any>('SELECT password_hash FROM users WHERE id = ?', req.user.id)!;
  if (!(await verifyPassword(b.current, user.password_hash))) throw new HttpError(400, 'Your current password is not correct.');
  if (b.current === b.next) throw new HttpError(400, 'Choose a different password.');
  run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', await hashPassword(b.next), req.user.id);
  const remember = sessionRemembered(req);
  destroyUserSessions(req.user.id);
  createSession(res, req.user.id, req.ip ?? '', remember);
  audit(req, 'auth.password_changed', 'user', req.user.id);
  res.json({ ok: true });
});

admin.get('/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 5000\n\n');
  const unsubscribe = subscribe(req.user.id, res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

// ---------- Notifications ----------
admin.get('/notifications', (req, res) => {
  res.json({
    notifications: all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30', req.user.id),
    unread: get<{ n: number }>('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', req.user.id)!.n,
  });
});

admin.post('/notifications/read', (req, res) => {
  run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), req.user.id);
  res.json({ ok: true });
});

// ---------- Dashboard ----------
function countsFor(req: Request) {
  const base = leadScope(req.user);
  const { project, owner, source, created_from, created_to } = req.query;
  const filter = leadFilters({ project, owner, source, created_from, created_to });
  const scope = { sql: base.sql + clauseSql(filter), params: [...base.params, ...filter.params] };
  const count = (extra: string, ...p: (string | number)[]) =>
    get<{ n: number }>(`SELECT COUNT(*) n FROM leads l WHERE ${scope.sql} AND ${extra}`, ...scope.params, ...p)!.n;
  return { scope, count };
}

const dayStart = () => nowIso().slice(0, 10) + ' 00:00:00';
const monthStart = () => nowIso().slice(0, 8) + '01 00:00:00';

admin.get('/dashboard', (req, res) => {
  const { scope, count } = countsFor(req);
  const user = req.user;
  const today = dayStart();
  const month = monthStart();
  const now = nowIso();

  const activityCount = (type: string, extra = '') =>
    get<{ n: number }>(
      `SELECT COUNT(*) n FROM activities a JOIN leads l ON l.id = a.lead_id
       WHERE ${scope.sql} AND a.type = ? AND a.created_at >= ? ${extra}`,
      ...scope.params, type, today,
    )!.n;

  const visitsToday = all(
    `SELECT v.id, v.lead_id, v.scheduled_at, v.status, l.name AS lead_name, p.name AS project_name, h.name AS host_name
     FROM site_visits v JOIN leads l ON l.id = v.lead_id JOIN projects p ON p.id = v.project_id LEFT JOIN users h ON h.id = v.host_id
     WHERE ${scope.sql} AND date(v.scheduled_at) = date(?) ORDER BY v.scheduled_at`,
    ...scope.params, now,
  );

  const myTasks = all(
    `SELECT t.id, t.lead_id, t.type, t.due_at, t.notes, l.name AS lead_name, l.temperature FROM tasks t JOIN leads l ON l.id = t.lead_id
     WHERE t.owner_id = ? AND t.completed_at IS NULL AND l.deleted_at IS NULL ORDER BY t.due_at LIMIT 12`,
    user.id,
  );

  const queue = ['telecaller', 'closing_manager'].includes(user.role)
    ? all(
        `SELECT l.id, l.name, l.source, l.stage, l.temperature, l.created_at, p.name AS project_name FROM leads l LEFT JOIN projects p ON p.id = l.project_id
         WHERE ${scope.sql} AND l.owner_id = ? AND l.stage IN ('Not Contacted','Contacted','Qualified')
         ORDER BY l.first_response_at IS NOT NULL, l.score DESC, l.created_at DESC LIMIT 10`,
        ...scope.params, user.id,
      )
    : [];

  const funnel = ['Not Contacted', 'Contacted', 'Qualified', 'Site Visit Scheduled', 'Site Visit Done', 'Working Deal', 'Booked'].map((stage) => ({
    stage,
    count: count('l.stage = ?', stage),
  }));

  const bySource = all(
    `SELECT l.source AS label, COUNT(*) AS value FROM leads l WHERE ${scope.sql} GROUP BY l.source ORDER BY value DESC LIMIT 7`,
    ...scope.params,
  );

  const reports = user.role === 'admin' ? [] : teamOf(user.id);
  const teamFilter = reports.length || ['sourcing_manager', 'closing_manager'].includes(user.role) ? `AND u.id IN (${[user.id, ...reports].map(Number).join(',')})` : '';
  const leaderboard = isManager(user.role)
    ? all(
        `SELECT u.id, u.name, u.role,
           (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.deleted_at IS NULL) AS leads,
           (SELECT COUNT(*) FROM activities a WHERE a.actor_id = u.id AND a.type = 'call' AND a.created_at >= ?) AS calls_today,
           (SELECT COUNT(*) FROM site_visits v WHERE v.host_id = u.id AND v.status IN ('Checked In','Completed') AND v.scheduled_at >= ?) AS visits_month,
           (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.stage = 'Booked' AND l.updated_at >= ?) AS booked_month
         FROM users u WHERE u.role IN ('closing_manager','telecaller') AND u.status = 'active' ${teamFilter}
         ORDER BY booked_month DESC, visits_month DESC, calls_today DESC LIMIT 8`,
        today, month, month,
      )
    : [];

  const revenue = isManager(user.role)
    ? get<{ v: number }>(
        `SELECT COALESCE(SUM(a.amount_lakhs), 0) v FROM approvals a JOIN leads l ON l.id = a.lead_id
         WHERE ${scope.sql} AND a.type = 'booking' AND a.status = 'approved' AND a.reviewed_at >= ?`,
        ...scope.params, month,
      )!.v
    : null;

  // Admins see every telecaller; a Site Head sees results on their own projects.
  const topTele = user.role === 'admin' ? topTelecallers(null) : user.role === 'site_head' ? topTelecallers(user.project_ids) : null;

  res.json({
    top_telecallers: topTele,
    stats: {
      totalLeads: count('1 = 1'),
      newToday: count('l.created_at >= ?', today),
      hot: count(`l.temperature = 'Hot' AND l.stage NOT IN ('Booked','Lost','Unqualified')`),
      awaitingResponse: count(`l.first_response_at IS NULL AND l.stage = 'Not Contacted'`),
      unassigned: count('l.owner_id IS NULL'),
      unread: count('l.unread_count > 0'),
      callsToday: activityCount('call', !isManager(user.role) ? `AND a.actor_id = ${Number(user.id)}` : ''),
      bookedThisMonth: count(`l.stage = 'Booked' AND l.updated_at >= ?`, month),
      overdueTasks: get<{ n: number }>(
        `SELECT COUNT(*) n FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE ${scope.sql} AND t.completed_at IS NULL AND t.due_at < ?`,
        ...scope.params, now,
      )!.n,
      pendingApprovals: get<{ n: number }>(
        `SELECT COUNT(*) n FROM approvals a JOIN leads l ON l.id = a.lead_id WHERE ${scope.sql} AND a.status = 'pending'`,
        ...scope.params,
      )!.n,
      revenueLakhs: revenue,
    },
    funnel,
    bySource,
    channels: all(`SELECT CASE WHEN l.source IN ('99acres','MagicBricks','Housing.com') THEN 'Portals' WHEN l.source IN ('Manual','Walk-in','Referral','Channel Partner') THEN 'Manual and referrals' WHEN l.source = 'Sheet Upload' THEN 'Sheets' ELSE l.source END AS label, COUNT(*) AS value, SUM(l.created_at >= ?) AS today FROM leads l WHERE ${scope.sql} GROUP BY label ORDER BY value DESC`, today, ...scope.params),
    callOutcomes: all(`SELECT replace(a.title, 'Call: ', '') AS label, COUNT(*) AS value FROM activities a JOIN leads l ON l.id = a.lead_id WHERE ${scope.sql} AND a.type = 'call' AND a.created_at >= ? GROUP BY label ORDER BY value DESC LIMIT 6`, ...scope.params, month),
    visitsToday,
    myTasks,
    queue,
    leaderboard,
  });
});

admin.post('/ad-spend', requirePermission('campaign.create'), (req, res) => {
  const b = z.object({
    source: z.enum(SOURCES),
    campaign: z.string().trim().max(100).default(''),
    project_id: z.number().int().nullish(),
    spend_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amount_inr: z.number().positive(),
  }).parse(req.body);
  run('INSERT INTO ad_spend(source, campaign, project_id, spend_date, amount_inr, created_by) VALUES(?, ?, ?, ?, ?, ?)', b.source, b.campaign, b.project_id ?? null, b.spend_date, b.amount_inr, req.user.id);
  audit(req, 'adspend.add', 'ad_spend', '', `${b.source} ${b.amount_inr}`);
  res.status(201).json({ ok: true });
});

// ---------- Users ----------
const userBody = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().transform((v) => v.toLowerCase()),
  phone: z.string().max(20).optional(),
  role: z.enum(ROLES),
  project_ids: z.array(z.number().int()).default([]),
  languages: z.array(z.enum(['en', 'hi', 'mr'])).default([]),
  team: z.string().trim().max(60).default(''),
  manager_id: z.number().int().nullish(),
});

const setProjects = (userId: number, ids: number[]) => {
  run('DELETE FROM user_projects WHERE user_id = ?', userId);
  for (const id of ids) run('INSERT INTO user_projects(user_id, project_id) VALUES(?, ?)', userId, id);
};

admin.get('/users', requirePermission('user.manage'), (_req, res) => {
  const users = all<any>(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.status, u.languages, u.team, u.last_login_at, u.created_at, u.manager_id, m.name AS manager_name
     FROM users u LEFT JOIN users m ON m.id = u.manager_id ORDER BY u.status, u.name`,
  );
  res.json({
    users: users.map((u) => ({
      ...u,
      languages: u.languages ? u.languages.split(',') : [],
      project_ids: all<any>('SELECT project_id FROM user_projects WHERE user_id = ?', u.id).map((p) => p.project_id),
    })),
  });
});

admin.post('/users', requirePermission('user.manage'), async (req, res) => {
  const b = userBody.parse(req.body);
  if (get('SELECT 1 AS x FROM users WHERE email = ?', b.email)) throw new HttpError(409, 'This email already has an account.');
  if (b.manager_id) assertManager(null, b.manager_id);
  const temporaryPassword = generatePassword();
  const hash = await hashPassword(temporaryPassword);
  const id = tx(() => {
    const r = run('INSERT INTO users(name, email, phone, role, password_hash, languages, team, manager_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?)', b.name, b.email, b.phone ?? '', b.role, hash, b.languages.join(','), b.team, b.manager_id ?? null);
    setProjects(r.id, b.project_ids);
    return r.id;
  });
  audit(req, 'user.create', 'user', id, `${b.email} as ${b.role}`);
  res.status(201).json({ id, temporaryPassword });
});

admin.put('/users/:id', requirePermission('user.manage'), (req, res) => {
  const id = Number(req.params.id);
  const b = userBody.parse(req.body);
  if (id === req.user.id && b.role !== req.user.role) throw new HttpError(400, 'You cannot change your own role.');
  if (b.manager_id) assertManager(id, b.manager_id);
  tx(() => {
    run('UPDATE users SET name = ?, email = ?, phone = ?, role = ?, languages = ?, team = ? WHERE id = ?', b.name, b.email, b.phone ?? '', b.role, b.languages.join(','), b.team, id);
    if (b.manager_id !== undefined) run('UPDATE users SET manager_id = ? WHERE id = ?', b.manager_id, id);
    setProjects(id, b.project_ids);
  });
  destroyUserSessions(id);
  audit(req, 'user.update', 'user', id, `role ${b.role}`);
  res.json({ ok: true });
});

/** Moves everyone reporting to this person, for when a manager leaves or changes teams. */
admin.post('/users/:id/move-team', requirePermission('user.manage'), (req, res) => {
  const id = Number(req.params.id);
  const { manager_id: target } = z.object({ manager_id: z.number().int().nullable() }).parse(req.body);
  if (target) assertManager(id, target);
  const { changes } = run('UPDATE users SET manager_id = ? WHERE manager_id = ?', target, id);
  audit(req, 'user.move_team', 'user', id, `${changes} people to ${target ?? 'no manager'}`);
  res.json({ moved: changes });
});

admin.post('/users/:id/status', requirePermission('user.manage'), (req, res) => {
  const id = Number(req.params.id);
  const { status } = z.object({ status: z.enum(['active', 'paused']) }).parse(req.body);
  if (id === req.user.id) throw new HttpError(400, 'You cannot pause your own account.');
  run('UPDATE users SET status = ? WHERE id = ?', status, id);
  if (status === 'paused') destroyUserSessions(id);
  audit(req, `user.${status}`, 'user', id);
  res.json({ ok: true });
});

admin.post('/users/:id/reset-password', requirePermission('user.manage'), async (req, res) => {
  const id = Number(req.params.id);
  const temporaryPassword = generatePassword();
  run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', await hashPassword(temporaryPassword), id);
  destroyUserSessions(id);
  audit(req, 'user.reset_password', 'user', id);
  res.json({ temporaryPassword });
});

// ---------- Settings ----------
const settingKeys = {
  sla_minutes: 15,
  hold_hours: 24,
  discount_limit_percent: 2,
  business_hours: { start: 10, end: 19 },
  mask_phone_roles: [] as string[],
  record_calls: false,
  payment_plan: [] as { label: string; percent: number }[],
  routing_mode: 'round_robin',
  inactive_alert_days: 3,
  auto_reassign_days: 0,
  drip_wait_days: 3,
  wa_daily_limit: 1000,
  wa_cost_per_message: null as number | null,
  report_schedule: REPORT_DEFAULTS,
  custom_stages: [] as string[],
  enforce_call_updates: true,
  alert_rules: ALERT_DEFAULTS,
};

admin.get('/settings', requirePermission('settings.manage'), (req, res) => {
  res.json({
    settings: { ...Object.fromEntries(Object.entries(settingKeys).map(([k, v]) => [k, getSetting(k, v)])), alert_rules: alertRules() },
    automations: all(
      `SELECT a.key, a.name, a.description, a.enabled, a.template_id, t.name AS template_name, t.status AS template_status
       FROM automations a LEFT JOIN wa_templates t ON t.id = a.template_id ORDER BY a.name`,
    ),
    integrations: connectionList(req.user.role === 'admin'),
    firebase: {
      connected: fcmReady(), project: fcmProject(), phones: phonesByPerson(), last: lastPhoneSend(), quiet: quietStatus(),
      app_connected: Boolean(fcmClient()), app_project: fcmClient()?.project_id ?? '',
    },
    wa_quality: getSetting('wa_quality', null),
    backup_last: getSetting('backup_last', ''),
    backup_download_last: getSetting('backup_download_last', ''),
    is_admin: req.user.role === 'admin',
    report_runs: all(
      `SELECT r.id, r.period, r.channel, r.status, r.created_at, u.name AS user_name FROM report_runs r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 20`,
    ),
  });
});

admin.put('/connections/:key', requirePermission('settings.manage'), (req, res) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can change connection keys.');
  const b = z.object({
    values: z.record(z.string(), z.string().max(4000)).default({}),
    clear: z.array(z.string().max(40)).max(20).default([]),
  }).parse(req.body);
  const key = String(req.params.key);
  const changed = saveConnection(key, b.values, b.clear);
  if (changed.length) audit(req, 'connection.update', 'connection', key, changed.join(', '));
  res.json({ ok: true, changed });
});

admin.put('/settings', requirePermission('settings.manage'), (req, res) => {
  const b = z.object({
    sla_minutes: z.number().int().min(1).max(1440),
    hold_hours: z.number().int().min(1).max(168),
    discount_limit_percent: z.number().min(0).max(50),
    business_hours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24) }),
    mask_phone_roles: z.array(z.enum(ROLES)),
    record_calls: z.boolean(),
    payment_plan: z.array(z.object({ label: z.string().trim().min(2).max(80), percent: z.number().positive().max(100) })).max(40),
    routing_mode: z.enum(['round_robin', 'workload']),
    inactive_alert_days: z.number().int().min(0).max(90),
    auto_reassign_days: z.number().int().min(0).max(90),
    drip_wait_days: z.number().int().min(1).max(30),
    wa_daily_limit: z.number().int().min(1).max(1000000),
    wa_cost_per_message: z.number().min(0).max(100).nullable(),
    report_schedule: z.object({ daily: z.boolean(), weekly: z.boolean(), hour: z.number().int().min(0).max(23), email: z.boolean(), whatsapp: z.boolean() }),
    custom_stages: z.array(z.string().trim().min(2).max(40)).max(10),
    enforce_call_updates: z.boolean(),
  }).parse(req.body);
  for (const [key, value] of Object.entries(b)) setSetting(key, value);
  audit(req, 'settings.update', 'settings');
  res.json({ ok: true });
});

// ---------- Workflow rules ----------
const workflowBody = z.object({
  name: z.string().trim().min(3).max(80),
  enabled: z.boolean().default(true),
  trigger: z.enum(['lead_created', 'stage_changed', 'lead_idle']),
  conditions: z.object({
    source: z.string().max(40).optional(), project_id: z.number().int().optional(), temperature: z.enum(['Hot', 'Warm', 'Cold']).optional(),
    stage: z.string().max(40).optional(), days: z.number().int().min(1).max(365).optional(),
  }).default({}),
  action: z.enum(['create_task', 'add_label', 'assign_owner', 'notify_owner', 'send_template']),
  config: z.object({
    task_type: z.string().trim().max(30).optional(), after_minutes: z.number().int().min(0).max(43200).optional(), label: z.string().trim().max(40).optional(),
    user_id: z.number().int().optional(), text: z.string().trim().max(120).optional(), template_id: z.number().int().optional(),
  }).default({}),
}).superRefine((b, ctx) => {
  const missing = (b.action === 'add_label' && !b.config.label) || (b.action === 'assign_owner' && !b.config.user_id) || (b.action === 'send_template' && !b.config.template_id);
  if (missing) ctx.addIssue({ code: 'custom', message: 'Complete the action details.' });
  if (b.trigger === 'stage_changed' && !b.conditions.stage) ctx.addIssue({ code: 'custom', message: 'Choose which stage starts this rule.' });
  if (b.trigger === 'lead_idle' && !b.conditions.days) ctx.addIssue({ code: 'custom', message: 'Choose how many quiet days start this rule.' });
});

admin.get('/workflows', requirePermission('settings.manage'), (_req, res) => {
  res.json({ rules: all<any>('SELECT * FROM workflow_rules ORDER BY id DESC').map((r) => ({ ...r, conditions: JSON.parse(r.conditions), config: JSON.parse(r.config) })) });
});

admin.post('/workflows', requirePermission('settings.manage'), (req, res) => {
  const b = workflowBody.parse(req.body);
  const { id } = run('INSERT INTO workflow_rules(name, enabled, trigger, conditions, action, config, created_by) VALUES(?, ?, ?, ?, ?, ?, ?)',
    b.name, b.enabled ? 1 : 0, b.trigger, JSON.stringify(b.conditions), b.action, JSON.stringify(b.config), req.user.id);
  audit(req, 'workflow.create', 'workflow', String(id), b.name);
  res.status(201).json({ id });
});

admin.put('/workflows/:id', requirePermission('settings.manage'), (req, res) => {
  const b = workflowBody.parse(req.body);
  run('UPDATE workflow_rules SET name = ?, enabled = ?, trigger = ?, conditions = ?, action = ?, config = ? WHERE id = ?',
    b.name, b.enabled ? 1 : 0, b.trigger, JSON.stringify(b.conditions), b.action, JSON.stringify(b.config), Number(req.params.id));
  audit(req, 'workflow.update', 'workflow', String(req.params.id), b.name);
  res.json({ ok: true });
});

admin.delete('/workflows/:id', requirePermission('settings.manage'), (req, res) => {
  run('DELETE FROM workflow_rules WHERE id = ?', Number(req.params.id));
  audit(req, 'workflow.delete', 'workflow', String(req.params.id));
  res.json({ ok: true });
});

/** Holds the whole business, so only an administrator can take it, and must prove who they are. */
admin.post('/settings/backup', async (req, res) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can download a backup.');
  const b = z.object({ password: z.string().min(1), passphrase: z.string().min(12, 'Use a passphrase of at least 12 characters.').max(200) }).parse(req.body);
  const user = get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', req.user.id)!;
  if (!(await verifyPassword(b.password, user.password_hash))) throw new HttpError(400, 'Your password is not correct.');

  const folder = dataDir();
  const snapshot = join(folder, `.backup-${randomUUID()}.db`);
  db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="archstone-connect-${nowIso().slice(0, 10)}.archstonebackup"`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    await writeBackup(snapshot, folder, b.passphrase, res);
    setSetting('backup_download_last', nowIso());
    audit(req, 'backup.download', 'settings');
  } catch (e) {
    console.error('Backup failed:', (e as Error).message);
    res.destroy();
  } finally {
    rmSync(snapshot, { force: true });
  }
});

admin.put('/settings/alerts', requirePermission('settings.manage'), (req, res) => {
  const hour = z.number().int().min(0).max(23);
  const rules = z.object({
    reminder_minutes: z.number().int().min(0).max(1440),
    overdue_repeat_minutes: z.number().int().min(10).max(1440),
    overdue_max_alerts: z.number().int().min(0).max(10),
    escalate_after_minutes: z.number().int().min(0).max(10080),
    quiet_enabled: z.boolean(),
    quiet_start: hour,
    quiet_end: hour,
    morning_summary: z.boolean(),
    summary_hour: hour,
    whatsapp_new_lead: z.boolean(),
    whatsapp_followup: z.boolean(),
    whatsapp_overdue: z.boolean(),
  }).parse(req.body);
  setSetting('alert_rules', rules);
  audit(req, 'settings.alerts', 'settings');
  res.json({ ok: true });
});

admin.post('/settings/firebase', requirePermission('settings.manage'), (req, res) => {
  const file = z.object({
    type: z.literal('service_account', { error: 'Choose the Firebase service account file.' }),
    project_id: z.string().min(1).max(100),
    client_email: z.email(),
    private_key: z.string().min(100).max(8000),
  }).parse(req.body);
  try {
    saveFcmAccount(file);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  audit(req, 'settings.firebase_connected', 'settings');
  res.status(201).json({ ok: true, project: file.project_id });
});

admin.delete('/settings/firebase', requirePermission('settings.manage'), (req, res) => {
  clearFcmAccount();
  audit(req, 'settings.firebase_removed', 'settings');
  res.json({ ok: true });
});

admin.post('/settings/firebase-app', requirePermission('settings.manage'), (req, res) => {
  let client;
  try {
    client = parseGoogleServices(req.body);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  saveFcmClient(client);
  audit(req, 'settings.firebase_app_connected', 'settings');
  res.status(201).json({ ok: true, project: client.project_id });
});

admin.delete('/settings/firebase-app', requirePermission('settings.manage'), (req, res) => {
  clearFcmClient();
  audit(req, 'settings.firebase_app_removed', 'settings');
  res.json({ ok: true });
});

admin.post('/settings/firebase/test', requirePermission('settings.manage'), async (req, res) => {
  if (!fcmReady()) throw new HttpError(400, 'Connect Firebase first.');
  // Goes to every device of this admin: the Android app (Firebase) and the installed web app / browsers.
  const result = await pushToUser(req.user.id, 'Archstone Connect test', 'Phone notifications are working.', '/account');
  if (!result.devices && !result.web.devices) {
    throw new HttpError(400, 'No device has notifications on for you. Open My Account → Phone notifications → Turn on for this device, or sign in to the Android app on your phone.');
  }
  if (!result.sent && !result.web.sent) throw new HttpError(502, result.error || result.web.error || 'The notification could not be delivered.');
  res.json(result);
});

admin.post('/reports/send-now', requirePermission('settings.manage'), async (req, res) => {
  const { period } = z.object({ period: z.enum(['daily', 'weekly']) }).parse(req.body);
  await sendReportTo(req.user.id, period);
  audit(req, 'report.send_now', 'report', '', period);
  res.json({ ok: true });
});

admin.put('/automations/:key', requirePermission('settings.manage'), (req, res) => {
  const b = z.object({ enabled: z.boolean(), template_id: z.number().int().nullish() }).parse(req.body);
  run('UPDATE automations SET enabled = ?, template_id = ? WHERE key = ?', b.enabled ? 1 : 0, b.template_id ?? null, String(req.params.key));
  audit(req, 'automation.update', 'automation', String(req.params.key), String(b.enabled));
  res.json({ ok: true });
});

admin.get('/audit', requirePermission('audit.view'), (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const where = ['1 = 1'];
  const params: (string | number)[] = [];
  if (q.q) { where.push('(a.action LIKE ? OR a.detail LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.actor) { where.push('a.actor_id = ?'); params.push(q.actor); }
  if (q.group) { where.push('a.action LIKE ?'); params.push(`${q.group}.%`); }
  if (q.created_from) { where.push('datetime(a.created_at) >= datetime(?)'); params.push(q.created_from); }
  if (q.created_to) { where.push('datetime(a.created_at) <= datetime(?)'); params.push(q.created_to); }
  res.json({
    entries: all(
      `SELECT a.*, u.name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT 500`,
      ...params,
    ),
    groups: all<{ g: string }>(`SELECT DISTINCT substr(action, 1, instr(action, '.') - 1) AS g FROM audit_log WHERE instr(action, '.') > 0 ORDER BY g`).map((r) => r.g),
  });
});

