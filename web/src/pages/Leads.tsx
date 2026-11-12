import { Columns3, CopyCheck, Download, MessageCircle, Plus, Rows3, Shuffle, Upload } from 'lucide-react';
import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CountTabs, DatePill, FilterBar, FilterPill, MultiPill, RangePill, SearchBox, dateBounds, toOptions, useFilters } from '../components/Filters.tsx';
import { BOARD_STAGES, DISPOSITIONS, SOURCES, STAGES } from '../../../shared/domain.ts';
import { Page } from '../components/Layout.tsx';
import {
  Badge, Button, Card, Empty, ErrorNote, Modal, PageHeader, Select, SelectField, Spinner, TempBadge, TextField, TextareaField, cx, useAction,
} from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { LabelChip, useLabels } from '../components/Labels.tsx';
import { useAuth } from '../lib/auth.tsx';
import { lakhs, parseCsv, prettyPhone, timeAgo, ago } from '../lib/format.ts';

export function AddLeadModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { data: p } = useApi('/projects');
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: '', phone: '', email: '', source: 'Manual', project_id: '', configuration: '', budget_lakhs: '', timeline: '', notes: '', wa_opt_in: false });
  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post('/leads', {
      ...f,
      project_id: f.project_id ? Number(f.project_id) : null,
      budget_lakhs: f.budget_lakhs ? Number(f.budget_lakhs) : null,
    }));
    if (r) nav(`/leads/${r.id}`);
  };
  return (
    <Modal title="Add lead" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextField label="Full name" required value={f.name} onChange={(e) => set('name', e.target.value)} />
        <TextField label="Phone" type="tel" required placeholder="98XXXXXXXX" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Source" value={f.source} onChange={(e) => set('source', e.target.value)}>
            {SOURCES.map((s) => <option key={s}>{s}</option>)}
          </SelectField>
          <SelectField label="Project" value={f.project_id} onChange={(e) => set('project_id', e.target.value)}>
            <option value="">Not decided</option>
            {p?.projects.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </SelectField>
          <TextField label="Configuration" placeholder="e.g. 2 BHK" value={f.configuration} onChange={(e) => set('configuration', e.target.value)} />
          <TextField label="Budget (₹ Lakhs)" type="number" min="1" value={f.budget_lakhs} onChange={(e) => set('budget_lakhs', e.target.value)} />
        </div>
        <SelectField label="Buying timeline" value={f.timeline} onChange={(e) => set('timeline', e.target.value)}>
          <option value="">Unknown</option>
          {['Immediately', 'Within 3 months', 'Within 6 months', 'Exploring'].map((t) => <option key={t}>{t}</option>)}
        </SelectField>
        <TextareaField label="Notes" value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 accent-[#C85A1E]" checked={f.wa_opt_in} onChange={(e) => set('wa_opt_in', e.target.checked)} />
          <span>Customer agreed to receive WhatsApp updates</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>Add lead</Button>
        </div>
      </form>
    </Modal>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [consent, setConsent] = useState('');
  const [fileError, setFileError] = useState('');
  const [result, setResult] = useState<any>(null);
  const { busy, run } = useAction();

  const read = async (file?: File) => {
    if (!file) return;
    setFileError('');
    let parsed: Record<string, string>[];
    try {
      parsed = /\.xlsx$/i.test(file.name) ? (await api.upload('/leads/parse-xlsx', file)).rows : parseCsv(await file.text());
    } catch (e) {
      return setFileError((e as Error).message);
    }
    if (!parsed.length || !('name' in parsed[0]) || !('phone' in parsed[0])) {
      setRows([]);
      return setFileError('The file needs "name" and "phone" columns.');
    }
    setRows(parsed);
  };
  const submit = async () => {
    const r = await run(() => api.post('/leads/import', { rows, consent_source: consent || undefined }));
    if (r) { setResult(r); onDone(); }
  };
  return (
    <Modal title="Import leads" onClose={onClose}>
      {result ? (
        <div className="space-y-2">
          <p className="text-ink"><b>{result.created}</b> added, <b>{result.duplicates}</b> already existed, <b>{result.failed.length}</b> failed.</p>
          {result.failed.slice(0, 5).map((f: any) => <p key={f.row} className="text-sm text-muted">Row {f.row}: {f.reason}</p>)}
          <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Upload an Excel or CSV file with these columns: name, phone, email, project, configuration, budget_lakhs, notes. Up to 10,000 rows.{' '}
            <a className="font-medium text-brand-ink underline" download="archstone-leads-template.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent('name,phone,email,project,configuration,budget_lakhs,notes\n')}`}>Download template</a>
          </p>
          {fileError && <ErrorNote>{fileError}</ErrorNote>}
          <input type="file" accept=".csv,.xlsx" aria-label="Excel or CSV file" className="block w-full text-sm" onChange={(e) => read(e.target.files?.[0])} />
          {!!rows.length && <p className="text-sm text-ink">{rows.length} rows ready.</p>}
          <TextField label="WhatsApp consent source (optional)" hint="Fill this in only if these people agreed to WhatsApp messages. Leave blank otherwise." placeholder="e.g. Expo sign-up form, Jan 2026" value={consent} onChange={(e) => setConsent(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={busy} disabled={!rows.length} onClick={submit}>Import {rows.length || ''} leads</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Board({ leads, onMoved }: { leads: any[]; onMoved: () => void }) {
  const { run } = useAction();
  const [over, setOver] = useState('');
  const drop = async (e: DragEvent, stage: string) => {
    e.preventDefault();
    setOver('');
    const id = e.dataTransfer.getData('text/plain');
    if (id) {
      await run(() => api.post(`/leads/${id}/stage`, { stage }));
      onMoved();
    }
  };
  return (
    <div className="scroll-thin flex gap-3 overflow-x-auto pb-3">
      {BOARD_STAGES.map((stage) => {
        const cards = leads.filter((l) => l.stage === stage);
        return (
          <div
            key={stage}
            onDragOver={(e) => { e.preventDefault(); setOver(stage); }}
            onDragLeave={() => setOver('')}
            onDrop={(e) => drop(e, stage)}
            className={cx('flex w-64 shrink-0 flex-col rounded-xl border bg-surface-2 p-2', over === stage ? 'border-brand' : 'border-line')}
          >
            <div className="flex items-center justify-between px-1.5 py-1 text-[13px] font-medium text-ink">
              <span>{stage}</span><span className="text-muted tabular-nums">{cards.length}</span>
            </div>
            <div className="mt-1 min-h-16 space-y-2">
              {cards.map((l) => (
                <Link key={l.id} to={`/leads/${l.id}`} draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', String(l.id))}
                  className="block rounded-lg border border-line bg-surface px-3 py-2 hover:border-brand">
                  <span className="flex items-center justify-between gap-2"><span className="truncate font-medium text-ink">{l.name}</span><TempBadge value={l.temperature} /></span>
                  <span className="mt-0.5 block truncate text-[13px] text-muted">{l.project_name ?? 'No project'} · {lakhs(l.budget_lakhs)}</span>
                  <span className="block truncate text-xs text-muted">{l.owner_name ?? 'Unassigned'}</span>
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const FILTER_KEYS = ['q', 'stage', 'source', 'temperature', 'project', 'owner', 'label', 'date', 'from', 'to', 'task', 'action', 'budget', 'budget_max', 'configuration', 'overdue', 'sort', 'campaign', 'adset', 'ad', 'disposition'] as const;

const TASK_STATES = [{ value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Due today' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'none', label: 'No follow-up' }];
const BUDGETS = [{ value: 'lt100', label: 'Under ₹1 Cr' }, { value: '100-200', label: '₹1 to 2 Cr' }, { value: '200-500', label: '₹2 to 5 Cr' }, { value: 'gt500', label: 'Above ₹5 Cr' }];
const SORTS = [
  { value: '', label: 'Latest activity' }, { value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }, { value: 'score', label: 'Highest score' },
  { value: 'budget_high', label: 'Budget: high to low' }, { value: 'budget_low', label: 'Budget: low to high' }, { value: 'name', label: 'Name A to Z' },
];

function DuplicatesModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { data, reload } = useApi('/leads-duplicates');
  const { busy, run } = useAction();
  const merge = async (keep: any, other: any) => {
    if (!confirm(`Merge ${other.name} (${prettyPhone(other.phone)}) into ${keep.name}? History moves to ${keep.name}, and this cannot be undone.`)) return;
    if (await run(() => api.post('/leads/merge', { keep_id: keep.id, merge_id: other.id }), 'Leads merged')) { void reload(); onDone(); }
  };
  return (
    <Modal title="Find duplicates" onClose={onClose} wide>
      <p className="text-sm text-muted">These leads may be one person using two numbers. Choose which record to keep. WhatsApp consent stays with each number.</p>
      {!data && <Spinner />}
      {data && !data.groups.length && <Empty title="No duplicates found" />}
      <div className="mt-2 space-y-3">
        {data?.groups.map((g: any) => (
          <div key={g.reason + g.leads[0].id} className="rounded-lg border border-line">
            <p className="border-b border-line px-3 py-1.5 text-[13px] font-medium text-ink">{g.reason}</p>
            <ul className="divide-y divide-line">
              {g.leads.map((l: any, i: number) => (
                <li key={l.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <Link to={`/leads/${l.id}`} className="min-w-44 flex-1"><span className="block font-medium text-ink">{l.name}</span><span className="block text-xs text-muted">{prettyPhone(l.phone)} · {l.stage} · {l.owner_name ?? 'Unassigned'}</span></Link>
                  <Button size="sm" busy={busy} onClick={() => merge(l, g.leads[i === 0 ? 1 : 0])}>Keep this one</Button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export default function Leads() {
  const { can, user } = useAuth();
  const [view, setView] = useState<'table' | 'board'>(() => (localStorage.getItem('leadsView') as 'board') ?? 'table');
  const { f, set: setF, clear, activeCount } = useFilters(FILTER_KEYS);
  const catalog = useLabels();
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<'add' | 'import' | 'duplicates' | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [assignee, setAssignee] = useState('');
  const { busy, run } = useAction();

  useEffect(() => localStorage.setItem('leadsView', view), [view]);

  const filterKey = JSON.stringify(f);
  useEffect(() => setPage(1), [filterKey]);

  // The same filters drive the list and the exports, so a file matches the screen.
  const filterQuery = useMemo(() => {
    const { date, from, to, ...rest } = f;
    const p = new URLSearchParams(Object.entries(rest).filter(([, v]) => v));
    const bounds = dateBounds(date, from, to);
    if (bounds.from) p.set('created_from', bounds.from);
    if (bounds.to) p.set('created_to', bounds.to);
    return p.toString();
  }, [filterKey]);

  const query = useMemo(() => {
    const p = new URLSearchParams(filterQuery);
    p.set('page', String(page));
    if (view === 'board') { p.set('board', '1'); p.delete('stage'); }
    return p.toString();
  }, [filterQuery, page, view]);

  const { data, loading, error, reload } = useApi(`/leads?${query}`, ['leads']);
  const { data: projects } = useApi('/projects');
  const { data: directory } = useApi('/directory');
  const setFilter = (k: (typeof FILTER_KEYS)[number], v: string) => setF({ [k]: v });
  const canAdd = can('lead.create');
  const { data: saved, reload: reloadSaved } = useApi('/saved-filters');
  const { data: ads } = useApi(`/leads-campaigns?${new URLSearchParams(Object.entries({ campaign: f.campaign, adset: f.adset }).filter(([, v]) => v))}`);
  const assignToMe = async () => {
    const ok = await run(() => api.post('/leads/assign', { lead_ids: selected, owner_id: user!.id }), `${selected.length} leads assigned to you`);
    if (ok) { setSelected([]); void reload(); }
  };
  const active = Object.entries(f).filter(([k, v]) => v && k !== 'sort');
  const applySaved = (id: string) => {
    const item = saved?.filters.find((x: any) => String(x.id) === id);
    if (!item) return;
    const p = new URLSearchParams(item.query);
    setF(Object.fromEntries(FILTER_KEYS.map((k) => [k, p.get(k) ?? ''])));
  };
  const counts: Record<string, number> = data?.stage_counts ?? {};
  const allCount = Object.values(counts).reduce((s, n) => s + n, 0);
  const stageTabs = [{ value: '', label: 'All', count: allCount }, ...STAGES.filter((s) => counts[s] || f.stage === s).map((s) => ({ value: s, label: s, count: counts[s] ?? 0 }))];
  const results: Record<string, number> = data?.result_counts ?? {};
  const resultTabs = DISPOSITIONS.filter((d) => results[d] || f.disposition === d).map((d) => ({ value: d, label: d, count: results[d] ?? 0 }));
  const inTeam = (u: any) => !directory?.team_ids || directory.team_ids.includes(u.id);
  const people = directory?.users.filter((u: any) => ['sales', 'telecaller', 'team_leader', 'site_head', 'sales_manager'].includes(u.role) && inTeam(u)).map((u: any) => ({ value: String(u.id), label: u.name })) ?? [];
  const distribute = async () => {
    const r = await run(() => api.post('/leads/auto-distribute'));
    if (r) { alert(r.waiting ? `${r.assigned} assigned. ${r.waiting} are still waiting because no telecaller is available.` : `${r.assigned} leads assigned.`); void reload(); }
  };
  const bhk = ['1 BHK', '2 BHK', '3 BHK', '4 BHK'];
  const saveCurrent = async () => {
    const name = prompt('Name this view');
    if (name) { await run(() => api.post('/saved-filters', { name, query: new URLSearchParams(active).toString() }), 'View saved'); void reloadSaved(); }
  };
  const allOnPage = data?.leads.map((l: any) => l.id) ?? [];

  const assign = async () => {
    const ok = await run(() => api.post('/leads/assign', { lead_ids: selected, owner_id: Number(assignee) }), `${selected.length} leads reassigned`);
    if (ok) { setSelected([]); setAssignee(''); void reload(); }
  };

  return (
    <Page>
      <PageHeader
        title="Leads"
        subtitle={data ? `${data.total} ${data.total === 1 ? 'lead' : 'leads'}` : undefined}
        actions={<>
          {can('lead.reassign') && f.owner === 'none' && !!data?.total && <Button busy={busy} onClick={distribute}><Shuffle size={16} />Auto distribute</Button>}
          {can('lead.export') && <a href={`/api/leads/export.xlsx?${filterQuery}`}><Button><Download size={16} />Excel</Button></a>}
          {can('lead.export') && <a href={`/api/leads/export?${filterQuery}`}><Button><Download size={16} />CSV</Button></a>}
          {can('lead.delete') && <Button onClick={() => setModal('duplicates')}><CopyCheck size={16} />Duplicates</Button>}
          {can('lead.import') && <Button onClick={() => setModal('import')}><Upload size={16} />Import</Button>}
          {canAdd && <Button variant="primary" onClick={() => setModal('add')}><Plus size={16} />Add lead</Button>}
        </>}
      />

      {view === 'table' && data && <CountTabs label="Stage" tabs={stageTabs} value={f.stage} onChange={(v) => setFilter('stage', v)} />}
      {view === 'table' && !!resultTabs.length && <CountTabs label="Call result" tabs={[{ value: '', label: 'All call results' }, ...resultTabs]} value={f.disposition} onChange={(v) => setFilter('disposition', v)} />}

      <FilterBar
        search={<SearchBox label="Search leads" placeholder="Name, phone, email or lead ID" value={f.q} onChange={(v) => setFilter('q', v)} />}
        activeCount={activeCount} onClear={clear} shown={data?.total} noun={data?.total === 1 ? 'lead' : 'leads'}
      >
        <DatePill label="Created" preset={f.date} from={f.from} to={f.to} onChange={(date, from, to) => setF({ date, from, to })} />
        <MultiPill label="Task status" value={f.task} options={TASK_STATES} onChange={(v) => setFilter('task', v)} />
        <FilterPill label="Action" value={f.action} options={toOptions(data?.actions ?? [])} onChange={(v) => setFilter('action', v)} />
        <FilterPill label="Call result" value={f.disposition} options={toOptions(DISPOSITIONS)} onChange={(v) => setFilter('disposition', v)} />
        <FilterPill label="Source" value={f.source} options={toOptions(SOURCES)} onChange={(v) => setFilter('source', v)} />
        <FilterPill label="Campaign" value={f.campaign} options={toOptions(ads?.campaigns ?? [])} onChange={(campaign) => setF({ campaign, adset: '', ad: '' })} />
        <FilterPill label="Ad set" value={f.adset} options={toOptions(ads?.adsets ?? [])} onChange={(adset) => setF({ adset, ad: '' })} />
        <FilterPill label="Ad" value={f.ad} options={toOptions(ads?.ads ?? [])} onChange={(ad) => setF({ ad })} />
        <FilterPill label="Score" value={f.temperature} options={toOptions(['Hot', 'Warm', 'Cold'])} onChange={(v) => setFilter('temperature', v)} />
        <FilterPill label="Project" value={f.project} options={projects?.projects.map((p: any) => ({ value: String(p.id), label: p.name })) ?? []} onChange={(v) => setFilter('project', v)} />
        <FilterPill label="Assigned to" value={f.owner} options={[{ value: 'none', label: 'Unassigned', count: data?.unassigned }, ...people]} onChange={(v) => setFilter('owner', v)} />
        <FilterPill label="Label" value={f.label} options={catalog.map((l) => ({ value: l.name, label: l.name }))} onChange={(v) => setFilter('label', v)} />
        <FilterPill label="Budget" value={f.budget} options={BUDGETS} onChange={(v) => setFilter('budget', v)} />
        <RangePill label="Max budget" value={f.budget_max} min={20} max={1000} step={10} format={lakhs} onChange={(v) => setFilter('budget_max', v)} />
        <FilterPill label="Home type" value={f.configuration} options={toOptions(bhk)} onChange={(v) => setFilter('configuration', v)} />
        <FilterPill label="Sort" value={f.sort} options={SORTS} onChange={(v) => setFilter('sort', v)} clearable={false} />
        {!!saved?.filters.length && <FilterPill label="Saved view" value="" options={saved.filters.map((x: any) => ({ value: String(x.id), label: x.name }))} onChange={applySaved} all="Choose" clearable={false} />}
        {!!active.length && <Button size="sm" onClick={saveCurrent}>Save view</Button>}
      </FilterBar>

      <div className="mb-3 flex justify-end max-sm:hidden">
        <div className="flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="View">
          <button aria-label="Table view" aria-pressed={view === 'table'} onClick={() => setView('table')} className={cx('flex size-9 items-center justify-center rounded-md', view === 'table' ? 'bg-brand-soft text-brand-ink' : 'text-muted')}><Rows3 size={17} /></button>
          <button aria-label="Board view" aria-pressed={view === 'board'} onClick={() => setView('board')} className={cx('flex size-9 items-center justify-center rounded-md', view === 'board' ? 'bg-brand-soft text-brand-ink' : 'text-muted')}><Columns3 size={17} /></button>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Spinner />}

      {!!selected.length && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-brand-soft px-3 py-2 text-sm text-brand-ink">
          <span className="font-medium">{selected.length} selected</span>
          <Select aria-label="Assign to" className="w-52" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Assign to…</option>
            {directory?.users.filter((u: any) => ['sales', 'telecaller', 'team_leader'].includes(u.role) && inTeam(u)).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
          <Button variant="primary" size="sm" busy={busy} disabled={!assignee} onClick={assign}>Assign</Button>
          <Button size="sm" busy={busy} onClick={assignToMe}>Assign to me</Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected([])}>Clear</Button>
        </div>
      )}

      {data && view === 'board' && <Board leads={data.leads} onMoved={reload} />}

      {data && view === 'table' && (
        <Card>
          {!data.leads.length ? <Empty title="No leads match">Try clearing a filter.</Empty> : (
            <>
              {/* Phones get a card list; a wide table does not fit. */}
              <ul className="divide-y divide-line md:hidden">
                {data.leads.map((l: any) => (
                  <li key={l.id}>
                    <Link to={`/leads/${l.id}`} className="block px-4 py-3">
                      <span className="flex items-center justify-between gap-2"><span className="truncate font-medium text-ink">{l.name}</span><TempBadge value={l.temperature} /></span>
                      <span className="block truncate text-[13px] text-muted">{l.stage}{l.last_disposition ? ` · ${l.last_disposition}` : ''} · {l.project_name ?? 'No project'} · {ago(l.last_activity_at)}</span>
                      {l.email && !l.phone_masked && <span className="block truncate text-[13px] text-muted">{l.email}</span>}
                      {l.utm_campaign && <span className="block truncate text-xs text-muted">{l.utm_campaign}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-[13px] text-muted">
                      {can('lead.reassign') && (
                        <th className="w-10 pl-4">
                          <input type="checkbox" aria-label="Select all on page" className="accent-[#C85A1E]"
                            checked={allOnPage.length > 0 && allOnPage.every((id: number) => selected.includes(id))}
                            onChange={(e) => setSelected(e.target.checked ? allOnPage : [])} />
                        </th>
                      )}
                      {['Lead', 'Stage', 'Project', 'Budget', 'Source', 'Assigned to', 'Last activity'].map((h) => <th key={h} className="px-3 py-2.5 font-medium">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.leads.map((l: any) => (
                      <tr key={l.id} className="hover:bg-surface-2">
                        {can('lead.reassign') && (
                          <td className="pl-4">
                            <input type="checkbox" aria-label={`Select ${l.name}`} className="accent-[#C85A1E]" checked={selected.includes(l.id)}
                              onChange={(e) => setSelected((s) => (e.target.checked ? [...s, l.id] : s.filter((x) => x !== l.id)))} />
                          </td>
                        )}
                        <td className="px-3 py-2">
                          <Link to={`/leads/${l.id}`} className="font-medium text-ink hover:text-brand-ink hover:underline">{l.name}</Link>
                          <span className="block text-[13px] text-muted tabular-nums">{prettyPhone(l.phone)}</span>
                          {l.email && !l.phone_masked && <span className="block max-w-56 truncate text-[13px] text-muted" title={l.email}>{l.email}</span>}
                          {!!l.labels.length && <span className="flex flex-wrap gap-1">{l.labels.map((x: string) => <LabelChip key={x} name={x} catalog={catalog} />)}</span>}
                          {l.last_comment && <span className="block max-w-56 truncate text-xs text-muted" title={l.last_comment}>{l.last_comment}</span>}
                        </td>
                        <td className="px-3 py-2"><span className="flex items-center gap-1.5 whitespace-nowrap">{l.stage}<TempBadge value={l.temperature} /></span></td>
                        <td className="px-3 py-2">{l.project_name ?? '—'}<span className="block text-[13px] text-muted">{l.configuration}</span></td>
                        <td className="px-3 py-2 whitespace-nowrap tabular-nums">{lakhs(l.budget_lakhs)}</td>
                        <td className="px-3 py-2">
                          <span className="block whitespace-nowrap">{l.source}</span>
                          {l.utm_campaign && <button type="button" className="block max-w-44 truncate text-left text-xs text-muted hover:underline" title={[l.utm_campaign, l.adset, l.ad].filter(Boolean).join(' › ')} onClick={() => setF({ campaign: l.utm_campaign, adset: '', ad: '' })}>{l.utm_campaign}</button>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{l.owner_name ?? <Badge tone="amber">Unassigned</Badge>}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted">
                          <span className="inline-flex items-center gap-1.5">
                            <span>{ago(l.last_activity_at)}{l.last_actor && <span className="block text-xs">by {l.last_actor}</span>}</span>
                            {!!l.unread_count && <Link to={`/inbox/${l.id}`} aria-label={`${l.unread_count} unread WhatsApp`}><Badge tone="green"><MessageCircle size={12} />{l.unread_count}</Badge></Link>}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.total > data.pageSize && (
                <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-sm text-muted">
                  <span>Page {page} of {Math.ceil(data.total / data.pageSize)}</span>
                  <span className="flex gap-2">
                    <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                    <Button size="sm" disabled={page * data.pageSize >= data.total} onClick={() => setPage((p) => p + 1)}>Next</Button>
                  </span>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {modal === 'add' && <AddLeadModal onClose={() => setModal(null)} />}
      {modal === 'import' && <ImportModal onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'duplicates' && <DuplicatesModal onClose={() => setModal(null)} onDone={reload} />}
    </Page>
  );
}
