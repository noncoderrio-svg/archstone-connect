import { LEAD_ROLES, isViewOnly } from '../../shared/domain.ts';
import { currentMonth, projectIdsOf, roleTargets, targetFor } from './targets.ts';
import { existsSync } from 'node:fs';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { SessionUser } from '../auth.ts';
import { all, get } from '../db.ts';
import { leadScope } from './core.ts';
import { clauseSql, leadFilters } from './filters.ts';

const FUNNEL = ['Not Contacted', 'Contacted', 'Qualified', 'Site Visit Scheduled', 'Site Visit Done', 'Working Deal', 'Booked'];

const sinceDays = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');

/** One report for every use: the screen, exports, schedules and AI answers. Always limited to what this user may see. */
export function buildReport(user: SessionUser, days: number, q: Record<string, unknown> = {}) {
  const base = leadScope(user);
  const filter = leadFilters({ project: q.project, owner: q.owner, source: q.source, created_to: q.created_to });
  const scope = { sql: base.sql + clauseSql(filter), params: [...base.params, ...filter.params] };
  const since = typeof q.created_from === 'string' && q.created_from ? q.created_from.slice(0, 19).replace('T', ' ') : sinceDays(days);
  const until = typeof q.created_to === 'string' && q.created_to ? q.created_to.slice(0, 10) : '9999-12-31';
  const projectId = Number(q.project) || 0;
  const ownerId = Number(q.owner) || 0;
  const count = (extra: string, ...p: (string | number)[]) =>
    get<{ n: number }>(`SELECT COUNT(*) n FROM leads l WHERE ${scope.sql} AND ${extra}`, ...scope.params, ...p)!.n;

  const canSeeSpend = user.role === 'admin';
  const spend = all<any>(
    'SELECT source, SUM(amount_inr) AS amount FROM ad_spend WHERE spend_date >= ? AND spend_date <= ? AND (? = 0 OR project_id = ?) GROUP BY source',
    since.slice(0, 10), until, projectId, projectId,
  );
  const sources = all<any>(
    `SELECT l.source,
       COUNT(*) AS leads,
       SUM(l.stage NOT IN ('Not Contacted','Contacted','Unqualified','Did Not Respond')) AS qualified,
       SUM(EXISTS (SELECT 1 FROM site_visits v WHERE v.lead_id = l.id AND v.status IN ('Checked In','Completed'))) AS visits,
       SUM(l.stage = 'Booked') AS booked
     FROM leads l WHERE ${scope.sql} AND l.created_at >= ? GROUP BY l.source ORDER BY leads DESC`,
    ...scope.params, since,
  ).map((s) => {
    const amount = canSeeSpend ? (spend.find((x) => x.source === s.source)?.amount ?? 0) : null;
    return { ...s, spend: amount, cpl: amount && s.leads ? Math.round(amount / s.leads) : null };
  });

  const projects = all<any>(
    `SELECT p.name AS project, COUNT(l.id) AS leads,
       SUM(l.stage = 'Booked') AS booked,
       SUM(l.temperature = 'Hot') AS hot,
       COALESCE((SELECT SUM(b.amount_lakhs) FROM bookings b JOIN units u ON u.id = b.unit_id
                 WHERE u.project_id = p.id AND b.status = 'active' AND b.created_at >= ?), 0) AS revenue_lakhs
     FROM leads l JOIN projects p ON p.id = l.project_id WHERE ${scope.sql} AND l.created_at >= ? GROUP BY p.id ORDER BY leads DESC`,
    since, ...scope.params, since,
  );

  const team = isViewOnly(user.role) ? [] : all<any>(
    `SELECT u.id, u.name, u.role,
       (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.deleted_at IS NULL) AS leads,
       (SELECT COUNT(*) FROM activities a WHERE a.actor_id = u.id AND a.type = 'call' AND a.created_at >= ?) AS calls,
       (SELECT COUNT(*) FROM activities a WHERE a.actor_id = u.id AND a.type = 'call' AND a.title LIKE '%Connected%' AND a.created_at >= ?) AS connected,
       (SELECT COUNT(*) FROM site_visits v WHERE v.host_id = u.id AND v.status IN ('Checked In','Completed') AND v.scheduled_at >= ?) AS visits,
       (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.stage = 'Booked') AS booked,
       (SELECT ROUND(AVG((julianday(l.first_response_at) - julianday(l.created_at)) * 1440), 1) FROM leads l
          WHERE (l.owner_id = u.id OR l.presales_id = u.id) AND l.first_response_at IS NOT NULL AND l.created_at >= ?) AS avg_response_minutes
     FROM users u WHERE u.role IN (${LEAD_ROLES.map((r) => `'${r}'`).join(',')}) AND u.status = 'active' AND (? = 0 OR u.id = ?) ORDER BY booked DESC, visits DESC`,
    since, since, since, since, ownerId, ownerId,
  );

  return {
    days,
    funnel: FUNNEL.map((stage) => ({ stage, count: count('l.stage = ?', stage) })),
    sources,
    projects,
    team,
    lost: all<any>(
      `SELECT l.lost_reason AS label, COUNT(*) AS value FROM leads l WHERE ${scope.sql} AND l.stage = 'Lost' AND l.lost_reason != '' GROUP BY l.lost_reason ORDER BY value DESC`,
      ...scope.params,
    ),
    canSeeSpend,
    collections: get<any>(
      `SELECT COALESCE(SUM(x.amount_lakhs), 0) AS scheduled,
        COALESCE(SUM(CASE WHEN x.paid_at IS NOT NULL THEN x.amount_lakhs END), 0) AS collected,
        COALESCE(SUM(CASE WHEN x.paid_at IS NULL AND x.due_date < date('now') THEN x.amount_lakhs END), 0) AS overdue
       FROM payments x JOIN bookings b ON b.id = x.booking_id JOIN leads l ON l.id = b.lead_id
       WHERE ${scope.sql} AND b.status = 'active'`,
      ...scope.params,
    ),
    newLeads: count('l.created_at >= ?', since),
  };
}

export type Report = ReturnType<typeof buildReport>;

/** A single line, because WhatsApp template values may not contain line breaks. */
export function summaryLine(r: Report) {
  const booked = r.funnel.find((f) => f.stage === 'Booked')?.count ?? 0;
  const visits = r.sources.reduce((s, x) => s + (x.visits ?? 0), 0);
  return `${r.newLeads} new leads, ${visits} site visits, ${booked} booked in total, Rs. ${r.collections.collected} Lakhs collected`;
}

// ---------- Tables, shared by Excel and PDF ----------
function sections(r: Report) {
  const out: { title: string; head: string[]; rows: (string | number)[][] }[] = [
    { title: 'Sales funnel', head: ['Stage', 'Leads'], rows: r.funnel.map((f) => [f.stage, f.count]) },
    {
      title: 'Sources',
      head: ['Source', 'Leads', 'Qualified', 'Visited', 'Booked', ...(r.canSeeSpend ? ['Spend (Rs.)', 'Cost per lead (Rs.)'] : [])],
      rows: r.sources.map((s) => [s.source, s.leads, s.qualified, s.visits, s.booked, ...(r.canSeeSpend ? [s.spend ?? 0, s.cpl ?? 0] : [])]),
    },
    {
      title: 'Projects',
      head: ['Project', 'Leads', 'Hot', 'Booked', 'Revenue (Rs. Lakhs)'],
      rows: r.projects.map((p) => [p.project, p.leads, p.hot, p.booked, p.revenue_lakhs]),
    },
  ];
  if (r.team.length) {
    out.push({
      title: 'Team',
      head: ['Name', 'Leads', 'Calls', 'Connected', 'Visits', 'Booked', 'Avg first response (min)'],
      rows: r.team.map((u) => [u.name, u.leads, u.calls, u.connected, u.visits, u.booked, u.avg_response_minutes ?? '-']),
    });
  }
  out.push({
    title: 'Collections',
    head: ['Scheduled (Rs. Lakhs)', 'Collected (Rs. Lakhs)', 'Overdue (Rs. Lakhs)'],
    rows: [[r.collections.scheduled, r.collections.collected, r.collections.overdue]],
  });
  if (r.lost.length) out.push({ title: 'Lost reasons', head: ['Reason', 'Leads'], rows: r.lost.map((l) => [l.label, l.value]) });
  return out;
}

export async function reportWorkbook(r: Report) {
  const book = new ExcelJS.Workbook();
  book.creator = 'Archstone Connect';
  for (const s of sections(r)) {
    const sheet = book.addWorksheet(s.title);
    sheet.addRow(s.head).font = { bold: true };
    s.rows.forEach((row) => sheet.addRow(row));
    sheet.columns.forEach((c) => { c.width = 20; });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function leadsWorkbook(head: string[], rows: Record<string, unknown>[]) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Leads');
  sheet.addRow(head).font = { bold: true };
  for (const r of rows) {
    // Keep every value as text so a spreadsheet cannot treat it as a formula.
    sheet.addRow(head.map((h) => String(r[h] ?? '')));
  }
  sheet.columns.forEach((c) => { c.width = 18; });
  return Buffer.from(await book.xlsx.writeBuffer());
}

/** Reads the first sheet of an uploaded .xlsx into rows keyed by its header. */
export async function readWorkbook(data: Buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(data as unknown as ArrayBuffer);
  const sheet = book.worksheets[0];
  if (!sheet) return [];
  const keys: string[] = [];
  const rows: Record<string, string>[] = [];
  sheet.eachRow((row, index) => {
    const cells = (row.values as unknown[]).slice(1).map((v) => {
      if (v && typeof v === 'object') return String((v as any).text ?? (v as any).result ?? '');
      return v === null || v === undefined ? '' : String(v);
    });
    if (index === 1) keys.push(...cells.map((c) => c.trim().toLowerCase().replace(/\s+/g, '_')));
    else if (cells.some((c) => c.trim())) rows.push(Object.fromEntries(keys.map((k, i) => [k, (cells[i] ?? '').trim()])));
  });
  return rows;
}

export function reportPdf(r: Report, preparedFor: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 44, info: { Title: 'Archstone Report', Author: 'Archstone Connect' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const logo = 'web/public/logo.png';
    if (existsSync(logo)) doc.image(logo, 44, 36, { height: 62 });
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#1e293b').text('Performance Report', 120, 44);
    doc.font('Helvetica').fontSize(10).fillColor('#64748b')
      .text(`Last ${r.days} days. Prepared for ${preparedFor} on ${new Date().toLocaleDateString('en-IN', { dateStyle: 'long', timeZone: 'Asia/Kolkata' })}.`, 120, 68);
    doc.y = 116;

    const width = doc.page.width - 88;
    for (const s of sections(r)) {
      if (doc.y > doc.page.height - 130) doc.addPage();
      doc.x = 44;
      doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor('#006792').text(s.title);
      doc.moveDown(0.25);
      const col = width / s.head.length;
      const line = (cells: (string | number)[], bold: boolean) => {
        if (doc.y > doc.page.height - 70) doc.addPage();
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(bold ? '#1e293b' : '#334155');
        cells.forEach((c, i) => doc.text(String(c), 44 + i * col, y, { width: col - 6, lineBreak: false, ellipsis: true }));
        doc.y = y + 15;
      };
      line(s.head, true);
      if (!s.rows.length) line(['No data'], false);
      s.rows.forEach((row) => line(row, false));
    }
    doc.end();
  });
}

// ---------- Targets and streaks ----------
export { currentMonth } from './targets.ts';

/** Personal progress for the dashboard: the role's goals and score, plus streak and call quality. */
export function targetProgress(userId: number) {
  const month = currentMonth();
  const start = `${month}-01 00:00:00`;
  const saved = targetFor(userId, month);
  const target = { calls: saved.calls ?? 0, visits: saved.visits ?? 0, bookings: saved.bookings ?? 0 };
  const person = get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
  const byRole = roleTargets({ id: userId, role: person?.role ?? '', project_ids: projectIdsOf(userId) }, month);
  const calls = get<{ n: number }>(`SELECT COUNT(*) n FROM activities WHERE actor_id = ? AND type = 'call' AND created_at >= ?`, userId, start)!.n;
  const connected = get<{ n: number }>(`SELECT COUNT(*) n FROM activities WHERE actor_id = ? AND type = 'call' AND title LIKE '%Connected%' AND created_at >= ?`, userId, start)!.n;
  const talk = get<{ s: number }>(`SELECT COALESCE(SUM(duration_seconds), 0) s FROM calls WHERE user_id = ? AND created_at >= ?`, userId, start)!.s;
  const visits = get<{ n: number }>(`SELECT COUNT(*) n FROM site_visits WHERE (host_id = ? OR created_by = ?) AND status IN ('Checked In','Completed') AND scheduled_at >= ?`, userId, userId, start)!.n;
  const bookings = get<{ n: number }>(
    `SELECT COUNT(*) n FROM bookings b JOIN leads l ON l.id = b.lead_id WHERE b.status = 'active' AND b.created_at >= ? AND (l.owner_id = ? OR l.presales_id = ?)`,
    start, userId, userId,
  )!.n;
  const qualified = get<{ n: number }>(
    `SELECT COUNT(DISTINCT a.lead_id) n FROM activities a WHERE a.actor_id = ? AND a.type = 'stage' AND a.title LIKE '%→ Qualified' AND a.created_at >= ?`,
    userId, start,
  )!.n;

  // Consecutive days with at least one call, counting back from today (IST).
  const days = new Set(
    all<{ d: string }>(
      `SELECT DISTINCT date(created_at, '+330 minutes') d FROM activities WHERE actor_id = ? AND type = 'call' AND created_at >= datetime('now', '-120 days')`,
      userId,
    ).map((r) => r.d),
  );
  let streak = 0;
  const today = new Date(Date.now() + 5.5 * 3600000);
  // Today does not break a streak if no call has been made yet.
  for (let i = days.has(today.toISOString().slice(0, 10)) ? 0 : 1; i < 120; i++) {
    const d = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    if (!days.has(d)) break;
    streak++;
  }

  return {
    month,
    target,
    calls,
    visits,
    bookings,
    qualified,
    streak,
    connect_rate: calls ? Math.round((connected / calls) * 100) : 0,
    talk_minutes: Math.round(talk / 60),
    goals: byRole.goals,
    score: byRole.score,
  };
}
