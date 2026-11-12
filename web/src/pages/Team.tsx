import { Copy, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { LANGUAGES, ROLES, ROLE_LABELS, MANAGER_ROLES } from '../../../shared/domain.ts';
import { CountTabs, FilterBar, FilterPill, SearchBox, filterRows, optionsFrom, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, ErrorNote, Modal, Notice, PageHeader, SelectField, Spinner, TextField, useAction, useToast } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { dateTime } from '../lib/format.ts';
import { RolePermissions, UserPermissions } from './Permissions.tsx';

function PasswordModal({ value, onClose }: { value: string; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal title="Temporary password" onClose={onClose}>
      <Notice>This is shown only once. Share it privately. The person must change it at first login.</Notice>
      <div className="mt-3 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
        <code className="flex-1 break-all text-ink">{value}</code>
        <Button size="sm" onClick={async () => { await navigator.clipboard.writeText(value); toast('Copied'); }}><Copy size={14} />Copy</Button>
      </div>
      <div className="mt-3 flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
    </Modal>
  );
}


function TreeNode({ person, all, depth, onEdit, onMove }: { person: any; all: any[]; depth: number; onEdit: (u: any) => void; onMove: (u: any) => void }) {
  const reports = all.filter((u) => u.manager_id === person.id);
  const below = (id: number): number => all.filter((u) => u.manager_id === id).reduce((sum, u) => sum + 1 + below(u.id), 0);
  return (
    <li>
      <div className="flex flex-wrap items-center gap-2 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-ink">{person.name}{person.status === 'paused' && <span className="ml-2"><Badge tone="red">Paused</Badge></span>}</p>
          <p className="text-[13px] text-muted">{ROLE_LABELS[person.role as keyof typeof ROLE_LABELS]}{reports.length ? ` · ${below(person.id)} in team` : ''}</p>
        </div>
        <span className="flex gap-1.5">
          {!!reports.length && <Button size="sm" onClick={() => onMove(person)}>Move team</Button>}
          <Button size="sm" onClick={() => onEdit(person)}>Edit</Button>
        </span>
      </div>
      {!!reports.length && (
        <ul className={depth < 3 ? 'ml-3 border-l-2 border-line pl-3 sm:ml-5 sm:pl-4' : 'border-l-2 border-line pl-2'}>
          {reports.map((u) => <TreeNode key={u.id} person={u} all={all} depth={depth + 1} onEdit={onEdit} onMove={onMove} />)}
        </ul>
      )}
    </li>
  );
}

function Structure({ users, onEdit, reload }: { users: any[]; onEdit: (u: any) => void; reload: () => void }) {
  const [moving, setMoving] = useState<any>(null);
  const [target, setTarget] = useState('');
  const { busy, run } = useAction();
  const known = new Set(users.map((u) => u.id));
  const roots = users.filter((u) => !u.manager_id || !known.has(u.manager_id));
  const linked = users.some((u) => u.manager_id);
  const teamIds = (id: number): number[] => users.filter((u) => u.manager_id === id).flatMap((u) => [u.id, ...teamIds(u.id)]);
  const move = async () => {
    const r = await run(() => api.post(`/users/${moving.id}/move-team`, { manager_id: target ? Number(target) : null }));
    if (r) { setMoving(null); setTarget(''); reload(); }
  };
  return (
    <Card className="p-4">
      {!linked && <div className="mb-3"><Notice>No reporting lines yet, so access works by role. Edit each person and choose who they report to. Managers then see only their own team.</Notice></div>}
      <ul className="divide-y divide-line">
        {roots.map((u) => <TreeNode key={u.id} person={u} all={users} depth={0} onEdit={onEdit} onMove={(p) => { setTarget(''); setMoving(p); }} />)}
      </ul>
      {moving && (
        <Modal title={`Move ${moving.name}'s team`} onClose={() => setMoving(null)}>
          <SelectField label="New manager" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">No manager</option>
            {users.filter((u) => MANAGER_ROLES.includes(u.role) && u.status === 'active' && u.id !== moving.id && !teamIds(moving.id).includes(u.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </SelectField>
          <p className="mt-2 text-[13px] text-muted">Their direct reports move, and anyone below those people stays with them.</p>
          <div className="mt-3 flex justify-end gap-2"><Button onClick={() => setMoving(null)}>Cancel</Button><Button variant="primary" busy={busy} onClick={move}>Move team</Button></div>
        </Modal>
      )}
    </Card>
  );
}

function UserModal({ user, people, onClose, onPassword }: { user: any | null; people: any[]; onClose: () => void; onPassword: (p: string) => void }) {
  const { data } = useApi('/projects');
  const [f, setF] = useState({ name: user?.name ?? '', email: user?.email ?? '', phone: user?.phone ?? '', role: user?.role ?? 'telecaller', project_ids: (user?.project_ids ?? []) as number[], languages: (user?.languages ?? []) as string[], team: user?.team ?? '', manager_id: String(user?.manager_id ?? '') });
  const { busy, run } = useAction();
  const managers = people.filter((p) => MANAGER_ROLES.includes(p.role) && p.status === 'active' && p.id !== user?.id);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, manager_id: f.manager_id ? Number(f.manager_id) : null };
    const r = await run(() => (user ? api.put(`/users/${user.id}`, body) : api.post('/users', body)), user ? 'User updated' : undefined);
    if (r) { onClose(); if (r.temporaryPassword) onPassword(r.temporaryPassword); }
  };
  const toggle = (id: number) => setF((s) => ({ ...s, project_ids: s.project_ids.includes(id) ? s.project_ids.filter((x) => x !== id) : [...s.project_ids, id] }));
  return (
    <Modal title={user ? `Edit ${user.name}` : 'Add team member'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextField label="Full name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <TextField label="Work email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <TextField label="Phone" hint="Needed for office line calling." type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <SelectField label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </SelectField>
        <SelectField label="Reports to" hint="Their manager sees their leads and gets their overdue alerts." value={f.manager_id} onChange={(e) => setF({ ...f, manager_id: e.target.value })}>
          <option value="">No manager</option>
          {managers.map((m) => <option key={m.id} value={m.id}>{m.name} ({ROLE_LABELS[m.role as keyof typeof ROLE_LABELS]})</option>)}
        </SelectField>
        <TextField label="Team" placeholder="e.g. West zone sales" value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })} />
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium">Languages</legend>
          <p className="mb-1 text-xs text-muted">Used to route WhatsApp leads. Leave blank if they speak all.</p>
          <div className="flex gap-4">{LANGUAGES.map((l) => (
            <label key={l.code} className="flex items-center gap-1.5 text-sm"><input type="checkbox" className="accent-[#C85A1E]" checked={f.languages.includes(l.code)} onChange={(e) => setF({ ...f, languages: e.target.checked ? [...f.languages, l.code] : f.languages.filter((x) => x !== l.code) })} />{l.label}</label>
          ))}</div>
        </fieldset>
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium">Projects</legend>
          <p className="mb-1 text-xs text-muted">Site heads see only these. Telecallers receive new leads from these first.</p>
          {data?.projects.map((p: any) => (
            <label key={p.id} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" className="accent-[#C85A1E]" checked={f.project_ids.includes(p.id)} onChange={() => toggle(p.id)} />{p.name}</label>
          ))}
        </fieldset>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>{user ? 'Save' : 'Create account'}</Button></div>
      </form>
    </Modal>
  );
}

function Targets({ onEdit }: { onEdit: (p: any) => void }) {
  const { data } = useApi('/targets');
  if (!data) return <Spinner />;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {data.people.map((p: any) => (
          <li key={p.id} className="flex flex-wrap items-center gap-4 px-4 py-2.5 text-sm">
            <span className="min-w-40 flex-1"><span className="font-medium text-ink">{p.name}</span><span className="block text-xs text-muted">{p.progress.streak} day streak · {p.progress.connect_rate}% connect rate</span></span>
            <span className="tabular-nums">Calls {p.progress.calls}/{p.progress.target.calls}</span>
            <span className="tabular-nums">Visits {p.progress.visits}/{p.progress.target.visits}</span>
            <span className="tabular-nums">Bookings {p.progress.bookings}/{p.progress.target.bookings}</span>
            <Button size="sm" onClick={() => onEdit(p)}>Set target</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TargetModal({ person, onClose }: { person: any; onClose: () => void }) {
  const [f, setF] = useState({ calls: String(person.progress.target.calls), visits: String(person.progress.target.visits), bookings: String(person.progress.target.bookings) });
  const { busy, run } = useAction();
  const save = async () => { if (await run(() => api.put(`/users/${person.id}/target`, { calls: Number(f.calls), visits: Number(f.visits), bookings: Number(f.bookings) }), 'Target saved')) onClose(); };
  return (
    <Modal title={`Monthly target for ${person.name}`} onClose={onClose}>
      <div className="grid grid-cols-3 gap-3">
        <TextField label="Calls" type="number" min="0" value={f.calls} onChange={(e) => setF({ ...f, calls: e.target.value })} />
        <TextField label="Site visits" type="number" min="0" value={f.visits} onChange={(e) => setF({ ...f, visits: e.target.value })} />
        <TextField label="Bookings" type="number" min="0" value={f.bookings} onChange={(e) => setF({ ...f, bookings: e.target.value })} />
      </div>
      <div className="mt-3 flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Save</Button></div>
    </Modal>
  );
}

export default function Team() {
  const { user: me } = useAuth();
  const { data, error, loading, reload } = useApi('/users');
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [password, setPassword] = useState('');
  const [tab, setTab] = useState<'People' | 'Structure' | 'Permissions' | 'Targets'>('People');
  const [permsFor, setPermsFor] = useState<any>(null);
  const [target, setTarget] = useState<any>(null);
  const { run } = useAction();
  const { f, set, clear, activeCount } = useFilters(['q', 'role', 'status', 'team'] as const);
  if (loading) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;
  const people = filterRows<any>(data.users, f, {
    search: (u) => [u.name, u.email, u.phone],
    match: { role: (u) => u.role, status: (u) => u.status, team: (u) => u.team },
  });
  const inStatus = (s: string) => data.users.filter((u: any) => u.status === s).length;

  const setStatus = async (u: any, status: string) => {
    await run(() => api.post(`/users/${u.id}/status`, { status }), status === 'paused' ? `${u.name} can no longer sign in` : `${u.name} restored`);
    void reload();
  };
  const reset2fa = async (u: any) => {
    if (confirm(`Reset two-factor login for ${u.name}? Do this only if you have confirmed who they are.`)) {
      await run(() => api.post(`/users/${u.id}/reset-2fa`), 'Two-factor login reset');
    }
  };
  const reset = async (u: any) => {
    if (!confirm(`Reset the password for ${u.name}?`)) return;
    const r = await run(() => api.post(`/users/${u.id}/reset-password`));
    if (r) setPassword(r.temporaryPassword);
  };

  return (
    <Page>
      <PageHeader title="Team" subtitle="Each person has a separate login. Pausing someone signs them out at once."
        actions={<Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} />Add team member</Button>} />
      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
        {(['People', 'Structure', 'Permissions', 'Targets'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-brand font-medium text-brand-ink' : 'border-transparent text-muted'}`}>{t}</button>
        ))}
      </div>
      {tab === 'Structure' && <Structure users={data.users} onEdit={setEditing} reload={reload} />}
      {tab === 'Permissions' && <RolePermissions />}
      {tab === 'Targets' && <Targets onEdit={setTarget} />}
      {tab === 'People' && <CountTabs label="Status" value={f.status} onChange={(status) => set({ status })} tabs={[{ value: '', label: 'All', count: data.users.length }, { value: 'active', label: 'Active', count: inStatus('active') }, { value: 'paused', label: 'Paused', count: inStatus('paused') }]} />}
      {tab === 'People' && (
        <FilterBar search={<SearchBox placeholder="Search name, email or phone" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={people.length} total={data.users.length} noun="people">
          <FilterPill label="Role" value={f.role} options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} onChange={(role) => set({ role })} />
          <FilterPill label="Team" value={f.team} options={optionsFrom<any>(data.users, (u) => u.team)} onChange={(team) => set({ team })} />
        </FilterBar>
      )}
      {tab === 'People' && <Card>
        {!people.length && <p className="p-6 text-center text-muted">Nobody matches these filters.</p>}
        <ul className="divide-y divide-line">
          {people.map((u: any) => (
            <li key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <div className="min-w-48 flex-1">
                <p className="font-medium text-ink">{u.name}{u.id === me!.id && <span className="ml-1.5 text-xs font-normal text-muted">you</span>}</p>
                <p className="truncate text-[13px] text-muted">{u.manager_name ? `Reports to ${u.manager_name}` : u.email} · last login {dateTime(u.last_login_at)}</p>
              </div>
              <Badge tone="brand">{ROLE_LABELS[u.role as keyof typeof ROLE_LABELS]}</Badge>
              {u.status === 'paused' && <Badge tone="red">Paused</Badge>}
              <span className="flex gap-1.5">
                <Button size="sm" onClick={() => setEditing(u)}>Edit</Button>
                <Button size="sm" onClick={() => reset(u)}>Reset password</Button>
                {u.id !== me!.id && <Button size="sm" onClick={() => reset2fa(u)}>Reset 2FA</Button>}
                {u.role !== 'admin' && <Button size="sm" onClick={() => setPermsFor(u)}>Permissions</Button>}
                {u.id !== me!.id && <Button size="sm" onClick={() => setStatus(u, u.status === 'active' ? 'paused' : 'active')}>{u.status === 'active' ? 'Pause' : 'Restore'}</Button>}
              </span>
            </li>
          ))}
        </ul>
      </Card>}
      {permsFor && <UserPermissions user={permsFor} onClose={() => setPermsFor(null)} />}
      {target && <TargetModal person={target} onClose={() => setTarget(null)} />}
      {editing && <UserModal user={editing === 'new' ? null : editing} people={data.users} onClose={() => { setEditing(null); void reload(); }} onPassword={setPassword} />}
      {password && <PasswordModal value={password} onClose={() => setPassword('')} />}
    </Page>
  );
}
