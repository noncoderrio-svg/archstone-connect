import { CircleCheck, CircleDashed, Copy, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ROLES, ROLE_LABELS, SOURCES, STAGES } from '../../../shared/domain.ts';
import { DatePill, FilterBar, FilterPill, SearchBox, dateBounds, filterRows, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { LABEL_COLORS, LabelChip } from '../components/Labels.tsx';
import { Badge, Button, Card, CardHeader, ErrorNote, IconButton, Input, Modal, Notice, PageHeader, SelectField, Spinner, TextField, cx, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { dateTime } from '../lib/format.ts';

const TABS = ['Rules', 'Alerts', 'Workflows', 'Labels', 'Reports', 'Integrations', 'Automations', 'Deleted leads', 'Audit log'] as const;

const TRIGGERS = [{ value: 'lead_created', label: 'A new lead arrives' }, { value: 'stage_changed', label: 'A lead moves to a stage' }, { value: 'lead_idle', label: 'A lead goes quiet' }];
const ACTIONS = [
  { value: 'create_task', label: 'Create a follow-up' }, { value: 'notify_owner', label: 'Alert the assigned person' }, { value: 'add_label', label: 'Add a label' },
  { value: 'assign_owner', label: 'Assign to someone' }, { value: 'send_template', label: 'Send a WhatsApp template' },
];
const BLANK_RULE = { name: '', enabled: true, trigger: 'lead_created', conditions: {} as any, action: 'create_task', config: {} as any };

function ruleSummary(r: any) {
  const when = r.trigger === 'stage_changed' ? `moves to ${r.conditions.stage}` : r.trigger === 'lead_idle' ? `quiet for ${r.conditions.days} days` : 'arrives';
  const only = [r.conditions.source, r.conditions.temperature].filter(Boolean).join(', ');
  return `When a lead ${when}${only ? ` (${only})` : ''}: ${ACTIONS.find((a) => a.value === r.action)?.label.toLowerCase()}`;
}

function RuleForm({ rule, onClose }: { rule: any; onClose: () => void }) {
  const [f, setF] = useState(rule);
  const { data: t } = useApi('/templates');
  const { data: d } = useApi('/directory');
  const { data: p } = useApi('/projects');
  const { busy, run } = useAction();
  const cond = (k: string, v: unknown) => setF({ ...f, conditions: { ...f.conditions, [k]: v || undefined } });
  const conf = (k: string, v: unknown) => setF({ ...f, config: { ...f.config, [k]: v || undefined } });
  const save = async () => {
    const done = await run(() => (f.id ? api.put(`/workflows/${f.id}`, f) : api.post('/workflows', f)), 'Rule saved');
    if (done) onClose();
  };
  return (
    <Modal title={f.id ? 'Edit rule' : 'New rule'} onClose={onClose}>
      <div className="space-y-3">
        <TextField label="Rule name" required placeholder="e.g. Call new Meta leads in 5 minutes" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <SelectField label="When" value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}>{TRIGGERS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</SelectField>
        {f.trigger === 'stage_changed' && <SelectField label="Stage" value={f.conditions.stage ?? ''} onChange={(e) => cond('stage', e.target.value)}><option value="">Choose</option>{STAGES.map((s) => <option key={s}>{s}</option>)}</SelectField>}
        {f.trigger === 'lead_idle' && <TextField label="Quiet for (days)" type="number" min={1} value={f.conditions.days ?? ''} onChange={(e) => cond('days', Number(e.target.value))} />}
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Only for source" value={f.conditions.source ?? ''} onChange={(e) => cond('source', e.target.value)}><option value="">Any</option>{SOURCES.map((s) => <option key={s}>{s}</option>)}</SelectField>
          <SelectField label="Only for score" value={f.conditions.temperature ?? ''} onChange={(e) => cond('temperature', e.target.value)}><option value="">Any</option>{['Hot', 'Warm', 'Cold'].map((s) => <option key={s}>{s}</option>)}</SelectField>
          <SelectField label="Only for project" value={f.conditions.project_id ?? ''} onChange={(e) => cond('project_id', Number(e.target.value))}><option value="">Any</option>{p?.projects.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</SelectField>
        </div>
        <SelectField label="Then" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value, config: {} })}>{ACTIONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</SelectField>
        {f.action === 'create_task' && (
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Follow-up type" placeholder="Call back" value={f.config.task_type ?? ''} onChange={(e) => conf('task_type', e.target.value)} />
            <TextField label="Due after (minutes)" type="number" min={0} value={f.config.after_minutes ?? ''} onChange={(e) => conf('after_minutes', Number(e.target.value))} />
          </div>
        )}
        {f.action === 'add_label' && <TextField label="Label" value={f.config.label ?? ''} onChange={(e) => conf('label', e.target.value)} />}
        {f.action === 'notify_owner' && <TextField label="Alert text" value={f.config.text ?? ''} onChange={(e) => conf('text', e.target.value)} />}
        {f.action === 'assign_owner' && <SelectField label="Assign to" value={f.config.user_id ?? ''} onChange={(e) => conf('user_id', Number(e.target.value))}><option value="">Choose</option>{d?.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</SelectField>}
        {f.action === 'send_template' && <SelectField label="Template" hint="Consent and MahaRERA checks still apply." value={f.config.template_id ?? ''} onChange={(e) => conf('template_id', Number(e.target.value))}><option value="">Choose</option>{t?.templates.filter((x: any) => x.status === 'approved').map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</SelectField>}
        <div className="flex justify-end gap-2 pt-1"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={f.name.trim().length < 3} onClick={save}>Save rule</Button></div>
      </div>
    </Modal>
  );
}

function Workflows() {
  const { data, reload } = useApi('/workflows');
  const [editing, setEditing] = useState<any>(null);
  const { run } = useAction();
  if (!data) return <Spinner />;
  const toggle = async (r: any) => { await run(() => api.put(`/workflows/${r.id}`, { ...r, enabled: !r.enabled })); void reload(); };
  const remove = async (r: any) => { if (confirm(`Delete the rule "${r.name}"?`)) { await run(() => api.del(`/workflows/${r.id}`), 'Rule deleted'); void reload(); } };
  return (
    <Card className="max-w-3xl">
      <CardHeader title="Workflow rules" hint="If this happens, do that, automatically." action={<Button size="sm" variant="primary" onClick={() => setEditing(BLANK_RULE)}><Plus size={14} />New rule</Button>} />
      {!data.rules.length && <p className="p-6 text-center text-muted">No rules yet. Start with one, such as a follow-up five minutes after every new Meta lead.</p>}
      <ul className="divide-y divide-line">
        {data.rules.map((r: any) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-48 flex-1">
              <p className="font-medium text-ink">{r.name}</p>
              <p className="text-[13px] text-muted">{ruleSummary(r)}</p>
              <p className="text-xs text-muted">Ran {r.runs} {r.runs === 1 ? 'time' : 'times'}{r.last_run_at ? `, last ${dateTime(r.last_run_at)}` : ''}</p>
            </div>
            <Badge tone={r.enabled ? 'green' : 'neutral'}>{r.enabled ? 'On' : 'Off'}</Badge>
            <span className="flex gap-1.5">
              <Button size="sm" onClick={() => toggle(r)}>{r.enabled ? 'Turn off' : 'Turn on'}</Button>
              <Button size="sm" onClick={() => setEditing(r)}>Edit</Button>
              <IconButton label="Delete rule" className="size-8" onClick={() => remove(r)}><Trash2 size={15} /></IconButton>
            </span>
          </li>
        ))}
      </ul>
      {editing && <RuleForm rule={editing} onClose={() => { setEditing(null); void reload(); }} />}
    </Card>
  );
}

function AlertRules({ initial, onSaved }: { initial: any; onSaved: () => void }) {
  const [f, setF] = useState(initial);
  const { busy, run } = useAction();
  const num = (k: string) => ({ type: 'number', value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: Number(e.target.value) }) });
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const label = (h: number) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
  const hourField = (k: string, text: string) => (
    <SelectField label={text} value={f[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })}>
      {hours.map((h) => <option key={h} value={h}>{label(h)}</option>)}
    </SelectField>
  );
  const check = (k: string, text: string) => (
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--brand)]" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} />{text}</label>
  );
  return (
    <Card className="max-w-3xl space-y-5 p-4">
      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold">Follow-up reminders</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Remind before due (minutes)" min={0} max={1440} {...num('reminder_minutes')} />
          <TextField label="Repeat overdue alert every (minutes)" min={10} max={1440} {...num('overdue_repeat_minutes')} />
          <TextField label="Overdue alerts per follow-up" min={0} max={10} hint="0 turns overdue alerts off." {...num('overdue_max_alerts')} />
          <TextField label="Tell the manager after (minutes)" min={0} max={10080} hint="0 turns this off." {...num('escalate_after_minutes')} />
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold">Morning summary</h2>
        {check('morning_summary', 'Send each person their overdue and due-today count')}
        <div className="max-w-52">{hourField('summary_hour', 'Send at')}</div>
      </section>
      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold">Quiet hours</h2>
        {check('quiet_enabled', 'No phone or WhatsApp alerts during these hours')}
        <p className="text-[13px] text-muted">Alerts still appear in the bell. Overdue alerts wait until quiet hours end.</p>
        <div className="grid max-w-md gap-3 grid-cols-2">{hourField('quiet_start', 'From')}{hourField('quiet_end', 'Until')}</div>
      </section>
      <section className="space-y-2">
        <h2 className="text-[15px] font-semibold">WhatsApp messages to staff</h2>
        <p className="text-[13px] text-muted">These use staff_ templates, which Meta must approve first. Send them for approval under Broadcasts, Templates.</p>
        {check('whatsapp_new_lead', 'New lead assigned')}
        {check('whatsapp_followup', 'Follow-up reminder and morning summary')}
        {check('whatsapp_overdue', 'Overdue follow-up')}
      </section>
      <Button variant="primary" busy={busy} onClick={async () => { if (await run(() => api.put('/settings/alerts', f), 'Alert rules saved')) onSaved(); }}>Save</Button>
    </Card>
  );
}

function LabelSettings() {
  const { data } = useApi('/directory');
  const [rows, setRows] = useState<{ name: string; color: string }[] | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { if (data && !rows) setRows(data.labels); }, [data, rows]);
  if (!rows) return <Spinner />;
  const update = (i: number, patch: object) => setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <Card className="max-w-xl p-4">
      <p className="mb-3 text-sm text-muted">Staff pick from these labels on leads and WhatsApp chats. Renaming one does not change leads already tagged.</p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_7rem_auto_auto] items-center gap-2">
            <Input aria-label="Label name" maxLength={30} value={r.name} onChange={(e) => update(i, { name: e.target.value })} />
            <select aria-label="Label colour" className="h-10 rounded-lg border border-line bg-surface px-2 text-sm text-ink capitalize" value={r.color} onChange={(e) => update(i, { color: e.target.value })}>
              {Object.keys(LABEL_COLORS).map((c) => <option key={c}>{c}</option>)}
            </select>
            <LabelChip name={r.name || 'Label'} catalog={[{ name: r.name || 'Label', color: r.color }]} />
            <IconButton label="Remove label" onClick={() => setRows(rows.filter((_, n) => n !== i))}><Trash2 size={16} /></IconButton>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button onClick={() => setRows([...rows, { name: '', color: 'teal' }])}><Plus size={15} />Add label</Button>
        <Button variant="primary" busy={busy} onClick={() => run(() => api.put('/labels', { labels: rows.filter((r) => r.name.trim()) }), 'Labels saved')}>Save</Button>
      </div>
    </Card>
  );
}

function Rules({ initial }: { initial: any }) {
  const [f, setF] = useState(initial);
  const { busy, run } = useAction();
  useEffect(() => setF(initial), [initial]);
  const num = (k: string) => ({ value: f[k], type: 'number', onChange: (e: any) => setF({ ...f, [k]: Number(e.target.value) }) });
  return (
    <Card className="max-w-2xl p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="First response alert (minutes)" hint="Alerts the assigned person and managers." {...num('sla_minutes')} />
        <TextField label="Unit hold time (hours)" hint="Holds release automatically." {...num('hold_hours')} />
        <TextField label="Site head discount limit (%)" hint="Above this needs admin approval." {...num('discount_limit_percent')} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Office opens (hour)" type="number" min="0" max="23" value={f.business_hours.start} onChange={(e) => setF({ ...f, business_hours: { ...f.business_hours, start: Number(e.target.value) } })} />
          <TextField label="Office closes (hour)" type="number" min="1" max="24" value={f.business_hours.end} onChange={(e) => setF({ ...f, business_hours: { ...f.business_hours, end: Number(e.target.value) } })} />
        </div>
      </div>
      <fieldset className="mt-4">
        <legend className="text-[13px] font-medium">Hide customer phone numbers from</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {ROLES.filter((r) => r !== 'admin').map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-[var(--brand)]" checked={f.mask_phone_roles.includes(r)}
                onChange={(e) => setF({ ...f, mask_phone_roles: e.target.checked ? [...f.mask_phone_roles, r] : f.mask_phone_roles.filter((x: string) => x !== r) })} />
              {ROLE_LABELS[r]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <SelectField label="Lead assignment" value={f.routing_mode} onChange={(e) => setF({ ...f, routing_mode: e.target.value })}>
          <option value="round_robin">Round robin</option><option value="workload">Fewest open leads</option>
        </SelectField>
        <TextField label="Quiet lead alert (days)" hint="0 turns it off." {...num('inactive_alert_days')} />
        <TextField label="Auto-reassign after (days)" hint="0 turns it off." {...num('auto_reassign_days')} />
        <TextField label="Follow-up nudge after (days)" {...num('drip_wait_days')} />
        <TextField label="Daily WhatsApp broadcast limit" hint="Keep within your Meta messaging tier." {...num('wa_daily_limit')} />
        <TextField label="Cost per marketing message (₹)" hint="Enter your current Meta rate for estimates." type="number" step="0.01" value={f.wa_cost_per_message ?? ''} onChange={(e) => setF({ ...f, wa_cost_per_message: e.target.value === '' ? null : Number(e.target.value) })} />
      </div>
      <div className="mt-3"><TextField label="Extra pipeline stages" hint="Separate with commas." value={f.custom_stages.join(', ')} onChange={(e) => setF({ ...f, custom_stages: e.target.value.split(',').map((s: string) => s.trimStart()) })} /></div>
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1 accent-[var(--brand)]" checked={f.enforce_call_updates} onChange={(e) => setF({ ...f, enforce_call_updates: e.target.checked })} />
        <span>Require a call result before the next lead<span className="block text-xs text-muted">Staff must save each outcome in Calling.</span></span>
      </label>
      <label className="mt-2 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1 accent-[var(--brand)]" checked={f.record_calls} onChange={(e) => setF({ ...f, record_calls: e.target.checked })} />
        <span>Record office line calls<span className="block text-xs text-muted">Customers must be told that calls are recorded, for example by a message at the start of the call.</span></span>
      </label>
      <fieldset className="mt-4">
        <legend className="text-[13px] font-medium">Default payment plan</legend>
        <p className="mb-2 text-xs text-muted">Pre-fills new booking schedules. Percentages should add up to 100.</p>
        <div className="space-y-2">
          {f.payment_plan.map((row: { label: string; percent: number }, i: number) => {
            const update = (patch: object) => setF({ ...f, payment_plan: f.payment_plan.map((x: object, n: number) => (n === i ? { ...x, ...patch } : x)) });
            return (
              <div key={i} className="grid grid-cols-[1fr_5.5rem_auto] gap-2">
                <Input aria-label="Milestone" placeholder="Milestone" value={row.label} onChange={(e) => update({ label: e.target.value })} />
                <Input aria-label="Percent" type="number" value={row.percent} onChange={(e) => update({ percent: Number(e.target.value) })} />
                <IconButton label="Remove milestone" onClick={() => setF({ ...f, payment_plan: f.payment_plan.filter((_: object, n: number) => n !== i) })}><Trash2 size={16} /></IconButton>
              </div>
            );
          })}
        </div>
        <Button size="sm" className="mt-2" onClick={() => setF({ ...f, payment_plan: [...f.payment_plan, { label: '', percent: 10 }] })}><Plus size={15} />Add milestone</Button>
      </fieldset>
      <Button className="mt-4" variant="primary" busy={busy} onClick={() => run(() => api.put('/settings', { ...f, custom_stages: f.custom_stages.map((s: string) => s.trim()).filter(Boolean) }), 'Settings saved')}>Save</Button>
    </Card>
  );
}

function ReportSchedule({ settings, runs, onSaved }: { settings: any; runs: any[]; onSaved: () => void }) {
  const [s, setS] = useState(settings.report_schedule);
  const { busy, run } = useAction();
  const flag = (k: string, label: string) => (
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--brand)]" checked={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.checked })} />{label}</label>
  );
  const save = () => run(() => api.put('/settings', { ...settings, report_schedule: s }), 'Schedule saved');
  const sendNow = async () => { await run(() => api.post('/reports/send-now', { period: 'daily' }), 'Report sent to you'); onSaved(); };
  return (
    <div className="max-w-2xl space-y-4">
      <Card className="p-4">
        <p className="mb-3 text-sm text-muted">Goes to admins, sales managers and site heads, each limited to what they may see.</p>
        <div className="space-y-1.5">{flag('daily', 'Send a daily report')}{flag('weekly', 'Send a weekly report on Mondays')}{flag('email', 'By email, with Excel and PDF attached')}{flag('whatsapp', 'By WhatsApp to their mobile number')}</div>
        <div className="mt-3 w-40"><TextField label="Send at (hour, IST)" type="number" min="0" max="23" value={s.hour} onChange={(e) => setS({ ...s, hour: Number(e.target.value) })} /></div>
        <div className="mt-3 flex gap-2"><Button variant="primary" busy={busy} onClick={save}>Save</Button><Button busy={busy} onClick={sendNow}>Send me one now</Button></div>
      </Card>
      {!!runs.length && (
        <Card>
          <CardHeader title="Recent reports" />
          <ul className="divide-y divide-line">{runs.map((r) => (
            <li key={r.id} className="flex justify-between gap-3 px-4 py-2 text-sm"><span>{r.user_name}, {r.period}, {r.channel}</span><span className="text-muted">{r.status} · {dateTime(r.created_at)}</span></li>
          ))}</ul>
        </Card>
      )}
    </div>
  );
}

function DeletedLeads() {
  const { data, reload } = useApi('/leads-deleted');
  const { run } = useAction();
  const { f, set, clear, activeCount } = useFilters(['q', 'date', 'from', 'to'] as const, { prefix: 'del_' });
  if (!data) return <Spinner />;
  const rows = filterRows<any>(data.leads, f, { search: (l) => [l.name, l.stage], date: (l) => l.deleted_at });
  return (
    <>
    <FilterBar search={<SearchBox placeholder="Search deleted leads" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={rows.length} total={data.leads.length} noun="leads">
      <DatePill label="Deleted" preset={f.date} from={f.from} to={f.to} onChange={(date, from, to) => set({ date, from, to })} />
    </FilterBar>
    <Card className="max-w-3xl">
      {!rows.length && <p className="p-6 text-center text-muted">No deleted leads.</p>}
      <ul className="divide-y divide-line">{rows.map((l: any) => (
        <li key={l.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
          <span><span className="font-medium text-ink">{l.name}</span><span className="block text-xs text-muted">{l.stage} · deleted {dateTime(l.deleted_at)}</span></span>
          <Button size="sm" onClick={async () => { await run(() => api.post(`/leads/${l.id}/restore`), 'Lead restored'); void reload(); }}>Restore</Button>
        </li>
      ))}</ul>
    </Card>
    </>
  );
}

function BackupCard({ last, reload }: { last: string; reload: () => void }) {
  const [f, setF] = useState({ password: '', passphrase: '', repeat: '' });
  const { busy, run } = useAction();
  const problem = !f.password ? 'Enter your login password.'
    : f.passphrase.length < 12 ? `Your passphrase needs ${12 - f.passphrase.length} more characters.`
    : f.passphrase !== f.repeat ? 'The two passphrases do not match yet.' : '';
  const download = () => run(async () => {
    const res = await fetch('/api/settings/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: f.password, passphrase: f.passphrase }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'The backup failed. Please try again.');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await res.blob());
    link.download = /filename="(.+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'archstone-connect.archstonebackup';
    document.body.append(link);
    link.click();
    link.remove();
    // Removing the file too soon can cancel the download, so it stays available for a while.
    setTimeout(() => URL.revokeObjectURL(link.href), 120000);
    setF({ password: '', passphrase: '', repeat: '' });
    reload();
  }, 'Backup sent to your browser. Check your Downloads folder for the file.');
  return (
    <Card className="max-w-3xl">
      <CardHeader title="Offsite backup" hint={last ? `Last downloaded ${dateTime(last)}.` : 'You have not downloaded a backup yet.'} />
      <div className="space-y-3 px-4 pb-4">
        <p className="text-[13px] text-muted">Downloads one encrypted file with your database, uploads and encryption key. Keep it away from this system, for example on a drive or in your own cloud storage. Use Chrome or Edge on a computer. Downloads may not save in the Android app or in other built-in browsers.</p>
        <Notice>Write your passphrase down somewhere safe. It is never stored, so without it this backup cannot be opened by anyone.</Notice>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField label="Your login password" type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <TextField label="Backup passphrase" type="password" autoComplete="new-password" hint="At least 12 characters." value={f.passphrase} onChange={(e) => setF({ ...f, passphrase: e.target.value })} />
          <TextField label="Repeat passphrase" type="password" autoComplete="new-password" value={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.value })} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" busy={busy} disabled={Boolean(problem)} onClick={download}>Download encrypted backup</Button>
          {problem && <p className="text-[13px] text-muted">{problem}</p>}
        </div>
      </div>
    </Card>
  );
}

function FirebaseCard({ firebase, reload }: { firebase: any; reload: () => void }) {
  const { busy, run } = useAction();

  const readJson = async (file: File, what: string) => {
    try {
      return JSON.parse(await file.text());
    } catch {
      throw new Error(`That is not a ${what} file.`);
    }
  };
  const upload = (file?: File) => {
    if (!file) return;
    void run(async () => {
      await api.post('/settings/firebase', await readJson(file, 'Firebase service account'));
      reload();
    }, 'Firebase server key saved');
  };
  const uploadApp = (file?: File) => {
    if (!file) return;
    void run(async () => {
      await api.post('/settings/firebase-app', await readJson(file, 'google-services.json'));
      reload();
    }, 'Android app settings saved');
  };
  const remove = () => run(async () => { await api.del('/settings/firebase'); reload(); }, 'Firebase server key removed');
  const removeApp = () => run(async () => { await api.del('/settings/firebase-app'); reload(); }, 'Android app settings removed');
  const test = () => run(() => api.post('/settings/firebase/test'), 'Test sent to your devices');
  const mismatch = firebase.connected && firebase.app_connected && firebase.project !== firebase.app_project;

  const fileButton = (label: string, onFile: (f?: File) => void) => (
    <label className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-line px-3 text-sm font-medium text-ink hover:bg-surface-2">
      {label}
      <input type="file" accept=".json,application/json" className="sr-only" disabled={busy} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
    </label>
  );

  return (
    <Card className="max-w-3xl">
      <CardHeader title="Android app notifications" hint="Both files come from the same Firebase project. You can replace them here at any time, with no app update." />
      <div className="divide-y divide-line">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="font-medium text-ink">1. Server key (service account)</p>
            <p className="text-sm text-muted">{firebase.connected ? `Connected to project ${firebase.project}. Stored encrypted.` : 'Firebase → Project settings → Service accounts → Generate new private key.'}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {fileButton(firebase.connected ? 'Replace key' : 'Upload key', upload)}
            {firebase.connected && <Button busy={busy} onClick={remove}>Remove</Button>}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="font-medium text-ink">2. App settings (google-services.json)</p>
            <p className="text-sm text-muted">{firebase.app_connected ? `Connected to project ${firebase.app_project}. Phones pick this up the next time the app opens.` : 'Firebase → Project settings → Your apps → Android app com.archstone.connect → download google-services.json.'}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {fileButton(firebase.app_connected ? 'Replace file' : 'Upload file', uploadApp)}
            {firebase.app_connected && <Button busy={busy} onClick={removeApp}>Remove</Button>}
          </div>
        </div>
        {mismatch && <div className="p-4"><Notice>These two files are from different Firebase projects ({firebase.project} and {firebase.app_project}). Notifications will fail until both come from the same project.</Notice></div>}
        {firebase.connected && (
          <div className="space-y-2 p-4 text-sm">
            <Button busy={busy} onClick={test}>Send test to my phone</Button>
            {firebase.quiet.now && <Notice>Quiet hours are on now, so alerts stay in the bell and do not reach phones. Change this in the Alerts tab.</Notice>}
            <p className="pt-1 font-medium text-ink">Who gets notifications</p>
            <ul className="divide-y divide-line">
              {firebase.phones.map((p: any) => (
                <li key={p.name} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="min-w-0 truncate">{p.name}</span>
                  <span className="flex shrink-0 flex-wrap justify-end gap-1">
                    {!!p.phones && <Badge tone="green">{p.phones} Android {p.phones === 1 ? 'app' : 'apps'}</Badge>}
                    {!!p.web_apps && <Badge tone="green">{p.web_apps} installed {p.web_apps === 1 ? 'app / browser' : 'apps / browsers'}</Badge>}
                    {!p.phones && !p.web_apps && <Badge tone="neutral">Not set up</Badge>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-[13px] text-muted">
              Installed app (from the website) or browser: each person opens <b>My Account → Phone notifications → Turn on for this device</b> and allows notifications.
              Android APK: registers when they sign in to it. A device counts for the last person who turned it on.
            </p>
            {firebase.last && (
              <p className="text-[13px] text-muted">
                Last alert sent {dateTime(firebase.last.at)}: {firebase.last.sent} delivered to Firebase, {firebase.last.failed} failed.{firebase.last.error ? ` ${firebase.last.error}` : ''}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');

function ConnectionField({ field: f, value, removing, generated, onChange, onGenerate, onRemove }: {
  field: any; value: string; removing: boolean; generated: boolean;
  onChange: (value: string) => void; onGenerate: () => void; onRemove: (remove: boolean) => void;
}) {
  const hint = generated ? 'Copy this now. It is hidden once saved.' : f.on_server ? `Set on the server. Typing here replaces it.${f.hint ? ` ${f.hint}` : ''}` : f.hint;
  if (!f.secret) return <TextField label={f.label} hint={hint} placeholder={f.placeholder} spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />;
  return (
    <div>
      <TextField label={f.label} hint={hint} type={generated ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} disabled={removing}
        placeholder={removing ? 'Removed when you save' : f.is_set ? 'Saved. Leave blank to keep it.' : ''} value={value} onChange={(e) => onChange(e.target.value)} />
      {(f.generate || f.removable) && (
        <div className="mt-1 flex gap-1">
          {f.generate && !removing && <Button size="sm" variant="ghost" onClick={onGenerate}>Generate a key</Button>}
          {f.removable && <Button size="sm" variant="ghost" onClick={() => onRemove(!removing)}>{removing ? 'Keep it' : 'Remove'}</Button>}
        </div>
      )}
    </div>
  );
}

function ConnectionForm({ item, onClose, onSaved }: { item: any; onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(item.fields.filter((f: any) => !f.secret).map((f: any) => [f.key, f.value])));
  const [clear, setClear] = useState<string[]>([]);
  const [generated, setGenerated] = useState<string[]>([]);
  const { busy, run } = useAction();
  const set = (key: string, value: string) => setValues({ ...values, [key]: value });
  const save = async () => {
    const done = await run(() => api.put(`/connections/${item.key}`, { values, clear }), 'Connection saved');
    if (done) onSaved();
  };
  return (
    <Modal title={item.name} onClose={onClose}>
      <div className="space-y-3">
        {item.address && (
          <div>
            <p className="text-sm font-medium text-ink">{item.address_label}</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 rounded-lg bg-surface-2 px-2.5 py-2 text-[13px] break-all text-body">{item.address}</code>
              <IconButton label="Copy address" onClick={() => run(() => navigator.clipboard.writeText(item.address), 'Copied')}><Copy size={16} /></IconButton>
            </div>
          </div>
        )}
        {item.fields.map((f: any) => (
          <ConnectionField key={f.key} field={f} value={values[f.key] ?? ''} removing={clear.includes(f.key)} generated={generated.includes(f.key)}
            onChange={(value) => { set(f.key, value); setGenerated(generated.filter((k) => k !== f.key)); }}
            onGenerate={() => { set(f.key, randomKey()); setGenerated([...generated, f.key]); }}
            onRemove={(remove) => { setClear(remove ? [...clear, f.key] : clear.filter((k) => k !== f.key)); set(f.key, ''); }} />
        ))}
        <p className="text-[13px] text-muted">Keys are encrypted when saved and are not shown again. Changes work straight away.</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={save}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

function Integrations({ items, reload }: { items: any[]; reload: () => void }) {
  const [editing, setEditing] = useState<any>(null);
  const canEdit = items.some((i) => i.fields);
  return (
    <Card className="max-w-3xl">
      <CardHeader title="Connections" hint={canEdit ? 'Add or change each connection here. No restart is needed.' : 'Only an administrator can change these.'} />
      <ul className="divide-y divide-line">
        {items.map((i) => (
          <li key={i.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
            {i.connected ? <CircleCheck size={20} className="shrink-0 text-emerald-700 dark:text-emerald-400" /> : <CircleDashed size={20} className="shrink-0 text-muted" />}
            <div className="min-w-0 flex-1 basis-48">
              <p className="font-medium text-ink">{i.name}</p>
              <p className="truncate text-[13px] text-muted">{i.detail}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-end">
              <Badge tone={i.connected ? 'green' : 'neutral'}>{i.connected ? 'Connected' : 'Not connected'}</Badge>
              {i.fields && <Button size="sm" onClick={() => setEditing(i)}>{i.connected ? 'Edit' : 'Set up'}</Button>}
            </div>
          </li>
        ))}
      </ul>
      {editing && <ConnectionForm item={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </Card>
  );
}

function Automations({ items, reload }: { items: any[]; reload: () => void }) {
  const { run } = useAction();
  const toggle = async (a: any) => {
    await run(() => api.put(`/automations/${a.key}`, { enabled: !a.enabled, template_id: a.template_id }));
    reload();
  };
  return (
    <Card className="max-w-3xl">
      <ul className="divide-y divide-line">
        {items.map((a) => (
          <li key={a.key} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">{a.name}</p>
              <p className="text-[13px] text-muted">{a.description}</p>
              {a.template_name && <p className="text-xs text-muted">Template: {a.template_name} ({a.template_status})</p>}
            </div>
            <button role="switch" aria-checked={!!a.enabled} aria-label={a.name} onClick={() => toggle(a)}
              className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', a.enabled ? 'bg-brand' : 'bg-line')}>
              <span className={cx('absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform', a.enabled && 'translate-x-5')} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AuditLog() {
  const { f, set, clear, activeCount } = useFilters(['q', 'actor', 'group', 'date', 'from', 'to'] as const, { prefix: 'audit_' });
  const query = new URLSearchParams();
  for (const k of ['q', 'actor', 'group'] as const) if (f[k]) query.set(k, f[k]);
  const bounds = dateBounds(f.date, f.from, f.to);
  if (bounds.from) query.set('created_from', bounds.from);
  if (bounds.to) query.set('created_to', bounds.to);
  const { data, error } = useApi(`/audit?${query}`);
  const { data: directory } = useApi('/directory');
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  return (
    <>
    <FilterBar search={<SearchBox placeholder="Search actions and details" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={data.entries.length} noun="entries">
      <DatePill preset={f.date} from={f.from} to={f.to} onChange={(date, from, to) => set({ date, from, to })} />
      <FilterPill label="Who" value={f.actor} options={directory?.users.map((u: any) => ({ value: String(u.id), label: u.name })) ?? []} onChange={(actor) => set({ actor })} />
      <FilterPill label="Area" value={f.group} options={data.groups.map((g: string) => ({ value: g, label: g }))} onChange={(group) => set({ group })} />
    </FilterBar>
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead><tr className="border-b border-line text-left text-[13px] text-muted">
            {['When', 'Who', 'Action', 'Detail'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-line">
            {data.entries.map((e: any) => (
              <tr key={e.id}>
                <td className="px-4 py-2 whitespace-nowrap text-muted">{dateTime(e.created_at)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-ink">{e.actor ?? 'System'}</td>
                <td className="px-4 py-2 whitespace-nowrap">{e.action}</td>
                <td className="px-4 py-2">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
    </>
  );
}

export default function Settings() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Rules');
  const { data, error, loading, reload } = useApi('/settings');
  if (loading) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;
  return (
    <Page>
      <PageHeader title="Settings" />
      <div className="scroll-thin mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={cx('-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap', tab === t ? 'border-brand font-medium text-brand-ink' : 'border-transparent text-muted')}>{t}</button>
        ))}
      </div>
      {tab === 'Rules' && <Rules initial={data.settings} />}
      {tab === 'Alerts' && <AlertRules initial={data.settings.alert_rules} onSaved={reload} />}
      {tab === 'Workflows' && <Workflows />}
      {tab === 'Labels' && <LabelSettings />}
      {tab === 'Reports' && <ReportSchedule settings={data.settings} runs={data.report_runs} onSaved={reload} />}
      {tab === 'Deleted leads' && <DeletedLeads />}
      {tab === 'Integrations' && (
        <div className="space-y-3">
          <Integrations items={data.integrations} reload={reload} />
          <FirebaseCard firebase={data.firebase} reload={reload} />
          {data.is_admin && <BackupCard last={data.backup_download_last} reload={reload} />}
          <p className="text-[13px] text-muted">{data.backup_last ? `Last automatic backup: ${data.backup_last}.` : 'The first automatic backup runs shortly after start-up.'}{data.wa_quality ? ` WhatsApp quality update: ${data.wa_quality.event}.` : ''}</p>
        </div>
      )}
      {tab === 'Automations' && <Automations items={data.automations} reload={reload} />}
      {tab === 'Audit log' && <AuditLog />}
    </Page>
  );
}
