// Calling mode: one lead at a time, with the result saved before the next lead opens.
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, requirePermission } from '../auth.ts';
import { all, get, getSetting, minutesFromNow, nowIso, run, tx } from '../db.ts';
import { audit, broadcast, leadScope, normalizePhone, notify, presentLead, workableLead } from '../services/core.ts';
import { ingestLead, logActivity, markResponded } from '../services/leads.ts';

export const dialer = Router();

const openCall = (userId: number) =>
  get<any>('SELECT c.id, c.lead_id, l.name FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.user_id = ? AND c.pending = 1 ORDER BY c.id DESC LIMIT 1', userId);

const enforced = () => getSetting('enforce_call_updates', true);

/** A call that leaves through the phone's own dialer is held open until its result is saved. */
dialer.post('/dialer/start/:leadId', (req, res) => {
  const lead = workableLead(req.user, Number(req.params.leadId));
  if (lead.do_not_contact) throw new HttpError(422, 'This contact is marked do not contact.');
  const open = openCall(req.user.id);
  if (open && open.lead_id !== lead.id && enforced()) {
    throw new HttpError(409, `Save the result of your call with ${open.name} first.`);
  }
  if (!open || open.lead_id !== lead.id) {
    run(`INSERT INTO calls(lead_id, user_id, provider_id, status, pending) VALUES(?, ?, ?, 'dialling', 1)`, lead.id, req.user.id, `phone-${randomUUID()}`);
  }
  res.status(201).json({ ok: true });
});

dialer.get('/dialer/next', (req, res) => {
  const open = openCall(req.user.id);
  const pendingId = open && enforced() ? open.lead_id : null;
  const list = Number(req.query.list) || null;
  const scope = leadScope(req.user);
  const skip = Number(req.query.skip) || 0;
  const callable = `${scope.sql} AND l.owner_id = ? AND l.do_not_contact = 0
    AND l.stage IN ('Not Contacted','Contacted','Qualified','Did Not Respond','Future Prospect')
    AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.type = 'call' AND a.created_at > ?)
    ${list ? 'AND l.call_list_id = ?' : ''} ${skip ? 'AND l.id != ?' : ''}`;
  const params = [...scope.params, req.user.id, minutesFromNow(-240), ...(list ? [list] : []), ...(skip ? [skip] : [])];
  const remaining = get<{ n: number }>(`SELECT COUNT(*) n FROM leads l WHERE ${callable}`, ...params)!.n;
  const row = pendingId
    ? get<any>('SELECT l.* FROM leads l WHERE l.id = ?', pendingId)
    : get<any>(
        `SELECT l.* FROM leads l WHERE ${callable}
         ORDER BY EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.completed_at IS NULL AND t.due_at < ?) DESC,
           l.first_response_at IS NOT NULL, l.score DESC, l.created_at DESC LIMIT 1`,
        ...params, nowIso(),
      );
  if (!row) return res.json({ lead: null, remaining: 0, calls_today: callsToday(req.user.id) });
  const project = row.project_id ? get<any>('SELECT name, location, call_script, objections FROM projects WHERE id = ?', row.project_id) : null;
  const last = get<any>(`SELECT title, body, created_at FROM activities WHERE lead_id = ? AND type IN ('call','note') ORDER BY id DESC LIMIT 1`, row.id);
  res.json({ lead: presentLead(req.user, row), project, last, pending: Boolean(pendingId), remaining, calls_today: callsToday(req.user.id) });
});

const callsToday = (userId: number) =>
  get<{ n: number }>(`SELECT COUNT(*) n FROM activities WHERE actor_id = ? AND type = 'call' AND created_at >= ?`, userId, `${nowIso().slice(0, 10)} 00:00:00`)!.n;

/** One-click SMS or email: the phone sends it, and this records that it happened. */
dialer.post('/leads/:id/touch', (req, res) => {
  const lead = workableLead(req.user, Number(req.params.id));
  const { channel } = z.object({ channel: z.enum(['sms', 'email']) }).parse(req.body);
  if (lead.do_not_contact) throw new HttpError(422, 'This contact is marked do not contact.');
  logActivity(lead.id, 'note', channel === 'sms' ? 'SMS opened from the app' : 'Email opened from the app', '', req.user.id);
  markResponded(lead.id);
  res.json({ ok: true });
});

// ---------- Cold-calling lists ----------
dialer.get('/dialer/lists', (req, res) => {
  const scope = leadScope(req.user);
  res.json({
    lists: all(
      `SELECT c.id, c.name, c.created_at, p.name AS project_name,
        COUNT(l.id) AS total,
        SUM(l.stage = 'Not Contacted') AS untouched,
        SUM(l.stage IN ('Qualified','Site Visit Scheduled','Site Visit Done','Working Deal','Booked')) AS interested
       FROM call_lists c LEFT JOIN projects p ON p.id = c.project_id
       JOIN leads l ON l.call_list_id = c.id AND ${scope.sql}
       GROUP BY c.id ORDER BY c.id DESC LIMIT 50`,
      ...scope.params,
    ),
  });
});

/**
 * Cleans an uploaded file, then shares it out equally. Repeats and bad numbers
 * are removed and counted. Numbers already in the CRM keep their current owner.
 */
dialer.post('/dialer/lists', requirePermission('lead.import'), (req, res) => {
  const b = z.object({
    name: z.string().trim().min(2).max(80),
    project_id: z.number().int().nullish(),
    agent_ids: z.array(z.number().int()).min(1, 'Choose at least one person.').max(100),
    rows: z.array(z.record(z.string(), z.string())).min(1).max(10000),
    consent_source: z.string().trim().max(120).optional(),
  }).parse(req.body);
  const agents = b.agent_ids.filter((id) => get(`SELECT 1 AS x FROM users WHERE id = ? AND status = 'active'`, id));
  if (!agents.length) throw new HttpError(400, 'Choose at least one active person.');

  const report = { added: 0, repeated_in_file: 0, already_in_crm: 0, invalid: 0, per_agent: {} as Record<string, number> };
  const seen = new Set<string>();
  const list = run('INSERT INTO call_lists(name, project_id, created_by) VALUES(?, ?, ?)', b.name, b.project_id ?? null, req.user.id);
  let turn = 0;
  tx(() => {
    for (const row of b.rows) {
      let phone: string;
      try {
        phone = normalizePhone(row.phone ?? row.mobile ?? '');
      } catch {
        report.invalid++;
        continue;
      }
      if (seen.has(phone)) { report.repeated_in_file++; continue; }
      seen.add(phone);
      if (get('SELECT 1 AS x FROM leads WHERE phone = ?', phone)) { report.already_in_crm++; continue; }
      const owner = agents[turn++ % agents.length];
      const budget = Number(row.budget_lakhs);
      const r = ingestLead({
        name: row.name?.trim() || 'Cold list contact',
        phone,
        email: row.email,
        source: 'Sheet Upload',
        project_id: b.project_id,
        configuration: row.configuration,
        budget_lakhs: budget > 0 ? budget : null,
        notes: row.notes,
        owner_id: owner,
        wa_opt_in: Boolean(b.consent_source),
        wa_opt_in_source: b.consent_source,
      }, req.user.id);
      run('UPDATE leads SET call_list_id = ?, presales_id = ? WHERE id = ?', list.id, owner, r.id);
      report.added++;
      report.per_agent[owner] = (report.per_agent[owner] ?? 0) + 1;
    }
  });
  for (const id of agents) notify(id, 'New calling list', `${b.name}: ${report.per_agent[id] ?? 0} contacts`, '/dial');
  audit(req, 'calllist.create', 'call_list', list.id, `${report.added} added, ${report.invalid} invalid, ${report.repeated_in_file} repeated`);
  broadcast('leads');
  res.status(201).json({ id: list.id, ...report });
});
