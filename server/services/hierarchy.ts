import { HttpError } from '../auth.ts';
import { all, get } from '../db.ts';

/** Everyone below this person, at every level. The depth limit guards against any bad data. */
export function teamOf(userId: number): number[] {
  return all<{ id: number }>(
    `WITH RECURSIVE team(id, depth) AS (
       SELECT id, 1 FROM users WHERE manager_id = ?
       UNION
       SELECT u.id, t.depth + 1 FROM users u JOIN team t ON u.manager_id = t.id WHERE t.depth < 12
     )
     SELECT DISTINCT id FROM team WHERE id != ?`,
    userId, userId,
  ).map((r) => r.id);
}

/** Active managers above this person, nearest first. A paused manager is skipped. */
export function managerChain(userId: number): number[] {
  const chain: number[] = [];
  const seen = new Set([userId]);
  let current = get<{ manager_id: number | null }>('SELECT manager_id FROM users WHERE id = ?', userId)?.manager_id ?? null;
  while (current && !seen.has(current) && seen.size < 13) {
    seen.add(current);
    const person = get<{ status: string; manager_id: number | null }>('SELECT status, manager_id FROM users WHERE id = ?', current);
    if (!person) break;
    if (person.status === 'active') chain.push(current);
    current = person.manager_id;
  }
  return chain;
}

const MANAGER_ROLES = ['admin', 'sales_manager', 'site_head', 'team_leader'];

/** A reporting line must point at an active manager and can never form a loop. */
export function assertManager(userId: number | null, managerId: number) {
  const manager = get<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = ?', managerId);
  if (!manager) throw new HttpError(400, 'That manager was not found.');
  if (manager.status !== 'active') throw new HttpError(400, 'Choose an active manager.');
  if (!MANAGER_ROLES.includes(manager.role)) throw new HttpError(400, 'Choose an Admin, Sales Manager, Site Head or Team Leader as manager.');
  if (userId === managerId) throw new HttpError(400, 'Someone cannot report to themselves.');
  if (userId && teamOf(userId).includes(managerId)) throw new HttpError(400, 'That would create a loop, because this manager already reports to them.');
}
