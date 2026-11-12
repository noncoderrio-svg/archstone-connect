// Monthly targets measured on each role's own work, the capped "target met" score, and the telecaller ranking.
import { GOALS, ROLE_GOALS, targetMet, type GoalKey, type Role } from '../../shared/domain.ts';
import { all, get } from '../db.ts';

export const currentMonth = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 7);
const monthStart = (month: string) => `${month}-01 00:00:00`;
const n = (sql: string, ...p: (string | number)[]) => Number(get<{ n: number }>(sql, ...p)?.n ?? 0);
const inList = (ids: number[]) => (ids.length ? ids.join(',') : 'NULL');

/** Visits that happened: checked in or completed. */
const DONE_VISIT = `v.status IN ('Checked In','Completed')`;
/** A lead this telecaller owns directly, or one they qualified and passed on. */
const TELE_LEAD = '(l.owner_id = ? OR l.presales_id = ?)';

/** What a person did this month, for each goal their role is measured on. */
export function goalActuals(user: { id: number; role: string; project_ids: number[] }, month = currentMonth()): Partial<Record<GoalKey, number>> {
  const start = monthStart(month);
  const id = user.id;
  const projects = inList(user.project_ids);
  const out: Partial<Record<GoalKey, number>> = {};
  for (const key of ROLE_GOALS[user.role as Role] ?? []) {
    out[key] = actual(key);
  }
  return out;

  function actual(key: GoalKey): number {
    switch (key) {
      case 'calls':
        return n(`SELECT COUNT(*) n FROM activities WHERE actor_id = ? AND type = 'call' AND created_at >= ?`, id, start);
      case 'qualified':
        return n(
          `SELECT COUNT(DISTINCT a.lead_id) n FROM activities a JOIN leads l ON l.id = a.lead_id
           WHERE a.type = 'stage' AND a.title LIKE '%→ Qualified' AND a.created_at >= ? AND ${TELE_LEAD}`,
          start, id, id,
        );
      case 'visits':
        if (user.role === 'site_head') return n(`SELECT COUNT(*) n FROM site_visits v WHERE ${DONE_VISIT} AND v.scheduled_at >= ? AND v.project_id IN (${projects})`, start);
        if (user.role === 'telecaller') {
          return n(`SELECT COUNT(*) n FROM site_visits v JOIN leads l ON l.id = v.lead_id WHERE ${DONE_VISIT} AND v.scheduled_at >= ? AND ${TELE_LEAD}`, start, id, id);
        }
        return n(`SELECT COUNT(*) n FROM site_visits v WHERE (v.host_id = ? OR v.created_by = ?) AND ${DONE_VISIT} AND v.scheduled_at >= ?`, id, id, start);
      case 'bookings':
        if (user.role === 'site_head') {
          return n(`SELECT COUNT(*) n FROM bookings b JOIN units u ON u.id = b.unit_id WHERE b.status = 'active' AND b.created_at >= ? AND u.project_id IN (${projects})`, start);
        }
        return n(`SELECT COUNT(*) n FROM bookings b JOIN leads l ON l.id = b.lead_id WHERE b.status = 'active' AND b.created_at >= ? AND ${TELE_LEAD}`, start, id, id);
      case 'partner_contacts':
        return n(`SELECT COUNT(*) n FROM partner_contacts WHERE user_id = ? AND created_at >= ?`, id, start);
      case 'partner_visits':
        return n(
          `SELECT COUNT(*) n FROM site_visits v JOIN leads l ON l.id = v.lead_id JOIN partners x ON x.id = l.partner_id
           WHERE x.manager_id = ? AND ${DONE_VISIT} AND v.scheduled_at >= ?`,
          id, start,
        );
      case 'partner_bookings':
        return n(
          `SELECT COUNT(*) n FROM bookings b JOIN leads l ON l.id = b.lead_id JOIN partners x ON x.id = l.partner_id
           WHERE x.manager_id = ? AND b.status = 'active' AND b.created_at >= ?`,
          id, start,
        );
      case 'payment_followups':
        return n(`SELECT COUNT(*) n FROM payment_followups WHERE user_id = ? AND created_at >= ?`, id, start);
      case 'collected_lakhs':
        return Math.round(Number(get<{ v: number }>(
          `SELECT COALESCE(SUM(p.amount_lakhs), 0) v FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN units u ON u.id = b.unit_id
           WHERE p.paid_at >= ? AND u.project_id IN (${projects})`,
          start,
        )!.v) * 100) / 100;
    }
  }
}

/** The goals set for a month. Targets saved before goals existed only had calls, visits and bookings. */
export function targetFor(userId: number, month = currentMonth()): Partial<Record<GoalKey, number>> {
  const row = get<any>('SELECT calls, visits, bookings, goals FROM targets WHERE user_id = ? AND month = ?', userId, month);
  if (!row) return {};
  const goals = JSON.parse(row.goals || '{}');
  if (Object.keys(goals).length) return goals;
  return { calls: row.calls, visits: row.visits, bookings: row.bookings };
}

/** Each goal with its target, what was done and progress; and the overall score. No target set means no score. */
export function roleTargets(user: { id: number; role: string; project_ids: number[] }, month = currentMonth()) {
  const target = targetFor(user.id, month);
  const done = goalActuals(user, month);
  const goals = (ROLE_GOALS[user.role as Role] ?? []).map((key) => {
    const t = Number(target[key] ?? 0);
    const a = Number(done[key] ?? 0);
    return { key, label: GOALS[key].label, unit: ('unit' in GOALS[key] ? GOALS[key].unit : '') as string, target: t, actual: a, progress: t > 0 ? Math.min(100, Math.round((a / t) * 100)) : null };
  });
  return { month, goals, score: targetMet(goals) };
}

export const projectIdsOf = (userId: number) => all<{ project_id: number }>('SELECT project_id FROM user_projects WHERE user_id = ?', userId).map((r) => r.project_id);

/**
 * Telecallers this month, ranked by bookings, then site visits, then qualified leads, then calls.
 * A telecaller gets credit for leads they own and for leads they passed on.
 * With projects, only leads on those projects count.
 */
export function topTelecallers(projectIds: number[] | null, limit = 5) {
  const start = monthStart(currentMonth());
  const onProjects = projectIds ? `AND l.project_id IN (${inList(projectIds)})` : '';
  const people = all<{ id: number; name: string }>(`SELECT id, name FROM users WHERE role = 'telecaller' AND status = 'active'`);
  return people.map((p) => ({
    ...p,
    bookings: n(`SELECT COUNT(*) n FROM bookings b JOIN leads l ON l.id = b.lead_id WHERE b.status = 'active' AND b.created_at >= ? AND ${TELE_LEAD} ${onProjects}`, start, p.id, p.id),
    visits: n(`SELECT COUNT(*) n FROM site_visits v JOIN leads l ON l.id = v.lead_id WHERE ${DONE_VISIT} AND v.scheduled_at >= ? AND ${TELE_LEAD} ${onProjects}`, start, p.id, p.id),
    qualified: n(
      `SELECT COUNT(DISTINCT a.lead_id) n FROM activities a JOIN leads l ON l.id = a.lead_id
       WHERE a.type = 'stage' AND a.title LIKE '%→ Qualified' AND a.created_at >= ? AND ${TELE_LEAD} ${onProjects}`,
      start, p.id, p.id,
    ),
    calls: n(`SELECT COUNT(*) n FROM activities a JOIN leads l ON l.id = a.lead_id WHERE a.actor_id = ? AND a.type = 'call' AND a.created_at >= ? ${onProjects}`, p.id, start),
  }))
    .filter((p) => p.bookings || p.visits || p.qualified || p.calls)
    .sort((a, b) => b.bookings - a.bookings || b.visits - a.visits || b.qualified - a.qualified || b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, limit);
}
