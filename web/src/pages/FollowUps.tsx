import { AlarmClock, Check, MessageCircle, Phone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CountTabs, DatePill, FUTURE_PRESETS, FilterBar, FilterPill, SearchBox, dateBounds, toOptions, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, Empty, ErrorNote, Modal, PageHeader, Spinner, TempBadge, TextField, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { placeCall } from '../lib/calling.ts';
import { dateTime, localToUtc, timeAgo } from '../lib/format.ts';

/** Tomorrow at 10:00 India time, as a stored UTC value. */
function tomorrowMorning() {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  const utc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, 10) - 5.5 * 3600000;
  return new Date(utc).toISOString().slice(0, 19).replace('T', ' ');
}

function SnoozeMenu({ onPick, onCustom }: { onPick: (body: object) => void; onCustom: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  const choose = (body: object) => { setOpen(false); onPick(body); };
  const items: [string, () => void][] = [
    ['30 minutes', () => choose({ minutes: 30 })],
    ['1 hour', () => choose({ minutes: 60 })],
    ['3 hours', () => choose({ minutes: 180 })],
    ['Tomorrow 10 am', () => choose({ due_at: tomorrowMorning() })],
    ['Choose date and time', () => { setOpen(false); onCustom(); }],
  ];
  return (
    <div ref={box} className="relative">
      <Button size="sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}><AlarmClock size={14} />Snooze</Button>
      {open && (
        <div className="fade-in absolute right-0 z-30 mt-1 w-48 rounded-xl border border-line bg-surface p-1.5 shadow-xl">
          {items.map(([label, act]) => <button key={label} type="button" onClick={act} className="block min-h-8 w-full rounded-md px-2 py-1 text-left text-[13px] text-body hover:bg-surface-2">{label}</button>)}
        </div>
      )}
    </div>
  );
}

export default function FollowUps() {
  const { user } = useAuth();
  const { f, set, clear, activeCount } = useFilters(['view', 'q', 'owner', 'project', 'type', 'date', 'from', 'to'] as const, { defaults: { view: 'overdue' } });
  const [custom, setCustom] = useState<any>(null);
  const [when, setWhen] = useState('');
  const { busy, run } = useAction();
  const manager = !['sales', 'telecaller'].includes(user!.role);

  const query = new URLSearchParams({ view: f.view });
  for (const k of ['q', 'owner', 'project', 'type'] as const) if (f[k]) query.set(k, f[k]);
  const bounds = dateBounds(f.date, f.from, f.to);
  if (bounds.from) query.set('due_from', bounds.from);
  if (bounds.to) query.set('due_to', bounds.to);

  const { data, error, loading, reload } = useApi(`/followups?${query}`, ['leads', 'notifications']);
  const { data: projects } = useApi('/projects');
  const { data: directory } = useApi(manager ? '/directory' : null);

  const done = async (id: number) => { if (await run(() => api.post(`/tasks/${id}/complete`), 'Follow-up completed')) void reload(); };
  const snooze = async (id: number, body: object) => { if (await run(() => api.post(`/tasks/${id}/snooze`, body), 'Follow-up moved')) void reload(); };
  const late = (t: any) => f.view === 'overdue';

  return (
    <Page>
      <PageHeader title="Follow-ups" subtitle={manager ? 'Every reminder across your team, in one list' : 'Your calls and meetings, most urgent first'} />
      <CountTabs label="Follow-up status" value={f.view} onChange={(view) => set({ view })} tabs={[
        { value: 'overdue', label: 'Overdue', count: data?.counts.overdue },
        { value: 'today', label: 'Due today', count: data?.counts.today },
        { value: 'upcoming', label: 'Upcoming', count: data?.counts.upcoming },
        { value: 'done', label: 'Completed' },
      ]} />
      <FilterBar search={<SearchBox placeholder="Search customer or phone" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={data?.tasks.length} noun="follow-ups">
        <DatePill label="Due" preset={f.date} from={f.from} to={f.to} extra={FUTURE_PRESETS} onChange={(date, from, to) => set({ date, from, to })} />
        <FilterPill label="Action" value={f.type} options={toOptions(data?.types ?? [])} onChange={(type) => set({ type })} />
        <FilterPill label="Project" value={f.project} options={projects?.projects.map((p: any) => ({ value: String(p.id), label: p.name })) ?? []} onChange={(project) => set({ project })} />
        {manager && <FilterPill label="Assigned to" value={f.owner} options={directory?.users.filter((u: any) => ['sales', 'telecaller', 'team_leader', 'site_head', 'sales_manager'].includes(u.role)).map((u: any) => ({ value: String(u.id), label: u.name })) ?? []} onChange={(owner) => set({ owner })} />}
      </FilterBar>
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Spinner />}
      {data && (
        <Card>
          {!data.tasks.length && <Empty title={f.view === 'overdue' && !activeCount ? 'Nothing overdue' : 'No follow-ups here'}>{f.view === 'overdue' && !activeCount ? 'You are up to date.' : 'Try another tab or clear a filter.'}</Empty>}
          <ul className="divide-y divide-line">
            {data.tasks.map((t: any) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <div className="min-w-48 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <Link to={`/leads/${t.lead_id}`} className="font-medium text-ink hover:underline">{t.lead_name}</Link>
                    <TempBadge value={t.temperature} />
                    {late(t) && <Badge tone="red">{timeAgo(t.due_at)} late</Badge>}
                  </p>
                  <p className="truncate text-[13px] text-muted">{t.type} · {dateTime(t.completed_at ?? t.due_at)}{t.project_name ? ` · ${t.project_name}` : ''}{manager && t.owner_name ? ` · ${t.owner_name}` : ''}</p>
                  {t.notes && <p className="text-[13px]">{t.notes}</p>}
                </div>
                {f.view !== 'done' && (
                  <span className="flex flex-wrap gap-1.5">
                    {!t.masked && <Button size="sm" variant="primary" onClick={() => placeCall(t.lead_id, t.phone)}><Phone size={14} />Call</Button>}
                    <Link to={`/inbox/${t.lead_id}`}><Button size="sm" variant="whatsapp"><MessageCircle size={14} />WhatsApp</Button></Link>
                    <SnoozeMenu onPick={(body) => snooze(t.id, body)} onCustom={() => { setWhen(''); setCustom(t); }} />
                    <Button size="sm" busy={busy} onClick={() => done(t.id)}><Check size={14} />Done</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {custom && (
        <Modal title={`Move follow-up for ${custom.lead_name}`} onClose={() => setCustom(null)}>
          <div className="space-y-3">
            <TextField label="New date and time" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setCustom(null)}>Cancel</Button>
              <Button variant="primary" disabled={!when} onClick={async () => { await snooze(custom.id, { due_at: localToUtc(when) }); setCustom(null); }}>Move</Button>
            </div>
          </div>
        </Modal>
      )}
    </Page>
  );
}
