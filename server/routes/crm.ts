import { Router, type Request } from 'express';
import { z } from 'zod';
import { BUYER_FIELDS, CLOSING_ROLES, DEFAULT_LABELS, DISPOSITIONS, SOURCES, STAGES, isManager, isViewOnly } from '../../shared/domain.ts';
import { HttpError, assertCan, requirePermission, type SessionUser } from '../auth.ts';
import { all, get, getSetting, minutesFromNow, nowIso, run, setSetting, tx } from '../db.ts';
import { audit, broadcast, leadScope, maskPhone, normalizePhone, phoneMasked, presentLead, visibleLead, workableLead } from '../services/core.ts';
import { clauseSql, leadFilters, leadSort } from '../services/filters.ts';
import { teamOf } from '../services/hierarchy.ts';
import { buyersFor, homesFor } from '../services/matching.ts';
import { assignLead, changeStage, ingestLead, logActivity, markResponded, nextTelecaller, rescore } from '../services/leads.ts';
import { draftReply, summarize } from '../services/ai.ts';
import { sendAutomation } from '../services/whatsapp.ts';
import { eraseDocuments } from './postsales.ts';

export const crm = Router();

const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.');
  return n;
};

const leadFields = z.object({
  name: z.string().trim().min(2, 'Please enter a name.').max(100),
  phone: z.string().min(8).max(20),
  email: z.union([z.email(), z.literal('')]).optional(),
  source: z.enum(SOURCES).default('Manual'),
  project_id: z.number().int().nullish(),
  configuration: z.string().max(60).optional(),
  budget_lakhs: z.number().positive().max(100000).nullish(),
  preferred_location: z.string().max(100).optional(),
  timeline: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
  wa_opt_in: z.boolean().optional(),
  wa_opt_in_source: z.string().max(120).optional(),
});

/** Sourcing and Closing Managers, and anyone leading a team below company level, assign only within that team. */
function allowedAssignees(user: SessionUser) {
  if (user.role === 'admin') return null;
  const reports = teamOf(user.id);
  return reports.length || user.role === 'sourcing_manager' || user.role === 'closing_manager' ? [user.id, ...reports] : null;
}

// ---------- List ----------
crm.get('/leads', (req, res) => {
  const scope = leadScope(req.user);
  const q = req.query as Record<string, string | undefined>;
  const filter = leadFilters(q);
  const whereSql = scope.sql + clauseSql(filter);
  const params = [...scope.params, ...filter.params];
  const pageSize = q.board === '1' ? 300 : 40;
  const page = Math.max(1, Number(q.page) || 1);
  const total = get<{ n: number }>(`SELECT COUNT(*) n FROM leads l WHERE ${whereSql}`, ...params)!.n;
  // Stage counts ignore the chosen stage, so the other tabs still show their numbers.
  const others = leadFilters(q, { skipStage: true });
  const stageCounts = all<{ stage: string; n: number }>(
    `SELECT l.stage, COUNT(*) n FROM leads l WHERE ${scope.sql}${clauseSql(others)} GROUP BY l.stage`,
    ...scope.params, ...others.params,
  );
  const rows = all<any>(
    `SELECT l.id, l.name, l.phone, l.email, l.source, l.stage, l.configuration, l.budget_lakhs, l.temperature, l.score, l.labels,
       l.created_at, l.last_activity_at, l.unread_count, l.do_not_contact, l.wa_opted_out_at, l.wa_opt_in,
       l.utm_campaign, l.adset, l.ad, l.last_disposition,
       (SELECT a.body FROM activities a WHERE a.lead_id = l.id AND a.body != '' AND a.type != 'manager_note' ORDER BY a.id DESC LIMIT 1) AS last_comment,
       (SELECT u2.name FROM activities a JOIN users u2 ON u2.id = a.actor_id WHERE a.lead_id = l.id AND a.type != 'manager_note' ORDER BY a.id DESC LIMIT 1) AS last_actor,
       p.name AS project_name, u.name AS owner_name,
       (SELECT MIN(t.due_at) FROM tasks t WHERE t.lead_id = l.id AND t.completed_at IS NULL) AS next_task_at
     FROM leads l LEFT JOIN projects p ON p.id = l.project_id LEFT JOIN users u ON u.id = l.owner_id
     WHERE ${whereSql} ORDER BY ${leadSort(q)} LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize,
  );
  // Result tabs count everything except the result itself, so each tab keeps its number.
  const otherResults = leadFilters({ ...q, disposition: undefined });
  const resultCounts = all<{ result: string; n: number }>(
    `SELECT l.last_disposition AS result, COUNT(*) n FROM leads l WHERE ${scope.sql}${clauseSql(otherResults)} AND l.last_disposition != '' GROUP BY l.last_disposition`,
    ...scope.params, ...otherResults.params,
  );
  const unassigned = get<{ n: number }>(`SELECT COUNT(*) n FROM leads l WHERE ${scope.sql} AND l.owner_id IS NULL`, ...scope.params)!.n;
  res.json({
    leads: rows.map((r) => presentLead(req.user, r)),
    total, page, pageSize,
    stage_counts: Object.fromEntries(stageCounts.map((s) => [s.stage, s.n])),
    result_counts: Object.fromEntries(resultCounts.map((r) => [r.result, r.n])),
    unassigned,
    actions: all<{ type: string }>('SELECT DISTINCT type FROM tasks ORDER BY type').map((t) => t.type),
  });
});

const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // Stops spreadsheets running a cell as a formula.
  return `"${s.replace(/"/g, '""')}"`;
};

/** Each list narrows to what fits the one before: campaign, then ad set, then ad. */
crm.get('/leads-campaigns', (req, res) => {
  const scope = leadScope(req.user);
  const { campaign, adset } = req.query as Record<string, string | undefined>;
  const values = (column: string, extra: string, ...params: string[]) => all<{ v: string }>(
    `SELECT DISTINCT ${column} AS v FROM leads l WHERE ${scope.sql} AND ${column} != '' ${extra} ORDER BY v LIMIT 300`,
    ...scope.params, ...params,
  ).map((r) => r.v);
  const inCampaign = campaign ? 'AND l.utm_campaign = ?' : '';
  const inAdset = adset ? 'AND l.adset = ?' : '';
  const scoped = campaign ? [campaign] : [];
  res.json({
    campaigns: values('l.utm_campaign', ''),
    adsets: values('l.adset', inCampaign, ...scoped),
    ads: values('l.ad', `${inCampaign} ${inAdset}`, ...scoped, ...(adset ? [adset] : [])),
  });
});

crm.get('/leads/export', requirePermission('lead.export'), (req, res) => {
  const scope = leadScope(req.user);
  const filter = leadFilters(req.query);
  const rows = all<any>(
    `SELECT l.name, l.phone, l.email, l.source, l.stage, p.name AS project, l.configuration, l.budget_lakhs, u.name AS assigned_to, l.created_at
     FROM leads l LEFT JOIN projects p ON p.id = l.project_id LEFT JOIN users u ON u.id = l.owner_id
     WHERE ${scope.sql}${clauseSql(filter)} ORDER BY ${leadSort(req.query)}`,
    ...scope.params, ...filter.params,
  ).map((r) => presentLead(req.user, r) as any);
  audit(req, 'lead.export', 'lead', '', `${rows.length} rows`);
  const header = ['name', 'phone', 'email', 'source', 'stage', 'project', 'configuration', 'budget_lakhs', 'assigned_to', 'created_at'];
  const csv = [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="archstone-leads.csv"');
  res.send(`ï»¿${csv}`);
});

// ---------- Create and import ----------
crm.post('/leads', async (req, res) => {
  assertCan(req.user, 'lead.create');
  const input = leadFields.parse(req.body);
  const assignSelf = ['closing_manager', 'telecaller'].includes(req.user.role);
  const result = ingestLead(
    {
      ...input,
      owner_id: assignSelf ? req.user.id : undefined,
      wa_opt_in_source: input.wa_opt_in ? input.wa_opt_in_source || `Confirmed by ${req.user.name}` : undefined,
    },
    req.user.id,
  );
  if (assignSelf && result.created && req.user.role === 'telecaller') {
    run('UPDATE leads SET presales_id = ? WHERE id = ?', req.user.id, result.id);
  }
  if (result.created) {
    const lead = get<any>('SELECT * FROM leads WHERE id = ?', result.id)!;
    await sendAutomation('welcome', lead);
  }
  res.status(result.created ? 201 : 200).json(result);
});

crm.post('/leads/import', requirePermission('lead.import'), (req, res) => {
  const body = z
    .object({
      rows: z.array(z.record(z.string(), z.string())).min(1).max(10000),
      source: z.enum(SOURCES).default('Sheet Upload'),
      consent_source: z.string().max(120).optional(),
    })
    .parse(req.body);
  const summary = { created: 0, duplicates: 0, failed: [] as { row: number; reason: string }[] };
  body.rows.forEach((row, i) => {
    try {
      const budget = Number(row.budget_lakhs);
      const project = row.project ? get<any>('SELECT id FROM projects WHERE name = ? COLLATE NOCASE', row.project) : undefined;
      if (!row.name || !row.phone) throw new Error('Name and phone are required.');
      const r = ingestLead({
        name: row.name,
        phone: row.phone,
        email: row.email,
        source: body.source,
        project_id: project?.id,
        configuration: row.configuration,
        budget_lakhs: budget > 0 ? budget : null,
        notes: row.notes,
        wa_opt_in: Boolean(body.consent_source),
        wa_opt_in_source: body.consent_source,
      }, req.user.id);
      if (r.created) summary.created++;
      else summary.duplicates++;
    } catch (e) {
      summary.failed.push({ row: i + 2, reason: (e as Error).message });
    }
  });
  audit(req, 'lead.import', 'lead', '', `${summary.created} created, ${summary.duplicates} duplicates, ${summary.failed.length} failed`);
  res.json({ ...summary, failed: summary.failed.slice(0, 50) });
});

// ---------- Lead 360 ----------
crm.get('/leads/:id', (req, res) => {
  const lead = visibleLead(req.user, id(req.params.id));
  const project = lead.project_id ? get('SELECT * FROM projects WHERE id = ?', lead.project_id) : null;
  res.json({
    lead: presentLead(req.user, {
      ...lead,
      owner_name: get<any>('SELECT name FROM users WHERE id = ?', lead.owner_id)?.name ?? null,
      presales_name: get<any>('SELECT name FROM users WHERE id = ?', lead.presales_id)?.name ?? null,
      partner_name: lead.partner_id ? get<any>('SELECT name FROM partners WHERE id = ?', lead.partner_id)?.name ?? null : null,
    }),
    project,
    calls: all(
      `SELECT c.id, c.status, c.duration_seconds, c.simulated, c.created_at, c.recording_url != '' AS has_recording, u.name AS caller
       FROM calls c JOIN users u ON u.id = c.user_id WHERE c.lead_id = ? ORDER BY c.id DESC LIMIT 20`,
      lead.id,
    ),
    documents: isViewOnly(req.user.role) ? [] : all(
      `SELECT d.id, d.type, d.filename, d.size, d.status, d.drive_file_id != '' AS in_drive, d.created_at, u.name AS uploaded_by_name
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.lead_id = ? ORDER BY d.id DESC`,
      lead.id,
    ),
    booking: get(`SELECT id, status FROM bookings WHERE lead_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, lead.id) ?? null,
    timeline: all(
      `SELECT a.id, a.type, a.title, a.body, a.created_at, u.name AS actor FROM activities a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.lead_id = ? AND (a.type != 'manager_note' OR ?) ORDER BY a.id DESC LIMIT 200`,
      lead.id, isManager(req.user.role) ? 1 : 0,
    ),
    tasks: all(
      `SELECT t.*, u.name AS owner_name FROM tasks t JOIN users u ON u.id = t.owner_id WHERE t.lead_id = ? ORDER BY t.completed_at IS NOT NULL, t.due_at`,
      lead.id,
    ),
    visits: all(
      `SELECT v.id, v.scheduled_at, v.status, v.rating, v.feedback, v.pickup, p.name AS project_name FROM site_visits v
       JOIN projects p ON p.id = v.project_id WHERE v.lead_id = ? ORDER BY v.scheduled_at DESC`,
      lead.id,
    ),
    approvals: all('SELECT * FROM approvals WHERE lead_id = ? ORDER BY id DESC', lead.id),
  });
});

crm.patch('/leads/:id', (req, res) => {
  const lead = workableLead(req.user, id(req.params.id));
  const input = leadFields.partial().omit({ wa_opt_in: true, wa_opt_in_source: true, source: true }).extend({
    labels: z.array(z.string().trim().min(1).max(30)).max(12).optional(),
    do_not_contact: z.boolean().optional(),
    profile: z.partialRecord(z.enum(BUYER_FIELDS.map((f) => f.key) as [string, ...string[]]), z.string().trim().max(200)).optional(),
  }).parse(req.body);
  const phone = input.phone ? normalizePhone(input.phone) : lead.phone;
  if (phone !== lead.phone && get('SELECT 1 AS x FROM leads WHERE phone = ? AND id != ?', phone, lead.id)) {
    throw new HttpError(409, 'Another lead already has this phone number.');
  }
  if (input.phone && phoneMasked(req.user)) throw new HttpError(403, 'Phone numbers are hidden for your role.');
  run(
    `UPDATE leads SET name = ?, phone = ?, email = ?, project_id = ?, configuration = ?, budget_lakhs = ?, preferred_location = ?,
       timeline = ?, notes = ?, labels = ?, do_not_contact = ?, updated_at = ? WHERE id = ?`,
    input.name ?? lead.name, phone, input.email ?? lead.email,
    input.project_id === undefined ? lead.project_id : input.project_id,
    input.configuration ?? lead.configuration,
    input.budget_lakhs === undefined ? lead.budget_lakhs : input.budget_lakhs,
    input.preferred_location ?? lead.preferred_location, input.timeline ?? lead.timeline, input.notes ?? lead.notes,
    input.labels ? JSON.stringify(input.labels) : lead.labels,
    input.do_not_contact === undefined ? lead.do_not_contact : input.do_not_contact ? 1 : 0,
    nowIso(), lead.id,
  );
  if (input.profile) run('UPDATE leads SET profile = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(lead.profile), ...input.profile }), lead.id);
  if (input.do_not_contact !== undefined && Boolean(lead.do_not_contact) !== input.do_not_contact) {
    logActivity(lead.id, 'compliance', input.do_not_contact ? 'Marked do not contact' : 'Do not contact removed', '', req.user.id);
    audit(req, 'lead.do_not_contact', 'lead', lead.id, String(input.do_not_contact));
  }
  rescore(lead.id);
  broadcast('leads');
  res.json({ ok: true });
});

/** A note for managers only. Agents, their AI summaries and the lead list never see it. */
crm.post('/leads/:id/manager-note', (req, res) => {
  if (!isManager(req.user.role)) throw new HttpError(403, 'Only managers can add this note.');
  const lead = visibleLead(req.user, id(req.params.id));
  const { body } = z.object({ body: z.string().trim().min(1).max(1000) }).parse(req.body);
  run(`INSERT INTO activities(lead_id, type, title, body, actor_id) VALUES(?, 'manager_note', 'Manager note', ?, ?)`, lead.id, body, req.user.id);
  broadcast('leads');
  res.status(201).json({ ok: true });
});

crm.post('/leads/:id/stage', (req, res) => {
  const lead = workableLead(req.user, id(req.params.id));
  const body = z.object({ stage: z.string().max(60), lost_reason: z.string().max(100).optional() }).parse(req.body);
  if (![...STAGES, ...getSetting<string[]>('custom_stages', [])].includes(body.stage)) throw new HttpError(400, 'Unknown stage.');
  if (lead.stage === 'Booked' && !['admin', 'site_head'].includes(req.user.role)) {
    throw new HttpError(403, 'Only an admin or site head can change a booked lead.');
  }
  if (body.stage === 'Booked') throw new HttpError(400, 'Bookings are created through an approved booking request.');
  changeStage(lead, body.stage, req.user.id, body.lost_reason);
  res.json({ ok: true });
});

crm.post('/leads/:id/call', (req, res) => {
  const lead = workableLead(req.user, id(req.params.id));
  if (lead.do_not_contact) throw new HttpError(422, 'This contact is marked do not contact.');
  const body = z.object({
    disposition: z.enum(DISPOSITIONS),
    notes: z.string().max(1000).optional(),
    duration_seconds: z.number().int().min(0).max(7200).optional(),
  }).parse(req.body);
  tx(() => {
    logActivity(lead.id, 'call', `Call: ${body.disposition}`, body.notes ?? '', req.user.id);
    run('UPDATE leads SET last_disposition = ? WHERE id = ?', body.disposition, lead.id);
    markResponded(lead.id);
    // Saving the result releases the agent to the next lead.
    run(
      `UPDATE calls SET pending = 0, status = 'completed', duration_seconds = ? WHERE lead_id = ? AND user_id = ? AND pending = 1`,
      body.duration_seconds ?? null, lead.id, req.user.id,
    );
    if (body.disposition === 'Qualified') {
      if (['Not Contacted', 'Contacted'].includes(lead.stage)) changeStage(lead, 'Qualified', req.user.id);
    } else if (lead.stage === 'Not Contacted') {
      changeStage(lead, body.disposition === 'Wrong Number' ? 'Unqualified' : 'Contacted', req.user.id);
    }
    if (body.disposition === 'Wrong Number') run('UPDATE leads SET do_not_contact = 1 WHERE id = ?', lead.id);
    rescore(lead.id);
  });
  broadcast('leads');
  res.json({ ok: true });
});

crm.post('/leads/:id/note', (req, res) => {
  const lead = workableLead(req.user, id(req.params.id));
  const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
  logActivity(lead.id, 'note', 'Note added', body, req.user.id);
  broadcast('leads');
  res.json({ ok: true });
});

crm.post('/leads/:id/handoff', (req, res) => {
  const lead = workableLead(req.user, id(req.params.id));
  const body = z.object({ sales_id: z.number().int(), notes: z.string().trim().min(5, 'Add a short note for the closing manager.').max(1000) }).parse(req.body);
  const target = get<any>(`SELECT id, role FROM users WHERE id = ? AND status = 'active'`, body.sales_id);
  if (!target || !(CLOSING_ROLES as readonly string[]).includes(target.role)) throw new HttpError(400, 'Choose an active closing manager.');
  if (req.user.role === 'telecaller' && lead.owner_id !== req.user.id) throw new HttpError(403, 'This lead is not assigned to you.');
  if (req.user.role !== 'telecaller' && !isManager(req.user.role)) throw new HttpError(403, 'You cannot hand off leads.');
  tx(() => {
    run('UPDATE leads SET presales_id = COALESCE(presales_id, ?) WHERE id = ?', lead.owner_id, lead.id);
    assignLead(lead.id, target.id, req.user.id, body.notes);
    if (['Not Contacted', 'Contacted'].includes(lead.stage)) changeStage(lead, 'Qualified', req.user.id);
  });
  res.json({ ok: true });
});

crm.post('/leads/assign', requirePermission('lead.reassign'), (req, res) => {
  const body = z.object({ lead_ids: z.array(z.number().int()).min(1).max(500), owner_id: z.number().int() }).parse(req.body);
  const limited = allowedAssignees(req.user);
  if (limited && !limited.includes(body.owner_id)) throw new HttpError(403, 'You can assign leads only within your team.');
  tx(() => {
    for (const leadId of body.lead_ids) {
      visibleLead(req.user, leadId);
      assignLead(leadId, body.owner_id, req.user.id, 'Reassigned');
    }
  });
  audit(req, 'lead.reassign', 'lead', body.lead_ids.join(','), `to user ${body.owner_id}`);
  res.json({ ok: true });
});

/** Shares unassigned leads out by the same routing rule used for new leads. */
crm.post('/leads/auto-distribute', requirePermission('lead.reassign'), (req, res) => {
  const scope = leadScope(req.user);
  const leads = all<{ id: number; project_id: number | null }>(
    `SELECT l.id, l.project_id FROM leads l WHERE ${scope.sql} AND l.owner_id IS NULL ORDER BY l.created_at LIMIT 500`,
    ...scope.params,
  );
  let assigned = 0;
  tx(() => {
    for (const lead of leads) {
      const next = nextTelecaller(lead.project_id);
      if (!next) break;
      assignLead(lead.id, next.id, req.user.id, 'Auto distributed');
      assigned += 1;
      // Many leads share one second here, so a counter keeps the turns in order.
      run('UPDATE users SET last_assigned_at = ? WHERE id = ?', `${nowIso()}.${String(assigned).padStart(3, '0')}`, next.id);
    }
  });
  audit(req, 'lead.auto_distribute', 'lead', '', `${assigned} leads`);
  res.json({ assigned, waiting: leads.length - assigned });
});

crm.delete('/leads/:id', requirePermission('lead.delete'), (req, res) => {
  const lead = visibleLead(req.user, id(req.params.id));
  run('UPDATE leads SET deleted_at = ? WHERE id = ?', nowIso(), lead.id);
  audit(req, 'lead.delete', 'lead', lead.id, lead.name);
  broadcast('leads');
  res.json({ ok: true });
});

// ---------- Matching homes ----------
crm.get('/leads/:id/matches', (req, res) => res.json(homesFor(visibleLead(req.user, id(req.params.id)))));

crm.get('/projects/:id/buyers', (req, res) => res.json({ buyers: buyersFor(id(req.params.id), leadScope(req.user)) }));

// ---------- Duplicates ----------
crm.get('/leads-duplicates', requirePermission('lead.delete'), (req, res) => {
  const scope = leadScope(req.user);
  const leads = all<any>(
    `SELECT l.id, l.name, l.phone, l.email, l.stage, l.source, l.created_at, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id = l.owner_id
     WHERE ${scope.sql} AND l.merged_into IS NULL ORDER BY l.created_at`,
    ...scope.params,
  );
  const groups = new Map<string, { reason: string; leads: any[] }>();
  const add = (key: string, reason: string, lead: any) => {
    const group = groups.get(key) ?? { reason, leads: [] };
    group.leads.push(lead);
    groups.set(key, group);
  };
  for (const lead of leads) {
    if (lead.email.trim()) add(`email:${lead.email.trim().toLowerCase()}`, 'Same email', lead);
    add(`name:${lead.name.trim().toLowerCase().replace(/\s+/g, ' ')}`, 'Same name', lead);
  }
  const masked = phoneMasked(req.user);
  res.json({
    groups: [...groups.values()].filter((g) => g.leads.length > 1).slice(0, 100)
      .map((g) => ({ ...g, leads: g.leads.map((l) => ({ ...l, phone: masked ? maskPhone(l.phone) : l.phone })) })),
  });
});

crm.post('/leads/merge', requirePermission('lead.delete'), (req, res) => {
  const { keep_id: keepId, merge_id: mergeId } = z.object({ keep_id: z.number().int(), merge_id: z.number().int() }).parse(req.body);
  if (keepId === mergeId) throw new HttpError(400, 'Choose two different leads.');
  const keep = visibleLead(req.user, keepId);
  const other = visibleLead(req.user, mergeId);
  tx(() => {
    // Every table that points at a lead moves across, including ones added later.
    const tables = all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'workflow_runs'`)
      .filter((t) => all<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, t.name).some((c) => c.name === 'lead_id'));
    for (const t of tables) run(`UPDATE OR IGNORE "${t.name}" SET lead_id = ? WHERE lead_id = ?`, keepId, mergeId);

    const labels = [...new Set([...JSON.parse(keep.labels), ...JSON.parse(other.labels)])];
    run(
      `UPDATE leads SET email = ?, configuration = ?, budget_lakhs = ?, preferred_location = ?, timeline = ?, project_id = ?, labels = ?,
         notes = ?, unread_count = unread_count + ?, updated_at = ? WHERE id = ?`,
      keep.email || other.email, keep.configuration || other.configuration, keep.budget_lakhs ?? other.budget_lakhs,
      keep.preferred_location || other.preferred_location, keep.timeline || other.timeline, keep.project_id ?? other.project_id,
      JSON.stringify(labels), [keep.notes, other.notes].filter(Boolean).join('\n'), other.unread_count, nowIso(), keepId,
    );
    // WhatsApp consent belongs to a phone number, so it is deliberately not copied across.
    run('UPDATE leads SET merged_into = ?, deleted_at = ?, unread_count = 0 WHERE id = ?', keepId, nowIso(), mergeId);
    logActivity(keepId, 'merge', `Merged with ${other.name}`, `Other number: ${phoneMasked(req.user) ? maskPhone(other.phone) : other.phone}`, req.user.id);
    rescore(keepId);
  });
  audit(req, 'lead.merge', 'lead', String(keepId), `merged ${mergeId}`);
  broadcast('leads');
  res.json({ ok: true });
});

crm.post('/leads/:id/restore', requirePermission('lead.delete'), (req, res) => {
  if (get('SELECT 1 AS x FROM leads WHERE id = ? AND merged_into IS NOT NULL', id(req.params.id))) throw new HttpError(400, 'This lead was merged into another lead.');
  run('UPDATE leads SET deleted_at = NULL WHERE id = ?', id(req.params.id));
  audit(req, 'lead.restore', 'lead', String(req.params.id));
  broadcast('leads');
  res.json({ ok: true });
});

/** Personal-data erasure request: removes identity and message content, keeps anonymous counts. */
crm.post('/leads/:id/erase', requirePermission('lead.delete'), (req, res) => {
  const lead = visibleLead(req.user, id(req.params.id));
  tx(() => {
    run(
      `UPDATE leads SET name = 'Erased contact', phone = ?, email = '', notes = '', labels = '[]', do_not_contact = 1, wa_opt_in = 0, deleted_at = ? WHERE id = ?`,
      `erased-${lead.id}`, nowIso(), lead.id,
    );
    run(`UPDATE wa_messages SET body = '[erased]' WHERE lead_id = ?`, lead.id);
    run(`UPDATE activities SET body = '' WHERE lead_id = ?`, lead.id);
    eraseDocuments(lead.id);
  });
  audit(req, 'lead.erase', 'lead', lead.id);
  broadcast('leads');
  res.json({ ok: true });
});

// ---------- Tasks ----------
crm.post('/leads/:id/tasks', (req, res) => {
  const lead = workableLead(req.user, id(req.params.id));
  const body = z.object({ type: z.string().min(2).max(30), due_at: z.string().min(10), notes: z.string().max(500).optional() }).parse(req.body);
  const owner = lead.owner_id ?? req.user.id;
  run('INSERT INTO tasks(lead_id, owner_id, type, due_at, notes) VALUES(?, ?, ?, ?, ?)', lead.id, owner, body.type, body.due_at, body.notes ?? '');
  logActivity(lead.id, 'task', `Follow-up set: ${body.type}`, body.notes ?? '', req.user.id);
  broadcast('leads');
  res.status(201).json({ ok: true });
});

// ---------- Follow-ups ----------
const followUpScope = (req: Request) => {
  const scope = leadScope(req.user);
  const mine = !isManager(req.user.role);
  return { sql: `${scope.sql} AND l.deleted_at IS NULL${mine ? ' AND t.owner_id = ?' : ''}`, params: [...scope.params, ...(mine ? [req.user.id] : [])] };
};

const OPEN_DUE: Record<string, string> = {
  overdue: 't.completed_at IS NULL AND t.due_at < ?',
  today: `t.completed_at IS NULL AND t.due_at >= ? AND date(t.due_at, '+330 minutes') = date('now', '+330 minutes')`,
  upcoming: `t.completed_at IS NULL AND t.due_at >= ? AND date(t.due_at, '+330 minutes') > date('now', '+330 minutes')`,
};

function followUpCounts(req: Request) {
  const scope = followUpScope(req);
  const count = (view: string) => get<{ n: number }>(
    `SELECT COUNT(*) n FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE ${scope.sql} AND ${OPEN_DUE[view]}`, ...scope.params, nowIso(),
  )!.n;
  return { overdue: count('overdue'), today: count('today'), upcoming: count('upcoming') };
}

crm.get('/followups/summary', (req, res) => res.json(followUpCounts(req)));

crm.get('/followups', (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const scope = followUpScope(req);
  const view = q.view ?? 'overdue';
  const where = [scope.sql];
  const params: (string | number)[] = [...scope.params];
  if (view === 'done') where.push('t.completed_at IS NOT NULL');
  else {
    where.push(OPEN_DUE[view] ?? OPEN_DUE.overdue);
    params.push(nowIso());
  }
  if (q.q) { where.push('(l.name LIKE ? OR l.phone LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.owner) { where.push('t.owner_id = ?'); params.push(q.owner); }
  if (q.project) { where.push('l.project_id = ?'); params.push(q.project); }
  if (q.type) { where.push('t.type = ?'); params.push(q.type); }
  if (q.due_from) { where.push('datetime(t.due_at) >= datetime(?)'); params.push(q.due_from); }
  if (q.due_to) { where.push('datetime(t.due_at) <= datetime(?)'); params.push(q.due_to); }
  const order = view === 'done' ? 't.completed_at DESC' : view === 'overdue' ? 'l.score DESC, t.due_at ASC' : 't.due_at ASC';
  const masked = phoneMasked(req.user);
  const rows = all<any>(
    `SELECT t.id, t.lead_id, t.type, t.due_at, t.notes, t.completed_at, l.name AS lead_name, l.phone, l.temperature, p.name AS project_name, u.name AS owner_name
     FROM tasks t JOIN leads l ON l.id = t.lead_id LEFT JOIN projects p ON p.id = l.project_id LEFT JOIN users u ON u.id = t.owner_id
     WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`,
    ...params,
  );
  res.json({
    tasks: rows.map((r) => ({ ...r, masked, phone: masked ? maskPhone(r.phone) : r.phone })),
    counts: followUpCounts(req),
    types: all<{ type: string }>('SELECT DISTINCT type FROM tasks ORDER BY type').map((t) => t.type),
  });
});

crm.post('/tasks/:id/snooze', (req, res) => {
  const body = z.object({ minutes: z.number().int().min(5).max(43200).optional(), due_at: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).optional() }).parse(req.body);
  const task = get<any>('SELECT * FROM tasks WHERE id = ? AND completed_at IS NULL', id(req.params.id));
  if (!task) throw new HttpError(404, 'Follow-up not found.');
  workableLead(req.user, task.lead_id);
  const due = body.due_at ?? (body.minutes ? minutesFromNow(body.minutes) : '');
  if (!due) throw new HttpError(400, 'Choose a new time.');
  if (due <= nowIso()) throw new HttpError(400, 'Choose a time in the future.');
  // A new time starts the reminders again from the beginning.
  run('UPDATE tasks SET due_at = ?, reminded = 0, overdue_alerts = 0, last_overdue_at = NULL, escalated = 0, snoozes = snoozes + 1 WHERE id = ?', due, task.id);
  logActivity(task.lead_id, 'task', `Follow-up moved: ${task.type}`, '', req.user.id);
  broadcast('leads');
  res.json({ ok: true, due_at: due });
});

crm.post('/tasks/:id/complete', (req, res) => {
  const task = get<any>('SELECT * FROM tasks WHERE id = ?', id(req.params.id));
  if (!task) throw new HttpError(404, 'Task not found.');
  workableLead(req.user, task.lead_id);
  run('UPDATE tasks SET completed_at = ? WHERE id = ?', nowIso(), task.id);
  logActivity(task.lead_id, 'task', `Completed: ${task.type}`, '', req.user.id);
  broadcast('leads');
  res.json({ ok: true });
});

// ---------- AI ----------
crm.post('/leads/:id/ai/draft', requirePermission('ai.use'), async (req, res) => {
  const lead = workableLead(req.user, id(req.params.id));
  const { language } = z.object({ language: z.enum(['English', 'Hindi', 'Marathi']) }).parse(req.body);
  res.json({ text: await draftReply(lead, language) });
});

crm.post('/leads/:id/ai/summary', requirePermission('ai.use'), async (req, res) => {
  const lead = visibleLead(req.user, id(req.params.id));
  res.json({ text: await summarize(lead) });
});

// ---------- Permission helper for the UI ----------
crm.get('/directory', (req, res) => {
  const users = all<any>(`SELECT id, name, role FROM users WHERE status = 'active' ORDER BY name`);
  res.json({
    users,
    team_ids: allowedAssignees(req.user),
    canReassign: req.user.permissions.includes('lead.reassign'),
    customStages: getSetting<string[]>('custom_stages', []),
    labels: getSetting('lead_labels', DEFAULT_LABELS),
  });
});

crm.post('/leads/:id/labels', (req, res) => {
  const lead = workableLead(req.user, id(req.params.id));
  const { labels } = z.object({ labels: z.array(z.string().trim().min(1).max(30)).max(12) }).parse(req.body);
  run('UPDATE leads SET labels = ? WHERE id = ?', JSON.stringify(labels), lead.id);
  logActivity(lead.id, 'note', 'Labels updated', labels.join(', '), req.user.id);
  broadcast('leads');
  broadcast('inbox');
  res.json({ ok: true });
});

crm.put('/labels', requirePermission('settings.manage'), (req, res) => {
  const { labels } = z.object({
    labels: z.array(z.object({
      name: z.string().trim().min(1).max(30),
      color: z.enum(['teal', 'green', 'amber', 'red', 'violet', 'slate']),
    })).max(30),
  }).parse(req.body);
  setSetting('lead_labels', labels);
  audit(req, 'labels.update', 'settings', '', `${labels.length} labels`);
  res.json({ ok: true });
});

