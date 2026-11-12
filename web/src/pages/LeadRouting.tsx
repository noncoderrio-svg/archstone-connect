import { Plus, RefreshCw, Shuffle, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { SOURCES } from '../../../shared/domain.ts';
import { CountTabs, FilterBar, FilterPill, SearchBox, filterRows, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, IconButton, Modal, Notice, PageHeader, SelectField, Spinner, TextField, cx, useAction, useToast } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { dateTime, timeAgo } from '../lib/format.ts';

const BLANK = { name: '', enabled: true, priority: 100, match_source: '', match_campaign: '', match_adset: '', match_ad: '', match_form: '', project_id: '', user_ids: [] as number[], mode: 'round_robin' };

function RuleForm({ rule, onClose }: { rule: any; onClose: () => void }) {
  const [f, setF] = useState({ ...BLANK, ...rule, project_id: rule.project_id ?? '' });
  const { data: d } = useApi('/directory');
  const { data: p } = useApi('/projects');
  const { busy, run } = useAction();
  const set = (k: string, v: unknown) => setF((s: any) => ({ ...s, [k]: v }));
  const staff = d?.users.filter((u: any) => ['telecaller', 'sales', 'team_leader', 'site_head', 'sales_manager'].includes(u.role)) ?? [];
  const flip = (id: number) => set('user_ids', f.user_ids.includes(id) ? f.user_ids.filter((x: number) => x !== id) : [...f.user_ids, id]);
  const save = async () => {
    const body = { ...f, project_id: f.project_id ? Number(f.project_id) : null, priority: Number(f.priority) };
    if (await run(() => (f.id ? api.put(`/routing/rules/${f.id}`, body) : api.post('/routing/rules', body)), 'Rule saved')) onClose();
  };
  return (
    <Modal title={f.id ? 'Edit mapping' : 'New campaign mapping'} onClose={onClose} wide>
      <div className="space-y-3">
        <TextField label="Mapping name" required placeholder="e.g. 44 West campaigns" value={f.name} onChange={(e) => set('name', e.target.value)} />
        <p className="text-[13px] text-muted">A lead matches if its name contains the words below. Fill in only what you need, and capital letters don't matter.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Campaign contains" placeholder="e.g. 44 West" value={f.match_campaign} onChange={(e) => set('match_campaign', e.target.value)} />
          <TextField label="Ad set contains" value={f.match_adset} onChange={(e) => set('match_adset', e.target.value)} />
          <TextField label="Ad contains" value={f.match_ad} onChange={(e) => set('match_ad', e.target.value)} />
          <TextField label="Form contains" value={f.match_form} onChange={(e) => set('match_form', e.target.value)} />
          <SelectField label="Source" value={f.match_source} onChange={(e) => set('match_source', e.target.value)}>
            <option value="">Any source</option>{SOURCES.map((s) => <option key={s}>{s}</option>)}
          </SelectField>
          <SelectField label="Set project to" value={f.project_id} onChange={(e) => set('project_id', e.target.value)}>
            <option value="">Leave as it is</option>{p?.projects.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </SelectField>
        </div>
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium">Assign to</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {staff.map((u: any) => (
              <label key={u.id} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--brand)]" checked={f.user_ids.includes(u.id)} onChange={() => flip(u.id)} />{u.name}</label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="How to share" value={f.mode} onChange={(e) => set('mode', e.target.value)}>
            <option value="round_robin">Take turns</option><option value="workload">Fewest open leads first</option>
          </SelectField>
          <TextField label="Order" type="number" min={0} hint="Lower numbers are checked first." value={f.priority} onChange={(e) => set('priority', e.target.value)} />
        </div>
        <div className="flex justify-end gap-2 pt-1"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={f.name.trim().length < 3 || !f.user_ids.length} onClick={save}>Save mapping</Button></div>
      </div>
    </Modal>
  );
}

function Campaigns({ data, onMap }: { data: any; onMap: (name: string) => void }) {
  const { f, set, clear, activeCount } = useFilters(['q', 'mapped', 'source'] as const);
  const rows = filterRows<any>(data.campaigns, f, {
    search: (c) => [c.campaign, c.rule],
    match: { source: (c) => c.source },
    test: (c) => !f.mapped || (f.mapped === 'yes' ? Boolean(c.rule) : !c.rule),
  });
  const missing = data.campaigns.filter((c: any) => !c.rule).length;
  return (
    <>
      {!!missing && <div className="mb-3"><Notice>{missing} recent {missing === 1 ? 'campaign has' : 'campaigns have'} no mapping, so those leads use the default routing.</Notice></div>}
      <FilterBar search={<SearchBox placeholder="Search campaigns" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={rows.length} total={data.campaigns.length} noun="campaigns">
        <FilterPill label="Mapping" value={f.mapped} options={[{ value: 'yes', label: 'Mapped' }, { value: 'no', label: 'Not mapped' }]} onChange={(mapped) => set({ mapped })} />
        <FilterPill label="Source" value={f.source} options={[...new Set<string>(data.campaigns.map((c: any) => c.source))].map((value) => ({ value, label: value }))} onChange={(source) => set({ source })} />
      </FilterBar>
      <Card>
        {!rows.length && <Empty title="No campaigns in the last 30 days">They appear here as soon as leads arrive.</Empty>}
        <ul className="divide-y divide-line">
          {rows.map((c: any) => (
            <li key={c.campaign + c.source} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-48 flex-1">
                <p className="font-medium break-words text-ink">{c.campaign}</p>
                <p className="text-[13px] text-muted">{c.source} · last lead {timeAgo(c.last_at)}</p>
                {!!c.people.length && <p className="text-[13px] text-muted">{c.people.map((p: any) => `${p.name} ${p.leads}`).join(' · ')}</p>}
              </div>
              <dl className="flex gap-4 text-sm">
                {[['Leads', c.leads], ['Waiting', c.unassigned], ['Visits', c.visits], ['Booked', c.booked]].map(([k, v]) => (
                  <div key={String(k)}><dt className="text-xs text-muted">{k}</dt><dd className="font-medium text-ink tabular-nums">{v}</dd></div>
                ))}
              </dl>
              {c.rule ? <Badge tone="green">{c.rule}</Badge> : <Button size="sm" variant="primary" onClick={() => onMap(c.campaign)}>Map campaign</Button>}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function Rules({ data, onEdit, reload }: { data: any; onEdit: (r: any) => void; reload: () => void }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const remove = async (r: any) => { if (confirm(`Delete the mapping "${r.name}"?`)) { await run(() => api.del(`/routing/rules/${r.id}`), 'Mapping deleted'); reload(); } };
  const flip = async (r: any) => { await run(() => api.put(`/routing/rules/${r.id}`, { ...r, enabled: !r.enabled })); reload(); };
  const apply = async () => {
    const r = await run(() => api.post('/routing/apply'));
    if (r) { toast(`${r.assigned} leads assigned${r.waiting ? `, ${r.waiting} have no matching rule` : ''}`); reload(); }
  };
  return (
    <>
      {!!data.unassigned && (
        <Card className="mb-3 flex flex-wrap items-center gap-3 p-4">
          <p className="min-w-48 flex-1 text-sm text-ink">{data.unassigned} {data.unassigned === 1 ? 'lead is' : 'leads are'} waiting without anyone assigned.</p>
          <Button busy={busy} onClick={apply}><Shuffle size={15} />Apply mappings now</Button>
        </Card>
      )}
      <Card>
        {!data.rules.length && <Empty title="No mappings yet">Map a campaign to the people who should work its leads.</Empty>}
        <ul className="divide-y divide-line">
          {data.rules.map((r: any) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <div className="min-w-48 flex-1">
                <p className="font-medium text-ink">{r.name}</p>
                <p className="text-[13px] text-muted">{[r.match_source, r.match_campaign && `Campaign: ${r.match_campaign}`, r.match_adset && `Ad set: ${r.match_adset}`, r.match_ad && `Ad: ${r.match_ad}`, r.match_form && `Form: ${r.match_form}`].filter(Boolean).join(' · ')}</p>
                <p className="text-[13px] text-muted">{r.mode === 'workload' ? 'Fewest open leads' : 'Takes turns'}: {r.people.join(', ')}</p>
              </div>
              <Badge tone={r.enabled ? 'green' : 'neutral'}>{r.enabled ? 'On' : 'Off'}</Badge>
              <span className="flex gap-1.5">
                <Button size="sm" onClick={() => flip(r)}>{r.enabled ? 'Turn off' : 'Turn on'}</Button>
                <Button size="sm" onClick={() => onEdit(r)}>Edit</Button>
                <IconButton label="Delete mapping" className="size-8" onClick={() => remove(r)}><Trash2 size={15} /></IconButton>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function MetaPages({ data, reload }: { data: any; reload: () => void }) {
  const [f, setF] = useState({ page_id: '', token: '' });
  const { busy, run } = useAction();
  const add = async () => {
    if (await run(() => api.post('/meta-pages', f), 'Page connected')) { setF({ page_id: '', token: '' }); reload(); }
  };
  const sync = async (id: number) => {
    const r = await run(() => api.post(`/meta-pages/${id}/sync`));
    if (r) reload();
  };
  const remove = async (p: any) => { if (confirm(`Disconnect ${p.name}?`)) { await run(() => api.del(`/meta-pages/${p.id}`), 'Page disconnected'); reload(); } };
  return (
    <div className="space-y-3">
      {!data.webhook_ready && <Notice>Instant delivery is off until the verify token and Meta app secret are added under Settings, Integrations, WhatsApp replies webhook. The 15-minute pull still works once a page is connected.</Notice>}
      <Card>
        <CardHeader title="Connected Facebook pages" hint="Leads arrive instantly. A pull every 15 minutes catches anything missed." />
        {!data.pages.length && <Empty title="No pages connected" />}
        <ul className="divide-y divide-line">
          {data.pages.map((p: any) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <div className="min-w-48 flex-1">
                <p className="font-medium text-ink">{p.name}</p>
                <p className="text-[13px] text-muted">{p.last_sync_at ? `Last pull ${dateTime(p.last_sync_at)}` : 'Not pulled yet'} · {p.leads_pulled} recovered</p>
                {p.last_error && <p className="text-[13px] text-red-700 dark:text-red-400">{p.last_error}</p>}
              </div>
              <span className="flex gap-1.5">
                <Button size="sm" busy={busy} onClick={() => sync(p.id)}><RefreshCw size={14} />Pull now</Button>
                <IconButton label="Disconnect page" className="size-8" onClick={() => remove(p)}><Trash2 size={15} /></IconButton>
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-4">
        <h2 className="text-[15px] font-semibold">Connect a page</h2>
        <p className="mb-3 text-[13px] text-muted">Your access token is stored encrypted and is never shown again.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Facebook Page ID" inputMode="numeric" value={f.page_id} onChange={(e) => setF({ ...f, page_id: e.target.value })} />
          <TextField label="Page access token" type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />
        </div>
        <Button className="mt-3" variant="primary" busy={busy} disabled={!f.page_id || f.token.length < 20} onClick={add}>Connect page</Button>
        <p className="mt-3 text-[13px] break-all text-muted">Webhook address for Meta: {data.webhook_url}</p>
      </Card>
    </div>
  );
}

function Feedback() {
  const { data, reload } = useApi('/routing/feedback', ['leads']);
  const [f, setF] = useState<any>(null);
  const [token, setToken] = useState('');
  const { busy, run } = useAction();
  const toast = useToast();
  if (!data) return <Spinner />;
  const s = f ?? data.settings;
  const set = (patch: object) => setF({ ...s, ...patch });
  const stats = data.stats;
  const save = async () => {
    const { has_token: _unused, ...body } = s;
    if (await run(() => api.put('/routing/feedback', { ...body, token: token || undefined }), 'Meta feedback saved')) { setToken(''); setF(null); void reload(); }
  };
  const send = async () => {
    const r = await run(() => api.post('/routing/feedback/send'));
    if (r) { toast(`${r.sent} sent${r.failed ? `, ${r.failed} failed` : ''}`, Boolean(r.failed)); void reload(); }
  };
  const checks: [string, string, boolean | null][] = [
    ['Meta leads, last 30 days', `${stats.leads_30_days} (Meta asks for 200 or more)`, stats.leads_30_days ? stats.leads_30_days >= 200 : null],
    ['Leads with outcomes sent', `${stats.coverage ?? 0}% (Meta suggests 60% or more)`, stats.coverage == null ? null : stats.coverage >= 60],
    [`Leads reaching ${s.target}`, `${stats.target_rate ?? 0}% (Meta asks for 1% to 40%)`, stats.target_rate == null ? null : stats.target_rate >= 1 && stats.target_rate <= 40],
  ];
  return (
    <div className="max-w-3xl space-y-3">
      <Notice>Sends what happened to each Meta lead back to Meta, so it can find more real buyers. Nothing is sent until this is turned on.</Notice>
      <Card>
        <CardHeader title="Health" hint={stats.last_sent_at ? `Last sent ${dateTime(stats.last_sent_at)}` : 'Nothing sent yet'} action={<Badge tone={data.settings.enabled ? 'green' : 'neutral'}>{data.settings.enabled ? 'On' : 'Off'}</Badge>} />
        <ul className="divide-y divide-line">
          {checks.map(([label, value, ok]) => (
            <li key={label} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
              <span className="text-ink">{label}</span>
              <span className="flex items-center gap-2 text-muted">{value}{ok !== null && <Badge tone={ok ? 'green' : 'amber'}>{ok ? 'Good' : 'Below'}</Badge>}</span>
            </li>
          ))}
          <li className="px-4 py-2 text-[13px] text-muted">{stats.sent} sent · {stats.pending} waiting · {stats.failed} failed · {stats.expired} too old</li>
        </ul>
        {stats.last_error && <div className="px-4 pb-3"><ErrorNote>{stats.last_error}</ErrorNote></div>}
        {data.settings.enabled && <div className="px-4 pb-4"><Button busy={busy} onClick={send}><RefreshCw size={15} />Send now</Button></div>}
      </Card>
      <Card className="space-y-3 p-4">
        <h2 className="text-[15px] font-semibold">Connection</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Meta Dataset ID" inputMode="numeric" value={s.dataset_id} onChange={(e) => set({ dataset_id: e.target.value })} />
          <TextField label="Conversions API access token" type="password" autoComplete="off" hint={data.settings.has_token ? 'Saved. Leave blank to keep it.' : 'Stored encrypted.'} value={token} onChange={(e) => setToken(e.target.value)} />
          <TextField label="Test event code (optional)" hint="From Meta's Test Events tab. Clear it when you go live." value={s.test_event_code} onChange={(e) => set({ test_event_code: e.target.value })} />
          <SelectField label="Main quality stage" hint="Choose one reached within 28 days." value={s.target} onChange={(e) => set({ target: e.target.value })}>
            {data.funnel.filter((x: string) => !['Unqualified', 'Lost'].includes(x)).map((x: string) => <option key={x}>{x}</option>)}
          </SelectField>
        </div>
        <h3 className="pt-1 text-sm font-semibold">What Meta is told</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {data.funnel.map((stage: string) => (
            <TextField key={stage} label={stage} hint={s.mapping[stage] ? undefined : 'Blank means this stage is not sent.'} value={s.mapping[stage] ?? ''} onChange={(e) => set({ mapping: { ...s.mapping, [stage]: e.target.value } })} />
          ))}
        </div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-[var(--brand)]" checked={s.privacy_confirmed} onChange={(e) => set({ privacy_confirmed: e.target.checked })} />Our privacy notice says we share lead outcomes with Meta. Phone numbers and emails are sent only as unreadable hashes.</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--brand)]" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Send lead outcomes to Meta automatically</label>
        <Button variant="primary" busy={busy} onClick={save}>Save</Button>
      </Card>
    </div>
  );
}

export default function LeadRouting() {
  const { data, error, loading, reload } = useApi('/routing', ['leads']);
  const [tab, setTab] = useState('campaigns');
  const [editing, setEditing] = useState<any>(null);
  if (error) return <Page><ErrorNote>{error}</ErrorNote></Page>;
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const close = () => { setEditing(null); void reload(); };
  return (
    <Page>
      <PageHeader title="Lead Routing" subtitle="Which campaign goes to which people, automatically"
        actions={<Button variant="primary" onClick={() => setEditing(BLANK)}><Plus size={16} />New mapping</Button>} />
      <CountTabs label="Lead routing section" value={tab} onChange={setTab} tabs={[
        { value: 'campaigns', label: 'Campaigns', count: data.campaigns.length },
        { value: 'rules', label: 'Mappings', count: data.rules.length },
        { value: 'meta', label: 'Meta pages', count: data.pages.length },
        { value: 'feedback', label: 'Meta feedback' },
      ]} />
      <div className={cx(tab !== 'campaigns' && 'hidden')}><Campaigns data={data} onMap={(name) => setEditing({ ...BLANK, name, match_campaign: name })} /></div>
      {tab === 'rules' && <Rules data={data} onEdit={setEditing} reload={reload} />}
      {tab === 'meta' && <MetaPages data={data} reload={reload} />}
      {tab === 'feedback' && <Feedback />}
      {editing && <RuleForm rule={editing} onClose={close} />}
    </Page>
  );
}
