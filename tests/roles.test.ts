// The role hierarchy: the one-time move from old roles, and what each new role may see.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'archstone-roles-'));
Object.assign(process.env, {
  ARCHSTONE_SKIP_DOTENV: '1', DB_PATH: join(dir, 'test.db'), DEMO_MODE: 'true', INITIAL_ADMIN_EMAIL: 'owner@test.local',
  WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', GEMINI_API_KEY: '',
});

let db: any;
let migrateRoles: () => void;
let leadScope: any;
let domain: any;
const ids: Record<string, number> = {};

const addUser = (key: string, role: string) => {
  ids[key] = db.run(`INSERT INTO users(name, email, role, password_hash) VALUES(?, ?, ?, 'x')`, key, `${key}@test.local`, role).id;
};

before(async () => {
  db = await import('../server/db.ts');
  ({ migrateRoles } = await import('../server/migrations.ts'));
  ({ leadScope } = await import('../server/services/core.ts'));
  domain = await import('../shared/domain.ts');
  // An installation from before the change: old roles and saved role permissions.
  addUser('boss', 'admin');
  addUser('sm', 'sales_manager');
  addUser('tl', 'team_leader');
  addUser('sp', 'sales');
  addUser('mk', 'marketing');
  addUser('tc', 'telecaller');
  addUser('sh', 'site_head');
  db.setSetting('role_permissions', {
    team_leader: ['lead.create', 'lead.reassign'],
    sales: ['lead.create', 'visit.checkin', 'not.a.real.action'],
    sales_manager: ['partner.manage', 'reports.view'],
  });
  db.setSetting('mask_phone_roles', ['marketing', 'sales', 'site_head']);
  migrateRoles();
});

after(() => {
  try { db.db.close(); rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the database. */ }
});

const roleOf = (key: string) => db.get('SELECT role FROM users WHERE id = ?', ids[key]).role;

test('every old role moves to its new role', () => {
  assert.equal(roleOf('sm'), 'sourcing_manager');
  assert.equal(roleOf('tl'), 'closing_manager');
  assert.equal(roleOf('sp'), 'closing_manager');
  assert.equal(roleOf('mk'), 'telecaller');
  assert.equal(roleOf('tc'), 'telecaller');
  assert.equal(roleOf('sh'), 'site_head');
  assert.equal(roleOf('boss'), 'admin');
  const roles = db.all('SELECT DISTINCT role FROM users').map((r: any) => r.role);
  assert.ok(roles.every((r: string) => domain.ROLES.includes(r)), 'no old role is left');
});

test('saved role permissions move too, and two old roles merge into one', () => {
  const saved = db.getSetting('role_permissions', {});
  assert.deepEqual([...saved.closing_manager].sort(), ['lead.create', 'lead.reassign', 'visit.checkin'], 'Team Leader and Sales Person combined');
  assert.deepEqual([...saved.sourcing_manager].sort(), ['partner.manage', 'reports.view']);
  assert.ok(!('sales' in saved) && !('team_leader' in saved) && !('sales_manager' in saved), 'old keys are gone');
  assert.ok(!saved.closing_manager.includes('not.a.real.action'), 'unknown actions are dropped');
  assert.ok(!('telecaller' in saved), 'a role with nothing saved keeps its defaults');
});

test('a phone mask on old Marketing is dropped, other masked roles are mapped', () => {
  assert.deepEqual(db.getSetting('mask_phone_roles', []).sort(), ['closing_manager', 'site_head']);
});

test('the migration runs only once', () => {
  const runs = () => db.get(`SELECT COUNT(*) n FROM audit_log WHERE action = 'roles.migrate'`).n;
  assert.equal(runs(), 1);
  addUser('late', 'sales');
  migrateRoles();
  assert.equal(roleOf('late'), 'sales', 'a second start does not touch anyone');
  assert.equal(runs(), 1);
  db.run('UPDATE users SET role = ? WHERE id = ?', 'closing_manager', ids.late);
});

test('role lists come from one shared place', () => {
  assert.deepEqual([...domain.ROLES], ['admin', 'site_head', 'sourcing_manager', 'closing_manager', 'payment_followup', 'telecaller']);
  for (const r of domain.ROLES) assert.ok(domain.ROLE_LABELS[r] && domain.PERMISSIONS[r] && domain.DEFAULT_SCOPE[r]);
  assert.ok(domain.MANAGER_ROLES.includes('sourcing_manager') && domain.MANAGER_ROLES.includes('closing_manager'));
  assert.ok(!domain.MANAGER_ROLES.includes('telecaller') && !domain.MANAGER_ROLES.includes('payment_followup'));
  assert.ok(domain.isViewOnly('payment_followup'));
});

test('Payment Follow-up sees only buyers with a booking on their own projects', () => {
  const p1 = db.run(`INSERT INTO projects(name) VALUES('Alpha')`).id;
  const p2 = db.run(`INSERT INTO projects(name) VALUES('Beta')`).id;
  const lead = (name: string, phone: string) => db.run(`INSERT INTO leads(name, phone) VALUES(?, ?)`, name, phone).id;
  const unit = (project: number, n: string) => db.run(`INSERT INTO units(project_id, floor, number) VALUES(?, 1, ?)`, project, n).id;
  const buyerA = lead('Buyer Alpha', '+919000000001');
  const buyerB = lead('Buyer Beta', '+919000000002');
  lead('Just a lead', '+919000000003');
  db.run('INSERT INTO bookings(lead_id, unit_id, amount_lakhs) VALUES(?, ?, 50)', buyerA, unit(p1, '101'));
  db.run('INSERT INTO bookings(lead_id, unit_id, amount_lakhs) VALUES(?, ?, 60)', buyerB, unit(p2, '101'));
  const user = { id: 999, role: 'payment_followup', project_ids: [p1], data_scope: '' };
  const scope = leadScope(user);
  const names = db.all(`SELECT l.name FROM leads l WHERE ${scope.sql}`, ...scope.params).map((r: any) => r.name);
  assert.deepEqual(names, ['Buyer Alpha']);
  const none = leadScope({ ...user, project_ids: [] });
  assert.equal(db.all(`SELECT l.id FROM leads l WHERE ${none.sql}`, ...none.params).length, 0, 'no projects, no buyers');
});

test('Sourcing and Closing Managers see their own and their team\'s leads, not everyone\'s', () => {
  const own = db.run(`INSERT INTO leads(name, phone, owner_id) VALUES('Mine', '+919000000011', ?)`, ids.tl).id;
  db.run(`INSERT INTO leads(name, phone, owner_id) VALUES('Report lead', '+919000000012', ?)`, ids.tc);
  db.run(`INSERT INTO leads(name, phone, owner_id) VALUES('Stranger', '+919000000013', ?)`, ids.sp);
  db.run('UPDATE users SET manager_id = ? WHERE id = ?', ids.tl, ids.tc);
  const scope = leadScope({ id: ids.tl, role: 'closing_manager', project_ids: [], data_scope: '' });
  const names = db.all(`SELECT l.name FROM leads l WHERE ${scope.sql} ORDER BY l.id`, ...scope.params).map((r: any) => r.name);
  assert.deepEqual(names, ['Mine', 'Report lead']);
  assert.ok(own);
});

test('permissions added later reach saved role sets once, by their defaults', async () => {
  const { addNewPermissions } = await import('../server/migrations.ts');
  db.setSetting('permissions_version', 2);
  db.setSetting('role_permissions', { closing_manager: ['lead.create'], sourcing_manager: ['lead.create'] });
  addNewPermissions();
  const saved = db.getSetting('role_permissions', {});
  assert.deepEqual(saved.closing_manager.sort(), ['lead.create', 'unit.hold']);
  assert.deepEqual(saved.sourcing_manager.sort(), ['lead.create', 'unit.book', 'unit.hold']);
  // An admin who later takes a permission away keeps that choice.
  db.setSetting('role_permissions', { closing_manager: ['lead.create'] });
  addNewPermissions();
  assert.deepEqual(db.getSetting('role_permissions', {}).closing_manager, ['lead.create']);
});

test('payment permissions reach a saved role set only if it could already manage bookings', async () => {
  const { addNewPermissions } = await import('../server/migrations.ts');
  db.setSetting('permissions_version', 3);
  db.setSetting('role_permissions', { sourcing_manager: ['booking.manage'], site_head: ['lead.create'] });
  addNewPermissions();
  const saved = db.getSetting('role_permissions', {});
  assert.deepEqual(saved.sourcing_manager.sort(), ['booking.manage', 'payment.followup', 'payment.record']);
  assert.deepEqual(saved.site_head, ['lead.create'], 'an admin had taken bookings away, so payments stay away too');
});
