import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DatePill, FUTURE_PRESETS, FilterBar, FilterPill, SearchBox, filterRows, optionsFrom, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { ConfirmErase, EraseButton } from '../components/Erase.tsx';
import { Badge, Button, Card, Empty, ErrorNote, Modal, PageHeader, SelectField, Spinner, TextField, TextareaField, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { dateTime, googleCalendarLink } from '../lib/format.ts';
import { isViewOnly } from '../../../shared/domain.ts';

const TONE: Record<string, 'brand' | 'amber' | 'green' | 'red' | 'neutral'> = {
  Scheduled: 'brand', 'Checked In': 'amber', Completed: 'green', 'No Show': 'red', Cancelled: 'neutral',
};

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

function CloseModal({ visit, onClose }: { visit: any; onClose: () => void }) {
  const [f, setF] = useState({ status: visit.status === 'Checked In' ? 'Completed' : 'No Show', rating: '', feedback: '' });
  const { busy, run } = useAction();
  const submit = async () => {
    const body = { status: f.status, rating: f.rating ? Number(f.rating) : undefined, feedback: f.feedback };
    if (await run(() => api.post(`/visits/${visit.id}/complete`, body), 'Visit updated')) onClose();
  };
  return (
    <Modal title="Close visit" onClose={onClose}>
      <div className="space-y-3">
        <SelectField label="Outcome" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
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
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={submit}>Save</Button></div>
      </div>
    </Modal>
  );
}

export default function Visits() {
  const { can, user } = useAuth();
  const { data, error, loading, reload } = useApi('/visits', ['visits']);
  const [checkIn, setCheckIn] = useState<any>(null);
  const [closing, setClosing] = useState<any>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const { f, set, clear, activeCount } = useFilters(['q', 'status', 'project', 'host', 'kind', 'date', 'from', 'to'] as const);
  if (loading) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;
  const after = () => { setCheckIn(null); setClosing(null); void reload(); };
  const rows = filterRows<any>(data.visits, f, {
    search: (v) => [v.lead_name, v.project_name, v.host_name],
    match: { status: (v) => v.status, project: (v) => v.project_name, host: (v) => v.host_name },
    date: (v) => v.scheduled_at,
    test: (v) => !f.kind || (f.kind === 'pickup' ? Boolean(v.pickup) : f.kind === 'revisit' ? Boolean(v.previous_visits) : !v.previous_visits),
  });
  const open = rows.filter((v: any) => ['Scheduled', 'Checked In'].includes(v.status)).reverse();
  const past = rows.filter((v: any) => !['Scheduled', 'Checked In'].includes(v.status));
  const works = !isViewOnly(user!.role);

  const list = (rows: any[]) => (
    <ul className="divide-y divide-line">
      {rows.map((v) => (
        <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <Link to={`/leads/${v.lead_id}`} className="font-medium text-ink hover:underline">{v.lead_name}</Link>
            <p className="truncate text-[13px] text-muted">{dateTime(v.scheduled_at)} · {v.project_name}{v.host_name ? ` · ${v.host_name}` : ''}{v.pickup ? ' · Pickup' : ''}{v.previous_visits ? ' · Revisit' : ''}{v.latitude ? ' · Location saved' : ''}</p>
            {v.feedback && <p className="text-[13px]">{v.feedback}</p>}
          </div>
          <Badge tone={TONE[v.status]}>{v.status}</Badge>
          {v.status === 'Scheduled' && (
            <a target="_blank" rel="noreferrer" href={googleCalendarLink(`Site visit: ${v.lead_name}`, v.project_name, v.scheduled_at)}><Button size="sm" variant="ghost">Add to calendar</Button></a>
          )}
          {works && v.status === 'Scheduled' && can('visit.checkin') && <Button size="sm" variant="primary" onClick={() => setCheckIn(v)}>Check in</Button>}
          {works && ['Scheduled', 'Checked In'].includes(v.status) && <Button size="sm" onClick={() => setClosing(v)}>Close</Button>}
          {user!.role === 'admin' && <EraseButton label="Delete" onClick={() => setDeleting(v)} />}
        </li>
      ))}
    </ul>
  );

  return (
    <Page>
      <PageHeader title="Site Visits" subtitle="Check customers in with the code sent to them on WhatsApp" />
      <FilterBar search={<SearchBox placeholder="Search customer, project or host" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={rows.length} total={data.visits.length} noun="visits">
        <DatePill label="Visit date" preset={f.date} from={f.from} to={f.to} extra={FUTURE_PRESETS} onChange={(date, from, to) => set({ date, from, to })} />
        <FilterPill label="Status" value={f.status} options={optionsFrom<any>(data.visits, (v) => v.status)} onChange={(status) => set({ status })} />
        <FilterPill label="Project" value={f.project} options={optionsFrom<any>(data.visits, (v) => v.project_name)} onChange={(project) => set({ project })} />
        <FilterPill label="Host" value={f.host} options={optionsFrom<any>(data.visits, (v) => v.host_name)} onChange={(host) => set({ host })} />
        <FilterPill label="Type" value={f.kind} options={[{ value: 'first', label: 'First visit' }, { value: 'revisit', label: 'Revisit' }, { value: 'pickup', label: 'Pickup needed' }]} onChange={(kind) => set({ kind })} />
      </FilterBar>
      <div className="space-y-4">
        <Card>
          <h2 className="px-4 pt-3.5 pb-2 text-[15px] font-semibold">Upcoming</h2>
          {open.length ? list(open) : <Empty title="No upcoming visits">Schedule one from a lead's page.</Empty>}
        </Card>
        {!!past.length && <Card><h2 className="px-4 pt-3.5 pb-2 text-[15px] font-semibold">Past visits</h2>{list(past)}</Card>}
      </div>
      {checkIn && <CheckInModal visit={checkIn} onClose={after} />}
      {closing && <CloseModal visit={closing} onClose={after} />}
      {deleting && (
        <ConfirmErase title="Delete site visit" onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); void reload(); }}
          action={() => api.del(`/erase/visits/${deleting.id}`)}>
          <p className="text-ink">The {deleting.status.toLowerCase()} visit for {deleting.lead_name} on {dateTime(deleting.scheduled_at)} is removed. The customer is kept.</p>
        </ConfirmErase>
      )}
    </Page>
  );
}
