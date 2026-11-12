import { useEffect, useState } from 'react';
import { ACTIONS, DATA_SCOPES, PERMISSION_GROUPS, PERMISSIONS, ROLES, ROLE_LABELS, type Action, type Role } from '../../../shared/domain.ts';
import { Button, Card, ErrorNote, Modal, Notice, SelectField, Spinner, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';

/** Every permission, by role. A person can then differ from their role. */
export function RolePermissions() {
  const { data, error, reload } = useApi('/permissions');
  const { run } = useAction();
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  const roles = ROLES.filter((r) => r !== 'admin');
  const toggle = async (role: Role, action: Action, on: boolean) => {
    const actions = on ? [...data.roles[role], action] : data.roles[role].filter((a: Action) => a !== action);
    await run(() => api.put(`/permissions/role/${role}`, { actions }));
    void reload();
  };
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-line text-left text-[13px] text-muted">
            <th className="px-4 py-2 font-medium">Permission</th>
            {roles.map((r) => <th key={r} className="px-2 py-2 text-center font-medium">{ROLE_LABELS[r]}</th>)}
          </tr>
        </thead>
        <tbody>
          {PERMISSION_GROUPS.map((g) => (
            <>
              <tr key={g.group}><td colSpan={roles.length + 1} className="bg-surface-2 px-4 py-1.5 text-[13px] font-semibold text-ink">{g.group}</td></tr>
              {g.items.map(([action, label]) => (
                <tr key={action} className="border-b border-line">
                  <td className="px-4 py-1.5">{label}</td>
                  {roles.map((r) => (
                    <td key={r} className="px-2 py-1.5 text-center">
                      <input type="checkbox" aria-label={`${label} for ${ROLE_LABELS[r]}`} className="accent-[#C85A1E]"
                        checked={data.roles[r].includes(action)} onChange={(e) => toggle(r, action, e.target.checked)} />
                    </td>
                  ))}
                </tr>
              ))}
            </>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-2 text-xs text-muted">Admins always keep every permission, so nobody can be locked out. Changes apply immediately.</p>
    </Card>
  );
}

type Choice = 'role' | 'allow' | 'deny';

export function UserPermissions({ user, onClose }: { user: any; onClose: () => void }) {
  const { data } = useApi(`/users/${user.id}/permissions`);
  const { data: roles } = useApi('/permissions');
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [scope, setScope] = useState('');
  const { busy, run } = useAction();

  useEffect(() => {
    if (!data) return;
    setScope(data.data_scope);
    setChoices(Object.fromEntries(data.overrides.map((o: any) => [o.action, o.allowed ? 'allow' : 'deny'])));
  }, [data]);

  const save = async () => {
    const pick = (c: Choice) => ACTIONS.filter((a) => choices[a] === c);
    if (await run(() => api.put(`/users/${user.id}/permissions`, { allow: pick('allow'), deny: pick('deny'), data_scope: scope }), 'Permissions saved')) onClose();
  };
  const fromRole: Action[] = roles?.roles[user.role] ?? PERMISSIONS[user.role as Role];
  return (
    <Modal title={`Permissions for ${user.name}`} onClose={onClose} wide>
      {!data ? <Spinner /> : user.role === 'admin' ? <Notice>Admins always keep every permission.</Notice> : (
        <div className="space-y-3">
          <SelectField label="Which leads can they see?" value={scope} onChange={(e) => setScope(e.target.value)}>
            {DATA_SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </SelectField>
          {PERMISSION_GROUPS.map((g) => (
            <fieldset key={g.group}>
              <legend className="mb-1 text-[13px] font-semibold text-ink">{g.group}</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {g.items.map(([action, label]) => (
                  <label key={action} className="flex items-center justify-between gap-2 rounded-lg border border-line px-2.5 py-1 text-[13px]">
                    <span>{label}</span>
                    <select aria-label={label} className="rounded border border-line bg-surface text-xs text-ink" value={choices[action] ?? 'role'}
                      onChange={(e) => setChoices({ ...choices, [action]: e.target.value as Choice })}>
                      <option value="role">Role ({fromRole.includes(action) ? 'yes' : 'no'})</option>
                      <option value="allow">Allow</option>
                      <option value="deny">Block</option>
                    </select>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Save</Button></div>
        </div>
      )}
    </Modal>
  );
}
