// Calling mode: one lead at a time, with the result saved before the next lead opens.
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, requirePermission } from '../auth.ts';
import { all, get, getSetting, minutesFromNow, nowIso, run, tx } from '../db.ts';
import { LEAD_ROLES } from '../../shared/domain.ts';
import { audit, broadcast, leadScope, normalizePhone, notify, presentLead, workableLead } from '../services/core.ts';
import { teamOf } from '../services/hierarchy.ts';
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
 * Hands out numbers in turn. People with a count get numbers until their count is reached;
 * anything beyond the counts, or everything when no counts are given, is shared equally.
 */
export function splitter(people: number[], counts: Record<string, number> = {}) {
  const left = new Map(people.map((id) => [id, Math.max(0, Math.floor(counts[id] ?? 0))]));
  let counted = 0;
  let equal = 0;
  return () => {
    const withCount = people.filter((id) => left.get(id)! > 0);
    if (withCount.length) {
      const id = withCount[counted++ % withCount.length];
      left.set(id, left.get(id)! - 1);
      return id;
    }
    return people[equal++ % people.length];
  };
}

const activeCallers = (ids: number[]) => {
  const roles = LEAD_ROLES.map((r) => `'${r}'`).join(',');
  return ids.filter((id) => get(`SELECT 1 AS x FROM users WHERE id = ? AND status = 'active' AND role IN (${roles})`, id));
};

/** Who a manager may move leads to, by the same rule as reassigning leads: their own team when they lead one. */
function assignablePeople(user: import('../auth.ts').SessionUser, ids: number[]) {
  const active = activeCallers(ids);
  if (user.role === 'admin' || user.role === 'site_head') return active;
  const team = teamOf(user.id);
  const limited = team.length || user.role === 'sourcing_manager' || user.role === 'closing_manager';
  return limited ? active.filter((id) => id === user.id || team.includes(id)) : active;
}

/**
 * Cleans an uploaded file, then shares it out by the counts typed in, and equally after that.
 * Repeats and bad numbers are removed and counted. Numbers already in the CRM keep their current owner.
 * Each person is told once about their share, not once per number.
 */
dialer.post('/dialer/lists', requirePermission('lead.import'), (req, res) => {
  const b = z.object({
    name: z.string().trim().min(2).max(80),
    project_id: z.number().int().nullish(),
    agent_ids: z.array(z.number().int()).min(1, 'Choose at least one person.').max(100),
    rows: z.array(z.record(z.string(), z.string())).min(1).max(10000),
    consent_source: z.string().trim().max(120).optional(),
    counts: z.record(z.string(), z.number().int().min(0).max(10000)).optional(),
  }).parse(req.body);
  const agents = [...new Set(activeCallers(b.agent_ids))];
  if (!agents.length) throw new HttpError(400, 'Choose at least one active person who works leads.');
  const next = splitter(agents, b.counts);

  const report = { added: 0, repeated_in_file: 0, already_in_crm: 0, invalid: 0, per_agent: {} as Record<string, number> };
  const seen = new Set<string>();
  const list = run('INSERT INTO call_lists(name, project_id, created_by) VALUES(?, ?, ?)', b.name, b.project_id ?? null, req.user.id);
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
      const owner = next();
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
      }, req.user.id, { quiet: true });
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

// ---------- Re-splitting a list ----------
/** A number nobody has called yet: no call logged on the lead, and no call placed. */
const UNCALLED = `NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.type = 'call') AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = l.id)`;

function visibleList(user: import('../auth.ts').SessionUser, id: number) {
  const list = get<any>('SELECT * FROM call_lists WHERE id = ?', id);
  const scope = leadScope(user);
  if (!list || !get(`SELECT 1 AS x FROM leads l WHERE l.call_list_id = ? AND ${scope.sql} LIMIT 1`, id, ...scope.params)) throw new HttpError(404, 'List not found.');
  return list;
}

/** Who holds this list's numbers, and how many each has not called yet. */
dialer.get('/dialer/lists/:id/people', requirePermission('lead.reassign'), (req, res) => {
  const list = visibleList(req.user, Number(req.params.id));
  const scope = leadScope(req.user);
  res.json({
    people: all(
      `SELECT u.id, u.name, u.role, COUNT(*) AS total, SUM(${UNCALLED}) AS uncalled
       FROM leads l JOIN users u ON u.id = l.owner_id
       WHERE l.call_list_id = ? AND ${scope.sql} GROUP BY u.id ORDER BY u.name`,
      list.id, ...scope.params,
    ),
  });
});

/**
 * Moves numbers nobody has called yet from some people to others, in one step, equally or by count.
 * Numbers already called stay with whoever called them. Each person is told once.
 */
dialer.post('/dialer/lists/:id/resplit', requirePermission('lead.reassign'), (req, res) => {
  const list = visibleList(req.user, Number(req.params.id));
  const b = z.object({
    from_ids: z.array(z.number().int()).min(1, 'Choose whose numbers to move.').max(100),
    to_ids: z.array(z.number().int()).min(1, 'Choose who gets them.').max(100),
    mode: z.enum(['equal', 'count']).default('equal'),
    counts: z.record(z.string(), z.number().int().min(0).max(10000)).optional(),
  }).parse(req.body);
  const targets = [...new Set(assignablePeople(req.user, b.to_ids))];
  if (!targets.length || targets.length !== new Set(b.to_ids).size) throw new HttpError(400, 'Choose active people you may assign leads to.');
  const scope = leadScope(req.user);
  const marks = b.from_ids.map(() => '?').join(',');
  const movable = all<{ id: number; owner_id: number }>(
    `SELECT l.id, l.owner_id FROM leads l WHERE l.call_list_id = ? AND l.owner_id IN (${marks}) AND ${UNCALLED} AND ${scope.sql} ORDER BY l.id`,
    list.id, ...b.from_ids, ...scope.params,
  );
  if (b.mode === 'count' && !Object.values(b.counts ?? {}).some((n) => n > 0)) throw new HttpError(400, 'Type how many numbers each person gets.');

  // By count: each person gets up to their number and the rest stay where they are. Equally: everything is shared.
  const quota = new Map(targets.map((id) => [id, b.mode === 'count' ? Math.max(0, b.counts?.[id] ?? 0) : Infinity]));
  let turn = 0;
  const gained = new Map<number, number>();
  const lost = new Map<number, number>();
  const names = new Map(all<{ id: number; name: string }>(`SELECT id, name FROM users WHERE id IN (${targets.map(() => '?').join(',')})`, ...targets).map((u) => [u.id, u.name]));
  tx(() => {
    for (const lead of movable) {
      const open = targets.filter((id) => quota.get(id)! > 0 && id !== lead.owner_id);
      if (!open.length) continue;
      const to = open[turn++ % open.length];
      quota.set(to, quota.get(to)! - 1);
      run('UPDATE leads SET owner_id = ?, presales_id = ?, updated_at = ? WHERE id = ?', to, to, nowIso(), lead.id);
      run(`INSERT INTO activities(lead_id, type, title, body, actor_id) VALUES(?, 'assign', ?, 'Calling list re-split', ?)`, lead.id, `Assigned to ${names.get(to)}`, req.user.id);
      gained.set(to, (gained.get(to) ?? 0) + 1);
      lost.set(lead.owner_id, (lost.get(lead.owner_id) ?? 0) + 1);
    }
  });
  const moved = [...gained.values()].reduce((s, n) => s + n, 0);
  for (const [id, n] of gained) notify(id, 'Calling list re-split', `${list.name}: ${n} more number${n > 1 ? 's' : ''} for you`, '/dial');
  for (const [id, n] of lost) if (!gained.has(id)) notify(id, 'Calling list re-split', `${list.name}: ${n} number${n > 1 ? 's' : ''} moved to colleagues`, '/dial', { push: false });
  audit(req, 'calllist.resplit', 'call_list', list.id, `${moved} moved from ${b.from_ids.join(',')} to ${targets.join(',')} (${b.mode})`);
  broadcast('leads');
  res.json({ moved, left: movable.length - moved, per_person: Object.fromEntries(gained) });
});
