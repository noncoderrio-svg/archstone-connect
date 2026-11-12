import type { Request } from 'express';
import { HttpError, type SessionUser } from '../auth.ts';
import { all, get, minutesFromNow } from '../db.ts';
import { audit, leadScope, maskPhone, phoneMasked, visibleLead } from './core.ts';

/**
 * The admin's view of every WhatsApp number. A conversation is one customer on
 * one number, because the same customer can talk to two staff on two numbers.
 * Reading here never changes a chat: staff keep their unread counts.
 */
export const SLOW_MINUTES = 60;
const COMPANY = 0; // Messages sent on the company number have no number row.

const order = (t: string) => `${t}.created_at || printf('%012d', ${t}.id)`; // Imported history arrives late, so IDs alone are not time order.
const idOf = (key: string) => `CAST(substr(${key}, -12) AS INTEGER)`;
/** A person answered. Bots and broadcasts do not count, so a customer is never marked as looked after by them. */
const byStaff = (t: string) => `(${t}.direction = 'out' AND ${t}.campaign_id IS NULL AND (${t}.actor_id IS NOT NULL OR ${t}.source = 'phone'))`;
const sameChat = (t: string) => `${t}.lead_id = c.lead_id AND COALESCE(${t}.number_id, 0) = c.num`;
const like = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

export interface ConversationQuery { number?: string; status?: string; staff?: string; q?: string; from?: string; to?: string; limit?: string }

export function listConversations(user: SessionUser, query: ConversationQuery) {
  const scope = leadScope(user);
  const masked = phoneMasked(user);
  const text = String(query.q ?? '').trim().slice(0, 100);
  const staff = Number(query.staff) || 0;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (text) {
    where.push(`(l.name LIKE ? ESCAPE '\\' ${masked ? '' : `OR l.phone LIKE ? ESCAPE '\\'`} OR EXISTS (SELECT 1 FROM wa_messages s WHERE ${sameChat('s')} AND s.body LIKE ? ESCAPE '\\'))`);
    params.push(like(text), ...(masked ? [] : [like(text)]), like(text));
  }
  if (staff) {
    where.push(`(l.owner_id = ? OR EXISTS (SELECT 1 FROM wa_numbers n WHERE n.id = c.num AND n.user_id = ?) OR EXISTS (SELECT 1 FROM wa_messages s WHERE ${sameChat('s')} AND s.actor_id = ?))`);
    params.push(staff, staff, staff);
  }
  if (query.from) { where.push('datetime(last.created_at) >= datetime(?)'); params.push(String(query.from)); }
  if (query.to) { where.push('datetime(last.created_at) <= datetime(?)'); params.push(String(query.to)); }

  const rows = all<any>(
    `WITH chats AS (
       SELECT m.lead_id, COALESCE(m.number_id, 0) AS num, COUNT(*) AS total, SUM(m.direction = 'in') AS received, SUM(${byStaff('m')}) AS staff_sent,
         MAX(${order('m')}) AS last_key,
         MAX(CASE WHEN m.direction = 'in' THEN ${order('m')} END) AS last_in,
         MAX(CASE WHEN ${byStaff('m')} THEN ${order('m')} END) AS last_staff
       FROM wa_messages m GROUP BY m.lead_id, num
       HAVING received > 0 OR staff_sent > 0
     )
     SELECT c.lead_id, c.num, c.total, c.received, l.name, l.phone, l.stage, l.owner_id, o.name AS owner_name,
       last.body AS last_body, last.direction AS last_direction, last.status AS last_status, last.created_at AS last_at, last.simulated,
       r.name AS replied_by,
       ${text ? `(SELECT s.body FROM wa_messages s WHERE ${sameChat('s')} AND s.body LIKE ? ESCAPE '\\' ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS found,` : ''}
       CASE WHEN c.last_in > COALESCE(c.last_staff, '') THEN (
         SELECT MIN(s.created_at) FROM wa_messages s WHERE ${sameChat('s')} AND s.direction = 'in' AND ${order('s')} > COALESCE(c.last_staff, '')
       ) END AS waiting_since
     FROM chats c
     JOIN leads l ON l.id = c.lead_id
     JOIN wa_messages last ON last.id = ${idOf('c.last_key')}
     LEFT JOIN users o ON o.id = l.owner_id
     LEFT JOIN wa_messages h ON h.id = ${idOf('c.last_staff')}
     LEFT JOIN users r ON r.id = h.actor_id
     WHERE ${scope.sql} ${where.length ? `AND ${where.join(' AND ')}` : ''}
     ORDER BY last.created_at DESC, last.id DESC`,
    ...(text ? [like(text)] : []), ...scope.params, ...params,
  );

  const slowSince = minutesFromNow(-SLOW_MINUTES);
  const isSlow = (r: any) => Boolean(r.waiting_since && r.waiting_since <= slowSince);
  const tests: Record<string, (r: any) => boolean> = {
    awaiting: (r) => Boolean(r.waiting_since),
    slow: isSlow,
    unassigned: (r) => !r.owner_id,
    failed: (r) => r.last_status === 'failed',
  };

  const numbers = all<any>(
    `SELECT n.id, n.label, n.display_number, n.status, n.phone_app, u.name AS user_name FROM wa_numbers n LEFT JOIN users u ON u.id = n.user_id ORDER BY n.label`,
  );
  if (rows.some((r) => r.num === COMPANY)) numbers.push({ id: COMPANY, label: 'Company number', display_number: '', status: 'active', phone_app: 0, user_name: null });
  const labels = new Map(numbers.map((n) => [n.id, n.label]));
  const cards = numbers.map((n) => {
    const own = rows.filter((r) => r.num === n.id);
    const waiting = own.filter(tests.awaiting);
    return {
      ...n,
      chats: own.length,
      waiting: waiting.length,
      slow: own.filter(isSlow).length,
      longest_wait_since: waiting.map((r) => r.waiting_since).sort()[0] ?? null,
      last_at: own[0]?.last_at ?? null,
    };
  });

  const chosen = query.number === undefined || query.number === '' ? null : Number(query.number);
  const onNumber = chosen === null ? rows : rows.filter((r) => r.num === chosen);
  const test = tests[String(query.status ?? '')];
  const matching = test ? onNumber.filter(test) : onNumber;
  const limit = Math.min(Number(query.limit) || 100, 500);

  return {
    numbers: cards,
    slow_minutes: SLOW_MINUTES,
    simulated: rows.some((r) => r.simulated),
    tabs: { all: onNumber.length, ...Object.fromEntries(Object.entries(tests).map(([k, t]) => [k, onNumber.filter(t).length])) },
    total: matching.length,
    conversations: matching.slice(0, limit).map(({ simulated: _simulated, ...r }) => ({
      ...r,
      number_label: labels.get(r.num) ?? 'Removed number',
      phone: masked ? maskPhone(r.phone) : r.phone,
    })),
  };
}

/** Admins reading customer chats is itself on the record, once per sitting rather than on every live refresh. */
function recordView(req: Request, leadId: number, label: string) {
  const recent = get(
    `SELECT 1 AS x FROM audit_log WHERE actor_id = ? AND action = 'conversation.view' AND entity_id = ? AND created_at >= ?`,
    req.user.id, String(leadId), minutesFromNow(-15),
  );
  if (!recent) audit(req, 'conversation.view', 'lead', leadId, label);
}

export function conversationThread(req: Request, leadId: number, num: number) {
  if (!Number.isInteger(num) || num < 0) throw new HttpError(400, 'Choose a number.');
  const lead = visibleLead(req.user, leadId);
  const number = num === COMPANY ? { label: 'Company number', user_name: null } : get<any>(
    'SELECT n.label, n.display_number, u.name AS user_name FROM wa_numbers n LEFT JOIN users u ON u.id = n.user_id WHERE n.id = ?', num,
  );
  if (!number) throw new HttpError(404, 'Number not found.');
  const LIMIT = 500;
  const messages = all<any>(
    `SELECT m.id, m.direction, m.body, m.status, m.error, m.simulated, m.created_at, m.media_url, m.media_type, m.source, m.campaign_id, u.name AS sender
     FROM wa_messages m LEFT JOIN users u ON u.id = m.actor_id
     WHERE m.lead_id = ? AND COALESCE(m.number_id, 0) = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    lead.id, num, LIMIT,
  ).reverse();
  if (!messages.length) throw new HttpError(404, 'No messages on this number.');
  recordView(req, lead.id, number.label);
  const owner = lead.owner_id ? get<any>('SELECT name FROM users WHERE id = ?', lead.owner_id) : null;
  return {
    lead: {
      id: lead.id,
      name: lead.name,
      phone: phoneMasked(req.user) ? maskPhone(lead.phone) : lead.phone,
      stage: lead.stage,
      owner_name: owner?.name ?? null,
    },
    number,
    messages,
    total: get<{ n: number }>('SELECT COUNT(*) AS n FROM wa_messages WHERE lead_id = ? AND COALESCE(number_id, 0) = ?', lead.id, num)!.n,
    limit: LIMIT,
    notes: all(
      `SELECT a.id, a.body, a.created_at, u.name AS sender FROM activities a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.lead_id = ? AND a.type = 'note' AND a.body != '' ORDER BY a.id DESC LIMIT 50`,
      lead.id,
    ),
    // The same customer may be talking to someone else on another number.
    other_numbers: all(
      `SELECT COALESCE(m.number_id, 0) AS num, COALESCE(n.label, 'Company number') AS label, COUNT(*) AS total
       FROM wa_messages m LEFT JOIN wa_numbers n ON n.id = m.number_id
       WHERE m.lead_id = ? AND COALESCE(m.number_id, 0) != ? GROUP BY num`,
      lead.id, num,
    ),
  };
}
