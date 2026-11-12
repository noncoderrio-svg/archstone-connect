import { ACTIONS, LEGACY_ROLES, ROLES, type Action, type Role } from '../shared/domain.ts';
import { all, getSetting, run, setSetting, tx } from './db.ts';

/** The default permissions each role had before the role change, needed to merge saved sets. */
const OLD_DEFAULTS: Record<string, string[]> = {
  sales_manager: ['lead.create', 'whatsapp.send', 'campaign.create', 'call.office', 'ai.use', 'lead.reassign', 'lead.import', 'lead.export', 'approval.review', 'reports.view', 'visit.checkin', 'booking.manage', 'partner.manage', 'media.manage'],
  team_leader: ['lead.create', 'whatsapp.send', 'campaign.create', 'call.office', 'ai.use', 'lead.reassign', 'approval.review', 'reports.view', 'visit.checkin'],
  marketing: ['campaign.create', 'ai.use', 'lead.import', 'template.manage', 'reports.view', 'media.manage'],
  sales: ['lead.create', 'whatsapp.send', 'campaign.create', 'call.office', 'ai.use', 'visit.checkin'],
  telecaller: ['lead.create', 'whatsapp.send', 'campaign.create', 'call.office', 'ai.use'],
};

const MARK = 'migration_roles_v2';

/**
 * Moves people and saved role permissions from the old roles to the new ones.
 * Runs once: a marker setting is written in the same transaction.
 * When two old roles become one new role, the new role gets everything either had.
 */
export function migrateRoles() {
  if (getSetting(MARK, false)) return;
  tx(() => {
    const saved = getSetting<Record<string, string[]>>('role_permissions', {});
    const known = new Set<string>(ACTIONS);
    const next: Partial<Record<Role, Action[]>> = {};
    for (const role of ROLES) {
      if (role === 'admin') continue;
      // The old roles that fold into this one, including itself when the name is unchanged.
      const sources = [...Object.keys(LEGACY_ROLES).filter((old) => LEGACY_ROLES[old] === role), ...(role in OLD_DEFAULTS || saved[role] ? [role] : [])];
      if (!sources.some((s) => saved[s])) continue;
      const merged = new Set<string>();
      for (const s of sources) for (const a of saved[s] ?? OLD_DEFAULTS[s] ?? []) if (known.has(a)) merged.add(a);
      next[role] = [...merged] as Action[];
    }
    if (Object.keys(saved).length) setSetting('role_permissions', next);

    const moved: string[] = [];
    for (const [old, role] of Object.entries(LEGACY_ROLES)) {
      const { changes } = run('UPDATE users SET role = ? WHERE role = ?', role, old);
      if (changes) moved.push(`${changes} ${old} → ${role}`);
    }

    // Masking phone numbers of a role that now makes calls would stop them working, so old Marketing is dropped.
    const masked = getSetting<string[] | null>('mask_phone_roles', null);
    if (masked) {
      const mapped = masked.filter((r) => r !== 'marketing').map((r) => LEGACY_ROLES[r] ?? r).filter((r) => (ROLES as readonly string[]).includes(r));
      setSetting('mask_phone_roles', [...new Set(mapped)]);
    }

    const leftover = all<{ role: string }>('SELECT DISTINCT role FROM users').filter((r) => !(ROLES as readonly string[]).includes(r.role));
    if (leftover.length) console.error(`Unknown roles left in users: ${leftover.map((r) => r.role).join(', ')}`);

    run(`INSERT INTO audit_log(action, entity, detail) VALUES('roles.migrate', 'user', ?)`, moved.join('; ') || 'no users to move');
    setSetting(MARK, true);
  });
}
