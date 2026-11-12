import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DatePill, FilterBar, FilterPill, SearchBox, filterRows, optionsFrom, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { ConfirmErase, EraseButton } from '../components/Erase.tsx';
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Spinner, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { dateTime, lakhs } from '../lib/format.ts';

export default function Approvals() {
  const { can, user } = useAuth();
  const { data, error, loading, reload } = useApi('/approvals', ['approvals']);
  const { busy, run } = useAction();
  const [deleting, setDeleting] = useState<any>(null);
  const { f, set, clear, activeCount } = useFilters(['q', 'status', 'type', 'project', 'date', 'from', 'to'] as const);
  if (loading) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;
  const review = can('approval.review');
  const rows = filterRows<any>(data.approvals, f, {
    search: (a) => [a.lead_name, a.project_name, a.unit_number, a.requested_by_name],
    match: { status: (a) => a.status, type: (a) => a.type, project: (a) => a.project_name },
    date: (a) => a.created_at,
  });
  const decide = async (id: number, approve: boolean) => {
    await run(() => api.post(`/approvals/${id}/review`, { approve }), approve ? 'Approved' : 'Rejected');
    void reload();
  };
  return (
    <Page>
      <PageHeader title="Approvals" subtitle={review ? 'Bookings and discounts waiting for your decision' : 'Your booking and discount requests'} />
      <FilterBar search={<SearchBox placeholder="Search customer, project or unit" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={rows.length} total={data.approvals.length} noun="requests">
        <DatePill label="Requested" preset={f.date} from={f.from} to={f.to} onChange={(date, from, to) => set({ date, from, to })} />
        <FilterPill label="Status" value={f.status} options={optionsFrom<any>(data.approvals, (a) => a.status)} onChange={(status) => set({ status })} />
        <FilterPill label="Type" value={f.type} options={optionsFrom<any>(data.approvals, (a) => a.type)} onChange={(type) => set({ type })} />
        <FilterPill label="Project" value={f.project} options={optionsFrom<any>(data.approvals, (a) => a.project_name)} onChange={(project) => set({ project })} />
      </FilterBar>
      <Card>
        {!data.approvals.length && <Empty title="Nothing here yet">Requests appear when a booking is raised on a lead.</Empty>}
        {!!data.approvals.length && !rows.length && <Empty title="No requests match">Try clearing a filter.</Empty>}
        <ul className="divide-y divide-line">
          {rows.map((a: any) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-ink"><span className="font-medium capitalize">{a.type}</span> · <Link to={`/leads/${a.lead_id}`} className="hover:underline">{a.lead_name}</Link></p>
                <p className="text-[13px] text-muted">
                  {a.project_name} · Tower {a.tower} · {a.unit_number} · {lakhs(a.amount_lakhs)}{a.discount_percent ? ` · ${a.discount_percent}% discount` : ''}
                </p>
                <p className="text-[13px] text-muted">Requested by {a.requested_by_name} · {dateTime(a.created_at)}</p>
                {a.note && <p className="text-sm">{a.note}</p>}
              </div>
              <Badge tone={a.status === 'approved' ? 'green' : a.status === 'rejected' ? 'red' : 'amber'}>{a.status}</Badge>
              {review && a.status === 'pending' && (a.requested_by !== user!.id || user!.role === 'admin') && (
                <span className="flex gap-2">
                  <Button size="sm" variant="primary" busy={busy} onClick={() => decide(a.id, true)}>Approve</Button>
                  <Button size="sm" busy={busy} onClick={() => decide(a.id, false)}>Reject</Button>
                </span>
              )}
              {user!.role === 'admin' && <EraseButton label="Delete" onClick={() => setDeleting(a)} />}
            </li>
          ))}
        </ul>
      </Card>
      {deleting && (
        <ConfirmErase title="Delete approval request" onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); void reload(); }}
          action={() => api.del(`/erase/approvals/${deleting.id}`)}>
          <p className="text-ink">The {deleting.type} request for {deleting.lead_name} ({deleting.status}) is removed. The customer is kept.</p>
          {deleting.type === 'booking' && deleting.status === 'approved' && <p className="text-muted">If a booking was made from this request, the server will refuse: erase the booking first.</p>}
        </ConfirmErase>
      )}
    </Page>
  );
}
