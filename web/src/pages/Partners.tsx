import { CalendarClock, History, MessageCircle, Phone, Plus, Trophy, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { isLeadRole } from '../../../shared/domain.ts';
import { FilterBar, FilterPill, SearchBox, filterRows, optionsFrom, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { ConfirmErase, EraseButton } from '../components/Erase.tsx';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Modal, PageHeader, SelectField, Spinner, Stat, TextField, TextareaField, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { dateTime, lakhs, timeAgo } from '../lib/format.ts';

const prettyDate = (d?: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');

function PartnerModal({ partner, managers, canMove, onClose }: { partner: any | null; managers: any[]; canMove: boolean; onClose: () => void }) {
  const [f, setF] = useState({
    name: partner?.name ?? '', firm: partner?.firm ?? '', area: partner?.area ?? '', phone: partner?.phone ?? '', email: partner?.email ?? '',
    rera_agent_number: partner?.rera_agent_number ?? '', commission_percent: String(partner?.commission_percent ?? ''), status: partner?.status ?? 'active',
    manager_id: '',
  });
  const { busy, run } = useAction();
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { manager_id, ...rest } = f;
    const body: any = { ...rest, commission_percent: Number(f.commission_percent) };
    if (!partner && canMove) body.manager_id = manager_id ? Number(manager_id) : null;
    const save = () => (partner ? api.put(`/partners/${partner.id}`, body) : api.post('/partners', body));
    if (await run(save, 'Partner saved')) onClose();
  };
  return (
    <Modal title={partner ? `Edit ${partner.name}` : 'Add channel partner'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextField label="Name" required value={f.name} onChange={(e) => set('name', e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Firm" value={f.firm} onChange={(e) => set('firm', e.target.value)} />
          <TextField label="Area" placeholder="e.g. Andheri East" value={f.area} onChange={(e) => set('area', e.target.value)} />
          <TextField label="Phone" type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
          <TextField label="Email" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
          <TextField label="MahaRERA agent number" value={f.rera_agent_number} onChange={(e) => set('rera_agent_number', e.target.value)} />
          <TextField label="Commission (%)" type="number" step="0.1" min="0" max="20" required value={f.commission_percent} onChange={(e) => set('commission_percent', e.target.value)} />
        </div>
        <SelectField label="Status" value={f.status} onChange={(e) => set('status', e.target.value)}>
          <option value="active">Active</option><option value="paused">Paused</option>
        </SelectField>
        {!partner && canMove && (
          <SelectField label="Sourcing Manager" value={f.manager_id} onChange={(e) => set('manager_id', e.target.value)}>
            <option value="">Not assigned yet</option>
            {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </SelectField>
        )}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function ContactModal({ partner, kinds, today, onClose }: { partner: any; kinds: string[]; today: string; onClose: () => void }) {
  const { data } = useApi(`/partners/${partner.id}/contacts`);
  const [f, setF] = useState({ kind: kinds[0], notes: '', next_contact_on: '' });
  const { busy, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/partners/${partner.id}/contacts`, f), 'Contact logged')) onClose();
  };
  return (
    <Modal title={`Contact log: ${partner.name}`} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="How you contacted them" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {kinds.map((k) => <option key={k}>{k}</option>)}
          </SelectField>
          <TextField label="Contact again on" type="date" min={today} value={f.next_contact_on} onChange={(e) => setF({ ...f, next_contact_on: e.target.value })} />
        </div>
        <TextareaField label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Close</Button><Button type="submit" variant="primary" busy={busy}>Save contact</Button></div>
      </form>
      <h3 className="mt-5 mb-2 text-sm font-semibold text-ink">Earlier contacts</h3>
      {!data ? <Spinner /> : !data.contacts.length ? <p className="text-sm text-muted">Nobody has contacted this partner yet.</p> : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {data.contacts.map((c: any) => (
            <li key={c.id} className="px-3 py-2 text-sm">
              <p className="flex flex-wrap items-center gap-2"><Badge>{c.kind}</Badge><span className="text-muted">{dateTime(c.created_at)} · {c.user_name ?? 'Someone'}</span>
                {c.next_contact_on && <span className="text-muted">· again on {prettyDate(c.next_contact_on)}</span>}</p>
              {c.notes && <p className="mt-1 text-body">{c.notes}</p>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function RegisterLeadModal({ partner, onClose }: { partner: any; onClose: () => void }) {
  const { can, user } = useAuth();
  const { data: projects } = useApi('/projects');
  const { data: directory } = useApi('/directory');
  const [f, setF] = useState({ name: '', phone: '', notes: '', project_id: '', owner_id: '' });
  const [result, setResult] = useState<any>(null);
  const { busy, run } = useAction();
  const people = (directory?.users ?? []).filter((u: any) => isLeadRole(u.role) && (can('lead.reassign') || u.id === user!.id));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { name: f.name, phone: f.phone, notes: f.notes, project_id: f.project_id ? Number(f.project_id) : null, owner_id: f.owner_id ? Number(f.owner_id) : null };
    const r = await run(() => api.post(`/partners/${partner.id}/leads`, body));
    if (r) setResult(r);
  };
  return (
    <Modal title={`Add a lead for ${partner.name}`} onClose={onClose}>
      {result ? (
        <div className="space-y-3">
          <p className="text-ink">
            {result.attributed
              ? 'Lead added and credited to this partner.'
              : 'This buyer already exists and stays credited to the original source. An admin can review it on the lead page.'}
          </p>
          <div className="flex justify-end gap-2"><Link to={`/leads/${result.id}`}><Button>Open lead</Button></Link><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <TextField label="Buyer name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <TextField label="Buyer phone" type="tel" required value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <SelectField label="Project" value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
            <option value="">Not decided yet</option>
            {projects?.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </SelectField>
          <SelectField label="Assign to" value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })} hint="Automatic routing uses your lead routing rules, as for any new lead.">
            <option value="">Automatic routing</option>
            {people.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </SelectField>
          <TextField label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Add lead</Button></div>
        </form>
      )}
    </Modal>
  );
}

function MoveModal({ partner, managers, onClose }: { partner: any; managers: any[]; onClose: () => void }) {
  const [managerId, setManagerId] = useState(String(partner.manager_id ?? ''));
  const { busy, run } = useAction();
  const save = async () => {
    if (await run(() => api.put(`/partners/${partner.id}/manager`, { manager_id: managerId ? Number(managerId) : null }), 'Partner moved')) onClose();
  };
  return (
    <Modal title={`Move ${partner.name}`} onClose={onClose}>
      <div className="space-y-3">
        <SelectField label="Sourcing Manager" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
          <option value="">Not assigned</option>
          {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </SelectField>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Move</Button></div>
      </div>
    </Modal>
  );
}

function PartnerRow({ p, onContact, onLead, onEdit, onMove, onDelete }: { p: any; onContact: () => void; onLead: () => void; onEdit: () => void; onMove?: () => void; onDelete?: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-48 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-medium text-ink">{p.name}
          {p.status === 'paused' && <Badge tone="red">Paused</Badge>}
          {p.due && <Badge tone="amber">Due today</Badge>}
        </p>
        <p className="truncate text-[13px] text-muted">{[p.firm || 'Independent', p.area, p.phone].filter(Boolean).join(' · ')}</p>
        <p className="truncate text-xs text-muted">
          {p.manager_name ? `Sourcing: ${p.manager_name}` : 'Not assigned'}
          {p.last_contact_at ? ` · last contact ${timeAgo(p.last_contact_at)} ago` : ' · never contacted'}
          {p.next_contact_on ? ` · next ${prettyDate(p.next_contact_on)}` : ''}
        </p>
      </div>
      <dl className="flex gap-5 text-sm">
        <div><dt className="text-xs text-muted">Leads</dt><dd className="font-medium text-ink tabular-nums">{p.leads}</dd></div>
        <div><dt className="text-xs text-muted">Bookings</dt><dd className="font-medium text-ink tabular-nums">{p.bookings}</dd></div>
        <div><dt className="text-xs text-muted">Due</dt><dd className="font-medium text-ink tabular-nums">{lakhs(p.due_lakhs)}</dd></div>
      </dl>
      <span className="flex flex-wrap gap-1.5">
        {p.phone && <a href={`tel:${p.phone}`} aria-label={`Call ${p.name}`}><Button size="sm"><Phone size={14} /></Button></a>}
        {p.phone && <a href={`https://wa.me/${p.phone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${p.name}`}><Button size="sm" variant="whatsapp"><MessageCircle size={14} /></Button></a>}
        <Button size="sm" onClick={onContact}><History size={14} />Log contact</Button>
        <Button size="sm" disabled={p.status !== 'active'} onClick={onLead}><UserPlus size={14} />Add lead</Button>
        <Button size="sm" onClick={onEdit}>Edit</Button>
        {onMove && <Button size="sm" onClick={onMove}>Move</Button>}
        {onDelete && <EraseButton label="Delete" onClick={onDelete} />}
      </span>
    </li>
  );
}

export default function Partners() {
  const { can, user } = useAuth();
  const { data, error, loading, reload } = useApi('/partners', ['leads', 'bookings', 'partners', 'visits']);
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [registering, setRegistering] = useState<any>(null);
  const [contacting, setContacting] = useState<any>(null);
  const [moving, setMoving] = useState<any>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const { run } = useAction();
  const startDelete = async (p: any) => { const preview = await run(() => api.get(`/erase/partners/${p.id}`)); if (preview) setDeleting(preview); };
  const { f, set, clear, activeCount } = useFilters(['q', 'status', 'firm', 'area', 'manager', 'commission', 'sort'] as const);
  if (loading) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;
  const partners = filterRows<any>(data.partners, f, {
    search: (p) => [p.name, p.firm, p.area, p.phone, p.rera_agent_number],
    match: { status: (p) => p.status, firm: (p) => p.firm, area: (p) => p.area, manager: (p) => p.manager_name ?? 'Not assigned' },
    sort: { leads: (a, b) => b.leads - a.leads, bookings: (a, b) => b.bookings - a.bookings, due: (a, b) => b.due_lakhs - a.due_lakhs },
  });
  const due = data.partners.filter((p: any) => p.due);
  const commissions = data.commissions.filter((c: any) => !f.commission || c.status === f.commission);
  const setStatus = async (id: number, status: string) => {
    await run(() => api.post(`/commissions/${id}/status`, { status }), status === 'paid' ? 'Marked as paid' : 'Commission approved');
    void reload();
  };
  const done = (fn: (v: any) => void) => () => { fn(null); void reload(); };
  const monthValue = data.month_bookings.reduce((s: number, b: any) => s + b.amount_lakhs, 0);
  const row = (p: any) => (
    <PartnerRow key={p.id} p={p} onContact={() => setContacting(p)} onLead={() => setRegistering(p)} onEdit={() => setEditing(p)} onMove={data.can_move ? () => setMoving(p) : undefined} onDelete={user!.role === 'admin' ? () => startDelete(p) : undefined} />
  );

  return (
    <Page>
      <PageHeader title="Channel Partners" subtitle="Who to contact today, and what partners are bringing in"
        actions={<Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} />Add partner</Button>} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Contact today" value={due.length} tone={due.length ? 'alert' : undefined} hint="Follow-up date reached, or never contacted" />
        <Stat label="Partner leads, last 7 days" value={data.recent_leads.length} />
        <Stat label="Partner site visits, last 7 days" value={data.recent_visits.length} />
        <Stat label="Bookings this month" value={data.month_bookings.length} hint={data.month_bookings.length ? lakhs(monthValue) : undefined} />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Contact today" hint={due.length ? `${due.length} partner${due.length > 1 ? 's' : ''}` : undefined} />
          {!due.length ? <Empty title="Nobody is due today">Partners appear here when their contact-again date arrives.</Empty> : (
            <ul className="divide-y divide-line">{due.map(row)}</ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Top partners" hint="By bookings, then booking value" />
          {!data.top_partners.length ? <Empty title="No partner bookings yet" /> : (
            <ol className="divide-y divide-line">
              {data.top_partners.map((p: any, i: number) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-brand-ink">{i === 0 ? <Trophy size={14} /> : i + 1}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium text-ink">{p.name}</span><span className="block truncate text-xs text-muted">{p.firm || 'Independent'}</span></span>
                  <span className="text-right tabular-nums"><span className="block font-medium text-ink">{p.bookings} booking{p.bookings > 1 ? 's' : ''}</span><span className="block text-xs text-muted">{lakhs(p.booking_lakhs)}</span></span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <FilterBar search={<SearchBox placeholder="Search partner, firm, area or phone" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={partners.length} total={data.partners.length} noun="partners">
        <FilterPill label="Status" value={f.status} options={optionsFrom<any>(data.partners, (p) => p.status)} onChange={(status) => set({ status })} />
        <FilterPill label="Area" value={f.area} options={optionsFrom<any>(data.partners, (p) => p.area)} onChange={(area) => set({ area })} />
        <FilterPill label="Firm" value={f.firm} options={optionsFrom<any>(data.partners, (p) => p.firm)} onChange={(firm) => set({ firm })} />
        {data.can_move && <FilterPill label="Sourcing Manager" value={f.manager} options={optionsFrom<any>(data.partners, (p) => p.manager_name ?? 'Not assigned')} onChange={(manager) => set({ manager })} />}
        <FilterPill label="Commission" value={f.commission} options={optionsFrom<any>(data.commissions, (c) => c.status)} onChange={(commission) => set({ commission })} />
        <FilterPill label="Sort" value={f.sort} options={[{ value: '', label: 'Default' }, { value: 'leads', label: 'Most leads' }, { value: 'bookings', label: 'Most bookings' }, { value: 'due', label: 'Most commission due' }]} onChange={(sort) => set({ sort })} clearable={false} />
      </FilterBar>
      <Card>
        <CardHeader title="All partners" />
        {!data.partners.length && <Empty title="No channel partners yet" />}
        {!!data.partners.length && !partners.length && <Empty title="No partners match">Try clearing a filter.</Empty>}
        <ul className="divide-y divide-line">{partners.map(row)}</ul>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Partner leads, last 7 days" />
          {!data.recent_leads.length ? <Empty title="No new partner leads" /> : (
            <ul className="divide-y divide-line">
              {data.recent_leads.map((l: any) => (
                <li key={l.id} className="px-4 py-2.5 text-sm">
                  <Link to={`/leads/${l.id}`} className="font-medium text-ink hover:underline">{l.name}</Link>
                  <span className="block truncate text-xs text-muted">{l.partner_name} · {l.project_name ?? 'No project'} · {l.stage} · {timeAgo(l.created_at)} ago</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Partner site visits, last 7 days" />
          {!data.recent_visits.length ? <Empty title="No partner site visits" /> : (
            <ul className="divide-y divide-line">
              {data.recent_visits.map((v: any) => (
                <li key={v.id} className="px-4 py-2.5 text-sm">
                  <Link to={`/leads/${v.lead_id}`} className="font-medium text-ink hover:underline">{v.lead_name}</Link>
                  <span className="block truncate text-xs text-muted"><CalendarClock size={12} className="mr-1 inline" />{dateTime(v.scheduled_at)} · {v.project_name} · {v.partner_name} · {v.status}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Bookings this month" />
          {!data.month_bookings.length ? <Empty title="No partner bookings this month" /> : (
            <ul className="divide-y divide-line">
              {data.month_bookings.map((b: any) => (
                <li key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="min-w-0 flex-1"><Link to={`/leads/${b.lead_id}`} className="block truncate font-medium text-ink hover:underline">{b.lead_name}</Link>
                    <span className="block truncate text-xs text-muted">{b.partner_name} · {b.project_name} {b.tower}-{b.unit_number}</span></span>
                  <span className="font-medium text-ink tabular-nums">{lakhs(b.amount_lakhs)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

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
      {editing && <PartnerModal partner={editing === 'new' ? null : editing} managers={data.managers} canMove={data.can_move} onClose={done(setEditing)} />}
      {registering && <RegisterLeadModal partner={registering} onClose={done(setRegistering)} />}
      {contacting && <ContactModal partner={contacting} kinds={data.kinds} today={data.today} onClose={done(setContacting)} />}
      {moving && <MoveModal partner={moving} managers={data.managers} onClose={done(setMoving)} />}
      {deleting && (
        <ConfirmErase title={`Delete ${deleting.partner.name}`} onClose={() => setDeleting(null)} onDone={done(setDeleting)}
          action={() => api.post(`/erase/partners/${deleting.partner.id}`)}>
          <ul className="list-disc space-y-0.5 pl-5 text-ink">
            <li>The partner and {deleting.contacts} contact log entr{deleting.contacts === 1 ? 'y' : 'ies'} are removed.</li>
            <li>{deleting.customers} customer{deleting.customers === 1 ? '' : 's'} stay, without the partner credit.</li>
          </ul>
          {deleting.commissions > 0 && <p className="font-medium text-red-700 dark:text-red-400">{deleting.commissions} booking{deleting.commissions === 1 ? ' carries' : 's carry'} a commission for this partner. Erase {deleting.commissions === 1 ? 'that booking' : 'those bookings'} first.</p>}
        </ConfirmErase>
      )}
    </Page>
  );
}
