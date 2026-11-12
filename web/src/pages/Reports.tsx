import { Download, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ROLE_LABELS, SOURCES } from '../../../shared/domain.ts';
import { BarList, Funnel } from '../components/Charts.tsx';
import { DatePill, FilterBar, FilterPill, dateBounds, toOptions, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Button, Card, CardHeader, Empty, ErrorNote, Input, Modal, PageHeader, Select, SelectField, Spinner, Stat, TextField, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { inr, lakhs } from '../lib/format.ts';

function SpendModal({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ source: 'Meta Ads', campaign: '', spend_date: new Date().toISOString().slice(0, 10), amount_inr: '' });
  const { busy, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post('/ad-spend', { ...f, amount_inr: Number(f.amount_inr) }), 'Spend recorded')) onClose();
  };
  return (
    <Modal title="Record ad spend" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <SelectField label="Source" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>{SOURCES.map((s) => <option key={s}>{s}</option>)}</SelectField>
        <TextField label="Campaign (optional)" value={f.campaign} onChange={(e) => setF({ ...f, campaign: e.target.value })} />
        <TextField label="Date" type="date" required value={f.spend_date} onChange={(e) => setF({ ...f, spend_date: e.target.value })} />
        <TextField label="Amount (₹)" type="number" min="1" required value={f.amount_inr} onChange={(e) => setF({ ...f, amount_inr: e.target.value })} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

export default function Reports() {
  const { can } = useAuth();
  const [days, setDays] = useState('30');
  const [spending, setSpending] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const ai = useAction();
  const { aiEnabled, can: allowed } = useAuth();
  const { f, set, clear, activeCount } = useFilters(['date', 'from', 'to', 'project', 'owner', 'source'] as const, { defaults: { date: 'last_30' } });
  const { data: projects } = useApi('/projects');
  const { data: directory } = useApi('/directory');
  const query = new URLSearchParams();
  const bounds = dateBounds(f.date, f.from, f.to);
  const spanDays = bounds.from ? Math.max(1, Math.ceil((new Date(bounds.to ?? Date.now()).getTime() - new Date(bounds.from).getTime()) / 86400000)) : 365;
  query.set('days', String(spanDays));
  if (bounds.from) query.set('created_from', bounds.from);
  if (bounds.to) query.set('created_to', bounds.to);
  for (const k of ['project', 'owner', 'source'] as const) if (f[k]) query.set(k, f[k]);
  const { data, error, loading, reload } = useApi(`/reports?${query}`, ['leads']);
  if (loading && !data) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;
  return (
    <Page>
      <PageHeader title="Reports" subtitle="See what brings bookings, and where leads drop off" actions={<>
        <a href={`/api/reports/export?format=xlsx&${query}`}><Button><Download size={15} />Excel</Button></a>
        <a href={`/api/reports/export?format=pdf&${query}`}><Button><Download size={15} />PDF</Button></a>
        {can('campaign.create') && data.canSeeSpend && <Button onClick={() => setSpending(true)}>Record ad spend</Button>}
      </>} />
      <FilterBar activeCount={activeCount} onClear={clear}>
        <DatePill label="Period" preset={f.date} from={f.from} to={f.to} onChange={(date, from, to) => set({ date, from, to })} />
        <FilterPill label="Project" value={f.project} options={projects?.projects.map((p: any) => ({ value: String(p.id), label: p.name })) ?? []} onChange={(project) => set({ project })} />
        <FilterPill label="Assigned to" value={f.owner} options={directory?.users.filter((u: any) => ['sales', 'telecaller'].includes(u.role)).map((u: any) => ({ value: String(u.id), label: u.name })) ?? []} onChange={(owner) => set({ owner })} />
        <FilterPill label="Source" value={f.source} options={toOptions(SOURCES)} onChange={(source) => set({ source })} />
      </FilterBar>
      {aiEnabled && allowed('ai.use') && (
        <Card className="mb-4 p-4">
          <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); const r = await ai.run(() => api.post('/ai/ask', { question, days: spanDays })); if (r) setAnswer(r.answer); }}>
            <Input aria-label="Ask about these reports" placeholder="Ask a question, e.g. Which source gave the most bookings?" value={question} onChange={(e) => setQuestion(e.target.value)} />
            <Button type="submit" variant="primary" busy={ai.busy} disabled={question.trim().length < 5}><Sparkles size={15} />Ask</Button>
          </form>
          {answer && <p className="mt-3 text-sm whitespace-pre-line">{answer}</p>}
        </Card>
      )}
      {data.collections.scheduled > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-3">
          <Stat label="Scheduled payments" value={lakhs(data.collections.scheduled)} />
          <Stat label="Collected" value={lakhs(data.collections.collected)} />
          <Stat label="Overdue" value={lakhs(data.collections.overdue)} tone={data.collections.overdue ? 'alert' : undefined} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader title="Sales funnel" hint="Leads now in each stage" /><Funnel rows={data.funnel} /></Card>
        <Card><CardHeader title="Why leads were lost" /><BarList rows={data.lost} emptyTitle="No lost leads recorded" /></Card>

        <Card className="lg:col-span-3">
          <CardHeader title="Performance by source" hint="Leads created in this period" />
          {!data.sources.length ? <Empty title="No leads in this period" /> : (
            <div className="overflow-x-auto pb-1">
              <table className="w-full min-w-[36rem] text-sm">
                <thead><tr className="border-b border-line text-left text-[13px] text-muted">
                  <th className="px-4 py-2 font-medium">Source</th>
                  {['Leads', 'Qualified', 'Visited', 'Booked'].map((h) => <th key={h} className="px-3 py-2 text-right font-medium">{h}</th>)}
                  {data.canSeeSpend && <><th className="px-3 py-2 text-right font-medium">Spend</th><th className="px-4 py-2 text-right font-medium">Cost per lead</th></>}
                </tr></thead>
                <tbody className="divide-y divide-line">
                  {data.sources.map((s: any) => (
                    <tr key={s.source}>
                      <td className="px-4 py-2 font-medium text-ink">{s.source}</td>
                      {[s.leads, s.qualified, s.visits, s.booked].map((v, i) => <td key={i} className="px-3 py-2 text-right tabular-nums">{v}</td>)}
                      {data.canSeeSpend && <><td className="px-3 py-2 text-right tabular-nums">{s.spend ? inr(s.spend) : '—'}</td><td className="px-4 py-2 text-right tabular-nums">{inr(s.cpl)}</td></>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {!!data.projects.length && (
          <Card className="lg:col-span-3">
            <CardHeader title="Project comparison" hint="Leads created in this period" />
            <div className="overflow-x-auto pb-1">
              <table className="w-full min-w-[32rem] text-sm">
                <thead><tr className="border-b border-line text-left text-[13px] text-muted"><th className="px-4 py-2 font-medium">Project</th>{['Leads', 'Hot', 'Booked', 'Revenue'].map((h) => <th key={h} className="px-3 py-2 text-right font-medium">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-line">{data.projects.map((p: any) => (
                  <tr key={p.project}><td className="px-4 py-2 font-medium text-ink">{p.project}</td><td className="px-3 py-2 text-right tabular-nums">{p.leads}</td><td className="px-3 py-2 text-right tabular-nums">{p.hot}</td><td className="px-3 py-2 text-right tabular-nums">{p.booked}</td><td className="px-3 py-2 text-right tabular-nums">{lakhs(p.revenue_lakhs)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </Card>
        )}

        {!!data.team.length && (
          <Card className="lg:col-span-3">
            <CardHeader title="Team performance" hint="Calls, response time and results" />
            <div className="overflow-x-auto pb-1">
              <table className="w-full min-w-[40rem] text-sm">
                <thead><tr className="border-b border-line text-left text-[13px] text-muted">
                  <th className="px-4 py-2 font-medium">Name</th>
                  {['Leads', 'Calls', 'Connected', 'First response', 'Visits', 'Booked'].map((h) => <th key={h} className="px-3 py-2 text-right font-medium">{h}</th>)}
                </tr></thead>
                <tbody className="divide-y divide-line">
                  {data.team.map((u: any) => (
                    <tr key={u.id}>
                      <td className="px-4 py-2"><span className="font-medium text-ink">{u.name}</span><span className="ml-2 text-xs text-muted">{ROLE_LABELS[u.role as keyof typeof ROLE_LABELS]}</span></td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.leads}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.calls}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.calls ? `${Math.round((u.connected / u.calls) * 100)}%` : '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.avg_response_minutes === null ? '—' : `${u.avg_response_minutes} min`}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{u.visits}</td>
                      <td className="px-3 py-2 text-right font-medium text-ink tabular-nums">{u.booked}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
      {spending && <SpendModal onClose={() => { setSpending(false); void reload(); }} />}
    </Page>
  );
}
