import { FileImage, Plus, RefreshCw, Send, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { SOURCES, STAGES } from '../../../shared/domain.ts';
import { DatePill, FilterBar, FilterPill, SearchBox, filterRows, optionsFrom, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import {
  Badge, Button, Card, Empty, ErrorNote, IconButton, Input, Modal, Notice, PageHeader, Select, SelectField, Spinner, TextField, TextareaField, cx, useAction, useToast,
} from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { dateTime, inr, localToUtc } from '../lib/format.ts';
import { useLabels } from '../components/Labels.tsx';
import { MediaPicker } from './Media.tsx';

const STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'green' | 'amber' | 'red' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending_approval: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Scheduled', tone: 'brand' },
  sending: { label: 'Sending', tone: 'brand' },
  sent: { label: 'Sent', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  blocked: { label: 'Blocked', tone: 'red' },
};

function Chips({ label, options, value, onChange }: { label: string; options: readonly string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset>
      <legend className="mb-1 text-[13px] font-medium">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = value.includes(o);
          return (
            <button key={o} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((v) => v !== o) : [...value, o])}
              className={cx('rounded-full border px-2.5 py-1 text-[13px]', on ? 'border-brand bg-brand-soft font-medium text-brand-ink' : 'border-line text-body hover:bg-surface-2')}>{o}</button>
          );
        })}
      </div>
    </fieldset>
  );
}

function CampaignBuilder({ onClose }: { onClose: () => void }) {
  const { can } = useAuth();
  const { data: t } = useApi('/templates', ['templates']);
  const { data: p } = useApi('/projects');
  const [f, setF] = useState({ name: '', template_id: '', project_id: '', when: '' });
  const [seg, setSeg] = useState({ stages: [] as string[], sources: [] as string[], temperature: [] as string[], labels: [] as string[], budget_min: '', budget_max: '', inactive_days: '' });
  const catalog = useLabels();
  const [preview, setPreview] = useState<any>(null);
  const { busy, run } = useAction();

  const templates = t?.templates.filter((x: any) => x.status === 'approved') ?? [];
  const template = templates.find((x: any) => String(x.id) === f.template_id);
  const project = p?.projects.find((x: any) => String(x.id) === f.project_id);

  const segment = {
    project_id: f.project_id ? Number(f.project_id) : null,
    stages: seg.stages,
    sources: seg.sources,
    temperature: seg.temperature,
    labels: seg.labels,
    budget_min: seg.budget_min ? Number(seg.budget_min) : null,
    budget_max: seg.budget_max ? Number(seg.budget_max) : null,
    inactive_days: seg.inactive_days ? Number(seg.inactive_days) : null,
  };
  const segmentKey = JSON.stringify([segment, f.template_id]);

  useEffect(() => {
    const timer = setTimeout(() => {
      api.post('/campaigns/preview', { segment, template_id: f.template_id ? Number(f.template_id) : null }).then(setPreview).catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentKey]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      name: f.name,
      template_id: Number(f.template_id),
      project_id: f.project_id ? Number(f.project_id) : null,
      segment,
      scheduled_at: f.when ? localToUtc(f.when) : null,
    };
    if (await run(() => api.post('/campaigns', body), can('campaign.direct') ? 'Broadcast started' : 'Broadcast sent for approval')) onClose();
  };

  return (
    <Modal title="New broadcast" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <TextField label="Broadcast name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Approved template" required value={f.template_id} onChange={(e) => setF({ ...f, template_id: e.target.value })}>
            <option value="">{templates.length ? 'Choose a template' : 'No approved templates yet'}</option>
            {templates.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </SelectField>
          <SelectField label="Project" value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
            <option value="">All projects</option>
            {p?.projects.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </SelectField>
        </div>
        {template && <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm whitespace-pre-line">{template.body}</p>}
        {project && !project.rera_number && <Notice>{project.name} has no MahaRERA number, so this campaign cannot be sent until one is added.</Notice>}
        <Chips label="Stage" options={STAGES} value={seg.stages} onChange={(v) => setSeg({ ...seg, stages: v })} />
        <Chips label="Lead score" options={['Hot', 'Warm', 'Cold']} value={seg.temperature} onChange={(v) => setSeg({ ...seg, temperature: v })} />
        <Chips label="Labels" options={catalog.map((l) => l.name)} value={seg.labels} onChange={(v) => setSeg({ ...seg, labels: v })} />
        <Chips label="Source" options={SOURCES} value={seg.sources} onChange={(v) => setSeg({ ...seg, sources: v })} />
        <div className="grid grid-cols-3 gap-3">
          <TextField label="Budget from (₹L)" type="number" value={seg.budget_min} onChange={(e) => setSeg({ ...seg, budget_min: e.target.value })} />
          <TextField label="Budget to (₹L)" type="number" value={seg.budget_max} onChange={(e) => setSeg({ ...seg, budget_max: e.target.value })} />
          <TextField label="Inactive days" type="number" value={seg.inactive_days} onChange={(e) => setSeg({ ...seg, inactive_days: e.target.value })} />
        </div>
        <TextField label="Send later (optional)" type="datetime-local" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} />
        {preview && (
          <div className="rounded-lg border border-line px-3 py-2 text-sm">
            <p className="text-ink"><b className="tabular-nums">{preview.eligible}</b> people will receive this, from {preview.matched} matched.{preview.estimated_cost !== null ? ` Estimated cost ${inr(preview.estimated_cost)}.` : ''}</p>
            {Object.entries(preview.excluded).map(([reason, n]) => <p key={reason} className="text-[13px] text-muted">{String(n)} left out: {reason}</p>)}
          </div>
        )}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>{can('campaign.direct') ? 'Send now' : 'Send for approval'}</Button></div>
      </form>
    </Modal>
  );
}

function TemplateModal({ template, variables, onClose }: { template: any | null; variables: string[]; onClose: () => void }) {
  const { aiEnabled } = useAuth();
  const [f, setF] = useState({
    name: template?.name ?? '', category: template?.category ?? 'MARKETING', language: template?.language ?? 'en', body: template?.body ?? '',
    header_type: template?.header_type ?? 'NONE', header_url: template?.header_url ?? '',
    buttons: (template ? JSON.parse(template.buttons) : []) as { type: string; text: string; value?: string }[],
  });
  const [picking, setPicking] = useState(false);
  const [goal, setGoal] = useState('');
  const { busy, run } = useAction();
  const ai = useAction();
  const write = async () => {
    const language = { en: 'English', hi: 'Hindi', mr: 'Marathi' }[f.language as 'en'];
    const r = await ai.run(() => api.post('/ai/template', { goal, language }));
    if (r) setF({ ...f, body: r.text });
  };
  const setButton = (i: number, patch: object) => setF({ ...f, buttons: f.buttons.map((b, n) => (n === i ? { ...b, ...patch } : b)) });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const save = () => (template ? api.put(`/templates/${template.id}`, f) : api.post('/templates', f));
    if (await run(save, 'Template saved')) onClose();
  };
  return (
    <Modal title={template ? 'Edit template' : 'New template'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <TextField label="Name" hint="Lowercase letters, numbers and underscores." required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            <option value="MARKETING">Marketing</option><option value="UTILITY">Utility</option>
          </SelectField>
          <SelectField label="Language" value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>
            <option value="en">English</option><option value="hi">Hindi</option><option value="mr">Marathi</option>
          </SelectField>
        </div>
        {aiEnabled && (
          <div className="flex gap-2">
            <Input aria-label="Describe the message" placeholder="Describe it, and AI will write it" value={goal} onChange={(e) => setGoal(e.target.value)} />
            <Button busy={ai.busy} disabled={goal.trim().length < 5} onClick={write}><Sparkles size={15} />Write</Button>
          </div>
        )}
        <TextareaField label="Message" rows={5} required value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        <div className="flex flex-wrap gap-1">
          {variables.map((v) => <button type="button" key={v} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-brand-ink" onClick={() => setF({ ...f, body: `${f.body}{{${v}}}` })}>{`{{${v}}}`}</button>)}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Media at top" value={f.header_type} onChange={(e) => setF({ ...f, header_type: e.target.value, header_url: e.target.value === 'NONE' ? '' : f.header_url })}>
            <option value="NONE">None</option><option value="IMAGE">Image</option><option value="DOCUMENT">PDF document</option><option value="VIDEO">Video</option>
          </SelectField>
          {f.header_type !== 'NONE' && <div className="self-end"><Button onClick={() => setPicking(true)}><FileImage size={15} />{f.header_url ? 'Change file' : 'Choose file'}</Button></div>}
        </div>
        {f.header_url && <p className="truncate text-xs text-muted">{f.header_url}</p>}
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium">Buttons (up to 3)</legend>
          <div className="space-y-2">{f.buttons.map((b, i) => (
            <div key={i} className="grid grid-cols-[7.5rem_1fr_1fr_auto] gap-1.5">
              <Select aria-label="Button type" value={b.type} onChange={(e) => setButton(i, { type: e.target.value })}><option value="QUICK_REPLY">Quick reply</option><option value="URL">Website</option><option value="PHONE_NUMBER">Call</option></Select>
              <Input aria-label="Button text" placeholder="Text" maxLength={25} value={b.text} onChange={(e) => setButton(i, { text: e.target.value })} />
              <Input aria-label="Button link or number" disabled={b.type === 'QUICK_REPLY'} placeholder={b.type === 'URL' ? 'https://' : b.type === 'PHONE_NUMBER' ? '+91...' : ''} value={b.value ?? ''} onChange={(e) => setButton(i, { value: e.target.value })} />
              <IconButton label="Remove button" onClick={() => setF({ ...f, buttons: f.buttons.filter((_, n) => n !== i) })}><Trash2 size={15} /></IconButton>
            </div>
          ))}</div>
          {f.buttons.length < 3 && <Button size="sm" className="mt-1.5" onClick={() => setF({ ...f, buttons: [...f.buttons, { type: 'QUICK_REPLY', text: '' }] })}><Plus size={14} />Add button</Button>}
        </fieldset>
        <div className="rounded-lg bg-[#e7ddd3] p-3 dark:bg-slate-800">
          <p className="mb-1 text-[11px] text-slate-600 dark:text-slate-300">Preview</p>
          <div className="max-w-xs rounded-lg bg-white p-2 text-sm text-slate-900 shadow-sm">
            {f.header_type === 'IMAGE' && f.header_url && <img src={f.header_url} alt="Preview" className="mb-1 rounded" />}
            {f.header_type !== 'NONE' && f.header_type !== 'IMAGE' && <p className="mb-1 rounded bg-slate-100 px-2 py-1 text-xs">{f.header_type === 'VIDEO' ? 'Video' : 'PDF'} attached</p>}
            <p className="break-words whitespace-pre-line">{f.body || 'Your message'}</p>
            {f.buttons.map((b, i) => <p key={i} className="mt-1 border-t pt-1 text-center text-[13px] text-sky-700">{b.text || 'Button'}</p>)}
          </div>
        </div>
        {picking && <MediaPicker kinds={[{ IMAGE: 'image', DOCUMENT: 'document', VIDEO: 'video' }[f.header_type as 'IMAGE']]} onPick={(m) => { setF({ ...f, header_url: m.url }); setPicking(false); }} onClose={() => setPicking(false)} />}
        {f.category === 'MARKETING' && <p className="text-[13px] text-muted">Include "Reply STOP to opt out" and {'{{rera}}'} for project promotions.</p>}
        {template?.status === 'approved' && <Notice>Saving a change means this template needs approval again.</Notice>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function Templates() {
  const { can, whatsappLive } = useAuth();
  const { data, reload } = useApi('/templates', ['templates']);
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const { f, set, clear, activeCount } = useFilters(['q', 'status', 'category', 'language'] as const, { prefix: 't_' });
  const manage = can('template.manage');
  const submit = async (id: number) => {
    await run(() => api.post(`/templates/${id}/submit`), whatsappLive ? 'Sent to Meta for approval' : 'Approved (simulated in demo mode)');
    void reload();
  };
  const checkStatus = async () => {
    const r = await run(() => api.post('/templates/sync'));
    if (r) { toast(r.simulated ? 'Demo mode: nothing to check' : r.changed ? `${r.changed} template${r.changed > 1 ? 's' : ''} updated from Meta` : 'Already up to date with Meta'); void reload(); }
  };
  if (!data) return <Spinner />;
  const rows = filterRows<any>(data.templates, f, {
    search: (t) => [t.name, t.body],
    match: { status: (t) => t.status, category: (t) => t.category, language: (t) => t.language },
  });
  return (
    <>
      {manage && (
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          {whatsappLive && <Button busy={busy} onClick={checkStatus}><RefreshCw size={15} />Check status with Meta</Button>}
          <Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} />New template</Button>
        </div>
      )}
      <FilterBar search={<SearchBox placeholder="Search templates" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={rows.length} total={data.templates.length} noun="templates">
        <FilterPill label="Status" value={f.status} options={optionsFrom<any>(data.templates, (t) => t.status)} onChange={(status) => set({ status })} />
        <FilterPill label="Category" value={f.category} options={optionsFrom<any>(data.templates, (t) => t.category)} onChange={(category) => set({ category })} />
        <FilterPill label="Language" value={f.language} options={optionsFrom<any>(data.templates, (t) => t.language)} onChange={(language) => set({ language })} />
      </FilterBar>
      {!!data.templates.length && !rows.length && <Card><Empty title="No templates match">Try clearing a filter.</Empty></Card>}
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((t: any) => (
          <Card key={t.id} className="p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-medium text-ink">{t.name}</p>
              <Badge tone={t.status === 'approved' ? 'green' : t.status === 'rejected' ? 'red' : t.status === 'pending' ? 'amber' : 'neutral'}>{t.status}</Badge>
            </div>
            <p className="text-xs text-muted capitalize">{t.category.toLowerCase()} · {t.language}</p>
            {t.header_type !== 'NONE' && <p className="mt-1 text-xs text-brand-ink">With {t.header_type.toLowerCase()}</p>}
            <p className="mt-2 text-sm whitespace-pre-line">{t.body}</p>
            {JSON.parse(t.buttons).length > 0 && <p className="mt-1 text-xs text-muted">Buttons: {JSON.parse(t.buttons).map((b: any) => b.text).join(', ')}</p>}
            {t.reject_reason && <p className="mt-1 text-[13px] text-red-700">{t.reject_reason}</p>}
            {manage && (
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => setEditing(t)}>Edit</Button>
                {['draft', 'rejected'].includes(t.status) && <Button size="sm" variant="primary" onClick={() => submit(t.id)}>Submit for approval</Button>}
              </div>
            )}
          </Card>
        ))}
      </div>
      {editing && <TemplateModal template={editing === 'new' ? null : editing} variables={data.variables} onClose={() => { setEditing(null); void reload(); }} />}
    </>
  );
}

function pct(part: number, total: number) {
  return total ? `${Math.round((part / total) * 100)}%` : '—';
}

export default function Campaigns() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'campaigns' | 'templates'>('campaigns');
  const [building, setBuilding] = useState(false);
  const { data, error, loading, reload } = useApi('/campaigns', ['campaigns', 'inbox']);
  const { run } = useAction();
  const { f, set, clear, activeCount } = useFilters(['q', 'status', 'project', 'creator', 'date', 'from', 'to', 'sort'] as const);
  const rows = filterRows<any>(data?.campaigns, f, {
    search: (c) => [c.name, c.template_name, c.project_name, c.created_by_name],
    match: { status: (c) => c.status, project: (c) => c.project_name, creator: (c) => c.created_by_name },
    date: (c) => c.scheduled_at ?? c.created_at,
    sort: {
      sent: (a, b) => b.sent - a.sent,
      read: (a, b) => (b.total ? b.read / b.total : 0) - (a.total ? a.read / a.total : 0),
      replied: (a, b) => b.replied - a.replied,
      bookings: (a, b) => b.bookings - a.bookings,
    },
  });
  const statusOptions = optionsFrom<any>(data?.campaigns, (c) => c.status).map((o) => ({ ...o, label: STATUS[o.value]?.label ?? o.label }));

  const decide = async (id: number, approve: boolean) => {
    await run(() => api.post(`/campaigns/${id}/approve`, { approve }), approve ? 'Campaign approved' : 'Campaign rejected');
    void reload();
  };

  return (
    <Page>
      <PageHeader title="Broadcasts" subtitle="Bulk WhatsApp messages, sent only to people who agreed to hear from you"
        actions={tab === 'campaigns' && <Button variant="primary" onClick={() => setBuilding(true)}><Send size={16} />New broadcast</Button>} />
      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
        {(['campaigns', 'templates'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={cx('-mb-px border-b-2 px-3 py-2 text-sm', tab === t ? 'border-brand font-medium text-brand-ink' : 'border-transparent text-muted')}>{t === 'campaigns' ? 'Broadcasts' : 'Templates'}</button>
        ))}
      </div>
      {tab === 'templates' ? <Templates /> : (
        <>
          {error && <ErrorNote>{error}</ErrorNote>}
          {loading && !data && <Spinner />}
          {data && !data.campaigns.length && <Card><Empty title="No broadcasts yet">Create one to reach a chosen group of leads.</Empty></Card>}
          {!!data?.campaigns.length && (
            <FilterBar search={<SearchBox placeholder="Search broadcasts" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={rows.length} total={data.campaigns.length} noun="broadcasts">
              <DatePill preset={f.date} from={f.from} to={f.to} onChange={(date, from, to) => set({ date, from, to })} />
              <FilterPill label="Status" value={f.status} options={statusOptions} onChange={(status) => set({ status })} />
              <FilterPill label="Project" value={f.project} options={optionsFrom<any>(data.campaigns, (c) => c.project_name)} onChange={(project) => set({ project })} />
              <FilterPill label="Created by" value={f.creator} options={optionsFrom<any>(data.campaigns, (c) => c.created_by_name)} onChange={(creator) => set({ creator })} />
              <FilterPill label="Sort" value={f.sort} options={[{ value: '', label: 'Newest first' }, { value: 'sent', label: 'Most sent' }, { value: 'read', label: 'Best read rate' }, { value: 'replied', label: 'Most replies' }, { value: 'bookings', label: 'Most bookings' }]} onChange={(sort) => set({ sort })} clearable={false} />
            </FilterBar>
          )}
          {!!data?.campaigns.length && !rows.length && <Card><Empty title="No broadcasts match">Try clearing a filter.</Empty></Card>}
          <div className="space-y-3">
            {rows.map((c: any) => {
              const s = STATUS[c.status] ?? STATUS.draft;
              return (
                <Card key={c.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{c.name}</p>
                      <p className="text-[13px] text-muted">{c.template_name} · {c.project_name ?? 'All projects'} · by {c.created_by_name}{c.number ? ` from ${c.number}` : ''} · {dateTime(c.scheduled_at ?? c.created_at)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {!!c.simulated && <Badge>Simulated</Badge>}
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </div>
                  </div>
                  {c.total > 0 && (
                    <dl className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-7">
                      {[['Sent', c.sent, ''], ['Delivered', c.delivered, pct(c.delivered, c.total)], ['Read', c.read, pct(c.read, c.total)], ['Replied', c.replied, pct(c.replied, c.total)], ['Visits', c.visits, ''], ['Bookings', c.bookings, ''], ['Failed', c.failed, '']].map(([label, value, share]) => (
                        <div key={String(label)}>
                          <dt className="text-[13px] text-muted">{label}</dt>
                          <dd className="text-lg font-semibold text-ink tabular-nums">{value} <span className="text-[13px] font-normal text-muted">{share}</span></dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {c.status === 'pending_approval' && can('campaign.approve') && (
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => decide(c.id, true)}>Approve</Button>
                      <Button size="sm" onClick={() => decide(c.id, false)}>Reject</Button>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}
      {building && <CampaignBuilder onClose={() => { setBuilding(false); void reload(); }} />}
    </Page>
  );
}
