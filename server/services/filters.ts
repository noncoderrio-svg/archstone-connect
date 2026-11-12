/** Lead filters shared by the list, its exports, the inbox, the dashboard and reports. */

type Query = Record<string, unknown>;
export interface Clause { where: string[]; params: (string | number)[] }

const text = (q: Query, key: string) => (typeof q[key] === 'string' ? (q[key] as string) : '');
const list = (q: Query, key: string) => text(q, key).split(',').filter(Boolean);

const BUDGETS: Record<string, string> = {
  lt100: 'l.budget_lakhs < 100',
  '100-200': 'l.budget_lakhs BETWEEN 100 AND 200',
  '200-500': 'l.budget_lakhs > 200 AND l.budget_lakhs <= 500',
  gt500: 'l.budget_lakhs > 500',
};

const OPEN_TASK = 'SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.completed_at IS NULL';
// Follow-ups are judged by the Indian calendar day, not the server's UTC day.
const TASKS: Record<string, string> = {
  overdue: `EXISTS (${OPEN_TASK} AND datetime(t.due_at) < datetime('now'))`,
  today: `EXISTS (${OPEN_TASK} AND date(t.due_at, '+330 minutes') = date('now', '+330 minutes') AND datetime(t.due_at) >= datetime('now'))`,
  upcoming: `EXISTS (${OPEN_TASK} AND date(t.due_at, '+330 minutes') > date('now', '+330 minutes'))`,
  none: `NOT EXISTS (${OPEN_TASK})`,
};

const SORTS: Record<string, string> = {
  activity: 'l.last_activity_at DESC',
  newest: 'l.created_at DESC',
  oldest: 'l.created_at ASC',
  score: 'l.score DESC, l.last_activity_at DESC',
  budget_high: 'l.budget_lakhs IS NULL, l.budget_lakhs DESC',
  budget_low: 'l.budget_lakhs IS NULL, l.budget_lakhs ASC',
  name: 'l.name COLLATE NOCASE ASC',
};

export const leadSort = (q: Query) => SORTS[text(q, 'sort')] ?? SORTS.activity;

/** A dropped filter must never widen what someone sees, so this only ever adds conditions. */
export function leadFilters(q: Query, options: { skipStage?: boolean } = {}): Clause {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const equal = (column: string, value: string) => {
    if (value) { where.push(`${column} = ?`); params.push(value); }
  };

  const search = text(q, 'q');
  if (search) {
    // A plain number also finds a lead by its ID.
    const byId = /^\d{1,9}$/.test(search);
    where.push(`(l.name LIKE ? OR l.phone LIKE ? OR l.email LIKE ?${byId ? ' OR l.id = ?' : ''})`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, ...(byId ? [Number(search)] : []));
  }
  equal('l.utm_campaign', text(q, 'campaign'));
  equal('l.adset', text(q, 'adset'));
  equal('l.ad', text(q, 'ad'));
  equal('l.last_disposition', text(q, 'disposition'));
  if (!options.skipStage) equal('l.stage', text(q, 'stage'));
  equal('l.source', text(q, 'source'));
  equal('l.temperature', text(q, 'temperature'));
  equal('l.project_id', text(q, 'project'));

  const owner = text(q, 'owner');
  if (owner === 'none') where.push('l.owner_id IS NULL');
  else equal('l.owner_id', owner);

  const label = text(q, 'label');
  if (label) { where.push('l.labels LIKE ?'); params.push(`%${JSON.stringify(label)}%`); }

  const configuration = text(q, 'configuration');
  if (configuration) { where.push('l.configuration LIKE ?'); params.push(`%${configuration}%`); }

  const created = [text(q, 'created_from'), text(q, 'created_to')];
  if (created[0]) { where.push('datetime(l.created_at) >= datetime(?)'); params.push(created[0]); }
  if (created[1]) { where.push('datetime(l.created_at) <= datetime(?)'); params.push(created[1]); }

  const budget = BUDGETS[text(q, 'budget')];
  if (budget) where.push(budget);
  const budgetMax = Number(text(q, 'budget_max'));
  if (budgetMax > 0) { where.push('l.budget_lakhs <= ?'); params.push(budgetMax); }

  const tasks = list(q, 'task').map((t) => TASKS[t]).filter(Boolean);
  if (tasks.length) where.push(`(${tasks.join(' OR ')})`);
  if (text(q, 'overdue') === '1') where.push(TASKS.overdue);

  const action = text(q, 'action');
  if (action) { where.push(`EXISTS (${OPEN_TASK} AND t.type = ?)`); params.push(action); }

  if (text(q, 'unread') === '1') where.push('l.unread_count > 0');
  if (text(q, 'waiting') === '1') where.push('l.first_response_at IS NULL');
  return { where, params };
}

export const clauseSql = (clause: Clause) => clause.where.map((w) => ` AND ${w}`).join('');
