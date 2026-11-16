import { ROLE_GOALS, isManager, isViewOnly, type Role } from '../../shared/domain.ts';
import { projectIdsOf, roleTargets } from '../services/targets.ts';
import { teamOf } from '../services/hierarchy.ts';
import express, { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { HttpError, assertCan, requirePermission } from '../auth.ts';
import { config } from '../config.ts';
import { all, get, nowIso, run } from '../db.ts';
import { answerFromReport, polishBrief } from '../services/ai.ts';
import { audit, leadScope, presentLead, visibleLead } from '../services/core.ts';
import { agentPerformance } from '../services/performance.ts';
import { clauseSql, leadFilters, leadSort } from '../services/filters.ts';
import { nextBestAction } from '../services/insight.ts';
import { buildReport, currentMonth, leadsWorkbook, readWorkbook, reportPdf, reportWorkbook, targetProgress } from '../services/reports.ts';
import { windowOpen } from '../services/whatsapp.ts';

export const insights = Router();

const days = (v: unknown) => Math.min(365, Math.max(1, Number(v) || 30));

// ---------- Reports ----------
insights.get('/reports', requirePermission('reports.view'), (req, res) => {
  res.json(buildReport(req.user, days(req.query.days), req.query));
});

insights.get('/reports/export', requirePermission('reports.view'), async (req, res) => {
  const format = z.enum(['xlsx', 'pdf']).parse(req.query.format);
  const report = buildReport(req.user, days(req.query.days), req.query);
  audit(req, 'report.export', 'report', '', `${format}, ${report.days} days`);
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="archstone-report.xlsx"');
    return res.send(await reportWorkbook(report));
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="archstone-report.pdf"');
  res.send(await reportPdf(report, req.user.name));
});

insights.get('/leads/export.xlsx', requirePermission('lead.export'), async (req, res) => {
  const scope = leadScope(req.user);
  const filter = leadFilters(req.query);
  const rows = all<any>(
    `SELECT l.name, l.phone, l.email, l.source, l.stage, p.name AS project, l.configuration, l.budget_lakhs, u.name AS assigned_to, l.created_at
     FROM leads l LEFT JOIN projects p ON p.id = l.project_id LEFT JOIN users u ON u.id = l.owner_id
     WHERE ${scope.sql}${clauseSql(filter)} ORDER BY ${leadSort(req.query)}`,
    ...scope.params, ...filter.params,
  ).map((r) => presentLead(req.user, r) as unknown as Record<string, unknown>);
  audit(req, 'lead.export', 'lead', '', `${rows.length} rows, xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="archstone-leads.xlsx"');
  res.send(await leadsWorkbook(['name', 'phone', 'email', 'source', 'stage', 'project', 'configuration', 'budget_lakhs', 'assigned_to', 'created_at'], rows));
});

insights.post('/leads/parse-xlsx', requirePermission('lead.import'), express.raw({ type: () => true, limit: 20 * 1024 * 1024 }), async (req, res) => {
  const data = req.body as Buffer;
  if (!Buffer.isBuffer(data) || data[0] !== 0x50 || data[1] !== 0x4b) throw new HttpError(415, 'Please choose an .xlsx file.');
  res.json({ rows: (await readWorkbook(data)).slice(0, 10000) });
});

// ---------- Performance ----------
insights.get('/performance', (req, res) => res.json(agentPerformance(req.user, req.query as Record<string, string>)));

// ---------- AI ----------
insights.post('/ai/ask', requirePermission('reports.view'), requirePermission('ai.use'), async (req, res) => {
  const { question, days: period } = z.object({ question: z.string().trim().min(5).max(300), days: z.number().int().optional() }).parse(req.body);
  const report = buildReport(req.user, days(period ?? 90));
  audit(req, 'ai.ask', 'report', '', question.slice(0, 120));
  res.json({ answer: await answerFromReport(report, question) });
});

function briefItems(userId: number, userScope: ReturnType<typeof leadScope>) {
  const now = nowIso();
  const items: string[] = [];
  const count = (sql: string, ...p: (string | number)[]) => get<{ n: number }>(sql, ...p)!.n;
  // People who lead a team also need the team's picture, not only their own work.
  const role = get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId)?.role ?? '';
  if (isManager(role)) {
    const waiting = count(`SELECT COUNT(*) n FROM leads l WHERE ${userScope.sql} AND l.first_response_at IS NULL AND l.stage = 'Not Contacted'`, ...userScope.params);
    if (waiting) items.push(`${waiting} lead${waiting > 1 ? 's are' : ' is'} still waiting for a first response.`);
    const approvals = count(`SELECT COUNT(*) n FROM approvals a JOIN leads l ON l.id = a.lead_id WHERE ${userScope.sql} AND a.status = 'pending'`, ...userScope.params);
    if (approvals) items.push(`Review ${approvals} pending approval${approvals > 1 ? 's' : ''}.`);
    const unanswered = count(`SELECT COUNT(*) n FROM leads l WHERE ${userScope.sql} AND l.unread_count > 0`, ...userScope.params);
    if (unanswered) items.push(`${unanswered} WhatsApp chat${unanswered > 1 ? 's are' : ' is'} unanswered across the team.`);
  }
  const overdue = count(`SELECT COUNT(*) n FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE t.owner_id = ? AND t.completed_at IS NULL AND t.due_at < ? AND l.deleted_at IS NULL`, userId, now);
  if (overdue) items.push(`Clear ${overdue} overdue follow-up${overdue > 1 ? 's' : ''}.`);
  const unanswered = count(`SELECT COUNT(*) n FROM leads l WHERE ${userScope.sql} AND l.owner_id = ? AND l.first_response_at IS NULL AND l.stage = 'Not Contacted'`, ...userScope.params, userId);
  if (unanswered) items.push(`Call ${unanswered} new lead${unanswered > 1 ? 's' : ''} waiting for a first response.`);
  const unread = count(`SELECT COUNT(*) n FROM leads l WHERE ${userScope.sql} AND l.owner_id = ? AND l.unread_count > 0`, ...userScope.params, userId);
  if (unread) items.push(`Reply to ${unread} WhatsApp conversation${unread > 1 ? 's' : ''}.`);
  const visits = count(`SELECT COUNT(*) n FROM site_visits v WHERE v.host_id = ? AND v.status IN ('Scheduled','Confirmed') AND date(v.scheduled_at) = date(?)`, userId, now);
  if (visits) items.push(`Prepare for ${visits} site visit${visits > 1 ? 's' : ''} today.`);
  const hot = all<{ name: string }>(
    `SELECT l.name FROM leads l WHERE ${userScope.sql} AND l.owner_id = ? AND l.temperature = 'Hot' AND l.stage NOT IN ('Booked','Lost') ORDER BY l.score DESC LIMIT 3`,
    ...userScope.params, userId,
  );
  if (hot.length) items.push(`Prioritise hot leads: ${hot.map((h) => h.name).join(', ')}.`);
  return items.length ? items : ['You are all caught up. Review your pipeline for your next opportunity.'];
}

insights.get('/brief', (req, res) => {
  res.json({ items: briefItems(req.user.id, leadScope(req.user)), progress: targetProgress(req.user.id) });
});

insights.post('/ai/brief', requirePermission('ai.use'), async (req, res) => {
  res.json({ text: await polishBrief(briefItems(req.user.id, leadScope(req.user))) });
});

insights.get('/leads/:id/next-action', (req, res) => {
  const lead = visibleLead(req.user, Number(req.params.id));
  const openTasks = all<any>('SELECT due_at FROM tasks WHERE lead_id = ? AND completed_at IS NULL', lead.id);
  res.json(nextBestAction({
    stage: lead.stage,
    do_not_contact: lead.do_not_contact,
    unread_count: lead.unread_count,
    intent: lead.intent,
    overdueTasks: openTasks.filter((t) => t.due_at < nowIso()).length,
    hasOpenTask: openTasks.length > 0,
    hasUpcomingVisit: Boolean(get(`SELECT 1 AS x FROM site_visits WHERE lead_id = ? AND status IN ('Scheduled','Confirmed')`, lead.id)),
    windowOpen: windowOpen(lead),
    hasBooking: Boolean(get(`SELECT 1 AS x FROM bookings WHERE lead_id = ? AND status = 'active'`, lead.id)),
    documents: get<{ n: number }>('SELECT COUNT(*) n FROM documents WHERE lead_id = ?', lead.id)!.n,
  }));
});

// ---------- Saved filters ----------
insights.get('/saved-filters', (req, res) => {
  res.json({ filters: all('SELECT id, name, query FROM saved_filters WHERE user_id = ? ORDER BY name', req.user.id) });
});

insights.post('/saved-filters', (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(40), query: z.string().max(400) }).parse(req.body);
  run(
    `INSERT INTO saved_filters(user_id, name, query) VALUES(?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET query = excluded.query`,
    req.user.id, b.name, b.query,
  );
  res.status(201).json({ ok: true });
});

insights.delete('/saved-filters/:id', (req, res) => {
  run('DELETE FROM saved_filters WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ---------- Calendar ----------
insights.get('/calendar', (req, res) => {
  const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  const scope = leadScope(req.user);
  const mine = !isManager(req.user.role) ? 'AND t.owner_id = ?' : '';
  const tasks = all(
    `SELECT t.id, t.lead_id, t.type AS title, t.due_at AS at, l.name AS lead_name, u.name AS owner, 'task' AS kind
     FROM tasks t JOIN leads l ON l.id = t.lead_id JOIN users u ON u.id = t.owner_id
     WHERE ${scope.sql} ${mine} AND t.completed_at IS NULL AND t.type != 'Site Visit' AND t.due_at BETWEEN ? AND ?`,
    ...scope.params, ...(mine ? [req.user.id] : []), `${q.from} 00:00:00`, `${q.to} 23:59:59`,
  );
  const visits = all(
    `SELECT v.id, v.lead_id, 'Site visit' AS title, v.scheduled_at AS at, l.name AS lead_name, p.name AS owner, 'visit' AS kind
     FROM site_visits v JOIN leads l ON l.id = v.lead_id JOIN projects p ON p.id = v.project_id
     WHERE ${scope.sql} AND v.status IN ('Scheduled','Confirmed','Checked In') AND v.scheduled_at BETWEEN ? AND ?`,
    ...scope.params, `${q.from} 00:00:00`, `${q.to} 23:59:59`,
  );
  res.json({ events: [...tasks, ...visits] });
});

// ---------- Targets ----------
/** Only an admin sets monthly targets. Each goal must be one the person's role is measured on. */
insights.put('/users/:id/target', (req, res) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Only an admin can set targets.');
  const person = get<{ id: number; role: Role }>('SELECT id, role FROM users WHERE id = ?', Number(req.params.id));
  if (!person) throw new HttpError(404, 'User not found.');
  const allowed = ROLE_GOALS[person.role] ?? [];
  if (!allowed.length) throw new HttpError(400, 'This role has no targets.');
  const amount = z.number().min(0).max(1000000);
  const b = z.object({
    goals: z.record(z.string(), amount).optional(),
    calls: amount.optional(), visits: amount.optional(), bookings: amount.optional(),
  }).parse(req.body);
  // Older screens sent calls, visits and bookings directly.
  const given: Record<string, number> = b.goals ?? Object.fromEntries((['calls', 'visits', 'bookings'] as const).filter((k) => b[k] !== undefined).map((k) => [k, b[k]!]));
  const unknown = Object.keys(given).filter((k) => !(allowed as string[]).includes(k));
  if (unknown.length) throw new HttpError(400, `Not a goal for this role: ${unknown.join(', ')}.`);
  const goals = Object.fromEntries(allowed.map((k) => [k, Math.max(0, Number(given[k] ?? 0))]));
  run(
    `INSERT INTO targets(user_id, month, calls, visits, bookings, goals) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET calls = excluded.calls, visits = excluded.visits, bookings = excluded.bookings, goals = excluded.goals`,
    person.id, currentMonth(), Math.round(goals.calls ?? 0), Math.round(goals.visits ?? 0), Math.round(goals.bookings ?? 0), JSON.stringify(goals),
  );
  audit(req, 'target.set', 'user', person.id, JSON.stringify(goals));
  res.json({ ok: true });
});

/** Everyone the viewer may see: an admin sees all; a manager sees their team; a site head also sees people on their projects. */
insights.get('/targets', requirePermission('reports.view'), (req, res) => {
  if (isViewOnly(req.user.role)) throw new HttpError(403, 'Targets are not available for your role.');
  const roles = (Object.keys(ROLE_GOALS) as Role[]).filter((r) => ROLE_GOALS[r].length).map((r) => `'${r}'`).join(',');
  let people = all<any>(`SELECT id, name, role FROM users WHERE role IN (${roles}) AND status = 'active' ORDER BY name`);
  if (req.user.role !== 'admin') {
    const team = new Set([req.user.id, ...teamOf(req.user.id)]);
    const shared = req.user.role === 'site_head' && req.user.project_ids.length
      ? new Set(all<{ user_id: number }>(`SELECT DISTINCT user_id FROM user_projects WHERE project_id IN (${req.user.project_ids.join(',')})`).map((r) => r.user_id))
      : new Set<number>();
    people = people.filter((p) => team.has(p.id) || shared.has(p.id));
  }
  res.json({
    can_edit: req.user.role === 'admin',
    month: currentMonth(),
    people: people.map((p) => ({ ...p, ...roleTargets({ ...p, project_ids: projectIdsOf(p.id) }), progress: targetProgress(p.id) })),
  });
});

// ---------- Hoarding QR codes ----------
insights.get('/projects/:id/qr', async (req, res) => {
  const project = get<any>('SELECT name FROM projects WHERE id = ?', Number(req.params.id));
  if (!project) throw new HttpError(404, 'Project not found.');
  if (!config.whatsappDisplayNumber) throw new HttpError(503, 'Add your WhatsApp number in Settings, Integrations first.');
  const link = `https://wa.me/${config.whatsappDisplayNumber}?text=${encodeURIComponent(`Hi, I am interested in ${project.name}`)}`;
  res.json({ link, qr: await QRCode.toDataURL(link, { width: 600, margin: 2 }) });
});

// ---------- Deleted leads ----------
insights.get('/leads-deleted', requirePermission('lead.delete'), (_req, res) => {
  res.json({
    leads: all(`SELECT id, name, source, stage, deleted_at FROM leads WHERE deleted_at IS NOT NULL AND merged_into IS NULL AND name != 'Erased contact' ORDER BY deleted_at DESC LIMIT 200`),
  });
});

// ---------- Sign-in history ----------
insights.get('/account/logins', (req, res) => {
  res.json({
    logins: all(`SELECT created_at, ip FROM audit_log WHERE action = 'auth.login' AND actor_id = ? ORDER BY id DESC LIMIT 10`, req.user.id),
    sessions: get<{ n: number }>('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND expires_at > ?', req.user.id, nowIso())!.n,
  });
});
