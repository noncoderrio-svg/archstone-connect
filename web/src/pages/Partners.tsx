import { Plus, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { FilterBar, FilterPill, SearchBox, filterRows, optionsFrom, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Modal, PageHeader, SelectField, Spinner, TextField, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { lakhs } from '../lib/format.ts';

function PartnerModal({ partner, onClose }: { partner: any | null; onClose: () => void }) {
  const [f, setF] = useState({
    name: partner?.name ?? '', firm: partner?.firm ?? '', phone: partner?.phone ?? '', email: partner?.email ?? '',
    rera_agent_number: partner?.rera_agent_number ?? '', commission_percent: String(partner?.commission_percent ?? ''), status: partner?.status ?? 'active',
  });
  const { busy, run } = useAction();
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, commission_percent: Number(f.commission_percent) };
    const save = () => (partner ? api.put(`/partners/${partner.id}`, body) : api.post('/partners', body));
    if (await run(save, 'Partner saved')) onClose();
  };
  return (
    <Modal title={partner ? `Edit ${partner.name}` : 'Add channel partner'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextField label="Name" required value={f.name} onChange={(e) => set('name', e.target.value)} />
        <TextField label="Firm" value={f.firm} onChange={(e) => set('firm', e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Phone" type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
          <TextField label="Email" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
          <TextField label="MahaRERA agent number" value={f.rera_agent_number} onChange={(e) => set('rera_agent_number', e.target.value)} />
          <TextField label="Commission (%)" type="number" step="0.1" min="0" max="20" required value={f.commission_percent} onChange={(e) => set('commission_percent', e.target.value)} />
        </div>
        <SelectField label="Status" value={f.status} onChange={(e) => set('status', e.target.value)}>
          <option value="active">Active</option><option value="paused">Paused</option>
        </SelectField>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function RegisterLeadModal({ partner, onClose }: { partner: any; onClose: () => void }) {
  const [f, setF] = useState({ name: '', phone: '', notes: '' });
  const [result, setResult] = useState<any>(null);
  const { busy, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post(`/partners/${partner.id}/leads`, f));
    if (r) setResult(r);
  };
  return (
    <Modal title={`Register buyer for ${partner.name}`} onClose={onClose}>
      {result ? (
        <div className="space-y-3">
          <p className="text-ink">
            {result.attributed
              ? 'Buyer registered and credited to this partner.'
              : 'This buyer already exists and stays credited to the original source. An admin can review it on the lead page.'}
          </p>
          <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <TextField label="Buyer name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <TextField label="Buyer phone" type="tel" required value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <TextField label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Register</Button></div>
        </form>
      )}
    </Modal>
  );
}

export default function Partners() {
  const { can, user } = useAuth();
  const { data, error, loading, reload } = useApi('/partners', ['leads', 'bookings']);
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [registering, setRegistering] = useState<any>(null);
  const { run } = useAction();
  const { f, set, clear, activeCount } = useFilters(['q', 'status', 'firm', 'commission', 'sort'] as const);
  if (loading) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;
  const partners = filterRows<any>(data.partners, f, {
    search: (p) => [p.name, p.firm, p.rera_agent_number],
    match: { status: (p) => p.status, firm: (p) => p.firm },
    sort: { leads: (a, b) => b.leads - a.leads, bookings: (a, b) => b.bookings - a.bookings, due: (a, b) => b.due_lakhs - a.due_lakhs },
  });
  const commissions = data.commissions.filter((c: any) => !f.commission || c.status === f.commission);
  const setStatus = async (id: number, status: string) => {
    await run(() => api.post(`/commissions/${id}/status`, { status }), status === 'paid' ? 'Marked as paid' : 'Commission approved');
    void reload();
  };
  return (
    <Page>
      <PageHeader title="Channel Partners" subtitle="The first partner to register a buyer keeps the credit"
        actions={<Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} />Add partner</Button>} />
      <FilterBar search={<SearchBox placeholder="Search partner, firm or RERA number" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={partners.length} total={data.partners.length} noun="partners">
        <FilterPill label="Status" value={f.status} options={optionsFrom<any>(data.partners, (p) => p.status)} onChange={(status) => set({ status })} />
        <FilterPill label="Firm" value={f.firm} options={optionsFrom<any>(data.partners, (p) => p.firm)} onChange={(firm) => set({ firm })} />
        <FilterPill label="Commission" value={f.commission} options={optionsFrom<any>(data.commissions, (c) => c.status)} onChange={(commission) => set({ commission })} />
        <FilterPill label="Sort" value={f.sort} options={[{ value: '', label: 'Default' }, { value: 'leads', label: 'Most leads' }, { value: 'bookings', label: 'Most bookings' }, { value: 'due', label: 'Most commission due' }]} onChange={(sort) => set({ sort })} clearable={false} />
      </FilterBar>
      <Card>
        {!data.partners.length && <Empty title="No channel partners yet" />}
        {!!data.partners.length && !partners.length && <Empty title="No partners match">Try clearing a filter.</Empty>}
        <ul className="divide-y divide-line">
          {partners.map((p: any) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-44 flex-1">
                <p className="font-medium text-ink">{p.name}{p.status === 'paused' && <span className="ml-2"><Badge tone="red">Paused</Badge></span>}</p>
                <p className="truncate text-[13px] text-muted">{p.firm || 'Independent'} · {p.commission_percent}% commission{p.rera_agent_number ? ` · ${p.rera_agent_number}` : ''}</p>
              </div>
              <dl className="flex gap-5 text-sm">
                <div><dt className="text-xs text-muted">Leads</dt><dd className="font-medium text-ink tabular-nums">{p.leads}</dd></div>
                <div><dt className="text-xs text-muted">Bookings</dt><dd className="font-medium text-ink tabular-nums">{p.bookings}</dd></div>
                <div><dt className="text-xs text-muted">Due</dt><dd className="font-medium text-ink tabular-nums">{lakhs(p.due_lakhs)}</dd></div>
                <div><dt className="text-xs text-muted">Paid</dt><dd className="font-medium text-ink tabular-nums">{lakhs(p.paid_lakhs)}</dd></div>
              </dl>
              <span className="flex gap-1.5">
                <Button size="sm" disabled={p.status !== 'active'} onClick={() => setRegistering(p)}><UserPlus size={14} />Register buyer</Button>
                <Button size="sm" onClick={() => setEditing(p)}>Edit</Button>
              </span>
            </li>
          ))}
        </ul>
      </Card>
      {!!commissions.length && (
        <Card className="mt-4">
          <CardHeader title="Commissions" />
          <ul className="divide-y divide-line">
            {commissions.map((c: any) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-44 flex-1"><span className="font-medium text-ink">{c.partner_name}</span> · {c.lead_name}<span className="block text-[13px] text-muted">{c.percent}% of {lakhs(c.booking_lakhs)}</span></span>
                <span className="font-medium text-ink tabular-nums">{lakhs(c.amount_lakhs)}</span>
                <Badge tone={c.status === 'paid' ? 'green' : c.status === 'approved' ? 'brand' : 'amber'}>{c.status}</Badge>
                {c.status === 'pending' && can('booking.manage') && <Button size="sm" onClick={() => setStatus(c.id, 'approved')}>Approve</Button>}
                {c.status === 'approved' && user!.role === 'admin' && <Button size="sm" variant="primary" onClick={() => setStatus(c.id, 'paid')}>Mark paid</Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && <PartnerModal partner={editing === 'new' ? null : editing} onClose={() => { setEditing(null); void reload(); }} />}
      {registering && <RegisterLeadModal partner={registering} onClose={() => { setRegistering(null); void reload(); }} />}
    </Page>
  );
}
