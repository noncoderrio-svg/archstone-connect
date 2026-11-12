import { MessageSquareText, Printer, ReceiptIndianRupee } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { FilterBar, FilterPill, SearchBox, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { ConfirmErase, EraseBooking, EraseButton } from '../components/Erase.tsx';
import { Badge, Button, Card, Empty, ErrorNote, Modal, PageHeader, SelectField, Spinner, Stat, TextField, TextareaField, cx, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { dateTime, lakhs } from '../lib/format.ts';

const STATE_TONE: Record<string, 'green' | 'red' | 'amber' | 'neutral'> = { Received: 'green', Overdue: 'red', 'Due in 7 days': 'amber', Upcoming: 'neutral' };
const prettyDate = (d?: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function FollowUpModal({ payment, outcomes, today, onClose }: { payment: any; outcomes: string[]; today: string; onClose: () => void }) {
  const { data } = useApi(`/payments/${payment.id}/followups`);
  const [f, setF] = useState({ outcome: outcomes[0], notes: '', promised_on: '' });
  const { busy, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/payments/${payment.id}/followups`, f), 'Follow-up saved')) onClose();
  };
  return (
    <Modal title={`Follow-up: ${payment.label}`} onClose={onClose} wide>
      <p className="mb-3 text-sm text-muted">{payment.buyer} · {lakhs(payment.amount_lakhs)} due {prettyDate(payment.due_date)}</p>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>
            {outcomes.map((o) => <option key={o}>{o}</option>)}
          </SelectField>
          <TextField label="Promised date" type="date" min={today} required={f.outcome === 'Promised to pay'} value={f.promised_on} onChange={(e) => setF({ ...f, promised_on: e.target.value })} />
        </div>
        <TextareaField label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Close</Button><Button type="submit" variant="primary" busy={busy}>Save follow-up</Button></div>
      </form>
      <h3 className="mt-5 mb-2 text-sm font-semibold text-ink">Earlier follow-ups</h3>
      {!data ? <Spinner /> : !data.followups.length ? <p className="text-sm text-muted">No follow-ups yet.</p> : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {data.followups.map((x: any) => (
            <li key={x.id} className="px-3 py-2 text-sm">
              <p className="flex flex-wrap items-center gap-2"><Badge tone={x.outcome === 'Dispute' ? 'red' : x.outcome === 'Promised to pay' ? 'green' : 'neutral'}>{x.outcome}</Badge>
                <span className="text-muted">{dateTime(x.created_at)} · {x.user_name ?? 'Someone'}{x.promised_on ? ` · promised ${prettyDate(x.promised_on)}` : ''}</span></p>
              {x.notes && <p className="mt-1 text-body">{x.notes}</p>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function ReceiveModal({ payment, onClose }: { payment: any; onClose: (receipt?: { booking: number; id: number }) => void }) {
  const [reference, setReference] = useState('');
  const { busy, run } = useAction();
  const pay = async () => {
    const r = await run(() => api.post(`/payments/${payment.id}/paid`, { reference }), 'Payment recorded');
    if (r) onClose({ booking: payment.booking_id, id: payment.id });
  };
  return (
    <Modal title={`Mark received: ${payment.label}`} onClose={() => onClose()}>
      <p className="mb-3 text-sm text-muted">{payment.buyer} · {lakhs(payment.amount_lakhs)}</p>
      <TextField label="Cheque or transaction reference" required value={reference} onChange={(e) => setReference(e.target.value)} />
      <div className="mt-3 flex justify-end gap-2"><Button onClick={() => onClose()}>Cancel</Button><Button variant="primary" busy={busy} disabled={reference.trim().length < 3} onClick={pay}>Save and create receipt</Button></div>
    </Modal>
  );
}

export default function Payments() {
  const { can, user } = useAuth();
  const { f, set, clear, activeCount } = useFilters(['project', 'q', 'state', 'stage'] as const);
  const { data, error, loading, reload } = useApi(`/payments/dashboard${f.project ? `?project=${f.project}` : ''}`, ['bookings']);
  const [followUp, setFollowUp] = useState<any>(null);
  const [receiving, setReceiving] = useState<any>(null);
  const [erasing, setErasing] = useState<number | null>(null);
  if (loading && !data) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;

  const q = f.q.trim().toLowerCase();
  const bookings = data.bookings.filter((b: any) =>
    (!q || b.lead_name.toLowerCase().includes(q) || `${b.tower}-${b.unit_number}`.toLowerCase().includes(q) || b.phone.includes(q)) &&
    (!f.stage || b.current_stage === f.stage) &&
    (!f.state || b.stages.some((s: any) => s.state === f.state)),
  );
  const s = data.summary;
  const closeReceive = (receipt?: { booking: number; id: number }) => {
    setReceiving(null);
    if (receipt) window.open(`/bookings/${receipt.booking}/receipt/${receipt.id}`, '_blank', 'noopener');
    void reload();
  };

  return (
    <Page>
      <PageHeader title="Payment follow-up" subtitle="Every active booking on the project, with its payment stages in order"
        actions={data.projects.length > 1 && (
          <SelectField label="Project" value={String(data.project_id)} onChange={(e) => set({ project: e.target.value, stage: '' })}>
            {data.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </SelectField>
        )} />
      {!data.projects.length ? <Card><Empty title="No projects yet">Ask an admin to assign you to a project.</Empty></Card> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Overdue" value={lakhs(s.overdue_lakhs)} tone={s.overdue_lakhs > 0 ? 'alert' : undefined} />
            <Stat label="Due in 7 days" value={lakhs(s.due_week_lakhs)} />
            <Stat label="Collected this month" value={lakhs(s.collected_month_lakhs)} />
            <Stat label="Bookings without a schedule" value={s.without_schedule} tone={s.without_schedule > 0 ? 'alert' : undefined} />
          </div>

          {!!data.stages.length && (
            <Card className="mb-4">
              <div className="flex items-center justify-between px-4 pt-3"><h2 className="text-[15px] font-semibold">Stages</h2><span className="text-xs text-muted">Tap a stage to see buyers whose next payment is that stage</span></div>
              <div className="scroll-thin flex gap-2 overflow-x-auto p-3">
                {data.stages.map((st: any) => {
                  const on = f.stage === st.label;
                  return (
                    <button key={st.label} type="button" aria-pressed={on} onClick={() => set({ stage: on ? '' : st.label })}
                      className={cx('min-w-44 shrink-0 rounded-xl border px-3 py-2 text-left transition-colors', on ? 'border-brand bg-brand-soft' : 'border-line bg-surface hover:border-brand/50')}>
                      <span className="block truncate text-sm font-medium text-ink">{st.label}</span>
                      <span className="block text-xs text-muted">{st.received} received · <span className={st.overdue ? 'text-red-700 dark:text-red-400' : ''}>{st.overdue} overdue</span></span>
                      <span className="mt-1 block text-sm font-semibold text-ink tabular-nums">{lakhs(st.pending_lakhs)} <span className="text-xs font-normal text-muted">pending</span></span>
                    </button>
                  );
                })}
              </div>
            </Card>
          )}

          <FilterBar search={<SearchBox placeholder="Search buyer, flat or phone" value={f.q} onChange={(v) => set({ q: v })} />} activeCount={activeCount - (f.project ? 1 : 0)}
            onClear={() => { clear(); if (f.project) set({ project: f.project }); }} shown={bookings.length} total={data.bookings.length} noun="bookings">
            <FilterPill label="State" value={f.state} options={['Overdue', 'Due in 7 days', 'Upcoming', 'Received'].map((v) => ({ value: v, label: v }))} onChange={(state) => set({ state })} />
            {f.stage && <FilterPill label="Stage" value={f.stage} options={[{ value: f.stage, label: f.stage }]} onChange={(stage) => set({ stage })} />}
          </FilterBar>

          {!bookings.length ? <Card><Empty title={data.bookings.length ? 'No bookings match' : 'No active bookings on this project'} /></Card> : (
            <div className="space-y-3">
              {bookings.map((b: any) => (
                <Card key={b.id}>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <Link to={`/leads/${b.lead_id}`} className="font-medium text-ink hover:underline">{b.lead_name}</Link>
                      <p className="text-[13px] text-muted">Flat {b.tower}-{b.unit_number} · {b.phone} · booked {prettyDate(b.created_at.slice(0, 10))}</p>
                    </div>
                    <p className="text-sm tabular-nums"><span className="font-semibold text-ink">{lakhs(b.collected_lakhs)}</span> <span className="text-muted">of {lakhs(b.amount_lakhs)} collected</span></p>
                    {user!.role === 'admin' && <EraseButton onClick={() => setErasing(b.id)} />}
                  </div>
                  {!b.stages.length ? (
                    <p className="px-4 py-3 text-sm text-muted">No payment schedule yet. <Link to="/bookings" className="text-brand-ink hover:underline">Create one on Bookings</Link>.</p>
                  ) : (
                    <ol className="divide-y divide-line">
                      {b.stages.map((p: any, i: number) => (
                        <li key={p.id} className={cx('flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm', f.stage && p.label === f.stage && 'bg-brand-soft/50')}>
                          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-xs text-muted">{i + 1}</span>
                          <div className="min-w-40 flex-1">
                            <p className="font-medium text-ink">{p.label}</p>
                            <p className="text-xs text-muted">Due {prettyDate(p.due_date)}{p.paid_at ? ` · received ${dateTime(p.paid_at)}` : ''}
                              {!p.paid_at && p.last_outcome ? ` · last: ${p.last_outcome}${p.promised_on ? ` (${prettyDate(p.promised_on)})` : ''}` : ''}</p>
                          </div>
                          <span className="font-medium text-ink tabular-nums">{lakhs(p.amount_lakhs)}</span>
                          <Badge tone={STATE_TONE[p.state]}>{p.state}</Badge>
                          {p.paid_at ? (
                            <Link to={`/bookings/${b.id}/receipt/${p.id}`} target="_blank"><Button size="sm"><Printer size={14} />{p.receipt_number}</Button></Link>
                          ) : (
                            <span className="flex gap-1.5">
                              {can('payment.followup') && <Button size="sm" onClick={() => setFollowUp({ ...p, buyer: b.lead_name })}><MessageSquareText size={14} />Follow-up</Button>}
                              {can('payment.record') && <Button size="sm" variant="primary" onClick={() => setReceiving({ ...p, buyer: b.lead_name })}><ReceiptIndianRupee size={14} />Mark received</Button>}
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      {followUp && <FollowUpModal payment={followUp} outcomes={data.outcomes} today={data.today} onClose={() => { setFollowUp(null); void reload(); }} />}
      {receiving && <ReceiveModal payment={receiving} onClose={closeReceive} />}
      {erasing && <EraseBooking bookingId={erasing} onClose={() => setErasing(null)} onDone={() => { setErasing(null); void reload(); }} />}
    </Page>
  );
}
