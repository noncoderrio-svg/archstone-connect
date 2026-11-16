import { CalendarClock, Columns3, List, MapPin, Star } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CountTabs, DatePill, FUTURE_PRESETS, FilterBar, FilterPill, SearchBox, filterRows, optionsFrom, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { ConfirmErase, EraseButton } from '../components/Erase.tsx';
import { Badge, Button, Card, Empty, ErrorNote, Modal, PageHeader, Select, SelectField, Spinner, TextField, TextareaField, cx, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { dateTime, googleCalendarLink, localToUtc } from '../lib/format.ts';
import { isViewOnly } from '../../../shared/domain.ts';

/** The visit pipeline, in order. No Show and Cancelled share the last column. */
const STAGES = ['Scheduled', 'Confirmed', 'Checked In', 'Completed', 'No Show', 'Cancelled'] as const;
const OPEN = ['Scheduled', 'Confirmed', 'Checked In'];
const COLUMNS: { title: string; statuses: string[]; hint: string }[] = [
  { title: 'Scheduled', statuses: ['Scheduled'], hint: 'Booked, not yet confirmed by the customer' },
  { title: 'Confirmed', statuses: ['Confirmed'], hint: 'Customer said they are coming' },
  { title: 'At site', statuses: ['Checked In'], hint: 'Checked in with the code' },
  { title: 'Completed', statuses: ['Completed'], hint: 'Visit done' },
  { title: 'No show / cancelled', statuses: ['No Show', 'Cancelled'], hint: 'Reschedule to bring them back' },
];
const TONE: Record<string, 'brand' | 'amber' | 'green' | 'red' | 'neutral'> = {
  Scheduled: 'brand', Confirmed: 'brand', 'Checked In': 'amber', Completed: 'green', 'No Show': 'red', Cancelled: 'neutral',
};
const NEXT_STEPS: Record<string, string> = { '': 'Not decided', follow_up: 'Follow-up', revisit: 'Revisit', negotiation: 'Negotiation' };
const FOLLOW_UP_TYPES = ['Call back', 'WhatsApp', 'Meeting', 'Send cost sheet', 'Send documents'];

const toTime = (s: string) => new Date(`${s.replace(' ', 'T')}Z`).getTime();
/** A visit whose time has passed without the customer arriving. */
const isLate = (v: any) => ['Scheduled', 'Confirmed'].includes(v.status) && toTime(v.scheduled_at) < Date.now() - 30 * 60000;
/** Coming up in the next 48 hours, and the customer has not confirmed yet. */
const needsConfirming = (v: any) => v.status === 'Scheduled' && toTime(v.scheduled_at) - Date.now() < 48 * 3600000 && !isLate(v);
const noNextStep = (v: any) => v.status === 'Completed' && !v.next_step && !['Booked', 'Working Deal'].includes(v.lead_stage);
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const inFuture = (value: string) => Boolean(value) && new Date(value).getTime() > Date.now() - 60000;

function CheckInModal({ visit, onClose }: { visit: any; onClose: () => void }) {
  const { user } = useAuth();
  const [otp, setOtp] = useState('');
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const canOverride = ['admin', 'site_head'].includes(user!.role);
  const submit = async () => {
    // Location is optional: check-in still works if the person declines.
    const where = await new Promise<GeolocationPosition | null>((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { timeout: 4000 });
    });
    const place = where ? { latitude: where.coords.latitude, longitude: where.coords.longitude } : {};
    const body = override ? { override_reason: reason, ...place } : { otp, ...place };
    if (await run(() => api.post(`/visits/${visit.id}/checkin`, body), 'Customer checked in')) onClose();
  };
  return (
    <Modal title={`Check in ${visit.lead_name}`} onClose={onClose}>
      {override
        ? <TextareaField label="Why is there no code?" required value={reason} onChange={(e) => setReason(e.target.value)} hint="This is recorded in the audit log." />
        : <TextField label="6-digit code from the customer" inputMode="numeric" maxLength={6} autoFocus value={otp} onChange={(e) => setOtp(e.target.value)} />}
      <div className="mt-3 flex items-center justify-between gap-2">
        {canOverride ? <Button variant="ghost" size="sm" onClick={() => setOverride((o) => !o)}>{override ? 'Use code' : 'No code?'}</Button> : <span />}
        <Button variant="primary" busy={busy} disabled={override ? !reason.trim() : otp.length !== 6} onClick={submit}>Check in</Button>
      </div>
    </Modal>
  );
}

function RescheduleModal({ visit, onClose }: { visit: any; onClose: () => void }) {
  const [when, setWhen] = useState('');
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const submit = async () => {
    const done = await run(() => api.post(`/visits/${visit.id}/reschedule`, { scheduled_at: localToUtc(when), reason }), 'Visit rescheduled');
    if (done) onClose();
  };
  return (
    <Modal title={`Reschedule ${visit.lead_name}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-muted">Now {dateTime(visit.scheduled_at)} at {visit.project_name}. The customer's code stays the same and they are sent the new time on WhatsApp.</p>
        <TextField label="New date and time" type="datetime-local" required min={localInput(new Date())} value={when} onChange={(e) => setWhen(e.target.value)} />
        <TextField label="Reason (optional)" maxLength={200} placeholder="e.g. Customer travelling, asked for Sunday" value={reason} onChange={(e) => setReason(e.target.value)} />
        {when && !inFuture(when) && <p className="text-[13px] text-red-700 dark:text-red-300">Choose a time in the future.</p>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!inFuture(when)} onClick={submit}>Reschedule</Button></div>
      </div>
    </Modal>
  );
}

function CloseModal({ visit, onClose }: { visit: any; onClose: () => void }) {
  const [f, setF] = useState({ status: visit.status === 'Checked In' ? 'Completed' : 'No Show', rating: '', feedback: '', next_step: '', next_at: '', next_type: 'Call back' });
  const { busy, run } = useAction();
  const needsTime = f.next_step === 'follow_up' || f.next_step === 'revisit';
  const submit = async () => {
    const body = {
      status: f.status, rating: f.rating ? Number(f.rating) : undefined, feedback: f.feedback,
      next_step: f.next_step,
      ...(needsTime && f.next_at ? { next_at: localToUtc(f.next_at) } : {}),
      next_type: f.next_type,
    };
    if (await run(() => api.post(`/visits/${visit.id}/complete`, body), 'Visit updated')) onClose();
  };
  // A visit that did not happen can still get a follow-up call; revisit and negotiation follow a completed visit.
  const steps = f.status === 'Completed' ? ['', 'follow_up', 'revisit', 'negotiation'] : ['', 'follow_up'];
  return (
    <Modal title="Close visit" onClose={onClose}>
      <div className="space-y-3">
        <SelectField label="Outcome" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, next_step: '' })}>
          {visit.status === 'Checked In' && <option>Completed</option>}
          <option>No Show</option><option>Cancelled</option>
        </SelectField>
        {f.status === 'Completed' && (
          <SelectField label="Customer interest" value={f.rating} onChange={(e) => setF({ ...f, rating: e.target.value })}>
            <option value="">Not rated</option>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} of 5</option>)}
          </SelectField>
        )}
        <TextareaField label="Feedback" value={f.feedback} onChange={(e) => setF({ ...f, feedback: e.target.value })} />
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink">Next step</legend>
          <div className="flex flex-wrap gap-1.5">
            {steps.map((s) => (
              <button key={s} type="button" aria-pressed={f.next_step === s} onClick={() => setF({ ...f, next_step: s })}
                className={cx('rounded-full border px-2.5 py-1 text-[13px]', f.next_step === s ? 'border-brand bg-brand-soft font-medium text-brand-ink' : 'border-line')}>
                {s === '' ? 'None yet' : s === 'negotiation' ? 'Negotiation (Working Deal)' : NEXT_STEPS[s]}
              </button>
            ))}
          </div>
        </fieldset>
        {needsTime && (
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <TextField label={f.next_step === 'revisit' ? 'Revisit date and time' : 'Follow-up date and time'} type="datetime-local" required min={localInput(new Date())} value={f.next_at} onChange={(e) => setF({ ...f, next_at: e.target.value })} />
            {f.next_step === 'follow_up' && (
              <Select aria-label="Follow-up type" value={f.next_type} onChange={(e) => setF({ ...f, next_type: e.target.value })}>{FOLLOW_UP_TYPES.map((t) => <option key={t}>{t}</option>)}</Select>
            )}
          </div>
        )}
        {needsTime && f.next_at && !inFuture(f.next_at) && <p className="text-[13px] text-red-700 dark:text-red-300">Choose a time in the future.</p>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={needsTime && !inFuture(f.next_at)} onClick={submit}>Save</Button></div>
      </div>
    </Modal>
  );
}

function Summary({ rows }: { rows: any[] }) {
  const now = Date.now();
  const istDay = (t: number) => new Date(t + 330 * 60000).toISOString().slice(0, 10);
  const today = istDay(now);
  const month = today.slice(0, 7);
  const todays = rows.filter((v) => istDay(toTime(v.scheduled_at)) === today && v.status !== 'Cancelled').length;
  const week = rows.filter((v) => OPEN.includes(v.status) && toTime(v.scheduled_at) >= now && toTime(v.scheduled_at) < now + 7 * 86400000).length;
  const toConfirm = rows.filter(needsConfirming).length;
  const thisMonth = rows.filter((v) => istDay(toTime(v.scheduled_at)).startsWith(month));
  const done = thisMonth.filter((v) => ['Checked In', 'Completed'].includes(v.status)).length;
  const noShow = thisMonth.filter((v) => v.status === 'No Show').length;
  const completed = rows.filter((v) => v.status === 'Completed');
  const booked = completed.filter((v) => v.lead_stage === 'Booked').length;
  const tiles: [string, string | number, string][] = [
    ['Today', todays, 'visits'],
    ['Next 7 days', week, 'still open'],
    ['To confirm', toConfirm, 'within 48 hours'],
    ['Done this month', done, 'checked in or completed'],
    ['No-show rate', done + noShow ? `${Math.round((noShow / (done + noShow)) * 100)}%` : '—', 'this month'],
    ['Visit to booking', completed.length ? `${Math.round((booked / completed.length) * 100)}%` : '—', `${booked} of ${completed.length} completed`],
  ];
  return (
    <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map(([label, value, hint]) => (
        <Card key={label} className="px-3 py-2.5">
          <p className="text-[12px] text-muted">{label}</p>
          <p className="font-display text-xl font-semibold text-ink tabular-nums">{value}</p>
          <p className="truncate text-[11.5px] text-muted">{hint}</p>
        </Card>
      ))}
    </div>
  );
}

export default function Visits() {
  const { can, user } = useAuth();
  const { data, error, loading, reload } = useApi('/visits', ['visits']);
  const [checkIn, setCheckIn] = useState<any>(null);
  const [closing, setClosing] = useState<any>(null);
  const [moving, setMoving] = useState<any>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const { run } = useAction();
  const { f, set, clear, activeCount } = useFilters(['view', 'stage', 'q', 'project', 'host', 'booked_by', 'kind', 'rating', 'lead_stage', 'source', 'attention', 'next', 'date', 'from', 'to'] as const, { defaults: { view: 'board' } });
  if (loading) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;
  const after = () => { setCheckIn(null); setClosing(null); setMoving(null); void reload(); };
  const all: any[] = data.visits;

  // Every filter except the stage, so the stage tabs can show how many each would give.
  const filtered = filterRows<any>(all, f, {
    search: (v) => [v.lead_name, v.project_name, v.host_name, v.booked_by, v.feedback],
    match: {
      project: (v) => v.project_name, host: (v) => v.host_name, booked_by: (v) => v.booked_by, lead_stage: (v) => v.lead_stage,
      source: (v) => v.lead_source, next: (v) => v.next_step || 'none', rating: (v) => (v.rating ? String(v.rating) : 'none'),
    },
    date: (v) => v.scheduled_at,
    test: (v) => (!f.kind || (f.kind === 'pickup' ? Boolean(v.pickup) : f.kind === 'revisit' ? Boolean(v.previous_visits) : f.kind === 'rescheduled' ? v.reschedules > 0 : !v.previous_visits))
      && (!f.attention || (f.attention === 'late' ? isLate(v) : f.attention === 'confirm' ? needsConfirming(v) : noNextStep(v))),
  });
  const rows = f.stage ? filtered.filter((v) => v.status === f.stage) : filtered;
  const works = !isViewOnly(user!.role);
  const byTime = (a: any, b: any) => toTime(a.scheduled_at) - toTime(b.scheduled_at);
  const viewChanged = f.view !== 'board' ? 1 : 0; // Switching view is not a filter.

  const actions = (v: any, compact = false) => (
    <div className={cx('flex flex-wrap gap-1.5', compact && 'mt-2')}>
      {works && v.status === 'Scheduled' && <Button size="sm" onClick={() => run(async () => { await api.post(`/visits/${v.id}/confirm`); await reload(); }, 'Marked confirmed')}>Confirm</Button>}
      {works && ['Scheduled', 'Confirmed'].includes(v.status) && can('visit.checkin') && <Button size="sm" variant="primary" onClick={() => setCheckIn(v)}>Check in</Button>}
      {works && ['Scheduled', 'Confirmed', 'No Show'].includes(v.status) && <Button size="sm" onClick={() => setMoving(v)}>Reschedule</Button>}
      {works && OPEN.includes(v.status) && <Button size="sm" variant="ghost" onClick={() => setClosing(v)}>Close</Button>}
      {!compact && ['Scheduled', 'Confirmed'].includes(v.status) && (
        <a target="_blank" rel="noreferrer" href={googleCalendarLink(`Site visit: ${v.lead_name}`, v.project_name, v.scheduled_at)}><Button size="sm" variant="ghost">Add to calendar</Button></a>
      )}
      {!compact && user!.role === 'admin' && <EraseButton label="Delete" onClick={() => setDeleting(v)} />}
    </div>
  );

  const flags = (v: any) => (
    <span className="flex flex-wrap gap-1">
      {isLate(v) && <Badge tone="red">Late</Badge>}
      {needsConfirming(v) && <Badge tone="amber">To confirm</Badge>}
      {v.previous_visits > 0 && <Badge>Revisit</Badge>}
      {v.pickup ? <Badge>Pickup</Badge> : null}
      {v.reschedules > 0 && <Badge>Moved {v.reschedules}×</Badge>}
      {v.rating ? <Badge tone="green"><Star size={11} />{v.rating}/5</Badge> : null}
      {v.status === 'Completed' && v.next_step && <Badge tone="brand">{NEXT_STEPS[v.next_step]}</Badge>}
      {noNextStep(v) && <Badge tone="amber">No next step</Badge>}
    </span>
  );

  const card = (v: any) => (
    <li key={v.id} className="rounded-xl border border-line bg-surface p-3 shadow-sm">
      <Link to={`/leads/${v.lead_id}`} className="block truncate text-sm font-medium text-ink hover:underline">{v.lead_name}</Link>
      <p className="mt-0.5 flex items-center gap-1 text-[12.5px] text-muted"><CalendarClock size={12} aria-hidden />{dateTime(v.scheduled_at)}</p>
      <p className="flex items-center gap-1 truncate text-[12.5px] text-muted"><MapPin size={12} aria-hidden />{v.project_name}{v.host_name ? ` · ${v.host_name}` : ''}</p>
      <div className="mt-1.5">{flags(v)}</div>
      {v.feedback && <p className="mt-1 line-clamp-2 text-[12.5px]">{v.feedback}</p>}
      {actions(v, true)}
    </li>
  );

  const board = (
    <div className="scroll-thin -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 lg:mx-0 lg:px-0 2xl:grid 2xl:grid-cols-5 2xl:overflow-visible">
      {COLUMNS.map((c) => {
        const items = rows.filter((v) => c.statuses.includes(v.status)).sort(byTime);
        const shown = c.statuses.some((s) => OPEN.includes(s)) ? items : items.reverse(); // Newest first once a visit is over.
        return (
          <section key={c.title} className="w-[78vw] max-w-[17rem] shrink-0 snap-start rounded-2xl bg-surface-2 p-2 sm:w-64 2xl:w-auto 2xl:max-w-none" aria-label={c.title}>
            <header className="flex items-baseline justify-between px-1.5 pt-1 pb-1">
              <h2 className="text-[14px] font-semibold text-ink">{c.title}</h2>
              <span className="rounded-full bg-surface px-2 text-[12px] text-muted tabular-nums">{items.length}</span>
            </header>
            <p className="px-1.5 pb-2 text-[11.5px] text-muted">{c.hint}</p>
            {shown.length ? <ul className="space-y-2">{shown.slice(0, 60).map(card)}</ul> : <p className="px-1.5 py-6 text-center text-[12.5px] text-muted">Nothing here</p>}
            {shown.length > 60 && <p className="px-1.5 pt-2 text-[12px] text-muted">{shown.length - 60} more. Narrow the filters or use the list.</p>}
          </section>
        );
      })}
    </div>
  );

  const list = (items: any[]) => (
    <ul className="divide-y divide-line">
      {items.map((v) => (
        <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <Link to={`/leads/${v.lead_id}`} className="font-medium text-ink hover:underline">{v.lead_name}</Link>
            <p className="truncate text-[13px] text-muted">{dateTime(v.scheduled_at)} · {v.project_name}{v.host_name ? ` · ${v.host_name}` : ''}{v.booked_by ? ` · booked by ${v.booked_by}` : ''}{v.latitude ? ' · Location saved' : ''}</p>
            <div className="mt-1">{flags(v)}</div>
            {v.feedback && <p className="text-[13px]">{v.feedback}</p>}
          </div>
          <Badge tone={TONE[v.status]}>{v.status}</Badge>
          {actions(v)}
        </li>
      ))}
    </ul>
  );
  const open = rows.filter((v) => OPEN.includes(v.status)).sort(byTime);
  const past = rows.filter((v) => !OPEN.includes(v.status));

  return (
    <Page>
      <PageHeader title="Site Visits" subtitle="From booking to the next step: confirm, check in with the customer's code, close with feedback" actions={
        <div className="flex rounded-lg border border-line p-0.5" role="group" aria-label="View">
          <button type="button" aria-pressed={f.view === 'board'} onClick={() => set({ view: 'board' })} className={cx('flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px]', f.view === 'board' ? 'bg-brand text-white dark:text-slate-950' : 'text-muted')}><Columns3 size={14} aria-hidden />Pipeline</button>
          <button type="button" aria-pressed={f.view === 'list'} onClick={() => set({ view: 'list' })} className={cx('flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px]', f.view === 'list' ? 'bg-brand text-white dark:text-slate-950' : 'text-muted')}><List size={14} aria-hidden />List</button>
        </div>
      } />
      <Summary rows={all} />
      <CountTabs label="Visit stage" value={f.stage} onChange={(stage) => set({ stage })} tabs={[
        { value: '', label: 'All', count: filtered.length },
        ...STAGES.map((s) => ({ value: s, label: s, count: filtered.filter((v) => v.status === s).length })),
      ]} />
      <FilterBar search={<SearchBox placeholder="Search customer, project, host or feedback" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount - viewChanged} onClear={() => { clear(); }} shown={rows.length} total={all.length} noun="visits">
        <DatePill label="Visit date" preset={f.date} from={f.from} to={f.to} extra={FUTURE_PRESETS} onChange={(date, from, to) => set({ date, from, to })} />
        <FilterPill label="Needs attention" value={f.attention} options={[{ value: 'confirm', label: 'To confirm in next 48 h' }, { value: 'late', label: 'Late: customer not arrived' }, { value: 'no_next', label: 'Completed, no next step' }]} onChange={(attention) => set({ attention })} />
        <FilterPill label="Project" value={f.project} options={optionsFrom<any>(all, (v) => v.project_name)} onChange={(project) => set({ project })} />
        <FilterPill label="Host" value={f.host} options={optionsFrom<any>(all, (v) => v.host_name)} onChange={(host) => set({ host })} />
        <FilterPill label="Booked by" value={f.booked_by} options={optionsFrom<any>(all, (v) => v.booked_by)} onChange={(booked_by) => set({ booked_by })} />
        <FilterPill label="Type" value={f.kind} options={[{ value: 'first', label: 'First visit' }, { value: 'revisit', label: 'Revisit' }, { value: 'pickup', label: 'Pickup needed' }, { value: 'rescheduled', label: 'Rescheduled' }]} onChange={(kind) => set({ kind })} />
        <FilterPill label="Interest" value={f.rating} options={[...[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${n} of 5` })), { value: 'none', label: 'Not rated' }]} onChange={(rating) => set({ rating })} />
        <FilterPill label="Next step" value={f.next} options={[{ value: 'follow_up', label: 'Follow-up' }, { value: 'revisit', label: 'Revisit' }, { value: 'negotiation', label: 'Negotiation' }, { value: 'none', label: 'Not decided' }]} onChange={(next) => set({ next })} />
        <FilterPill label="Lead stage" value={f.lead_stage} options={optionsFrom<any>(all, (v) => v.lead_stage)} onChange={(lead_stage) => set({ lead_stage })} />
        <FilterPill label="Source" value={f.source} options={optionsFrom<any>(all, (v) => v.lead_source)} onChange={(source) => set({ source })} />
      </FilterBar>
      {f.view === 'list' ? (
        <div className="space-y-4">
          <Card>
            <h2 className="px-4 pt-3.5 pb-2 text-[15px] font-semibold">Upcoming and at site</h2>
            {open.length ? list(open) : <Empty title="No upcoming visits">Schedule one from a lead's page.</Empty>}
          </Card>
          {!!past.length && <Card><h2 className="px-4 pt-3.5 pb-2 text-[15px] font-semibold">Past visits</h2>{list(past)}</Card>}
        </div>
      ) : board}
      {checkIn && <CheckInModal visit={checkIn} onClose={after} />}
      {closing && <CloseModal visit={closing} onClose={after} />}
      {moving && <RescheduleModal visit={moving} onClose={after} />}
      {deleting && (
        <ConfirmErase title="Delete site visit" onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); void reload(); }}
          action={() => api.del(`/erase/visits/${deleting.id}`)}>
          <p className="text-ink">The {deleting.status.toLowerCase()} visit for {deleting.lead_name} on {dateTime(deleting.scheduled_at)} is removed. The customer is kept.</p>
        </ConfirmErase>
      )}
    </Page>
  );
}
