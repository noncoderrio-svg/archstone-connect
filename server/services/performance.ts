import type { SessionUser } from '../auth.ts';
import { all, nowIso } from '../db.ts';
import { teamOf } from './hierarchy.ts';

/** A follow-up finished within this many minutes of its time still counts as on time. */
const GRACE_MINUTES = 30;

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);

/** Under 15 minutes is excellent. An hour is fair. Anything slower scores low. */
const responsePoints = (minutes: number | null) => (minutes == null ? null : minutes <= 15 ? 100 : minutes <= 60 ? 60 : 20);

/** Half follow-up discipline, a quarter call connects, a quarter response speed. Missing parts are left out. */
export function activityScore(onTime: number | null, connect: number | null, response: number | null) {
  // Response speed alone is not enough to judge someone with no follow-ups or calls.
  if (onTime == null && connect == null) return null;
  const parts = [[onTime, 50], [connect, 25], [response, 25]].filter(([value]) => value != null) as [number, number][];
  const weight = parts.reduce((sum, [, w]) => sum + w, 0);
  return weight ? Math.round(parts.reduce((sum, [value, w]) => sum + value * w, 0) / weight) : null;
}

const TEAM_VIEWERS = ['admin', 'sales_manager', 'site_head', 'team_leader'];

/** Who this person may compare. Sales staff and telecallers see only themselves. */
function visibleAgents(user: SessionUser, q: Record<string, string>) {
  const where = [`u.status = 'active'`, `u.role IN ('sales','telecaller','team_leader','site_head','sales_manager')`];
  const params: (string | number)[] = [];
  if (!TEAM_VIEWERS.includes(user.role)) {
    where.push('u.id = ?');
    params.push(user.id);
  } else {
    const reports = user.role === 'admin' ? [] : teamOf(user.id);
    if (reports.length || user.role === 'team_leader') {
      const people = [user.id, ...reports];
      where.push(`u.id IN (${people.map(() => '?').join(',')})`);
      params.push(...people);
    } else if (user.role === 'site_head') {
      where.push('u.id IN (SELECT a.user_id FROM user_projects a JOIN user_projects b ON a.project_id = b.project_id WHERE b.user_id = ?)');
      params.push(user.id);
    }
    if (q.owner) { where.push('u.id = ?'); params.push(q.owner); }
    if (q.role) { where.push('u.role = ?'); params.push(q.role); }
    if (q.team) { where.push('u.team = ?'); params.push(q.team); }
  }
  return all<any>(`SELECT u.id, u.name, u.role, u.team FROM users u WHERE ${where.join(' AND ')} ORDER BY u.name`, ...params);
}

export function agentPerformance(user: SessionUser, q: Record<string, string>) {
  const from = q.created_from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = q.created_to || new Date().toISOString();
  const project = Number(q.project) || 0;
  const leadFilter = 'l.deleted_at IS NULL AND (? = 0 OR l.project_id = ?)';
  const inRange = (column: string) => `datetime(${column}) >= datetime(?) AND datetime(${column}) <= datetime(?)`;
  const byId = <T extends { id: number }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const onTimeTest = `datetime(t.completed_at) <= datetime(t.due_at, '+${GRACE_MINUTES} minutes')`;
  const due = inRange('t.due_at');

  const tasks = byId(all<any>(
    `SELECT t.owner_id AS id,
       SUM(${inRange('t.created_at')}) AS set_count,
       SUM(${due}) AS due,
       SUM(${due} AND t.completed_at IS NOT NULL AND ${onTimeTest}) AS on_time,
       SUM(${due} AND t.completed_at IS NOT NULL AND NOT ${onTimeTest}) AS late,
       SUM(${due} AND t.completed_at IS NULL AND datetime(t.due_at) < datetime(?)) AS missed,
       SUM(${due} AND t.completed_at IS NULL AND datetime(t.due_at) >= datetime(?)) AS pending,
       SUM(CASE WHEN ${due} THEN t.snoozes ELSE 0 END) AS moved,
       AVG(CASE WHEN ${due} AND t.completed_at IS NOT NULL AND NOT ${onTimeTest} THEN (julianday(t.completed_at) - julianday(t.due_at)) * 1440 END) AS avg_delay
     FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE ${leadFilter} GROUP BY t.owner_id`,
    from, to, from, to, from, to, from, to, from, to, nowIso(), from, to, nowIso(), from, to, from, to, project, project,
  ));
  const calls = byId(all<any>(
    `SELECT a.actor_id AS id, COUNT(*) AS calls, SUM(a.title LIKE '%Connected%') AS connected
     FROM activities a JOIN leads l ON l.id = a.lead_id WHERE a.type = 'call' AND ${inRange('a.created_at')} AND ${leadFilter} GROUP BY a.actor_id`,
    from, to, project, project,
  ));
  const visits = byId(all<any>(
    `SELECT v.host_id AS id, COUNT(*) AS visits FROM site_visits v JOIN leads l ON l.id = v.lead_id
     WHERE v.status IN ('Checked In','Completed') AND ${inRange('v.scheduled_at')} AND ${leadFilter} GROUP BY v.host_id`,
    from, to, project, project,
  ));
  const leads = byId(all<any>(
    `SELECT l.owner_id AS id, SUM(${inRange('l.created_at')}) AS new_leads, SUM(l.stage = 'Booked' AND ${inRange('l.updated_at')}) AS booked,
       AVG(CASE WHEN l.first_response_at IS NOT NULL AND ${inRange('l.created_at')} THEN (julianday(l.first_response_at) - julianday(l.created_at)) * 1440 END) AS response
     FROM leads l WHERE ${leadFilter} GROUP BY l.owner_id`,
    from, to, from, to, from, to, project, project,
  ));
  const messages = byId(all<any>(
    `SELECT m.actor_id AS id, COUNT(*) AS messages FROM wa_messages m JOIN leads l ON l.id = m.lead_id
     WHERE m.direction = 'out' AND ${inRange('m.created_at')} AND ${leadFilter} GROUP BY m.actor_id`,
    from, to, project, project,
  ));

  const agents = visibleAgents(user, q).map((u) => {
    const t = tasks.get(u.id) ?? {};
    const c = calls.get(u.id) ?? {};
    const l = leads.get(u.id) ?? {};
    const closed = (t.on_time ?? 0) + (t.late ?? 0) + (t.missed ?? 0);
    const onTimeRate = percent(t.on_time ?? 0, closed);
    const connectRate = percent(c.connected ?? 0, c.calls ?? 0);
    const response = l.response == null ? null : Math.round(l.response);
    return {
      ...u,
      set: t.set_count ?? 0, due: t.due ?? 0, on_time: t.on_time ?? 0, late: t.late ?? 0, missed: t.missed ?? 0, pending: t.pending ?? 0, moved: t.moved ?? 0,
      on_time_rate: onTimeRate, avg_delay_minutes: t.avg_delay == null ? null : Math.round(t.avg_delay),
      calls: c.calls ?? 0, connected: c.connected ?? 0, connect_rate: connectRate,
      visits: visits.get(u.id)?.visits ?? 0, messages: messages.get(u.id)?.messages ?? 0,
      new_leads: l.new_leads ?? 0, booked: l.booked ?? 0, response_minutes: response,
      score: activityScore(onTimeRate, connectRate, responsePoints(response)),
    };
  });

  const sum = (key: 'due' | 'on_time' | 'late' | 'missed' | 'pending') => agents.reduce((total, a) => total + a[key], 0);
  const totals = { due: sum('due'), on_time: sum('on_time'), late: sum('late'), missed: sum('missed'), pending: sum('pending') };
  return {
    agents,
    totals: { ...totals, on_time_rate: percent(totals.on_time, totals.on_time + totals.late + totals.missed) },
    team_view: TEAM_VIEWERS.includes(user.role),
    grace_minutes: GRACE_MINUTES,
    teams: all<{ team: string }>(`SELECT DISTINCT team FROM users WHERE team != '' ORDER BY team`).map((r) => r.team),
  };
}
