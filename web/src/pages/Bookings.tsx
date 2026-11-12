import { Plus, Printer, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { COMPANY, HANDOVER_STAGES } from '../../../shared/domain.ts';
import { DatePill, FilterBar, FilterPill, SearchBox, filterRows, optionsFrom, toOptions, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, Empty, ErrorNote, IconButton, Input, Logo, Modal, Notice, PageHeader, SelectField, Spinner, Stat, TextField, useAction, useToast } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { dateTime, fullRupees, isOverdue, lakhs } from '../lib/format.ts';

interface Item { label: string; due_date: string; amount_lakhs: string }

function ScheduleEditor({ booking, payments, plan, onClose }: { booking: any; payments: any[]; plan: { label: string; percent: number }[]; onClose: () => void }) {
  const paid = payments.filter((p) => p.paid_at).reduce((s, p) => s + p.amount_lakhs, 0);
  const open = payments.filter((p) => !p.paid_at);
  const [items, setItems] = useState<Item[]>(() => {
    if (open.length) return open.map((p) => ({ label: p.label, due_date: p.due_date, amount_lakhs: String(p.amount_lakhs) }));
    return plan.length
      ? plan.map((p) => ({ label: p.label, due_date: '', amount_lakhs: String(Math.round(booking.amount_lakhs * p.percent) / 100) }))
      : [{ label: 'Booking amount', due_date: '', amount_lakhs: String(booking.amount_lakhs - paid) }];
  });
  const { busy, run } = useAction();
  const total = Math.round((items.reduce((s, i) => s + (Number(i.amount_lakhs) || 0), 0) + paid) * 100) / 100;
  const set = (i: number, patch: Partial<Item>) => setItems((list) => list.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  const save = async () => {
    const body = { items: items.map((i) => ({ ...i, amount_lakhs: Number(i.amount_lakhs) })) };
    if (await run(() => api.put(`/bookings/${booking.id}/schedule`, body), 'Schedule saved')) onClose();
  };
  return (
    <Modal title="Payment schedule" onClose={onClose} wide>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="grid grid-cols-[1fr_9.5rem_6rem_auto] items-center gap-2">
            <Input aria-label="Milestone" placeholder="Milestone" value={item.label} onChange={(e) => set(i, { label: e.target.value })} />
            <Input aria-label="Due date" type="date" value={item.due_date} onChange={(e) => set(i, { due_date: e.target.value })} />
            <Input aria-label="Amount in lakhs" type="number" step="0.01" value={item.amount_lakhs} onChange={(e) => set(i, { amount_lakhs: e.target.value })} />
            <IconButton label="Remove milestone" onClick={() => setItems((l) => l.filter((_, n) => n !== i))}><Trash2 size={16} /></IconButton>
          </div>
        ))}
      </div>
      <Button size="sm" className="mt-2" onClick={() => setItems((l) => [...l, { label: '', due_date: '', amount_lakhs: '' }])}><Plus size={15} />Add milestone</Button>
      <p className="mt-3 text-sm">Total {paid > 0 && `(including ${lakhs(paid)} paid) `}<b className="text-ink">{lakhs(total)}</b> of {lakhs(booking.amount_lakhs)}</p>
      <div className="mt-3 flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Save schedule</Button></div>
    </Modal>
  );
}

function BookingModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { can, user } = useAuth();
  const { data, reload } = useApi(`/bookings/${id}`, ['bookings']);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState<any>(null);
  const [reference, setReference] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [portal, setPortal] = useState('');
  const toast = useToast();
  const { busy, run } = useAction();
  if (!data) return <Modal title="Booking" onClose={onClose}><Spinner /></Modal>;
  const { booking, payments, default_plan } = data;
  const manage = can('booking.manage') && booking.status === 'active';

  const pay = async () => {
    const r = await run(() => api.post(`/payments/${paying.id}/paid`, { reference }));
    if (r) { setPaying(null); setReference(''); void reload(); }
  };
  const handover = async (status: string) => {
    await run(() => api.post(`/bookings/${id}/handover`, { status }));
    void reload();
  };
  const cancel = async () => {
    if (await run(() => api.post(`/bookings/${id}/cancel`, { reason }), 'Booking cancelled')) onClose();
  };
  const makePortal = async () => {
    const r = await run(() => api.post(`/bookings/${id}/portal`));
    if (r) { setPortal(r.url); void reload(); }
  };
  const stopPortal = async () => {
    await run(() => api.del(`/bookings/${id}/portal`), 'Buyer page turned off');
    setPortal('');
    void reload();
  };

  return (
    <Modal title={`${booking.lead_name}: ${booking.project_name}`} onClose={onClose} wide>
      <p className="text-sm text-muted">Tower {booking.tower} · Unit {booking.unit_number} · {lakhs(booking.amount_lakhs)}{booking.discount_percent ? ` · ${booking.discount_percent}% discount` : ''}</p>
      {booking.status === 'cancelled' && <div className="mt-2"><Notice>This booking was cancelled.</Notice></div>}
      <div className="mt-3 max-w-56">
        <SelectField label="Handover stage" disabled={!manage} value={booking.handover_status} onChange={(e) => handover(e.target.value)}>
          {HANDOVER_STAGES.map((s) => <option key={s}>{s}</option>)}
        </SelectField>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <h3 className="text-[15px] font-semibold">Payments</h3>
        {manage && <Button size="sm" onClick={() => setEditing(true)}>{payments.length ? 'Edit schedule' : 'Create schedule'}</Button>}
      </div>
      {!payments.length && <Empty title="No schedule yet" />}
      <ul className="mt-1 divide-y divide-line">
        {payments.map((p: any) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <div className="min-w-40 flex-1">
              <p className="font-medium text-ink">{p.label}</p>
              <p className={!p.paid_at && isOverdue(`${p.due_date} 23:59:59`) ? 'text-xs text-red-700 dark:text-red-400' : 'text-xs text-muted'}>
                Due {p.due_date}{p.paid_at ? ` · Paid ${dateTime(p.paid_at)}` : ''}
              </p>
            </div>
            <span className="font-medium text-ink tabular-nums">{lakhs(p.amount_lakhs)}</span>
            {p.paid_at
              ? <Link to={`/bookings/${id}/receipt/${p.id}`} target="_blank"><Button size="sm"><Printer size={14} />{p.receipt_number}</Button></Link>
              : can('payment.record') && booking.status === 'active' && <Button size="sm" variant="primary" onClick={() => setPaying(p)}>Record payment</Button>}
          </li>
        ))}
      </ul>
      {manage && (
        <div className="mt-4 rounded-lg border border-line p-3">
          <h3 className="text-[15px] font-semibold">Buyer page</h3>
          <p className="text-[13px] text-muted">A private link where the buyer sees their payments and handover progress, with no login. Creating a new link stops the old one.</p>
          {portal && <p className="mt-2 rounded bg-surface-2 p-2 text-xs break-all text-ink">{portal}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" busy={busy} onClick={makePortal}>{booking.portal_hash ? 'Create new link' : 'Create link'}</Button>
            {portal && <Button size="sm" onClick={async () => { await navigator.clipboard.writeText(portal); toast('Link copied'); }}>Copy link</Button>}
            {booking.portal_hash && <Button size="sm" variant="ghost" busy={busy} onClick={stopPortal}>Turn off</Button>}
          </div>
        </div>
      )}
      {user!.role === 'admin' && booking.status === 'active' && (
        <Button size="sm" variant="ghost" className="mt-3 text-red-700 dark:text-red-400" onClick={() => setCancelling(true)}>Cancel booking</Button>
      )}
      {editing && <ScheduleEditor booking={booking} payments={payments} plan={default_plan} onClose={() => { setEditing(false); void reload(); }} />}
      {paying && (
        <Modal title={`Record ${paying.label}`} onClose={() => setPaying(null)}>
          <TextField label="Cheque or transaction reference" required value={reference} onChange={(e) => setReference(e.target.value)} />
          <div className="mt-3 flex justify-end gap-2"><Button onClick={() => setPaying(null)}>Cancel</Button><Button variant="primary" busy={busy} disabled={reference.trim().length < 3} onClick={pay}>Save and create receipt</Button></div>
        </Modal>
      )}
      {cancelling && (
        <Modal title="Cancel this booking?" onClose={() => setCancelling(false)}>
          <Notice>The unit becomes available again, and unpaid commission is reversed.</Notice>
          <div className="mt-3"><TextField label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="mt-3 flex justify-end gap-2"><Button onClick={() => setCancelling(false)}>Keep booking</Button><Button variant="danger" busy={busy} disabled={reason.trim().length < 3} onClick={cancel}>Cancel booking</Button></div>
        </Modal>
      )}
    </Modal>
  );
}

/** Printable receipt, opened in its own tab. */
export function Receipt() {
  const { id, paymentId } = useParams();
  const { data, error } = useApi(`/bookings/${id}`);
  useEffect(() => {
    if (data) document.title = 'Receipt';
  }, [data]);
  if (error) return <div className="p-6"><ErrorNote>{error}</ErrorNote></div>;
  if (!data) return <Spinner />;
  const payment = data.payments.find((p: any) => String(p.id) === paymentId);
  if (!payment?.paid_at) return <div className="p-6"><ErrorNote>Receipt not found.</ErrorNote></div>;
  return (
    <div className="mx-auto max-w-2xl bg-white p-8 text-slate-800">
      <div className="flex items-start justify-between border-b border-slate-300 pb-4">
        <Logo variant="print" className="w-56" />
        <div className="text-right">
          <h1 className="font-display text-2xl font-semibold text-slate-900">Payment Receipt</h1>
          <p className="text-sm">{payment.receipt_number}</p>
          <p className="text-sm">{dateTime(payment.paid_at)}</p>
        </div>
      </div>
      <dl className="mt-5 space-y-2 text-sm">
        {[
          ['Received from', data.booking.lead_name],
          ['Project', data.booking.project_name],
          ['Unit', `Tower ${data.booking.tower}, ${data.booking.unit_number}`],
          ['Towards', payment.label],
          ['Reference', payment.reference],
        ].map(([k, v]) => <div key={k} className="flex justify-between gap-6 border-b border-slate-100 pb-1"><dt className="text-slate-500">{k}</dt><dd className="font-medium">{v}</dd></div>)}
      </dl>
      <p className="mt-5 text-right text-xl font-semibold text-slate-900">{fullRupees(payment.amount_lakhs)}</p>
      <p className="mt-8 text-xs text-slate-500">{[COMPANY.name, COMPANY.address].filter(Boolean).join(', ')}</p>
      <Button variant="primary" className="mt-5 print:hidden" onClick={() => window.print()}><Printer size={15} />Print or save as PDF</Button>
    </div>
  );
}

export default function Bookings() {
  const { data, error, loading, reload } = useApi('/bookings', ['bookings']);
  const [open, setOpen] = useState<number | null>(null);
  const { f, set, clear, activeCount } = useFilters(['q', 'status', 'project', 'handover', 'payment', 'date', 'from', 'to', 'sort'] as const);
  if (loading) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;
  const rows = filterRows<any>(data.bookings, f, {
    search: (b) => [b.lead_name, b.project_name, b.unit_number, b.tower],
    match: { status: (b) => b.status, project: (b) => b.project_name, handover: (b) => b.handover_status },
    date: (b) => b.created_at,
    test: (b) => !f.payment || (f.payment === 'overdue' ? b.overdue > 0 : f.payment === 'none' ? !b.milestones : b.milestones > 0 && !b.overdue),
    sort: {
      value: (a, b) => b.amount_lakhs - a.amount_lakhs,
      balance: (a, b) => (b.amount_lakhs - b.collected_lakhs) - (a.amount_lakhs - a.collected_lakhs),
    },
  });
  const active = rows.filter((b: any) => b.status === 'active');
  const value = active.reduce((s: number, b: any) => s + b.amount_lakhs, 0);
  const collected = active.reduce((s: number, b: any) => s + b.collected_lakhs, 0);
  const overdue = active.filter((b: any) => b.overdue > 0).length;
  return (
    <Page>
      <PageHeader title="Bookings" subtitle="Payment schedules, receipts and handover" />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active bookings" value={active.length} />
        <Stat label="Booking value" value={lakhs(value)} />
        <Stat label="Collected" value={lakhs(collected)} />
        <Stat label="With overdue payments" value={overdue} tone={overdue ? 'alert' : undefined} />
      </div>
      <FilterBar search={<SearchBox placeholder="Search customer, project or unit" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={rows.length} total={data.bookings.length} noun="bookings">
        <DatePill label="Booked" preset={f.date} from={f.from} to={f.to} onChange={(date, from, to) => set({ date, from, to })} />
        <FilterPill label="Status" value={f.status} options={optionsFrom<any>(data.bookings, (b) => b.status)} onChange={(status) => set({ status })} />
        <FilterPill label="Project" value={f.project} options={optionsFrom<any>(data.bookings, (b) => b.project_name)} onChange={(project) => set({ project })} />
        <FilterPill label="Handover" value={f.handover} options={toOptions(HANDOVER_STAGES)} onChange={(handover) => set({ handover })} />
        <FilterPill label="Payments" value={f.payment} options={[{ value: 'overdue', label: 'Overdue' }, { value: 'clear', label: 'On track' }, { value: 'none', label: 'No schedule' }]} onChange={(payment) => set({ payment })} />
        <FilterPill label="Sort" value={f.sort} options={[{ value: '', label: 'Newest first' }, { value: 'value', label: 'Highest value' }, { value: 'balance', label: 'Largest balance' }]} onChange={(sort) => set({ sort })} clearable={false} />
      </FilterBar>
      <Card>
        {!data.bookings.length && <Empty title="No bookings yet">An approved booking request appears here.</Empty>}
        {!!data.bookings.length && !rows.length && <Empty title="No bookings match">Try clearing a filter.</Empty>}
        <ul className="divide-y divide-line">
          {rows.map((b: any) => (
            <li key={b.id}>
              <button onClick={() => setOpen(b.id)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-surface-2">
                <span className="min-w-48 flex-1">
                  <span className="block font-medium text-ink">{b.lead_name}</span>
                  <span className="block text-[13px] text-muted">{b.project_name} · Tower {b.tower} · {b.unit_number}</span>
                </span>
                {b.status === 'cancelled' && <Badge tone="red">Cancelled</Badge>}
                {b.overdue > 0 && <Badge tone="red">{b.overdue} overdue</Badge>}
                {!b.milestones && b.status === 'active' && <Badge tone="amber">No schedule</Badge>}
                <Badge tone="brand">{b.handover_status}</Badge>
                <span className="text-sm tabular-nums">{lakhs(b.collected_lakhs)} of {lakhs(b.amount_lakhs)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      {open && <BookingModal id={open} onClose={() => { setOpen(null); void reload(); }} />}
    </Page>
  );
}
