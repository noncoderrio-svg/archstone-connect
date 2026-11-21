import { Bot, Check, CircleAlert, Play, Plus, RefreshCw, Send, ShieldCheck, Trash2, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, Modal, Notice, PageHeader, SelectField, Spinner, Stat, TextField, TextareaField, cx, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { ago, dateTime, inr } from '../lib/format.ts';

const TABS = [['team', 'Team'], ['briefs', 'Campaign briefs'], ['approvals', 'Approvals'], ['results', 'Results'], ['reports', 'Reports'], ['knowledge', 'Knowledge']] as const;
type Tab = (typeof TABS)[number][0];

const Simulated = () => <Badge tone="amber">Simulated</Badge>;
const BRAIN: Record<string, string> = { claude: 'Claude', gemini: 'Gemini', simulated: 'Sample answers', rules: 'Fixed rules', none: 'Not connected' };
const KIND: Record<string, string> = { create_paused: 'Create in Meta, paused', activate: 'Switch campaign on', pause: 'Pause campaign', budget: 'Change budget', advice: 'Suggestion' };
const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'neutral' | 'brand'> = { planned: 'green', planning: 'brand', blocked: 'red', failed: 'red', draft: 'neutral', pending: 'amber', done: 'green', rejected: 'neutral', running: 'brand', live: 'green', paused: 'amber', in_meta_paused: 'amber' };
const label = (s: string) => ({ in_meta_paused: 'In Meta, paused' } as Record<string, string>)[s] ?? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ');

const Bullets = ({ items }: { items?: string[] }) => (items?.length ? <ul className="list-disc space-y-0.5 pl-5">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="text-muted">None.</p>);
const Block = ({ title, children }: { title: string; children: ReactNode }) => <div><p className="mb-0.5 text-[13px] font-medium text-muted">{title}</p><div className="text-sm">{children}</div></div>;

// ---------- Team ----------
function Team() {
  const { data, error, reload } = useApi('/marketing/team', ['marketing']);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ answer: string; missing: string[] } | null>(null);
  const [check, setCheck] = useState<any>(null);
  const askAction = useAction();
  const checkAction = useAction();
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  const c = data.connections;
  const line = (ok: boolean, name: string, off: string) => <li className="flex items-center gap-2">{ok ? <Check size={15} className="text-emerald-600" /> : <CircleAlert size={15} className="text-amber-600" />}<span className="font-medium text-ink">{name}</span><span className="text-muted">{ok ? 'Connected' : off}</span></li>;
  return (
    <div className="space-y-4">
      {!c.claude && !c.gemini && <Notice>No AI key is connected, so the team shows sample answers marked “Simulated”. Add a Claude or Gemini key in Settings, Integrations to get real work.</Notice>}
      <Card className="p-4">
        <form className="flex gap-2" onSubmit={async (e: FormEvent) => { e.preventDefault(); const r = await askAction.run(() => api.post('/marketing/ask', { question })); if (r) setAnswer(r); }}>
          <Input aria-label="Ask the Marketing Director" placeholder="Ask the Marketing Director, e.g. Which campaign is wasting money?" value={question} onChange={(e) => setQuestion(e.target.value)} />
          <Button type="submit" variant="primary" busy={askAction.busy} disabled={question.trim().length < 5}><Send size={15} />Ask</Button>
        </form>
        {answer && <div className="mt-3 text-sm"><p className="whitespace-pre-line">{answer.answer}</p>{!!answer.missing.length && <p className="mt-1 text-muted">Missing: {answer.missing.join('; ')}</p>}</div>}
      </Card>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data.agents.map((a: any, i: number) => (
          <Card key={a.key} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium text-ink"><span className="mr-1.5 text-muted">{i + 1}.</span>{a.name}</p>
              <Bot size={17} className="shrink-0 text-muted" />
            </div>
            <p className="mt-1 min-h-[3.75rem] text-[13px] text-body">{a.job}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge tone={a.uses === 'none' ? 'red' : a.uses === 'simulated' ? 'amber' : 'brand'}>{BRAIN[a.uses]}</Badge>
              {a.last?.status === 'failed' && <Badge tone="red">Last run failed</Badge>}
            </div>
            <p className="mt-1.5 text-xs text-muted" title={a.last?.error || undefined}>{a.last ? `Worked ${a.runs} time${a.runs === 1 ? '' : 's'}, last ${ago(a.last.created_at)}` : 'Has not worked yet'}</p>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader title="What is connected" hint="Set these up in Settings, Integrations" action={c.meta_ads ? <Button size="sm" busy={checkAction.busy} onClick={async () => { const r = await checkAction.run(() => api.post('/marketing/check-meta')); if (r) setCheck(r); void reload(); }}><ShieldCheck size={15} />Test Meta safely</Button> : undefined} />
        <ul className="space-y-1.5 px-4 pb-4 text-sm">
          {line(c.claude, 'Claude', 'Optional. Plans and writes.')}
          {line(c.gemini, 'Gemini', 'Researches and analyses.')}
          {line(c.meta_ads, 'Meta Ads Manager', c.demo ? 'Not connected. Campaigns and results are simulated.' : 'Not connected.')}
          {line(c.meta_leads, 'Meta lead forms', 'Add your page in Lead Routing.')}
          {line(c.n8n, 'n8n automation', 'Optional. The CRM already runs its own schedule.')}
        </ul>
        {check && <div className="border-t border-line px-4 py-3 text-sm">
          <p><span className="font-medium text-ink">{check.account}</span> · {check.active ? 'Active' : 'Not active'} · {check.currency} · {check.timezone}</p>
          {check.missing.length ? <p className="text-red-700 dark:text-red-400">Missing permissions: {check.missing.join(', ')}</p> : <p className="text-muted">{check.permissions.length ? 'The token has the permissions it needs.' : 'Meta did not list this token’s permissions.'}</p>}
          {!check.page_set && <p className="text-amber-700 dark:text-amber-300">Add your Facebook Page ID before creating campaigns.</p>}
        </div>}
      </Card>
    </div>
  );
}

// ---------- Briefs ----------
function NewBrief({ projects, onClose }: { projects: any[]; onClose: (id?: number) => void }) {
  const [f, setF] = useState({ project_id: String(projects[0]?.id ?? ''), title: '', goal: '', budget_inr: '', days: '14', notes: '' });
  const { busy, run } = useAction();
  const chosen = projects.find((p) => String(p.id) === f.project_id);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const made = await run(() => api.post('/marketing/briefs', { ...f, project_id: Number(f.project_id), budget_inr: Number(f.budget_inr), days: Number(f.days) }));
    if (!made) return;
    await run(() => api.post(`/marketing/briefs/${made.id}/plan`), 'The team has started');
    onClose(made.id);
  };
  return (
    <Modal title="New campaign brief" onClose={() => onClose()}>
      <form onSubmit={submit} className="space-y-3">
        <SelectField label="Project" value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}, {p.location}</option>)}</SelectField>
        {chosen && !chosen.has_rera && <Notice>This project has no MahaRERA number yet, so the team can draft but the campaign will be blocked. Add the number under Projects.</Notice>}
        <TextField label="Campaign name" required minLength={3} maxLength={80} placeholder="December site visits" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <TextField label="Goal" maxLength={300} placeholder="Qualified leads who book a site visit" value={f.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Total budget (₹)" type="number" min="1000" required hint="The team may divide this, never raise it." value={f.budget_inr} onChange={(e) => setF({ ...f, budget_inr: e.target.value })} />
          <TextField label="Days" type="number" min="3" max="90" required value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />
        </div>
        <TextareaField label="Verified facts and notes" maxLength={2000} hint="Possession date, amenities, offers. The team uses only what is written here and on the project." value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        <div className="flex justify-end gap-2"><Button onClick={() => onClose()}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Start the team</Button></div>
      </form>
    </Modal>
  );
}

function AgentWork({ w }: { w: any }) {
  const o = w.output;
  const head = { director: 'Marketing Director', audience: 'Audience Research', strategist: 'Meta Ads Strategist', creative: 'Creative', builder: 'Campaign Builder' }[w.agent as string] ?? w.agent;
  return (
    <Card>
      <CardHeader title={head} hint={w.status === 'failed' ? undefined : BRAIN[w.provider] ?? w.provider} action={w.simulated ? <Simulated /> : undefined} />
      <div className="space-y-3 px-4 pb-4">
        {w.status === 'failed' && <ErrorNote>{w.error}</ErrorNote>}
        {w.status === 'ok' && w.agent === 'director' && <>
          <p className="text-sm">{o.summary}</p>
          <Block title="Positioning">{o.positioning}</Block>
          <Block title="Key messages"><Bullets items={o.key_messages} /></Block>
          <Block title="Funnel">{o.funnel}</Block>
          <Block title="Budget split"><Bullets items={o.budget_split?.map((b: any) => `${b.name}: ${b.percent}%. ${b.why}`)} /></Block>
          <Block title="Estimate">About {o.expected_leads} leads at around {inr(o.target_cpl_inr)} each. An estimate, not a promise.</Block>
          <Block title="Risks"><Bullets items={o.risks} /></Block>
          <Block title="Questions for you"><Bullets items={o.questions_for_owner} /></Block>
        </>}
        {w.status === 'ok' && w.agent === 'audience' && <>
          {o.personas?.map((p: any) => <Block key={p.name} title={p.name}>{p.description}<br /><span className="text-muted">Wants: {p.motivations?.join(', ')}. Worries: {p.objections?.join(', ')}.</span></Block>)}
          <Block title="Where">{o.center}, within {o.radius_km} km. Nearby: {o.nearby_areas?.join(', ')}</Block>
          <Block title="Interests">{o.interests?.join(', ')}</Block>
          <Block title="Compliance"><Bullets items={o.compliance_notes} /></Block>
        </>}
        {w.status === 'ok' && w.agent === 'strategist' && <>
          <Block title="Objective">{o.objective?.replace('OUTCOME_', '')} · {o.lead_method?.replace(/_/g, ' ')} · {o.placements?.replace(/_/g, ' ')}</Block>
          <Block title="Ad sets"><Bullets items={o.adsets?.map((s: any) => `${s.name}: ${s.share_percent}% of budget`)} /></Block>
          <Block title="Lead form questions"><Bullets items={o.form_questions} /></Block>
          <Block title="Why">{o.rationale}</Block>
        </>}
        {w.status === 'ok' && w.agent === 'creative' && <>
          <Block title="Hooks"><Bullets items={o.hooks} /></Block>
          <Block title={`Reel script: ${o.reel_script?.title} (${o.reel_script?.duration_seconds}s)`}><Bullets items={o.reel_script?.scenes?.map((s: any) => `${s.seconds}s · ${s.visual} · “${s.voiceover}” · Text: ${s.on_screen_text}`)} /></Block>
          <Block title="Video brief (for Adobe or your editor)">{o.video_brief}</Block>
          <Block title="Canva brief">{o.canva_brief?.format}. {o.canva_brief?.layout}. Colours: {o.canva_brief?.colours}. Image: {o.canva_brief?.image_direction}<Bullets items={o.canva_brief?.text_blocks} /></Block>
        </>}
        {w.status === 'ok' && w.agent === 'builder' && <p className="text-sm text-muted">Assembled the campaign below and ran {o.issues?.length ?? 0} checks.</p>}
      </div>
    </Card>
  );
}

function BriefView({ id, onBack }: { id: number; onBack: () => void }) {
  const { data, error } = useApi(`/marketing/briefs/${id}`, ['marketing']);
  const { busy, run } = useAction();
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  const { brief, plan } = data;
  const p = plan?.payload;
  const inMeta = plan && !['draft', 'blocked'].includes(plan.status);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onBack}>← All briefs</Button>
        <p className="font-medium text-ink">{brief.title}</p><span className="text-muted">{brief.project} · {inr(brief.budget_inr)} over {brief.days} days</span>
        <Badge tone={STATUS_TONE[brief.status]}>{label(brief.status)}</Badge>
        <span className="flex-1" />
        {!inMeta && brief.status !== 'planning' && <Button size="sm" busy={busy} onClick={() => run(() => api.post(`/marketing/briefs/${id}/plan`), 'The team has started')}><RefreshCw size={14} />{data.work.length ? 'Plan again' : 'Start the team'}</Button>}
      </div>
      {brief.status === 'planning' && <Card className="flex items-center gap-2 p-4 text-sm"><RefreshCw size={15} className="animate-spin text-brand" />{brief.stage || 'The team is working'}…</Card>}
      {brief.status === 'failed' && <ErrorNote>The team stopped: {brief.error}</ErrorNote>}
      {plan && (
        <Card>
          <CardHeader title={`Campaign draft: ${plan.name}`} hint={`${inr(p.daily_budget_inr)} a day for ${p.days} days · objective ${String(p.objective).replace('OUTCOME_', '')}`} action={<span className="flex gap-1.5">{plan.simulated && <Simulated />}<Badge tone={STATUS_TONE[plan.status]}>{label(plan.status)}</Badge></span>} />
          <div className="space-y-3 px-4 pb-4">
            {!!plan.issues.length && <ul className="space-y-1 text-sm">{plan.issues.map((i: any, n: number) => (
              <li key={n} className="flex gap-2"><Badge tone={i.level === 'blocked' ? 'red' : i.level === 'fixed' ? 'green' : 'amber'}>{i.level === 'blocked' ? 'Blocked' : i.level === 'fixed' ? 'Fixed' : 'Remember'}</Badge><span>{i.text}</span></li>
            ))}</ul>}
            <Block title="Ad sets"><Bullets items={p.adsets.map((s: any) => `${s.name}: ${inr(s.daily_budget_inr)} a day · ${s.targeting.center}, ${s.targeting.radius_km} km · everyone aged 18 to 65+ · ${s.targeting.interests.join(', ') || 'no interests'}`)} /></Block>
            <div className="grid gap-3 md:grid-cols-3">{p.ads.map((ad: any) => (
              <div key={ad.name} className="rounded-xl border border-line p-3 text-sm">
                <p className="text-xs text-muted">{ad.name} · {String(ad.cta).replace(/_/g, ' ').toLowerCase()}</p>
                <p className="mt-1 font-medium text-ink">{ad.headline}</p>
                <p className="mt-1 whitespace-pre-line">{ad.primary_text}</p>
                <p className="mt-1 text-muted">{ad.description}</p>
              </div>
            ))}</div>
            {plan.status === 'draft' && <p className="text-sm text-muted">Open the Approvals tab to create this in Meta as paused. Nothing is spent until you switch it on.</p>}
            {(plan.status === 'in_meta_paused' || plan.status === 'paused') && <Button variant="primary" busy={busy} onClick={() => run(() => api.post(`/marketing/plans/${plan.id}/switch`, { on: true }), 'Request added to Approvals')}><Play size={15} />Ask to switch on</Button>}
            {plan.status === 'live' && <Button busy={busy} onClick={() => run(() => api.post(`/marketing/plans/${plan.id}/switch`, { on: false }), 'Request added to Approvals')}>Ask to pause</Button>}
          </div>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">{data.work.filter((w: any) => w.agent !== 'builder').map((w: any) => <AgentWork key={w.agent} w={w} />)}</div>
    </div>
  );
}

function Briefs() {
  const [params, setParams] = useSearchParams();
  const open = Number(params.get('brief')) || 0;
  const show = (id?: number) => { const next = new URLSearchParams(params); if (id) next.set('brief', String(id)); else next.delete('brief'); setParams(next); };
  const { data, error, reload } = useApi('/marketing/briefs', ['marketing']);
  const [adding, setAdding] = useState(false);
  const { run } = useAction();
  if (open) return <BriefView id={open} onBack={() => show()} />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  return (
    <Card>
      <CardHeader title="Campaign briefs" hint="Give the team a project, a goal and a budget" action={<Button variant="primary" size="sm" onClick={() => setAdding(true)}><Plus size={15} />New brief</Button>} />
      {!data.briefs.length ? <Empty title="No briefs yet">Write one, and the team returns a strategy, audience, campaign structure and ads for your review.</Empty> : (
        <ul className="divide-y divide-line">{data.briefs.map((b: any) => (
          <li key={b.id} className="flex items-center gap-3 px-4 py-3">
            <button className="min-w-0 flex-1 text-left" onClick={() => show(b.id)}>
              <p className="truncate font-medium text-ink">{b.title}</p>
              <p className="truncate text-[13px] text-muted">{b.project} · {inr(b.budget_inr)} over {b.days} days · {ago(b.created_at)}</p>
            </button>
            <Badge tone={STATUS_TONE[b.status]}>{b.status === 'planning' ? b.stage || 'Working' : label(b.status)}</Badge>
            <button aria-label={`Delete ${b.title}`} className="text-muted hover:text-red-700" onClick={async () => { if (confirm(`Delete the brief “${b.title}”?`)) { await run(() => api.del(`/marketing/briefs/${b.id}`), 'Brief deleted'); void reload(); } }}><Trash2 size={16} /></button>
          </li>
        ))}</ul>
      )}
      {adding && <NewBrief projects={data.projects} onClose={(id) => { setAdding(false); if (id) show(id); }} />}
    </Card>
  );
}

// ---------- Approvals ----------
function Approvals() {
  const { data, error } = useApi('/marketing/actions', ['marketing']);
  const { busy, run } = useAction();
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  const waiting = data.actions.filter((a: any) => a.status === 'pending');
  const past = data.actions.filter((a: any) => a.status !== 'pending');
  const decide = (a: any, approve: boolean) => {
    if (approve && a.kind === 'activate' && !confirm(`Switch on “${a.campaign}”? Meta starts spending money. ${a.payload.cost ?? ''}`)) return;
    void run(() => api.post(`/marketing/actions/${a.id}`, { approve }), approve ? 'Done' : 'Rejected');
  };
  const row = (k: string, v?: string) => (v ? <p><span className="inline-block w-36 text-[12px] font-medium tracking-wide text-muted uppercase">{k}</span>{v}</p> : null);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Waiting for you" hint="The team cannot spend money or change a campaign without an approval here" />
        {!waiting.length ? <Empty title="Nothing is waiting" /> : <ul className="divide-y divide-line">{waiting.map((a: any) => (
          <li key={a.id} className="space-y-1 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><Badge tone={a.kind === 'activate' || a.kind === 'budget' ? 'red' : 'amber'}>{KIND[a.kind]}</Badge><span className="font-medium text-ink">{a.campaign}</span><span className="text-xs text-muted">from {a.source === 'person' ? 'a team member' : `the ${a.source} agent`} · {ago(a.created_at)}</span></div>
            {row('Action', a.reason)}{row('Data', a.payload.data)}{row('Expected result', a.payload.expected)}{row('Risk', a.payload.risk)}{row('Cost', a.payload.cost)}
            {data.can_approve ? <div className="flex gap-2 pt-1.5">
              <Button variant="primary" size="sm" busy={busy} onClick={() => decide(a, true)}><Check size={14} />{a.kind === 'advice' ? 'Noted' : 'Approve'}</Button>
              <Button size="sm" busy={busy} onClick={() => decide(a, false)}><X size={14} />Reject</Button>
            </div> : <p className="pt-1 text-muted">Waiting for someone who can approve.</p>}
          </li>
        ))}</ul>}
      </Card>
      {!!past.length && <Card>
        <CardHeader title="History" />
        <ul className="divide-y divide-line">{past.map((a: any) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
            <Badge tone={STATUS_TONE[a.status] ?? 'neutral'}>{label(a.status)}</Badge><span className="font-medium text-ink">{KIND[a.kind]}</span><span>{a.campaign}</span>
            <span className="text-muted">{a.result}</span><span className="ml-auto text-xs text-muted">{a.reviewer ?? ''} · {dateTime(a.reviewed_at)}</span>
          </li>
        ))}</ul>
      </Card>}
    </div>
  );
}

// ---------- Results ----------
function Results() {
  const [days, setDays] = useState('7');
  const { data, error } = useApi(`/marketing/performance?days=${days}`, ['marketing', 'leads']);
  const sync = useAction();
  const reviewing = useAction();
  const [found, setFound] = useState<any>(null);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  const t = data.totals;
  const cell = (v: ReactNode) => <td className="px-3 py-2 text-right tabular-nums">{v ?? '—'}</td>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Period" className="h-10 rounded-lg border border-line bg-surface px-3 text-sm" value={days} onChange={(e) => setDays(e.target.value)}><option value="1">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select>
        {data.simulated && <Simulated />}
        <span className="text-[13px] text-muted">{data.synced_at ? `Updated ${ago(data.synced_at)}` : 'Not updated yet'}</span>
        <span className="flex-1" />
        <Button busy={sync.busy} onClick={() => sync.run(() => api.post('/marketing/sync'), 'Results updated')}><RefreshCw size={15} />Update results</Button>
        <Button variant="primary" busy={reviewing.busy} disabled={!data.campaigns.length} onClick={async () => { const r = await reviewing.run(() => api.post('/marketing/review', { days: Number(days) })); if (r) setFound(r); }}><Bot size={15} />Ask the team to review</Button>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Spend" value={inr(t.spend)} /><Stat label="Leads" value={t.leads} /><Stat label="Cost per lead" value={inr(t.cpl)} />
        <Stat label="Qualified leads" value={t.qualified} hint="From your CRM" /><Stat label="Cost per qualified lead" value={inr(t.cost_per_qualified)} />
      </div>
      {found && <Card><CardHeader title="Performance Analyst" hint={`${found.proposed} suggestion${found.proposed === 1 ? '' : 's'} added to Approvals`} action={found.simulated ? <Simulated /> : undefined} />
        <div className="space-y-2 px-4 pb-4 text-sm"><p className="font-medium text-ink">{found.analysis.headline}</p>
          <Block title="Strong"><Bullets items={found.analysis.strong.map((s: any) => `${s.campaign}: ${s.why}`)} /></Block>
          <Block title="Weak"><Bullets items={found.analysis.weak.map((s: any) => `${s.campaign}: ${s.why}`)} /></Block>
          <Block title="Observations"><Bullets items={found.analysis.observations} /></Block></div></Card>}
      <Card>
        <CardHeader title="Campaigns" hint="Meta figures beside what your sales team made of the leads" />
        {!data.campaigns.length ? <Empty title="No results yet">Choose “Update results” to fetch them from Meta.</Empty> : (
          <div className="overflow-x-auto pb-1"><table className="w-full min-w-[60rem] text-sm">
            <thead><tr className="border-b border-line text-left text-[13px] text-muted"><th className="px-4 py-2 font-medium">Campaign</th>{['Spend', 'CPM', 'CTR', 'CPC', 'Leads', 'CPL', 'Qualified', 'Visits', 'Booked', 'Per qualified', 'Per booking'].map((h) => <th key={h} className="px-3 py-2 text-right font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">{data.campaigns.map((c: any) => (
              <tr key={c.campaign_id}><td className="px-4 py-2 font-medium text-ink">{c.campaign}</td>
                {cell(inr(c.spend))}{cell(inr(c.cpm))}{cell(c.ctr === null ? null : `${c.ctr}%`)}{cell(c.cpc === null ? null : `₹${c.cpc}`)}{cell(c.leads)}{cell(inr(c.cpl))}{cell(c.crm.qualified)}{cell(c.crm.visits)}{cell(c.crm.booked)}{cell(inr(c.cost_per_qualified))}{cell(inr(c.cost_per_booking))}</tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Hot leads, no follow-up" value={data.pipeline.hot_waiting} tone={data.pipeline.hot_waiting ? 'alert' : undefined} />
        <Stat label="Overdue follow-ups" value={data.pipeline.overdue_followups} tone={data.pipeline.overdue_followups ? 'alert' : undefined} />
        <Stat label="Unassigned leads" value={data.pipeline.unassigned} /><Stat label="Waiting for first call" value={data.pipeline.awaiting_first_response} /><Stat label="Site visits, next 7 days" value={data.pipeline.visits_next_7_days} />
      </div>
    </div>
  );
}

// ---------- Reports ----------
function Reports() {
  const { data, error } = useApi('/marketing/reports', ['marketing']);
  const { busy, run } = useAction();
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">{(['daily', 'weekly', 'monthly'] as const).map((p) => <Button key={p} busy={busy} onClick={() => run(() => api.post('/marketing/reports', { period: p }), 'Report ready')}><Plus size={15} />{label(p)} report</Button>)}</div>
      {!data.reports.length && <Card><Empty title="No reports yet">With Meta connected, the daily report is written each morning at 9, the weekly one on Monday and the monthly one on the 1st.</Empty></Card>}
      {data.reports.map((r: any) => (
        <Card key={r.id}>
          <CardHeader title={r.data.title} hint={`${r.from_day} to ${r.to_day} · ${dateTime(r.created_at)}`} action={r.simulated ? <Simulated /> : undefined} />
          <div className="grid gap-3 px-4 pb-4 md:grid-cols-2">
            <Block title="Status">{r.data.status}</Block>
            <Block title="Performance"><Bullets items={r.data.performance} /></Block>
            <Block title="Problems"><Bullets items={r.data.problems} /></Block>
            <Block title="Opportunities"><Bullets items={r.data.opportunities} /></Block>
            <Block title="Urgent"><Bullets items={r.data.urgent} /></Block>
            <Block title="Approval required"><Bullets items={r.data.approval_required?.map((a: any) => `${KIND[a.kind]}: ${a.campaign}`)} /></Block>
            <Block title="AI actions completed"><Bullets items={r.data.ai_actions?.map((a: any) => `${KIND[a.kind]}: ${a.campaign}. ${a.result}`)} /></Block>
            <Block title="Next priorities"><ol className="list-decimal space-y-0.5 pl-5">{r.data.next_priorities?.map((x: string, i: number) => <li key={i}>{x}</li>)}</ol></Block>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ---------- Knowledge ----------
function Knowledge() {
  const { data, error } = useApi('/marketing/knowledge');
  const [notes, setNotes] = useState<string | null>(null);
  const { busy, run } = useAction();
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Your company notes" hint="Verified facts every agent may use: developer record, standing offers, brand voice, things never to say" />
        <div className="space-y-3 px-4 pb-4">
          <TextareaField label="Notes" rows={8} maxLength={8000} placeholder={'Example:\nWe sell for developers; never call ourselves the builder.\nBank approvals: SBI, HDFC.\nTone: warm, no exclamation marks.'} value={notes ?? data.notes} onChange={(e) => setNotes(e.target.value)} />
          <Button variant="primary" busy={busy} disabled={notes === null} onClick={() => run(() => api.put('/marketing/knowledge', { notes: notes ?? '' }), 'Notes saved')}>Save</Button>
        </div>
      </Card>
      <Card>
        <CardHeader title="Built-in market knowledge" hint="Mumbai, Navi Mumbai, Thane and the wider region, plus proven lead generation practice. Used for thinking; ads state only your project facts." />
        <pre className="max-h-[32rem] overflow-y-auto px-4 pb-4 font-sans text-[13px] whitespace-pre-wrap text-body">{data.built_in}</pre>
      </Card>
    </div>
  );
}

export default function Marketing() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'team') as Tab;
  const { data } = useApi('/marketing/team', ['marketing']);
  return (
    <Page>
      <PageHeader title="Marketing AI" subtitle="Eight agents plan, write, analyse and report. You approve anything that reaches Meta or spends money." />
      <div className="scroll-thin mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {TABS.map(([key, name]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setParams(key === 'team' ? {} : { tab: key })}
            className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap', tab === key ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink')}>
            {name}{key === 'approvals' && !!data?.pending && <span className="ml-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-[11px] text-white">{data.pending}</span>}
          </button>
        ))}
      </div>
      {tab === 'team' && <Team />}{tab === 'briefs' && <Briefs />}{tab === 'approvals' && <Approvals />}{tab === 'results' && <Results />}{tab === 'reports' && <Reports />}{tab === 'knowledge' && <Knowledge />}
    </Page>
  );
}
