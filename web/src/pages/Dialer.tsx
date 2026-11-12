import { ArrowLeft, Mail, MessageCircle, MessageSquareText, Phone, PhoneForwarded, Shuffle, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DISPOSITIONS, isLeadRole } from '../../../shared/domain.ts';
import { FilterBar, FilterPill, SearchBox, filterRows, optionsFrom, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, Empty, ErrorNote, Modal, Notice, PageHeader, Select, Spinner, TempBadge, TextField, Textarea, cx, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { callSeconds, emailLink, placeCall, smsLink } from '../lib/calling.ts';
import { lakhs, localToUtc, parseCsv, prettyPhone, timeAgo } from '../lib/format.ts';

function NewListModal({ onClose }: { onClose: () => void }) {
  const { data: people } = useApi('/directory');
  const { data: projects } = useApi('/projects');
  const [f, setF] = useState({ name: '', project_id: '', consent: '' });
  const [agents, setAgents] = useState<number[]>([]);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileError, setFileError] = useState('');
  const [report, setReport] = useState<any>(null);
  const { busy, run } = useAction();

  const read = async (file?: File) => {
    if (!file) return;
    setFileError('');
    try {
      const parsed = /\.xlsx$/i.test(file.name) ? (await api.upload('/leads/parse-xlsx', file)).rows : parseCsv(await file.text());
      if (!parsed.length || !('phone' in parsed[0] || 'mobile' in parsed[0])) throw new Error('The file needs a "phone" column.');
      setRows(parsed);
    } catch (e) {
      setRows([]);
      setFileError((e as Error).message);
    }
  };
  const submit = async () => {
    const r = await run(() => api.post('/dialer/lists', {
      name: f.name, project_id: f.project_id ? Number(f.project_id) : null, agent_ids: agents, rows, consent_source: f.consent || undefined,
      counts: Object.fromEntries(agents.filter((a) => Number(counts[a]) > 0).map((a) => [a, Number(counts[a])])),
    }));
    if (r) setReport(r);
  };

  const callers = people?.users.filter((u: any) => isLeadRole(u.role)) ?? [];
  const typed = agents.reduce((s, a) => s + (Number(counts[a]) || 0), 0);
  if (report) {
    return (
      <Modal title="List ready" onClose={onClose}>
        <ul className="space-y-1 text-sm">
          <li><b className="text-ink">{report.added}</b> contacts added and shared out</li>
          <li><b className="text-ink">{report.repeated_in_file}</b> repeats removed from the file</li>
          <li><b className="text-ink">{report.already_in_crm}</b> already in the CRM, left with their current owner</li>
          <li><b className="text-ink">{report.invalid}</b> invalid numbers removed</li>
        </ul>
        {!!Object.keys(report.per_agent).length && (
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line text-sm">
            {Object.entries(report.per_agent).map(([id, n]) => (
              <li key={id} className="flex justify-between px-3 py-1.5"><span>{callers.find((u: any) => String(u.id) === id)?.name ?? 'Someone'}</span><b className="tabular-nums text-ink">{String(n)}</b></li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
      </Modal>
    );
  }
  return (
    <Modal title="New calling list" onClose={onClose}>
      <div className="space-y-3">
        <TextField label="List name" required placeholder="e.g. Property expo contacts" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Select aria-label="Project" value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
          <option value="">No project</option>
          {projects?.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <input type="file" accept=".csv,.xlsx" aria-label="Excel or CSV file" className="block w-full text-sm" onChange={(e) => read(e.target.files?.[0])} />
        <p className="text-xs text-muted">Use a "phone" column. Repeats and invalid numbers are removed automatically.</p>
        {fileError && <ErrorNote>{fileError}</ErrorNote>}
        {!!rows.length && <p className="text-sm text-ink">{rows.length} rows ready.</p>}
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium">Who gets these numbers</legend>
          <p className="mb-2 text-xs text-muted">Type how many each person gets, or leave it empty. Anything beyond the counts is shared equally.</p>
          <div className="scroll-thin max-h-60 space-y-1 overflow-y-auto">
            {callers.map((u: any) => {
              const on = agents.includes(u.id);
              return (
                <div key={u.id} className="flex items-center gap-2 text-sm">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input type="checkbox" className="accent-[var(--brand)]" checked={on} onChange={(e) => setAgents(e.target.checked ? [...agents, u.id] : agents.filter((a) => a !== u.id))} />
                    <span className="truncate">{u.name}</span>
                  </label>
                  <input type="number" min="0" inputMode="numeric" aria-label={`How many numbers for ${u.name}`} placeholder="Equal share" disabled={!on}
                    className="h-8 w-28 rounded-lg border border-line bg-surface px-2 text-right text-sm tabular-nums disabled:opacity-40"
                    value={counts[u.id] ?? ''} onChange={(e) => setCounts({ ...counts, [u.id]: e.target.value })} />
                </div>
              );
            })}
          </div>
          {!!rows.length && !!agents.length && (
            <p className="mt-2 text-xs text-muted">{typed ? `${Math.min(typed, rows.length)} by count, about ${Math.max(0, rows.length - typed)} shared equally (before repeats and invalid numbers are removed).` : `About ${Math.ceil(rows.length / agents.length)} each.`}</p>
          )}
        </fieldset>
        <TextField label="WhatsApp consent source (optional)" hint="Fill this in only if these people agreed to WhatsApp messages." value={f.consent} onChange={(e) => setF({ ...f, consent: e.target.value })} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!rows.length || !agents.length || f.name.trim().length < 2} onClick={submit}>Create list</Button>
        </div>
      </div>
    </Modal>
  );
}

function ResplitModal({ list, onClose }: { list: any; onClose: () => void }) {
  const { data } = useApi(`/dialer/lists/${list.id}/people`);
  const { data: people } = useApi('/directory');
  const [from, setFrom] = useState<number[]>([]);
  const [to, setTo] = useState<number[]>([]);
  const [mode, setMode] = useState<'equal' | 'count'>('equal');
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [result, setResult] = useState<any>(null);
  const { busy, run } = useAction();
  const holders = data?.people ?? [];
  // Same rule as reassigning leads: a manager with a team moves numbers only within it.
  const callers = (people?.users ?? []).filter((u: any) => isLeadRole(u.role) && (!people?.team_ids || people.team_ids.includes(u.id)));
  const available = holders.filter((p: any) => from.includes(p.id)).reduce((s: number, p: any) => s + p.uncalled, 0);
  const toggle = (set: number[], id: number, fn: (v: number[]) => void) => fn(set.includes(id) ? set.filter((x) => x !== id) : [...set, id]);
  const submit = async () => {
    const r = await run(() => api.post(`/dialer/lists/${list.id}/resplit`, {
      from_ids: from, to_ids: to, mode,
      counts: mode === 'count' ? Object.fromEntries(to.map((id) => [id, Number(counts[id]) || 0])) : undefined,
    }));
    if (r) setResult(r);
  };
  if (result) {
    return (
      <Modal title="Numbers moved" onClose={onClose}>
        <p className="text-sm text-ink"><b>{result.moved}</b> uncalled numbers moved.{result.left ? ` ${result.left} stayed where they were.` : ''} Each person has been told once.</p>
        <div className="mt-3 flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
      </Modal>
    );
  }
  return (
    <Modal title={`Re-split: ${list.name}`} onClose={onClose} wide>
      {!data ? <Spinner /> : (
        <div className="space-y-4">
          <p className="text-[13px] text-muted">Only numbers nobody has called yet are moved. Numbers already called stay with their caller.</p>
          <fieldset>
            <legend className="mb-1 text-[13px] font-medium">Take uncalled numbers from</legend>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {holders.map((p: any) => (
                <li key={p.id}>
                  <label className="flex items-center gap-2 px-3 py-2 text-sm">
                    <input type="checkbox" className="accent-[var(--brand)]" checked={from.includes(p.id)} disabled={!p.uncalled} onChange={() => toggle(from, p.id, setFrom)} />
                    <span className="flex-1">{p.name}</span>
                    <span className="text-xs text-muted tabular-nums">{p.uncalled} uncalled of {p.total}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-[13px] font-medium">Give them to</legend>
            <div className="mb-2 flex gap-4 text-sm">
              <label className="flex items-center gap-1.5"><input type="radio" name="mode" className="accent-[var(--brand)]" checked={mode === 'equal'} onChange={() => setMode('equal')} />Share equally</label>
              <label className="flex items-center gap-1.5"><input type="radio" name="mode" className="accent-[var(--brand)]" checked={mode === 'count'} onChange={() => setMode('count')} />By count</label>
            </div>
            <div className="scroll-thin max-h-56 space-y-1 overflow-y-auto">
              {callers.map((u: any) => (
                <div key={u.id} className="flex items-center gap-2 text-sm">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input type="checkbox" className="accent-[var(--brand)]" checked={to.includes(u.id)} onChange={() => toggle(to, u.id, setTo)} />
                    <span className="truncate">{u.name}</span>
                  </label>
                  {mode === 'count' && (
                    <input type="number" min="0" inputMode="numeric" aria-label={`How many for ${u.name}`} disabled={!to.includes(u.id)}
                      className="h-8 w-24 rounded-lg border border-line bg-surface px-2 text-right text-sm tabular-nums disabled:opacity-40"
                      value={counts[u.id] ?? ''} onChange={(e) => setCounts({ ...counts, [u.id]: e.target.value })} />
                  )}
                </div>
              ))}
            </div>
          </fieldset>
          <p className="text-sm text-ink">{available} uncalled number{available === 1 ? '' : 's'} selected{mode === 'equal' && to.length ? `, about ${Math.ceil(available / to.length)} each` : ''}.</p>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={busy} disabled={!from.length || !to.length || !available} onClick={submit}>Move numbers</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

const FOLLOW_UPS = [
  { label: 'In 2 hours', at: () => new Date(Date.now() + 2 * 3600000) },
  { label: 'Tomorrow 11 am', at: () => { const d = new Date(Date.now() + 86400000); d.setHours(11, 0, 0, 0); return d; } },
  { label: 'In 3 days', at: () => new Date(Date.now() + 3 * 86400000) },
];

function Session({ list, onExit }: { list: number | null; onExit: () => void }) {
  const [skip, setSkip] = useState(0);
  const { data, error, loading, reload } = useApi(`/dialer/next?${list ? `list=${list}&` : ''}${skip ? `skip=${skip}` : ''}`);
  const [calling, setCalling] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [followUp, setFollowUp] = useState(-1);
  const [script, setScript] = useState(false);
  const { busy, run } = useAction();

  // A reopened app must finish the open call before anything else.
  useEffect(() => { if (data?.pending) setCalling(true); }, [data?.pending, data?.lead?.id]);

  if (loading) return <Spinner />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  const lead = data?.lead;
  if (!lead) {
    return (
      <Card>
        <Empty title="Your queue is clear">{data?.calls_today ?? 0} calls made today.</Empty>
        <div className="pb-5 text-center"><Button onClick={onExit}>Back to lists</Button></div>
      </Card>
    );
  }

  const call = async () => {
    if (await run(async () => { await placeCall(lead.id, lead.phone); return true; })) setCalling(true);
  };
  const touch = (channel: string) => run(() => api.post(`/leads/${lead.id}/touch`, { channel }));
  const save = async () => {
    const connected = ['Connected', 'Qualified', 'Call Back', 'Not Interested'].includes(outcome);
    const seconds = callSeconds();
    const ok = await run(async () => {
      await api.post(`/leads/${lead.id}/call`, { disposition: outcome, notes, duration_seconds: connected ? seconds : undefined });
      if (followUp >= 0) {
        await api.post(`/leads/${lead.id}/tasks`, { type: 'Call back', due_at: localToUtc(FOLLOW_UPS[followUp].at().toISOString()), notes });
      }
      return true;
    });
    if (ok) {
      setCalling(false); setOutcome(''); setNotes(''); setFollowUp(-1); setScript(false); setSkip(0);
      void reload();
    }
  };

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-3 flex items-center justify-between">
        <Button size="sm" variant="ghost" disabled={calling} onClick={onExit}><ArrowLeft size={15} />Lists</Button>
        <span className="text-[13px] text-muted">{data.calls_today} calls today · {data.remaining} left</span>
      </div>
      <Card className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link to={`/leads/${lead.id}`} className="block truncate font-display text-xl font-semibold text-ink">{lead.name}</Link>
            <p className="text-muted tabular-nums">{prettyPhone(lead.phone)}</p>
          </div>
          <TempBadge value={lead.temperature} />
        </div>
        <p className="mt-2 text-sm">{[data.project?.name, lead.configuration, lead.budget_lakhs ? lakhs(lead.budget_lakhs) : '', lead.source].filter(Boolean).join(' · ')}</p>
        <div className="mt-1 flex flex-wrap gap-1.5"><Badge>{lead.stage}</Badge>{lead.intent && lead.intent !== 'general' && <Badge tone="brand">Asked about {lead.intent}</Badge>}</div>
        {data.last && <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px]"><b className="text-ink">{timeAgo(data.last.created_at)} ago:</b> {data.last.title}{data.last.body ? `. ${data.last.body}` : ''}</p>}
        {(data.project?.call_script || data.project?.objections) && (
          <button className="mt-2 text-sm text-brand-ink underline" onClick={() => setScript(!script)}>{script ? 'Hide script' : 'Show call script'}</button>
        )}
        {script && <p className="mt-1 text-sm whitespace-pre-line">{data.project.call_script}{data.project.objections ? `\n\n${data.project.objections}` : ''}</p>}

        {!calling ? (
          <>
            <Button variant="primary" className="mt-4 h-12 w-full text-base" disabled={lead.phone_masked} onClick={call}><Phone size={18} />Call now</Button>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Link to={`/inbox/${lead.id}`}><Button variant="whatsapp" className="w-full"><MessageCircle size={16} />Chat</Button></Link>
              <a href={smsLink(lead.phone, lead.name)} onClick={() => touch('sms')}><Button className="w-full"><MessageSquareText size={16} />SMS</Button></a>
              {lead.email
                ? <a href={emailLink(lead.email)} onClick={() => touch('email')}><Button className="w-full"><Mail size={16} />Email</Button></a>
                : <Button disabled><Mail size={16} />Email</Button>}
            </div>
            <Button variant="ghost" className="mt-2 w-full" onClick={() => setSkip(lead.id)}><PhoneForwarded size={15} />Skip for now</Button>
          </>
        ) : (
          <div className="mt-4 border-t border-line pt-3">
            <Notice>Save the result of this call to move to the next lead.</Notice>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {DISPOSITIONS.map((d) => <Button key={d} variant={d === outcome ? 'primary' : 'secondary'} onClick={() => setOutcome(d)}>{d}</Button>)}
            </div>
            <Textarea aria-label="Call notes" className="mt-2" rows={2} placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <p className="mt-2 mb-1 text-[13px] font-medium">Follow up</p>
            <div className="flex flex-wrap gap-1.5">
              {FOLLOW_UPS.map((o, i) => (
                <button key={o.label} aria-pressed={followUp === i} onClick={() => setFollowUp(followUp === i ? -1 : i)}
                  className={cx('rounded-full border px-2.5 py-1 text-[13px]', followUp === i ? 'border-brand bg-brand-soft font-medium text-brand-ink' : 'border-line')}>{o.label}</button>
              ))}
            </div>
            <Button variant="primary" className="mt-3 h-11 w-full" busy={busy} disabled={!outcome} onClick={save}>Save and next lead</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function Dialer() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi('/dialer/lists', ['leads']);
  const [active, setActive] = useState<{ list: number | null } | null>(null);
  const [creating, setCreating] = useState(false);
  const [resplitting, setResplitting] = useState<any>(null);
  const { f, set, clear, activeCount } = useFilters(['q', 'project', 'progress', 'sort'] as const);
  if (active) return <Page><Session list={active.list} onExit={() => { setActive(null); void reload(); }} /></Page>;
  const lists = filterRows<any>(data?.lists, f, {
    search: (l) => [l.name, l.project_name],
    match: { project: (l) => l.project_name },
    test: (l) => !f.progress || (f.progress === 'done' ? l.untouched === 0 : l.untouched > 0),
    sort: { left: (a, b) => b.untouched - a.untouched, interested: (a, b) => b.interested - a.interested },
  });
  return (
    <Page>
      <PageHeader title="Calling" subtitle="One lead at a time, with every result saved"
        actions={<>
          {can('lead.import') && <Button onClick={() => setCreating(true)}><Upload size={16} />New list</Button>}
          <Button variant="primary" onClick={() => setActive({ list: null })}><Phone size={16} />Start calling</Button>
        </>} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Spinner />}
      {data && !data.lists.length && <Card><Empty title="No calling lists yet">Start calling works through your assigned leads. Create a list to work a cold-calling file.</Empty></Card>}
      {!!data?.lists.length && (
        <FilterBar search={<SearchBox placeholder="Search lists" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={lists.length} total={data.lists.length} noun="lists">
          <FilterPill label="Project" value={f.project} options={optionsFrom<any>(data.lists, (l) => l.project_name)} onChange={(project) => set({ project })} />
          <FilterPill label="Progress" value={f.progress} options={[{ value: 'open', label: 'Calls remaining' }, { value: 'done', label: 'Finished' }]} onChange={(progress) => set({ progress })} />
          <FilterPill label="Sort" value={f.sort} options={[{ value: '', label: 'Newest first' }, { value: 'left', label: 'Most calls left' }, { value: 'interested', label: 'Most interested' }]} onChange={(sort) => set({ sort })} clearable={false} />
        </FilterBar>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {lists.map((l: any) => (
          <Card key={l.id} className="p-4">
            <p className="font-medium text-ink">{l.name}</p>
            <p className="text-[13px] text-muted">{l.project_name ?? 'No project'} · {l.total} contacts</p>
            <div className="mt-2 h-2 rounded-full bg-surface-2"><div className="h-full rounded-full bg-brand" style={{ width: `${l.total ? ((l.total - l.untouched) / l.total) * 100 : 0}%` }} /></div>
            <p className="mt-1 text-[13px]">{l.total - l.untouched} worked · {l.interested} interested</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setActive({ list: l.id })}><Phone size={14} />Call this list</Button>
              {can('lead.reassign') && <Button size="sm" onClick={() => setResplitting(l)}><Shuffle size={14} />Re-split</Button>}
            </div>
          </Card>
        ))}
      </div>
      {creating && <NewListModal onClose={() => { setCreating(false); void reload(); }} />}
      {resplitting && <ResplitModal list={resplitting} onClose={() => { setResplitting(null); void reload(); }} />}
    </Page>
  );
}
