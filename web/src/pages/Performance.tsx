import { ArrowRight, Download } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ROLE_LABELS, LEAD_ROLES, isLeadRole } from '../../../shared/domain.ts';
import { DatePill, FilterBar, FilterPill, dateBounds, filterRows, toOptions, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, PageHeader, Spinner, Stat } from '../components/ui.tsx';
import { useApi } from '../lib/api.ts';

const SORTS = [
  { value: 'score', label: 'Activity score' }, { value: 'on_time', label: 'On-time rate' }, { value: 'missed', label: 'Most missed' },
  { value: 'calls', label: 'Most calls' }, { value: 'visits', label: 'Most site visits' }, { value: 'booked', label: 'Most bookings' },
];

const orNone = (value: number | null, suffix = '') => (value == null ? '—' : `${value}${suffix}`);
const scoreTone = (s: number | null) => (s == null ? 'neutral' : s >= 75 ? 'green' : s >= 50 ? 'amber' : 'red');

function csvFile(agents: any[]) {
  const head = ['Name', 'Role', 'Follow-ups set', 'Due', 'On time', 'Late', 'Missed', 'Moved', 'On-time %', 'Calls', 'Connected', 'Site visits', 'Bookings', 'Response minutes', 'Score'];
  const rows = agents.map((a) => [a.name, ROLE_LABELS[a.role as keyof typeof ROLE_LABELS], a.set, a.due, a.on_time, a.late, a.missed, a.moved, a.on_time_rate ?? '', a.calls, a.connected, a.visits, a.booked, a.response_minutes ?? '', a.score ?? '']);
  // A leading apostrophe stops a spreadsheet running a name as a formula.
  const cell = (v: unknown) => { const s = String(v); return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`; };
  return `data:text/csv;charset=utf-8,${encodeURIComponent([head, ...rows].map((r) => r.map(cell).join(',')).join('\n'))}`;
}

function PersonCard({ a }: { a: any }) {
  const stats: [string, string | number, string?][] = [
    ['On-time follow-ups', orNone(a.on_time_rate, '%'), `${a.on_time} of ${a.on_time + a.late + a.missed} finished or missed`],
    ['Missed', a.missed, a.pending ? `${a.pending} still to come` : undefined],
    ['Done late', a.late, a.avg_delay_minutes != null ? `On average ${a.avg_delay_minutes} minutes late` : undefined],
    ['Moved by snooze', a.moved],
    ['Calls', a.calls, a.connect_rate != null ? `${a.connect_rate}% connected` : undefined],
    ['First response', orNone(a.response_minutes, ' min')],
    ['Site visits', a.visits],
    ['Bookings', a.booked, `${a.new_leads} new leads`],
  ];
  return (
    <>
      <Card className="mb-3 flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-48 flex-1"><h2 className="font-display text-xl font-semibold">{a.name}</h2><p className="text-[13px] text-muted">{ROLE_LABELS[a.role as keyof typeof ROLE_LABELS]}{a.team ? ` · ${a.team}` : ''}</p></div>
        <Badge tone={scoreTone(a.score)}>Score {orNone(a.score)}</Badge>
        <Link to={`/followups?owner=${a.id}`}><Button size="sm">Open follow-ups<ArrowRight size={14} /></Button></Link>
      </Card>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(([label, value, hint]) => <Stat key={label} label={label} value={value} hint={hint} tone={label === 'Missed' && a.missed ? 'alert' : undefined} />)}
      </div>
    </>
  );
}

export default function Performance() {
  const { f, set, clear, activeCount } = useFilters(['date', 'from', 'to', 'owner', 'project', 'role', 'team', 'sort'] as const, { defaults: { date: 'last_30', sort: 'score' } });
  const query = new URLSearchParams();
  const bounds = dateBounds(f.date, f.from, f.to);
  if (bounds.from) query.set('created_from', bounds.from);
  if (bounds.to) query.set('created_to', bounds.to);
  for (const k of ['owner', 'project', 'role', 'team'] as const) if (f[k]) query.set(k, f[k]);
  const { data, error, loading } = useApi(`/performance?${query}`, ['leads']);
  const { data: projects } = useApi('/projects');
  const { data: directory } = useApi('/directory');
  if (error) return <Page><ErrorNote>{error}</ErrorNote></Page>;
  if (loading && !data) return <Spinner />;
  if (!data) return null;

  const desc = (key: string) => (a: any, b: any) => (b[key] ?? -1) - (a[key] ?? -1);
  const agents = filterRows<any>(data.agents, { sort: f.sort }, {
    sort: { score: desc('score'), on_time: desc('on_time_rate'), missed: desc('missed'), calls: desc('calls'), visits: desc('visits'), booked: desc('booked') },
  });
  const team = data.team_view;
  const single = !team || Boolean(f.owner);
  const people = directory?.users.filter((u: any) => isLeadRole(u.role)).map((u: any) => ({ value: String(u.id), label: u.name })) ?? [];

  return (
    <Page>
      <PageHeader title={team ? 'Agent Performance' : 'My Performance'} subtitle="Follow-ups, calls, visits and bookings, measured the same way for everyone"
        actions={team && <a href={csvFile(agents)} download="archstone-performance.csv"><Button><Download size={16} />CSV</Button></a>} />
      <FilterBar activeCount={activeCount} onClear={clear}>
        <DatePill label="Period" preset={f.date} from={f.from} to={f.to} onChange={(date, from, to) => set({ date, from, to })} />
        {team && <FilterPill label="Agent" value={f.owner} options={people} onChange={(owner) => set({ owner })} all="Everyone" />}
        <FilterPill label="Project" value={f.project} options={projects?.projects.map((p: any) => ({ value: String(p.id), label: p.name })) ?? []} onChange={(project) => set({ project })} />
        {team && <FilterPill label="Role" value={f.role} options={LEAD_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} onChange={(role) => set({ role })} />}
        {team && !!data.teams.length && <FilterPill label="Team" value={f.team} options={toOptions(data.teams)} onChange={(t) => set({ team: t })} />}
        {team && !f.owner && <FilterPill label="Sort" value={f.sort} options={SORTS} onChange={(sort) => set({ sort })} clearable={false} />}
      </FilterBar>

      {single && agents[0] && <PersonCard a={agents[0]} />}
      {!agents.length && <Card><Empty title="Nobody matches these filters" /></Card>}

      {!single && !!agents.length && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Follow-ups due" value={data.totals.due} hint={data.totals.pending ? `${data.totals.pending} still to come` : undefined} />
            <Stat label="Done on time" value={orNone(data.totals.on_time_rate, '%')} hint={`${data.totals.on_time} follow-ups`} />
            <Stat label="Done late" value={data.totals.late} />
            <Stat label="Missed" value={data.totals.missed} tone={data.totals.missed ? 'alert' : undefined} />
          </div>
          <Card>
            <CardHeader title="Every agent" hint="Choose a name to see their own card" />
            <ul className="divide-y divide-line md:hidden">
              {agents.map((a: any) => (
                <li key={a.id}>
                  <button type="button" onClick={() => set({ owner: String(a.id) })} className="flex w-full items-center gap-2 px-4 py-2.5 text-left">
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium text-ink">{a.name}</span><span className="block text-xs text-muted">{orNone(a.on_time_rate, '%')} on time · {a.missed} missed · {a.calls} calls</span></span>
                    <Badge tone={scoreTone(a.score)}>{orNone(a.score)}</Badge>
                  </button>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[52rem] text-sm">
                <thead><tr className="border-b border-line text-left text-[13px] text-muted">
                  <th className="px-4 py-2 font-medium">Agent</th>
                  {['Set', 'Due', 'On time', 'Late', 'Missed', 'Moved', 'Calls', 'Connect', 'Response', 'Visits', 'Booked'].map((h) => <th key={h} className="px-2 py-2 text-right font-medium">{h}</th>)}
                  <th className="px-4 py-2 text-right font-medium">Score</th>
                </tr></thead>
                <tbody className="divide-y divide-line">
                  {agents.map((a: any) => (
                    <tr key={a.id} className="hover:bg-surface-2">
                      <td className="px-4 py-2"><button type="button" className="text-left font-medium text-ink hover:underline" onClick={() => set({ owner: String(a.id) })}>{a.name}</button><span className="block text-xs text-muted">{ROLE_LABELS[a.role as keyof typeof ROLE_LABELS]}</span></td>
                      <td className="px-2 text-right tabular-nums">{a.set}</td>
                      <td className="px-2 text-right tabular-nums">{a.due}</td>
                      <td className="px-2 text-right tabular-nums">{orNone(a.on_time_rate, '%')}</td>
                      <td className="px-2 text-right tabular-nums">{a.late}</td>
                      <td className="px-2 text-right tabular-nums">{a.missed ? <Link className="font-semibold text-red-700 hover:underline dark:text-red-400" to={`/followups?owner=${a.id}`}>{a.missed}</Link> : 0}</td>
                      <td className="px-2 text-right tabular-nums">{a.moved}</td>
                      <td className="px-2 text-right tabular-nums">{a.calls}</td>
                      <td className="px-2 text-right tabular-nums">{orNone(a.connect_rate, '%')}</td>
                      <td className="px-2 text-right whitespace-nowrap tabular-nums">{orNone(a.response_minutes, ' min')}</td>
                      <td className="px-2 text-right tabular-nums">{a.visits}</td>
                      <td className="px-2 text-right tabular-nums">{a.booked}</td>
                      <td className="px-4 text-right"><Badge tone={scoreTone(a.score)}>{orNone(a.score)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
      <p className="mt-3 text-[13px] text-muted">On time means done within {data.grace_minutes} minutes of the due time. The score is 50% on-time follow-ups, 25% call connect rate and 25% first response speed. Bookings are shown separately, because they also depend on the leads someone was given.</p>
    </Page>
  );
}
