import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ROLES, ROLE_LABELS, WEEKDAYS } from '../../../shared/domain.ts';
import { BULLETIN_KINDS } from '../components/Bulletin.tsx';
import { FilterBar, FilterPill, SearchBox, filterRows, optionsFrom, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, Empty, ErrorNote, IconButton, Modal, Notice, PageHeader, SelectField, Spinner, TextField, TextareaField, cx, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const plusDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// ---------- Bulletin ----------
function BulletinForm({ item, onClose }: { item: any; onClose: () => void }) {
  const [f, setF] = useState(item);
  const { busy, run } = useAction();
  const save = async () => {
    const body = { text: f.text, kind: f.kind, starts_on: f.starts_on, ends_on: f.ends_on, roles: f.roles, active: f.active };
    if (await run(() => (f.id ? api.put(`/bulletins/${f.id}`, body) : api.post('/bulletins', body)), 'Message saved')) onClose();
  };
  const toggleRole = (r: string) => setF({ ...f, roles: f.roles.includes(r) ? f.roles.filter((x: string) => x !== r) : [...f.roles, r] });
  return (
    <Modal title={f.id ? 'Edit message' : 'New message'} onClose={onClose}>
      <div className="space-y-3">
        <TextareaField label="Message" required maxLength={280} placeholder="e.g. Skyline Residences Tower B launches on Saturday" value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
        <SelectField label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {Object.entries(BULLETIN_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </SelectField>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Show from" type="date" value={f.starts_on} onChange={(e) => setF({ ...f, starts_on: e.target.value })} />
          <TextField label="Show until" type="date" value={f.ends_on} onChange={(e) => setF({ ...f, ends_on: e.target.value })} />
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink">Who sees it</legend>
          <p className="mb-2 text-[13px] text-muted">Leave all unticked for everyone.</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {ROLES.map((r) => (
              <label key={r} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.roles.includes(r)} onChange={() => toggleRole(r)} />{ROLE_LABELS[r]}</label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Showing (untick to pause it)</label>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Save</Button></div>
      </div>
    </Modal>
  );
}

function Bulletins() {
  const { data, error, loading, reload } = useApi('/bulletins', ['bulletins']);
  const [editing, setEditing] = useState<any>(null);
  const { run } = useAction();
  const { f, set, clear, activeCount } = useFilters(['bq', 'bstatus', 'bkind', 'brole'] as const);
  if (loading) return <Spinner />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  const today = data.today;
  const status = (b: any) => (!b.active ? ['Paused', 'neutral'] : b.ends_on < today ? ['Ended', 'neutral'] : b.starts_on > today ? ['Scheduled', 'brand'] : ['Showing now', 'green']) as [string, any];
  const shown = filterRows<any>(data.bulletins, { q: f.bq }, {
    search: (b) => [b.text, b.author],
    test: (b) => (!f.bstatus || status(b)[0] === f.bstatus) && (!f.bkind || b.kind === f.bkind)
      && (!f.brole || (f.brole === 'everyone' ? !b.roles.length : b.roles.includes(f.brole))),
  });
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Messages scroll under the top bar for the people you choose, between the dates you set.</p>
        <Button variant="primary" onClick={() => setEditing({ text: '', kind: 'news', starts_on: today, ends_on: plusDays(today, 7), roles: [], active: true })}><Plus size={15} />New message</Button>
      </div>
      {!!data.bulletins.length && (
        <FilterBar search={<SearchBox placeholder="Search messages" value={f.bq} onChange={(bq) => set({ bq })} />} activeCount={activeCount} onClear={clear} shown={shown.length} total={data.bulletins.length} noun="messages">
          <FilterPill label="Status" value={f.bstatus} options={['Showing now', 'Scheduled', 'Ended', 'Paused'].map((s) => ({ value: s, label: s }))} onChange={(bstatus) => set({ bstatus })} />
          <FilterPill label="Type" value={f.bkind} options={Object.entries(BULLETIN_KINDS).map(([value, label]) => ({ value, label }))} onChange={(bkind) => set({ bkind })} />
          <FilterPill label="Who sees it" value={f.brole} options={[{ value: 'everyone', label: 'Everyone' }, ...ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))]} onChange={(brole) => set({ brole })} />
        </FilterBar>
      )}
      {!data.bulletins.length ? <Empty title="No messages yet">Add a target, launch, offer or birthday wish.</Empty> : !shown.length ? <Empty title="No messages match">Change or reset the filters.</Empty> : (
        <Card className="divide-y divide-line">
          {shown.map((b: any) => {
            const [label, tone] = status(b);
            return (
              <div key={b.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">{b.text}</p>
                  <p className="mt-0.5 text-[13px] text-muted">
                    {BULLETIN_KINDS[b.kind]} · {b.starts_on} to {b.ends_on} · {b.roles.length ? b.roles.map((r: string) => ROLE_LABELS[r as keyof typeof ROLE_LABELS]).join(', ') : 'Everyone'}{b.author ? ` · by ${b.author}` : ''}
                  </p>
                </div>
                <Badge tone={tone}>{label}</Badge>
                <IconButton label="Edit message" onClick={() => setEditing(b)}><Pencil size={16} /></IconButton>
                <IconButton label="Delete message" onClick={() => confirm('Delete this message?') && run(async () => { await api.del(`/bulletins/${b.id}`); await reload(); }, 'Message deleted')}><Trash2 size={16} /></IconButton>
              </div>
            );
          })}
        </Card>
      )}
      {editing && <BulletinForm item={editing} onClose={() => { setEditing(null); void reload(); }} />}
    </>
  );
}

// ---------- Duty ----------
const STATE: Record<string, [string, any]> = {
  on: ['On duty', 'green'], weekly_off: ['Weekly off', 'neutral'], absent: ['Absent', 'red'], off_shift: ['Outside shift', 'amber'],
};

function DutyForm({ person, onClose }: { person: any; onClose: () => void }) {
  const [f, setF] = useState({ weekly_off: person.weekly_off as number[], shift_start: person.shift_start, shift_end: person.shift_end });
  const { busy, run } = useAction();
  const toggle = (d: number) => setF({ ...f, weekly_off: f.weekly_off.includes(d) ? f.weekly_off.filter((x) => x !== d) : [...f.weekly_off, d] });
  return (
    <Modal title={`Duty for ${person.name}`} onClose={onClose}>
      <div className="space-y-3">
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink">Weekly off</legend>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d, i) => (
              <button key={d} type="button" aria-pressed={f.weekly_off.includes(i)} onClick={() => toggle(i)}
                className={cx('rounded-full border px-3 py-1 text-sm', f.weekly_off.includes(i) ? 'border-brand bg-brand text-white dark:text-slate-950' : 'border-line text-ink')}>{d.slice(0, 3)}</button>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Shift starts" type="time" value={f.shift_start} onChange={(e) => setF({ ...f, shift_start: e.target.value })} />
          <TextField label="Shift ends" type="time" value={f.shift_end} onChange={(e) => setF({ ...f, shift_end: e.target.value })} />
        </div>
        <p className="text-[13px] text-muted">Leave both times empty for no fixed shift. A shift can run past midnight. Outside their shift and on their weekly off, people get no new leads and no phone alerts; the bell still keeps everything.</p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setF({ ...f, shift_start: '', shift_end: '' })}>Clear shift</Button>
          <Button variant="primary" busy={busy} onClick={async () => { if (await run(() => api.put(`/duty/users/${person.id}`, f), 'Duty saved')) onClose(); }}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

function AbsentForm({ person, people, onClose }: { person: any; people: any[]; onClose: () => void }) {
  const [f, setF] = useState({ reason: '', hand_over_followups: true, hand_over_leads: false, to_user_id: '' });
  const { busy, run } = useAction();
  const [result, setResult] = useState<any>(null);
  const save = async () => {
    const body = { user_id: person.id, reason: f.reason, hand_over_followups: f.hand_over_followups, hand_over_leads: f.hand_over_leads, ...(f.to_user_id ? { to_user_id: Number(f.to_user_id) } : {}) };
    await run(async () => setResult(await api.post('/duty/absences', body)), 'Marked absent');
  };
  if (result) {
    return (
      <Modal title="Marked absent" onClose={onClose}>
        <Notice>{person.name} is absent today. {result.to ? `${result.followups} follow-up${result.followups === 1 ? '' : 's'}${result.leads ? ` and ${result.leads} lead${result.leads === 1 ? '' : 's'}` : ''} moved to ${result.to.name}.` : 'Nothing was handed over.'}</Notice>
        <div className="mt-3 flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
      </Modal>
    );
  }
  return (
    <Modal title={`${person.name} is absent today`} onClose={onClose}>
      <div className="space-y-3">
        <TextField label="Reason (optional)" maxLength={120} placeholder="e.g. Sick, family function" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.hand_over_followups} onChange={(e) => setF({ ...f, hand_over_followups: e.target.checked })} />Hand over today's and overdue follow-ups</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.hand_over_leads} onChange={(e) => setF({ ...f, hand_over_leads: e.target.checked })} />Also move all their open leads (permanent)</label>
        {(f.hand_over_followups || f.hand_over_leads) && (
          <SelectField label="Hand over to" hint="Automatic picks someone with the same role, from the same team first, who is on duty." value={f.to_user_id} onChange={(e) => setF({ ...f, to_user_id: e.target.value })}>
            <option value="">Automatic</option>
            {people.filter((p) => p.id !== person.id).map((p) => <option key={p.id} value={p.id}>{p.name} ({ROLE_LABELS[p.role as keyof typeof ROLE_LABELS]})</option>)}
          </SelectField>
        )}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Mark absent</Button></div>
      </div>
    </Modal>
  );
}

function Duty() {
  const { data, error, loading, reload } = useApi('/duty', ['duty']);
  const [editing, setEditing] = useState<any>(null);
  const [absent, setAbsent] = useState<any>(null);
  const { run } = useAction();
  const { f, set, clear, activeCount } = useFilters(['q', 'state', 'role', 'team', 'off'] as const);
  if (loading) return <Spinner />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  const people = filterRows<any>(data.people, f, {
    search: (p) => [p.name, p.team],
    match: { state: (p) => p.state, role: (p) => p.role, team: (p) => p.team },
    test: (p) => !f.off || (f.off === 'none' ? !p.weekly_off.length : p.weekly_off.includes(Number(f.off))),
  });
  const close = () => { setEditing(null); setAbsent(null); void reload(); };
  return (
    <>
      <p className="mb-3 text-sm text-muted">New leads go only to people on duty now. If nobody is, leads are shared as usual, so none are left waiting. Today is {data.today}.</p>
      {!!data.people.length && (
        <FilterBar search={<SearchBox placeholder="Search name or team" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={people.length} total={data.people.length} noun="people">
          <FilterPill label="Now" value={f.state} options={Object.entries(STATE).map(([value, [label]]) => ({ value, label }))} onChange={(state) => set({ state })} />
          <FilterPill label="Role" value={f.role} options={[...new Set<string>(data.people.map((p: any) => p.role))].map((r) => ({ value: r, label: ROLE_LABELS[r as keyof typeof ROLE_LABELS] }))} onChange={(role) => set({ role })} />
          <FilterPill label="Team" value={f.team} options={optionsFrom<any>(data.people, (p) => p.team)} onChange={(team) => set({ team })} />
          <FilterPill label="Weekly off" value={f.off} options={[...WEEKDAYS.map((d, i) => ({ value: String(i), label: d })), { value: 'none', label: 'No weekly off set' }]} onChange={(off) => set({ off })} />
        </FilterBar>
      )}
      {!data.people.length ? <Empty title="Nobody to manage">People who report to you appear here.</Empty> : !people.length ? <Empty title="Nobody matches">Change or reset the filters.</Empty> : (
        <Card className="divide-y divide-line">
          {people.map((p: any) => {
            const [label, tone] = STATE[p.state] ?? STATE.on;
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{p.name}</p>
                  <p className="text-[13px] text-muted">
                    {ROLE_LABELS[p.role as keyof typeof ROLE_LABELS]} · Off: {p.weekly_off.length ? p.weekly_off.map((d: number) => WEEKDAYS[d].slice(0, 3)).join(', ') : 'none'} · Shift: {p.shift_start ? `${p.shift_start}–${p.shift_end}` : 'not fixed'}
                    {p.absent_reason ? ` · ${p.absent_reason}` : ''}
                  </p>
                </div>
                <Badge tone={tone}>{label}</Badge>
                <Button size="sm" onClick={() => setEditing(p)}>Weekly off & shift</Button>
                {p.state === 'absent'
                  ? <Button size="sm" onClick={() => run(async () => { await api.del(`/duty/absences/${p.id}/${data.date}`); await reload(); }, 'Marked present')}>Mark present</Button>
                  : <Button size="sm" onClick={() => setAbsent(p)}>Mark absent</Button>}
              </div>
            );
          })}
        </Card>
      )}
      {editing && <DutyForm person={editing} onClose={close} />}
      {absent && <AbsentForm person={absent} people={data.people} onClose={close} />}
    </>
  );
}

export default function Workplace() {
  const { can, on } = useAuth();
  const tabs = [
    ...(on('duty') && can('duty.manage') ? ['Duty'] : []),
    ...(on('bulletin') && can('bulletin.manage') ? ['Bulletin'] : []),
  ];
  const [tab, setTab] = useState(tabs[0] ?? '');
  return (
    <Page>
      <PageHeader title="Duty & Bulletin" />
      {!tabs.length ? <Notice>These features are switched off, or you do not have permission. An administrator can change this in Settings → Features and Team → Permissions.</Notice> : (
        <>
          <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
            {tabs.map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={cx('-mb-px border-b-2 px-3 py-2 text-sm', tab === t ? 'border-brand font-medium text-brand-ink' : 'border-transparent text-muted')}>{t}</button>
            ))}
          </div>
          {tab === 'Duty' && <Duty />}
          {tab === 'Bulletin' && <Bulletins />}
        </>
      )}
    </Page>
  );
}
