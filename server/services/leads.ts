import { HttpError } from '../auth.ts';
import { all, get, getSetting, nowIso, run, tx } from '../db.ts';
import { alertUser } from './alerts.ts';
import { broadcast, normalizePhone, notify } from './core.ts';
import { matchRoute, nextFromRoute } from './routing.ts';
import { assignmentExclusions } from './workplace.ts';
import { runWorkflows } from './workflows.ts';

export interface LeadInput {
  name: string;
  phone: string;
  email?: string;
  source: string;
  project_id?: number | null;
  configuration?: string;
  budget_lakhs?: number | null;
  preferred_location?: string;
  timeline?: string;
  notes?: string;
  utm_source?: string;
  utm_campaign?: string;
  adset?: string;
  ad?: string;
  form_name?: string;
  wa_opt_in?: boolean;
  wa_opt_in_source?: string;
  owner_id?: number | null;
  partner_id?: number | null;
}

export function logActivity(leadId: number, type: string, title: string, body = '', actorId: number | null = null) {
  run('INSERT INTO activities(lead_id, type, title, body, actor_id) VALUES(?, ?, ?, ?, ?)', leadId, type, title, body, actorId);
  run('UPDATE leads SET last_activity_at = ?, updated_at = ?, inactive_alerted = 0 WHERE id = ?', nowIso(), nowIso(), leadId);
}

/** Rule-based score, so every lead has an explainable score with or without AI. */
export function rescore(leadId: number) {
  const l = get<any>('SELECT * FROM leads WHERE id = ?', leadId);
  if (!l) return;
  const counts = get<any>(
    `SELECT
      (SELECT COUNT(*) FROM site_visits WHERE lead_id = ? AND status IN ('Checked In','Completed')) AS visits,
      (SELECT COUNT(*) FROM wa_messages WHERE lead_id = ? AND direction = 'in') AS replies,
      (SELECT COUNT(*) FROM activities WHERE lead_id = ? AND type = 'call' AND title LIKE '%Connected%') AS connects`,
    leadId, leadId, leadId,
  )!;
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };
  if (l.budget_lakhs) add(15, 'budget shared');
  if (l.configuration) add(10, 'configuration known');
  if (l.project_id) add(10, 'project chosen');
  if (['Immediately', 'Within 3 months'].includes(l.timeline)) add(15, `buying ${l.timeline.toLowerCase()}`);
  if (['Referral', 'Walk-in', 'Channel Partner'].includes(l.source)) add(10, `${l.source.toLowerCase()} source`);
  if (counts.connects) add(10, 'spoke on call');
  if (counts.replies) add(Math.min(15, counts.replies * 5), 'replied on WhatsApp');
  if (counts.visits) add(25, 'visited site');
  if (['Unqualified', 'Lost', 'Did Not Respond'].includes(l.stage)) score = Math.min(score, 20);
  score = Math.min(100, score);
  const temperature = score >= 60 ? 'Hot' : score >= 30 ? 'Warm' : 'Cold';
  run('UPDATE leads SET score = ?, temperature = ?, score_reason = ? WHERE id = ?', score, temperature, reasons.join(', '), leadId);
}

/**
 * Picks a telecaller: on this project and speaking this language where possible,
 * then by the routing rule (longest wait, or fewest open leads).
 */
export function nextTelecaller(projectId?: number | null, language?: string, excludeId?: number) {
  const order = getSetting<string>('routing_mode', 'round_robin') === 'workload'
    ? `(SELECT COUNT(*) FROM leads o WHERE o.owner_id = u.id AND o.deleted_at IS NULL AND o.stage NOT IN ('Booked','Lost','Unqualified')) ASC, u.id ASC`
    : `COALESCE(u.last_assigned_at, '') ASC, u.id ASC`;
  let skip: number[] = [];
  const pick = (extra: string, ...p: (number | string)[]) =>
    get<{ id: number }>(
      `SELECT u.id FROM users u WHERE u.role = 'telecaller' AND u.status = 'active' AND u.id != ? ${skip.length ? `AND u.id NOT IN (${skip.join(',')})` : ''} ${extra} ORDER BY ${order} LIMIT 1`,
      excludeId ?? 0, ...p,
    );
  const onProject = 'AND u.id IN (SELECT user_id FROM user_projects WHERE project_id = ?)';
  const speaks = `AND (u.languages = '' OR ',' || u.languages || ',' LIKE ?)`;
  const lang = `%,${language},%`;
  // With duty-aware assignment on, people on duty are tried first, then anyone working today, then everyone.
  for (const excluded of assignmentExclusions()) {
    skip = excluded.filter(Number.isInteger);
    const found =
      (projectId && language ? pick(`${onProject} ${speaks}`, projectId, lang) : undefined) ??
      (language ? pick(speaks, lang) : undefined) ??
      (projectId ? pick(onProject, projectId) : undefined) ??
      pick('');
    if (found) return found;
  }
  return undefined;
}

export type IngestResult = { id: number; duplicate: boolean; created: boolean };

/**
 * The one way leads enter the system: website, ads, WhatsApp, imports and
 * manual entry all pass through here, so de-duplication and routing are uniform.
 */
/** `quiet` skips the per-lead "new lead" alert, for bulk files where each person is told once instead. */
export function ingestLead(input: LeadInput, actorId: number | null = null, options: { quiet?: boolean } = {}): IngestResult {
  const phone = normalizePhone(input.phone);
  const result = tx(() => {
    const match = get<any>('SELECT id, owner_id, presales_id, deleted_at, merged_into FROM leads WHERE phone = ?', phone);
    // A merged number belongs to the lead it was merged into.
    const existing = match?.merged_into ? get<any>('SELECT id, owner_id, presales_id, deleted_at FROM leads WHERE id = ?', match.merged_into) : match;
    if (existing) {
      if (existing.deleted_at) run('UPDATE leads SET deleted_at = NULL WHERE id = ?', existing.id);
      if (input.wa_opt_in) grantOptIn(existing.id, input.wa_opt_in_source || input.source);
      if (input.email) run(`UPDATE leads SET email = ? WHERE id = ? AND email = ''`, input.email, existing.id); // Never overwrites one a person may have corrected.
      logActivity(existing.id, 'enquiry', `Enquired again via ${input.source}`, input.notes ?? '', actorId);
      const owner = existing.owner_id ?? existing.presales_id;
      alertUser(owner, 'new_lead', 'Existing lead enquired again', `${input.name} via ${input.source}`, `/leads/${existing.id}`);
      broadcast('leads');
      return { id: existing.id, duplicate: true, created: false };
    }

    // A campaign mapping decides first. Anything unmapped falls back to the usual routing.
    const route = input.owner_id ? undefined : matchRoute(input);
    const routed = route ? nextFromRoute(route) : null;
    const projectId = input.project_id ?? route?.project_id ?? null;
    const telecaller = input.owner_id || routed ? undefined : nextTelecaller(projectId);
    const ownerId = input.owner_id ?? routed?.id ?? telecaller?.id ?? null;
    const presalesId = telecaller?.id ?? (routed?.role === 'telecaller' ? routed.id : null);
    const optIn = Boolean(input.wa_opt_in);
    const { id } = run(
      `INSERT INTO leads(name, phone, email, source, project_id, configuration, budget_lakhs, preferred_location, timeline, notes,
         utm_source, utm_campaign, adset, ad, form_name, owner_id, presales_id, wa_opt_in, wa_opt_in_source, wa_opt_in_at, partner_id)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name.trim(), phone, input.email ?? '', input.source, projectId, input.configuration ?? '',
      input.budget_lakhs ?? null, input.preferred_location ?? '', input.timeline ?? '', input.notes ?? '',
      input.utm_source ?? '', input.utm_campaign ?? '', input.adset ?? '', input.ad ?? '', input.form_name ?? '', ownerId, presalesId,
      optIn ? 1 : 0, optIn ? input.wa_opt_in_source || input.source : '', optIn ? nowIso() : null, input.partner_id ?? null,
    );
    if (ownerId && (telecaller || routed)) run('UPDATE users SET last_assigned_at = ? WHERE id = ?', nowIso(), ownerId);
    logActivity(id, 'created', `Lead created from ${input.source}`, input.notes ?? '', actorId);
    if (route && routed) logActivity(id, 'assign', `Assigned by mapping: ${route.name}`, '', actorId);
    rescore(id);
    if (!options.quiet) {
      alertUser(ownerId, 'new_lead', 'New lead assigned', `${input.name} · ${input.source}`, `/leads/${id}`, {
        template: 'staff_new_lead', vars: { lead: input.name.trim(), source: input.source },
      });
      broadcast('leads');
    }
    return { id, duplicate: false, created: true };
  });
  if (result.created) void runWorkflows('lead_created', result.id).catch(() => undefined);
  return result;
}

export function grantOptIn(leadId: number, source: string) {
  run(
    `UPDATE leads SET wa_opt_in = 1, wa_opt_in_source = ?, wa_opt_in_at = ?, wa_opted_out_at = NULL WHERE id = ?`,
    source, nowIso(), leadId,
  );
}

export function changeStage(lead: any, stage: string, actorId: number | null, lostReason = '') {
  if (stage === lead.stage) return;
  if (stage === 'Lost' && !lostReason) throw new HttpError(400, 'Please choose a lost reason.');
  run('UPDATE leads SET stage = ?, lost_reason = ?, updated_at = ? WHERE id = ?', stage, stage === 'Lost' ? lostReason : '', nowIso(), lead.id);
  logActivity(lead.id, 'stage', `Stage: ${lead.stage} → ${stage}`, lostReason, actorId);
  rescore(lead.id);
  broadcast('leads');
  void runWorkflows('stage_changed', lead.id, `${stage}:${nowIso()}`).catch(() => undefined);
}

/** Records the first human contact, which stops the response-time alert. */
export function markResponded(leadId: number) {
  run('UPDATE leads SET first_response_at = COALESCE(first_response_at, ?) WHERE id = ?', nowIso(), leadId);
}

export function assignLead(leadId: number, ownerId: number, actorId: number, reason: string) {
  const user = get<any>(`SELECT id, name, role, status FROM users WHERE id = ?`, ownerId);
  if (!user || user.status !== 'active') throw new HttpError(400, 'That user is not active.');
  run('UPDATE leads SET owner_id = ?, updated_at = ? WHERE id = ?', ownerId, nowIso(), leadId);
  if (user.role === 'telecaller') run('UPDATE leads SET presales_id = ? WHERE id = ?', ownerId, leadId);
  logActivity(leadId, 'assign', `Assigned to ${user.name}`, reason, actorId);
  const lead = get<any>('SELECT name FROM leads WHERE id = ?', leadId);
  alertUser(ownerId, 'new_lead', 'Lead assigned to you', lead?.name ?? '', `/leads/${leadId}`);
  broadcast('leads');
}

export const openTaskCount = (userId: number) =>
  all('SELECT id FROM tasks WHERE owner_id = ? AND completed_at IS NULL', userId).length;
