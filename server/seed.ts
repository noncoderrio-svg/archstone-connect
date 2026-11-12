import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { all, get, minutesFromNow, nowIso, run, tx } from './db.ts';
import { generatePassword, hashPassword } from './auth.ts';
import { ingestLead, logActivity, rescore } from './services/leads.ts';

const DATA_DIR = dirname(config.dbPath);
const CREDENTIALS_FILE = join(DATA_DIR, 'first-login-passwords.txt');

const PROJECTS = [
  {
    name: 'Skyline Residences', location: 'Andheri East', configuration: '1, 1.5, 2 BHK and 2 BHK with balcony', type: 'Residential', price: 90,
    note: 'Sample mandate priced from ₹90 Lakhs. Replace it with your live projects.',
  },
  { name: 'Harbour Square', location: 'Powai', configuration: 'Studio, 1 and 2 BHK', type: 'Residential', price: 90, note: '' },
  { name: 'Parkview Heights', location: 'Thane West', configuration: 'Commercial spaces, Studio, 1 and 2 BHK', type: 'Residential and Commercial', price: 80, note: '' },
  { name: 'Lakeside Towers', location: 'Chembur', configuration: '1 and 2 BHK', type: 'Residential', price: 135, note: '' },
];

const TEMPLATES = [
  { name: 'welcome_enquiry', category: 'UTILITY', body: 'Namaste {{name}}, thank you for your interest in {{project}} by Archstone. {{agent}} from our team will call you shortly.' },
  { name: 'visit_confirmation', category: 'UTILITY', body: 'Hello {{name}}, your site visit to {{project}} is confirmed for {{visit_time}}. Please share this code at the site office: {{otp}}.' },
  { name: 'visit_reminder', category: 'UTILITY', body: 'Hello {{name}}, a reminder of your site visit to {{project}} on {{visit_time}}. Your check-in code is {{otp}}.' },
  { name: 'project_offer', category: 'MARKETING', body: 'Hello {{name}}, homes at {{project}}, {{location}} start from {{price}}. MahaRERA No: {{rera}}. Reply to book a site visit. Reply STOP to opt out.' },
  { name: 'payment_reminder', category: 'UTILITY', body: 'Hello {{name}}, your {{milestone}} payment of {{amount}} for {{project}} is due on {{due_date}}. Please contact {{agent}} for any help.' },
  { name: 'follow_up_nudge', category: 'MARKETING', body: 'Hello {{name}}, we tried reaching you about {{project}}. Reply here or tell us a good time to call. MahaRERA No: {{rera}}. Reply STOP to opt out.' },
  { name: 'post_visit_feedback', category: 'UTILITY', body: 'Thank you for visiting {{project}}, {{name}}. How was your visit? Please reply with your feedback, and {{agent}} will help with your next steps.' },
  { name: 'staff_report', category: 'UTILITY', body: 'Archstone Connect {{period}} report: {{summary}}.' },
  { name: 'staff_new_lead', category: 'UTILITY', body: 'New lead for you: {{lead}} from {{source}}. Open Archstone Connect and call now.' },
  { name: 'staff_followup', category: 'UTILITY', body: 'Reminder: {{task}} with {{lead}} at {{time}}. Open Archstone Connect for details.' },
  { name: 'staff_overdue', category: 'UTILITY', body: 'Overdue: {{task}} with {{lead}} was due at {{time}}. Please complete or reschedule it.' },
  { name: 'staff_summary', category: 'UTILITY', body: 'Good morning {{name}}. You have {{overdue}} overdue and {{today}} follow-ups due today.' },
];

const AUTOMATIONS = [
  { key: 'welcome', name: 'Instant welcome', description: 'Sent the moment a new lead arrives and has opted in.', template: 'welcome_enquiry' },
  { key: 'visit_confirm', name: 'Site visit confirmation', description: 'Sends the time and check-in code when a visit is booked.', template: 'visit_confirmation' },
  { key: 'visit_reminder', name: 'Site visit reminder', description: 'Sent up to 24 hours before a scheduled visit.', template: 'visit_reminder' },
  { key: 'after_hours', name: 'After-hours reply', description: 'Acknowledges new chats and messages outside business hours.', template: null },
  { key: 'chatbot', name: 'WhatsApp chatbot', description: 'Greets new WhatsApp contacts, collects project, size, timeline and budget, then hands over to your team.', template: null },
  { key: 'payment_reminder', name: 'Payment reminder', description: 'Sent 3 days before a booking milestone is due.', template: 'payment_reminder' },
  { key: 'follow_up', name: 'Follow-up drip', description: 'Up to two nudges to leads who stopped responding. Needs marketing consent and a MahaRERA number.', template: 'follow_up_nudge' },
  { key: 'post_visit', name: 'Post-visit feedback', description: 'Thanks the customer and asks for feedback after a completed site visit.', template: 'post_visit_feedback' },
];

/** Adds templates and automations that newer versions introduce. Runs on every start. */
function ensureDefaults() {
  tx(() => {
    for (const t of TEMPLATES) {
      run(`INSERT OR IGNORE INTO wa_templates(name, category, body, status) VALUES(?, ?, ?, ?)`, t.name, t.category, t.body, config.demoMode && t.category === 'UTILITY' ? 'approved' : 'draft');
    }
    for (const a of AUTOMATIONS) {
      const template = a.template ? get<any>('SELECT id FROM wa_templates WHERE name = ?', a.template) : null;
      run('INSERT OR IGNORE INTO automations(key, name, description, template_id) VALUES(?, ?, ?, ?)', a.key, a.name, a.description, template?.id ?? null);
    }
  });
}

function recordPassword(line: string) {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(CREDENTIALS_FILE, `${line}\n`);
}

async function addUser(name: string, email: string, role: string, projectIds: number[] = [], chosenPassword = '') {
  const password = chosenPassword || generatePassword();
  const { id } = run('INSERT INTO users(name, email, role, password_hash) VALUES(?, ?, ?, ?)', name, email, role, await hashPassword(password));
  for (const p of projectIds) run('INSERT INTO user_projects(user_id, project_id) VALUES(?, ?)', id, p);
  if (!chosenPassword) recordPassword(`${role.padEnd(14)} ${email.padEnd(40)} ${password}`);
  return id;
}

/** In demo mode, gives the sample telecallers their own simulated numbers. */
function ensureDemoNumbers() {
  if (!config.demoMode || get('SELECT 1 AS x FROM wa_numbers LIMIT 1')) return;
  const staff = all<any>(`SELECT id, name FROM users WHERE email LIKE '%@demo.archstone.test' AND role IN ('telecaller','sales') ORDER BY id`);
  staff.forEach((u, i) => {
    run(
      `INSERT INTO wa_numbers(label, display_number, phone_number_id, user_id, daily_limit) VALUES(?, ?, ?, ?, 250)`,
      u.name, `+9190000900${String(i + 10)}`, `demo-${i + 1}`, u.id,
    );
  });
}

/** Creates what every installation needs. Safe to run on each start. */
export async function ensureBaseData() {
  ensureDefaults();
  if (get('SELECT 1 AS x FROM users LIMIT 1')) {
    ensureDemoNumbers();
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_FILE, 'Temporary passwords. Each one must be changed at first login. Delete this file afterwards.\n\n');

  tx(() => {
    for (const p of PROJECTS) {
      run(
        `INSERT INTO projects(name, location, configuration, type, price_from_lakhs, verify_note) VALUES(?, ?, ?, ?, ?, ?)`,
        p.name, p.location, p.configuration, p.type, p.price, p.note,
      );
    }
  });

  if (!config.initialAdminEmail) throw new Error('Set INITIAL_ADMIN_EMAIL in your .env file before the first start.');
  // A hosted server's files are out of reach, so the owner can set this one in the host's settings.
  await addUser('Administrator', config.initialAdminEmail, 'admin', [], config.initialAdminPassword);
  if (config.demoMode) {
    await addDemoData();
    ensureDemoNumbers();
  }
}

async function addDemoData() {
  const ids = Object.fromEntries(all<any>('SELECT id, name FROM projects').map((p) => [p.name, p.id as number]));
  const [bliss, square, dar, bait] = [ids['Skyline Residences'], ids['Harbour Square'], ids['Parkview Heights'], ids['Lakeside Towers']];

  await addUser('Demo Sales Manager', 'manager@demo.archstone.test', 'sales_manager');
  const head = await addUser('Demo Site Head', 'sitehead@demo.archstone.test', 'site_head', [bliss, square]);
  await addUser('Demo Marketing', 'marketing@demo.archstone.test', 'marketing');
  const salesA = await addUser('Demo Sales One', 'sales1@demo.archstone.test', 'sales');
  const salesB = await addUser('Demo Sales Two', 'sales2@demo.archstone.test', 'sales');
  const teleA = await addUser('Demo Telecaller One', 'telecaller1@demo.archstone.test', 'telecaller');
  const teleB = await addUser('Demo Telecaller Two', 'telecaller2@demo.archstone.test', 'telecaller');

  // Sample units so the inventory screen can be tried. Replace with real floor plans.
  tx(() => {
    for (const [project, config_, price] of [[bliss, '1 BHK', 92], [square, '2 BHK', 120]] as const) {
      for (let floor = 1; floor <= 6; floor++) {
        for (let n = 1; n <= 4; n++) {
          run(
            'INSERT INTO units(project_id, tower, floor, number, configuration, price_lakhs) VALUES(?, ?, ?, ?, ?, ?)',
            project, 'A', floor, `${floor}0${n}`, config_, price + floor,
          );
        }
      }
    }
  });

  const sample: Array<[string, string, number | null, string, number, string, boolean]> = [
    ['Sample Lead Aarav', 'Website', bliss, '1 BHK', 92, 'Immediately', true],
    ['Sample Lead Zoya', 'Meta Ads', bliss, '2 BHK', 130, 'Within 3 months', true],
    ['Sample Lead Kabir', 'Google Ads', square, '1 BHK', 95, 'Within 6 months', true],
    ['Sample Lead Meera', 'Referral', square, '2 BHK', 125, 'Within 3 months', true],
    ['Sample Lead Imran', 'Walk-in', dar, 'Studio', 85, 'Immediately', false],
    ['Sample Lead Sana', 'WhatsApp', bait, '2 BHK', 150, 'Within 6 months', true],
    ['Sample Lead Rohan', '99acres', dar, '1 BHK', 90, 'Exploring', false],
    ['Sample Lead Farah', 'Meta Ads', bait, '1 BHK', 140, 'Within 3 months', true],
    ['Sample Lead Dev', 'MagicBricks', bliss, '1.5 BHK', 100, 'Exploring', true],
    ['Sample Lead Ayesha', 'Website', square, 'Studio', 90, 'Immediately', true],
    ['Sample Lead Vikram', 'Channel Partner', dar, 'Commercial', 200, 'Within 3 months', false],
    ['Sample Lead Nisha', 'Housing.com', bliss, '2 BHK', 128, 'Within 6 months', true],
  ];

  const leadIds: number[] = [];
  sample.forEach(([name, source, project, configuration, budget, timeline, optIn], i) => {
    const { id } = ingestLead({
      name, source, project_id: project, configuration, budget_lakhs: budget, timeline,
      phone: `+9190000${String(10000 + i)}`,
      wa_opt_in: optIn,
      wa_opt_in_source: optIn ? 'Sample data' : undefined,
      owner_id: i % 2 ? teleB : teleA,
    });
    run('UPDATE leads SET presales_id = ? WHERE id = ?', i % 2 ? teleB : teleA, id);
    leadIds.push(id);
  });

  const stageTo = (idx: number, stage: string, owner: number) => {
    run('UPDATE leads SET stage = ?, owner_id = ?, first_response_at = ? WHERE id = ?', stage, owner, nowIso(), leadIds[idx]);
    logActivity(leadIds[idx], 'stage', `Stage: ${stage}`, 'Sample data');
    rescore(leadIds[idx]);
  };
  stageTo(0, 'Working Deal', salesA);
  stageTo(1, 'Site Visit Scheduled', salesA);
  stageTo(2, 'Qualified', salesB);
  stageTo(3, 'Site Visit Done', salesB);
  stageTo(4, 'Contacted', teleA);
  stageTo(5, 'Contacted', teleB);

  run(
    `INSERT INTO site_visits(lead_id, project_id, host_id, scheduled_at, otp, created_by) VALUES(?, ?, ?, ?, ?, ?)`,
    leadIds[1], bliss, salesA, minutesFromNow(180), '482913', head,
  );
  run('INSERT INTO tasks(lead_id, owner_id, type, due_at, notes) VALUES(?, ?, ?, ?, ?)', leadIds[4], teleA, 'Call back', minutesFromNow(60), 'Asked to call after lunch');
  run('INSERT INTO tasks(lead_id, owner_id, type, due_at, notes) VALUES(?, ?, ?, ?, ?)', leadIds[0], salesA, 'Send cost sheet', minutesFromNow(-90), 'Overdue sample task');

  for (const [i, text] of [[0, 'Is the 1 BHK still available?'], [5, 'Please share the brochure']] as const) {
    run(
      `INSERT INTO wa_messages(lead_id, direction, body, status, simulated, wa_id) VALUES(?, 'in', ?, 'received', 1, ?)`,
      leadIds[i], text, `demo.seed.${i}`,
    );
    run('UPDATE leads SET last_inbound_at = ?, last_message_at = ?, unread_count = 1 WHERE id = ?', nowIso(), nowIso(), leadIds[i]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await ensureBaseData();
  console.log(`Done. Temporary passwords are in ${CREDENTIALS_FILE}`);
}
