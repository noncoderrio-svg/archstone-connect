import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FilterBar, FilterPill, SearchBox, filterRows, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Button, Card, ErrorNote, IconButton, PageHeader, cx } from '../components/ui.tsx';
import { useApi } from '../lib/api.ts';
import { timeOnly } from '../lib/format.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const istDay = (utc: string) => new Date(new Date(`${utc.replace(' ', 'T')}Z`).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);

export default function Calendar() {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7)); // Weeks start on Monday.
  const days = useMemo(() => Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)), [month]);
  const { data, error } = useApi(`/calendar?from=${key(days[0])}&to=${key(days[41])}`, ['leads', 'visits']);
  const today = key(new Date());
  const { f, set, clear, activeCount } = useFilters(['q', 'kind'] as const);
  const rows = filterRows<any>(data?.events, f, { search: (e) => [e.lead_name, e.title, e.owner], match: { kind: (e) => e.kind } });
  const events: Record<string, any[]> = {};
  for (const e of rows) (events[istDay(e.at)] ??= []).push(e);
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  return (
    <Page>
      <PageHeader title="Calendar" subtitle="Follow-ups and site visits" actions={<>
        <IconButton label="Previous month" onClick={() => shift(-1)}><ChevronLeft size={18} /></IconButton>
        <span className="w-36 text-center font-medium text-ink">{month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</span>
        <IconButton label="Next month" onClick={() => shift(1)}><ChevronRight size={18} /></IconButton>
        <Button onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</Button>
      </>} />
      {error && <ErrorNote>{error}</ErrorNote>}
      <FilterBar search={<SearchBox placeholder="Search customer or assigned person" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={rows.length} total={data?.events.length} noun="events">
        <FilterPill label="Type" value={f.kind} options={[{ value: 'visit', label: 'Site visits' }, { value: 'task', label: 'Follow-ups' }]} onChange={(kind) => set({ kind })} />
      </FilterBar>
      <Card className="overflow-x-auto">
        <div className="grid min-w-[46rem] grid-cols-7">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="border-b border-line px-2 py-1.5 text-[13px] font-medium text-muted">{d}</div>)}
          {days.map((d) => {
            const k = key(d);
            const items = (events[k] ?? []).sort((a, b) => a.at.localeCompare(b.at));
            return (
              <div key={k} className={cx('min-h-24 border-b border-r border-line p-1', d.getMonth() !== month.getMonth() && 'bg-surface-2')}>
                <p className={cx('mb-0.5 flex size-6 items-center justify-center rounded-full text-xs', k === today ? 'bg-brand font-medium text-white' : 'text-muted')}>{d.getDate()}</p>
                {items.slice(0, 4).map((e) => (
                  <Link key={`${e.kind}${e.id}`} to={`/leads/${e.lead_id}`} title={`${e.title}: ${e.lead_name}`}
                    className={cx('mb-0.5 block truncate rounded px-1 py-0.5 text-[11px]', e.kind === 'visit' ? 'bg-brand-soft text-brand-ink' : 'bg-surface-2 text-body')}>
                    {timeOnly(e.at)} {e.lead_name}
                  </Link>
                ))}
                {items.length > 4 && <p className="px-1 text-[11px] text-muted">+{items.length - 4} more</p>}
              </div>
            );
          })}
        </div>
      </Card>
    </Page>
  );
}
