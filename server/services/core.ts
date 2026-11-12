import type { Request, Response } from 'express';
import type { SessionUser } from '../auth.ts';
import { HttpError } from '../auth.ts';
import { get, getSetting, run } from '../db.ts';
import { sendMail } from './mail.ts';
import { teamOf } from './hierarchy.ts';
import { pushToUser } from './push.ts';

// ---------- Audit ----------
export function audit(req: Request | null, action: string, entity = '', entityId: string | number = '', detail = '') {
  run(
    'INSERT INTO audit_log(actor_id, action, entity, entity_id, detail, ip) VALUES(?, ?, ?, ?, ?, ?)',
    req?.user?.id ?? null,
    action,
    entity,
    String(entityId),
    detail,
    req?.ip ?? '',
  );
}

// ---------- Live updates (server-sent events) ----------
// Events only say "something changed"; the browser re-fetches through the
// normal permission-checked API, so no customer data leaks through this channel.
const streams = new Map<number, Set<Response>>();

export function subscribe(userId: number, res: Response) {
  const set = streams.get(userId) ?? new Set();
  set.add(res);
  streams.set(userId, set);
  return () => {
    set.delete(res);
    if (!set.size) streams.delete(userId);
  };
}

export function broadcast(topic: string, userIds?: number[]) {
  const payload = `event: change\ndata: ${JSON.stringify({ topic })}\n\n`;
  for (const [userId, set] of streams) {
    if (userIds && !userIds.includes(userId)) continue;
    for (const res of set) res.write(payload);
  }
}

// ---------- Notifications ----------
export function notify(userId: number | null | undefined, title: string, body = '', link = '', options: { kind?: string; push?: boolean } = {}) {
  if (!userId) return;
  const { kind = '', push = true } = options;
  run('INSERT INTO notifications(user_id, title, body, link, kind) VALUES(?, ?, ?, ?, ?)', userId, title, body, link, kind);
  broadcast('notifications', [userId]);
  if (push) void pushToUser(userId, title, body, link, kind).catch(() => undefined);
}

/** An in-app alert that also goes by email, for things that should not wait. */
export function notifyUrgent(userId: number | null | undefined, title: string, body = '', link = '') {
  if (!userId) return;
  notify(userId, title, body, link);
  const user = get<{ email: string }>('SELECT email FROM users WHERE id = ?', userId);
  if (user) void sendMail({ to: user.email, subject: `Archstone Connect: ${title}`, text: `${title}\n\nOpen Archstone Connect for details.` }).catch(() => undefined);
}

// ---------- Lead visibility ----------
/** SQL condition limiting leads (aliased `l`) to what this user may see. */
export function leadScope(user: SessionUser): { sql: string; params: number[] } {
  if (user.role === 'admin') return { sql: 'l.deleted_at IS NULL', params: [] };
  const reports = teamOf(user.id);
  const leads = reports.length > 0;
  // Reporting lines take over as soon as they are set. Until then, access stays as it always was.
  const fallback = ({
    sales_manager: leads ? 'team' : 'all',
    marketing: 'all',
    site_head: 'projects',
    team_leader: 'team',
  } as Record<string, string>)[user.role] ?? (leads ? 'team' : 'own');
  // An admin can widen or narrow any one person's view from the permissions screen.
  const scope = user.data_scope || fallback;
  if (scope === 'all') return { sql: 'l.deleted_at IS NULL', params: [] };

  const people = [user.id, ...reports];
  const marks = people.map(() => '?').join(',');
  const byTeam = `(l.owner_id IN (${marks}) OR l.presales_id IN (${marks}))`;
  if (scope === 'projects') {
    const ids = user.project_ids;
    const byProject = `l.project_id IN (${ids.map(() => '?').join(',')})`;
    if (leads && ids.length) return { sql: `l.deleted_at IS NULL AND (${byProject} OR ${byTeam})`, params: [...ids, ...people, ...people] };
    if (leads) return { sql: `l.deleted_at IS NULL AND ${byTeam}`, params: [...people, ...people] };
    if (!ids.length) return { sql: '1 = 0', params: [] };
    return { sql: `l.deleted_at IS NULL AND ${byProject}`, params: ids };
  }
  if (scope === 'team') return { sql: `l.deleted_at IS NULL AND ${byTeam}`, params: [...people, ...people] };
  return { sql: 'l.deleted_at IS NULL AND (l.owner_id = ? OR l.presales_id = ?)', params: [user.id, user.id] };
}

/** Returns the lead only if this user may see it. Responds 404 otherwise, so ids cannot be probed. */
export function visibleLead(user: SessionUser, leadId: number) {
  const scope = leadScope(user);
  const lead = get<any>(`SELECT l.* FROM leads l WHERE l.id = ? AND ${scope.sql}`, leadId, ...scope.params);
  if (!lead) throw new HttpError(404, 'Lead not found.');
  return lead;
}

/** Marketing can see leads for reporting and targeting, but cannot work them directly. */
export function workableLead(user: SessionUser, leadId: number) {
  const lead = visibleLead(user, leadId);
  if (user.role === 'marketing') throw new HttpError(403, 'Marketing has view-only access to individual leads.');
  return lead;
}

// ---------- Phone masking ----------
export const maskPhone = (phone: string) => (phone.length > 6 ? `${phone.slice(0, 5)}••••${phone.slice(-3)}` : '••••');

export function phoneMasked(user: SessionUser) {
  return getSetting<string[]>('mask_phone_roles', ['marketing']).includes(user.role);
}

export function presentLead<T extends { phone: string; labels?: string }>(user: SessionUser, lead: T) {
  const masked = phoneMasked(user);
  return {
    ...lead,
    phone: masked ? maskPhone(lead.phone) : lead.phone,
    phone_masked: masked,
    labels: lead.labels ? JSON.parse(lead.labels) : [],
  };
}

// ---------- Phone numbers ----------
/** Normalises Indian numbers to +91XXXXXXXXXX and keeps other E.164 numbers. */
export function normalizePhone(input: string): string {
  const digits = input.replace(/[^\d+]/g, '');
  const plain = digits.replace(/^\+/, '');
  if (/^[6-9]\d{9}$/.test(plain)) return `+91${plain}`;
  if (/^0[6-9]\d{9}$/.test(plain)) return `+91${plain.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(plain)) return `+${plain}`;
  if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) return digits;
  throw new HttpError(400, `"${input}" is not a valid phone number.`);
}
