import { all, get, minutesFromNow, nowIso, run } from '../db.ts';
import { alertUser } from './alerts.ts';
import { broadcast } from './core.ts';
import { assignLead, logActivity } from './leads.ts';
import { sendBlockers, sendTemplate } from './whatsapp.ts';

export type Trigger = 'lead_created' | 'stage_changed' | 'lead_idle';

interface Rule {
  id: number; name: string; trigger: string; action: string; created_by: number;
  conditions: { source?: string; project_id?: number; temperature?: string; stage?: string; days?: number };
  config: { task_type?: string; after_minutes?: number; label?: string; user_id?: number; text?: string; template_id?: number };
}

const activeRules = (trigger: Trigger) => all<any>('SELECT * FROM workflow_rules WHERE enabled = 1 AND trigger = ?', trigger)
  .map((r): Rule => ({ ...r, conditions: JSON.parse(r.conditions), config: JSON.parse(r.config) }));

function matches(rule: Rule, lead: any) {
  const c = rule.conditions;
  return (!c.source || c.source === lead.source)
    && (!c.project_id || c.project_id === lead.project_id)
    && (!c.temperature || c.temperature === lead.temperature)
    && (!c.stage || c.stage === lead.stage);
}

async function perform(rule: Rule, lead: any) {
  const { action, config } = rule;
  if (action === 'create_task') {
    const owner = lead.owner_id ?? rule.created_by;
    run('INSERT INTO tasks(lead_id, owner_id, type, due_at, notes) VALUES(?, ?, ?, ?, ?)', lead.id, owner, config.task_type || 'Call back', minutesFromNow(config.after_minutes ?? 60), `Created by rule: ${rule.name}`);
  } else if (action === 'add_label') {
    const labels: string[] = JSON.parse(lead.labels);
    if (config.label && !labels.includes(config.label)) run('UPDATE leads SET labels = ? WHERE id = ?', JSON.stringify([...labels, config.label]), lead.id);
  } else if (action === 'assign_owner') {
    if (config.user_id) assignLead(lead.id, config.user_id, rule.created_by, `Rule: ${rule.name}`);
  } else if (action === 'notify_owner') {
    alertUser(lead.owner_id, 'followup', config.text || rule.name, lead.name, `/leads/${lead.id}`);
  } else if (action === 'send_template') {
    const template = get<any>('SELECT * FROM wa_templates WHERE id = ?', config.template_id ?? 0);
    // The same consent and MahaRERA checks as every other message.
    if (!template || sendBlockers(lead, template).length) return false;
    await sendTemplate(lead, template.id, null);
  }
  return true;
}

/** Runs once per rule, lead and occasion. A rule that fails must never stop the sale. */
async function apply(rule: Rule, leadId: number, occasion: string) {
  const lead = get<any>('SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL', leadId);
  if (!lead || !matches(rule, lead)) return;
  const { changes } = run('INSERT OR IGNORE INTO workflow_runs(rule_id, lead_id, occasion) VALUES(?, ?, ?)', rule.id, leadId, occasion);
  if (!changes) return;
  try {
    if (await perform(rule, lead)) {
      logActivity(leadId, 'automation', `Rule ran: ${rule.name}`, '', null);
      run('UPDATE workflow_rules SET runs = runs + 1, last_run_at = ? WHERE id = ?', nowIso(), rule.id);
      broadcast('leads');
    }
  } catch (e) {
    console.error(`Rule ${rule.id} failed:`, (e as Error).message);
  }
}

export async function runWorkflows(trigger: 'lead_created' | 'stage_changed', leadId: number, occasion = '') {
  for (const rule of activeRules(trigger)) await apply(rule, leadId, occasion);
}

export async function runIdleWorkflows() {
  for (const rule of activeRules('lead_idle')) {
    const leads = all<{ id: number; last_activity_at: string }>(
      `SELECT id, last_activity_at FROM leads WHERE deleted_at IS NULL AND stage NOT IN ('Booked','Lost','Unqualified') AND last_activity_at <= ? LIMIT 500`,
      minutesFromNow(-(rule.conditions.days || 3) * 1440),
    );
    // A lead that wakes up and goes quiet again counts as a new occasion.
    for (const lead of leads) await apply(rule, lead.id, lead.last_activity_at);
  }
}
