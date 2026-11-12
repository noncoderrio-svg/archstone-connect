import { ArrowLeft, Building2, Pencil, Plus, QrCode, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CustomerSearch, type Customer } from '../components/CustomerSearch.tsx';
import { FilterBar, FilterPill, SearchBox, filterRows, optionsFrom, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import {
  Badge, Button, Card, Empty, ErrorNote, Modal, Notice, PageHeader, SelectField, Spinner, TextField, TextareaField, cx, useAction, useToast,
} from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { dateTime, lakhs } from '../lib/format.ts';

const UNIT_STYLE: Record<string, string> = {
  Available: 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:border-emerald-600 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  Hold: 'border-amber-300 bg-amber-50 text-amber-900 hover:border-amber-600 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  Booked: 'border-line bg-surface-2 text-muted hover:border-muted',
  Sold: 'border-line bg-surface-2 text-muted hover:border-muted',
};

function ProjectModal({ project, onClose }: { project: any | null; onClose: () => void }) {
  const [f, setF] = useState({
    name: project?.name ?? '', location: project?.location ?? '', configuration: project?.configuration ?? '', type: project?.type ?? 'Residential',
    price_from_lakhs: project?.price_from_lakhs ?? '', rera_number: project?.rera_number ?? '', brochure_url: project?.brochure_url ?? '',
    status: project?.status ?? 'ongoing', verify_note: project?.verify_note ?? '',
    gst_percent: project?.gst_percent ?? '', stamp_duty_percent: project?.stamp_duty_percent ?? '',
    registration_lakhs: project?.registration_lakhs ?? '', other_charges_lakhs: project?.other_charges_lakhs ?? '',
    call_script: project?.call_script ?? '', objections: project?.objections ?? '',
  });
  const { busy, run } = useAction();
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const number = (v: string | number) => (v === '' ? null : Number(v));
    const body = {
      ...f,
      price_from_lakhs: number(f.price_from_lakhs),
      gst_percent: number(f.gst_percent),
      stamp_duty_percent: number(f.stamp_duty_percent),
      registration_lakhs: number(f.registration_lakhs),
      other_charges_lakhs: number(f.other_charges_lakhs),
    };
    const save = () => (project ? api.put(`/projects/${project.id}`, body) : api.post('/projects', body));
    if (await run(save, 'Project saved')) onClose();
  };
  return (
    <Modal title={project ? `Edit ${project.name}` : 'Add project'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextField label="Project name" required value={f.name} onChange={(e) => set('name', e.target.value)} />
        <TextField label="Location" value={f.location} onChange={(e) => set('location', e.target.value)} />
        <TextField label="Configuration" value={f.configuration} onChange={(e) => set('configuration', e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Starting price (₹ Lakhs)" type="number" value={f.price_from_lakhs} onChange={(e) => set('price_from_lakhs', e.target.value)} />
          <SelectField label="Status" value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="ongoing">Ongoing</option><option value="upcoming">Upcoming</option><option value="completed">Completed</option>
          </SelectField>
        </div>
        <TextField label="MahaRERA number" hint="Project campaigns are blocked until this is added." value={f.rera_number} onChange={(e) => set('rera_number', e.target.value)} />
        <TextField label="Brochure link" type="url" value={f.brochure_url} onChange={(e) => set('brochure_url', e.target.value)} />
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium">Cost sheet rates</legend>
          <p className="mb-2 text-xs text-muted">Enter your confirmed rates. Blank rates are left out of cost sheets.</p>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="GST (%)" type="number" step="0.01" min="0" value={f.gst_percent} onChange={(e) => set('gst_percent', e.target.value)} />
            <TextField label="Stamp duty (%)" type="number" step="0.01" min="0" value={f.stamp_duty_percent} onChange={(e) => set('stamp_duty_percent', e.target.value)} />
            <TextField label="Registration (₹ Lakhs)" type="number" step="0.01" min="0" value={f.registration_lakhs} onChange={(e) => set('registration_lakhs', e.target.value)} />
            <TextField label="Other charges (₹ Lakhs)" type="number" step="0.01" min="0" value={f.other_charges_lakhs} onChange={(e) => set('other_charges_lakhs', e.target.value)} />
          </div>
        </fieldset>
        <TextareaField label="Call script" rows={4} hint="Telecallers see this on each lead." value={f.call_script} onChange={(e) => set('call_script', e.target.value)} />
        <TextareaField label="Objection handling" rows={4} value={f.objections} onChange={(e) => set('objections', e.target.value)} />
        <TextareaField label="Details to verify" hint="Clear this once the details are confirmed." value={f.verify_note} onChange={(e) => set('verify_note', e.target.value)} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function AddUnitsModal({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const [f, setF] = useState({ tower: 'A', floors: '10', per_floor: '4', configuration: '', carpet_sqft: '', price_lakhs: '' });
  const { busy, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      tower: f.tower, floors: Number(f.floors), per_floor: Number(f.per_floor), configuration: f.configuration,
      carpet_sqft: f.carpet_sqft ? Number(f.carpet_sqft) : null, price_lakhs: f.price_lakhs ? Number(f.price_lakhs) : null,
    };
    if (await run(() => api.post(`/projects/${projectId}/units`, body), 'Units added')) onClose();
  };
  return (
    <Modal title="Add units" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <TextField label="Tower" required value={f.tower} onChange={(e) => setF({ ...f, tower: e.target.value })} />
          <TextField label="Floors" type="number" min="1" required value={f.floors} onChange={(e) => setF({ ...f, floors: e.target.value })} />
          <TextField label="Per floor" type="number" min="1" required value={f.per_floor} onChange={(e) => setF({ ...f, per_floor: e.target.value })} />
        </div>
        <TextField label="Configuration" required placeholder="e.g. 2 BHK" value={f.configuration} onChange={(e) => setF({ ...f, configuration: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Carpet area (sq ft)" type="number" value={f.carpet_sqft} onChange={(e) => setF({ ...f, carpet_sqft: e.target.value })} />
          <TextField label="Price (₹ Lakhs)" type="number" value={f.price_lakhs} onChange={(e) => setF({ ...f, price_lakhs: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Add units</Button></div>
      </form>
    </Modal>
  );
}

type UnitAction = '' | 'hold' | 'book' | 'customer';

function UnitModal({ unit, onClose }: { unit: any; onClose: () => void }) {
  const { user, can } = useAuth();
  const [action, setAction] = useState<UnitAction>('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [amount, setAmount] = useState(unit.price_lakhs ? String(unit.price_lakhs) : '');
  const { busy, run } = useAction();
  const toastAfter = useToast();
  const isAdmin = user!.role === 'admin';
  const holder = unit.held_by === user!.id;
  const canHold = can('unit.hold') && unit.status === 'Available';
  const canBook = can('unit.book') && (unit.status === 'Available' || (unit.status === 'Hold' && !unit.pending_booking)) && !unit.has_booking;
  const canChangeCustomer = !unit.has_booking && (
    (unit.status === 'Hold' && !unit.pending_booking && (holder || can('inventory.manage'))) ||
    (['Booked', 'Sold'].includes(unit.status) && can('unit.book'))
  );
  const open = (a: UnitAction) => {
    setAction(a);
    // Booking a held flat starts with the customer it is held for.
    setCustomer(a === 'book' && unit.status === 'Hold' && unit.lead_id ? { id: unit.lead_id, name: unit.lead_name, phone: '', stage: 'Held for' } : null);
  };
  const hold = async () => { if (await run(() => api.post(`/units/${unit.id}/hold`, { lead_id: customer!.id }), 'Flat held')) onClose(); };
  const release = async () => { if (await run(() => api.post(`/units/${unit.id}/release`), 'Hold released')) onClose(); };
  const book = async () => {
    const r = await run(() => api.post(`/units/${unit.id}/book`, { lead_id: customer!.id, amount_lakhs: Number(amount) }));
    if (r) { toastAfter(r.status === 'booked' ? 'Flat booked' : 'Booking sent for approval'); onClose(); }
  };
  const setOwner = async () => { if (await run(() => api.post(`/units/${unit.id}/customer`, { lead_id: customer!.id }), 'Customer updated')) onClose(); };

  return (
    <Modal title={`Unit ${unit.number}, Tower ${unit.tower}`} onClose={onClose}>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div><dt className="text-muted">Status</dt><dd className="font-medium text-ink">{unit.status}</dd></div>
        <div><dt className="text-muted">Configuration</dt><dd className="font-medium text-ink">{unit.configuration || '—'}</dd></div>
        <div><dt className="text-muted">Price</dt><dd className="font-medium text-ink">{lakhs(unit.price_lakhs)}</dd></div>
        <div><dt className="text-muted">Carpet area</dt><dd className="font-medium text-ink">{unit.carpet_sqft ? `${unit.carpet_sqft} sq ft` : '—'}</dd></div>
        {unit.lead_name && <div><dt className="text-muted">Customer</dt><dd className="font-medium text-ink">{unit.lead_name}</dd></div>}
        {unit.hold_until && <div><dt className="text-muted">Held until</dt><dd className="font-medium text-ink">{dateTime(unit.hold_until)}</dd></div>}
      </dl>
      {unit.pending_booking ? <div className="mt-3"><Notice>A booking request for this flat is waiting for approval.</Notice></div> : null}
      {unit.has_booking ? <p className="mt-3 text-[13px] text-muted">This flat has a booking record, so it keeps its buyer. Manage it from Bookings.</p> : null}

      {!action && (
        <div className="mt-4 flex flex-wrap gap-2">
          {canBook && <Button variant="primary" onClick={() => open('book')}>Book flat</Button>}
          {canHold && <Button onClick={() => open('hold')}>Hold flat</Button>}
          {canChangeCustomer && <Button onClick={() => open('customer')}>{unit.lead_id ? 'Change customer' : 'Set customer'}</Button>}
          {unit.status === 'Hold' && (can('inventory.manage') || holder) && <Button busy={busy} onClick={release}>Release hold</Button>}
        </div>
      )}

      {action && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <CustomerSearch value={customer} onChange={setCustomer} label={action === 'hold' ? 'Hold for customer' : 'Customer'} />
          {action === 'book' && (
            <>
              <TextField label="Booking amount (₹ Lakhs)" type="number" step="0.01" min="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
              <p className="text-[13px] text-muted">{isAdmin ? 'As an admin, this books the flat at once.' : 'This goes to an approver. You cannot approve your own request.'}</p>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAction('')}>Back</Button>
            {action === 'hold' && <Button variant="primary" busy={busy} disabled={!customer} onClick={hold}>Hold flat</Button>}
            {action === 'book' && <Button variant="primary" busy={busy} disabled={!customer || !(Number(amount) > 0)} onClick={book}>{isAdmin ? 'Book now' : 'Send for approval'}</Button>}
            {action === 'customer' && <Button variant="primary" busy={busy} disabled={!customer} onClick={setOwner}>Save customer</Button>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Inventory({ project, onEdit }: { project: any; onEdit: () => void }) {
  const { user, can } = useAuth();
  const { data, reload } = useApi(`/projects/${project.id}/units`, ['inventory']);
  const [adding, setAdding] = useState(false);
  const [unit, setUnit] = useState<any>(null);
  const [qr, setQr] = useState<any>(null);
  const { data: media } = useApi(`/media?project=${project.id}`);
  const action = useAction();
  const showQr = async () => setQr((await action.run(() => api.get(`/projects/${project.id}/qr`))) ?? null);
  const canManage = can('inventory.manage') && (user!.role === 'admin' || user!.project_ids.includes(project.id));
  const canEdit = user!.role === 'admin' || (user!.role === 'site_head' && user!.project_ids.includes(project.id));
  const filters = useFilters(['q', 'status', 'tower', 'configuration', 'budget'] as const, { prefix: 'u_' });
  const [showBuyers, setShowBuyers] = useState(false);
  const { data: buyers } = useApi(showBuyers ? `/projects/${project.id}/buyers` : null);
  const shownUnits = filterRows<any>(data?.units, filters.f, {
    search: (u) => [u.number],
    match: { status: (u) => u.status, tower: (u) => u.tower, configuration: (u) => u.configuration },
    test: (u) => !filters.f.budget || (filters.f.budget === 'lt100' ? u.price_lakhs < 100 : filters.f.budget === '100-200' ? u.price_lakhs >= 100 && u.price_lakhs <= 200 : u.price_lakhs > 200),
  });

  const towers = new Map<string, Map<number, any[]>>();
  for (const u of shownUnits) {
    const floors = towers.get(u.tower) ?? new Map<number, any[]>();
    floors.set(u.floor, [...(floors.get(u.floor) ?? []), u]);
    towers.set(u.tower, floors);
  }

  return (
    <Page>
      <Link to="/projects" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft size={15} />Projects</Link>
      <PageHeader title={project.name} subtitle={`${project.location} · ${project.configuration}`} actions={<>
        <Button onClick={() => setShowBuyers(true)}><Users size={15} />Matching buyers</Button>
        <Button onClick={showQr}><QrCode size={15} />WhatsApp QR</Button>
        {canEdit && <Button onClick={onEdit}><Pencil size={15} />Edit project</Button>}
        {canManage && <Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} />Add units</Button>}
      </>} />
      <div className="mb-3 space-y-2">
        {!project.rera_number && <Notice>MahaRERA number is missing, so project marketing is blocked.</Notice>}
        {project.verify_note && <Notice>{project.verify_note}</Notice>}
      </div>
      <div className="mb-3 flex flex-wrap gap-3 text-[13px]" aria-label="Legend">
        {[['Available', project.available_units], ['Hold', project.held_units], ['Booked', project.sold_units]].map(([s, n]) => (
          <span key={String(s)} className="flex items-center gap-1.5"><span className={cx('size-3 rounded border', UNIT_STYLE[String(s)])} />{s} ({n})</span>
        ))}
      </div>
      {!!data?.units.length && (
        <FilterBar search={<SearchBox placeholder="Find a unit number" value={filters.f.q} onChange={(q) => filters.set({ q })} />} activeCount={filters.activeCount} onClear={filters.clear} shown={shownUnits.length} total={data.units.length} noun="units">
          <FilterPill label="Status" value={filters.f.status} options={optionsFrom<any>(data.units, (u) => u.status)} onChange={(status) => filters.set({ status })} />
          <FilterPill label="Tower" value={filters.f.tower} options={optionsFrom<any>(data.units, (u) => u.tower)} onChange={(tower) => filters.set({ tower })} />
          <FilterPill label="Home type" value={filters.f.configuration} options={optionsFrom<any>(data.units, (u) => u.configuration)} onChange={(configuration) => filters.set({ configuration })} />
          <FilterPill label="Price" value={filters.f.budget} options={[{ value: 'lt100', label: 'Under ₹1 Cr' }, { value: '100-200', label: '₹1 to 2 Cr' }, { value: 'gt200', label: 'Above ₹2 Cr' }]} onChange={(budget) => filters.set({ budget })} />
        </FilterBar>
      )}
      {!data && <Spinner />}
      {data && !data.units.length && <Card><Empty title="No units added">Add towers and floors to track availability here.</Empty></Card>}
      {!!data?.units.length && !shownUnits.length && <Card><Empty title="No units match">Try clearing a filter.</Empty></Card>}
      <div className="space-y-4">
        {[...towers.entries()].map(([tower, floors]) => (
          <Card key={tower} className="p-4">
            <h2 className="mb-3 text-[15px] font-semibold">Tower {tower}</h2>
            <div className="scroll-thin space-y-1.5 overflow-x-auto pb-1">
              {[...floors.entries()].map(([floor, units]) => (
                <div key={floor} className="flex items-center gap-1.5">
                  <span className="w-14 shrink-0 text-xs text-muted">Floor {floor}</span>
                  {units.map((u: any) => (
                    <button key={u.id} onClick={() => setUnit(u)} aria-label={`Unit ${u.number}, ${u.status}`} title={`${u.configuration} · ${lakhs(u.price_lakhs)}`}
                      className={cx('h-11 min-w-16 rounded-lg border px-2 text-[13px] font-medium tabular-nums transition-colors', UNIT_STYLE[u.status])}>{u.number}</button>
                  ))}
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
      {!!media?.media.length && (
        <Card className="mt-4 p-4">
          <h2 className="mb-2 text-[15px] font-semibold">Files</h2>
          <div className="flex flex-wrap gap-2">{media.media.map((m: any) => <a key={m.id} href={m.preview} target="_blank" rel="noreferrer"><Badge tone="brand">{m.title}</Badge></a>)}</div>
        </Card>
      )}
      {qr && (
        <Modal title={`QR code for ${project.name}`} onClose={() => setQr(null)}>
          <img src={qr.qr} alt="WhatsApp QR code" className="mx-auto w-64 rounded-lg bg-white" />
          <p className="mt-2 text-center text-[13px] text-muted">Print this on hoardings. Scanning opens a WhatsApp chat with your team, and the project is recorded automatically.</p>
          <a href={qr.qr} download={`archstone-${project.name}-qr.png`} className="mt-3 block text-center"><Button>Download</Button></a>
        </Modal>
      )}
      {showBuyers && (
        <Modal title={`Buyers who may fit ${project.name}`} onClose={() => setShowBuyers(false)} wide>
          {!buyers && <Spinner />}
          {buyers && !buyers.buyers.length && <Empty title="No matching buyers yet">Add budget and home type to your leads to see matches.</Empty>}
          <ul className="divide-y divide-line">
            {buyers?.buyers.map((b: any) => (
              <li key={b.id}>
                <Link to={`/leads/${b.id}`} className="flex items-center gap-3 py-2 hover:bg-surface-2">
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium text-ink">{b.name}</span><span className="block truncate text-xs text-muted">{b.stage}{b.owner_name ? ` · ${b.owner_name}` : ''} · {b.reasons.join(' · ')}</span></span>
                  <Badge tone={b.match >= 80 ? 'green' : 'brand'}>{b.match}%</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Modal>
      )}
      {adding && <AddUnitsModal projectId={project.id} onClose={() => { setAdding(false); void reload(); }} />}
      {unit && <UnitModal unit={unit} onClose={() => { setUnit(null); void reload(); }} />}
    </Page>
  );
}

export default function Projects() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi('/projects', ['inventory']);
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const { f, set, clear, activeCount } = useFilters(['q', 'type', 'location', 'stock', 'rera', 'sort'] as const);
  if (loading) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;

  const closeModal = () => { setEditing(null); void reload(); };
  const rows = filterRows<any>(data.projects, f, {
    search: (p) => [p.name, p.location, p.configuration],
    match: { type: (p) => p.type, location: (p) => p.location },
    test: (p) => (!f.stock || (f.stock === 'available' ? p.available_units > 0 : f.stock === 'none' ? !p.total_units : p.total_units > 0 && !p.available_units))
      && (!f.rera || (f.rera === 'missing' ? !p.rera_number : Boolean(p.rera_number))),
    sort: {
      price_low: (a, b) => a.price_from_lakhs - b.price_from_lakhs,
      price_high: (a, b) => b.price_from_lakhs - a.price_from_lakhs,
      available: (a, b) => b.available_units - a.available_units,
    },
  });
  const modal = editing && <ProjectModal project={editing === 'new' ? null : editing} onClose={closeModal} />;

  if (id) {
    const project = data.projects.find((p: any) => String(p.id) === id);
    if (!project) return <Page><ErrorNote>Project not found.</ErrorNote></Page>;
    return <><Inventory project={project} onEdit={() => setEditing(project)} />{modal}</>;
  }

  return (
    <Page>
      <PageHeader title="Projects & Units" subtitle="The single source for prices, availability and MahaRERA details"
        actions={can('settings.manage') && <Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} />Add project</Button>} />
      <FilterBar search={<SearchBox placeholder="Search project or location" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={rows.length} total={data.projects.length} noun="projects">
        <FilterPill label="Type" value={f.type} options={optionsFrom<any>(data.projects, (p) => p.type)} onChange={(type) => set({ type })} />
        <FilterPill label="Location" value={f.location} options={optionsFrom<any>(data.projects, (p) => p.location)} onChange={(location) => set({ location })} />
        <FilterPill label="Availability" value={f.stock} options={[{ value: 'available', label: 'Units available' }, { value: 'sold', label: 'Sold out' }, { value: 'none', label: 'No units added' }]} onChange={(stock) => set({ stock })} />
        <FilterPill label="MahaRERA" value={f.rera} options={[{ value: 'added', label: 'Number added' }, { value: 'missing', label: 'Number missing' }]} onChange={(rera) => set({ rera })} />
        <FilterPill label="Sort" value={f.sort} options={[{ value: '', label: 'Default' }, { value: 'price_low', label: 'Price: low to high' }, { value: 'price_high', label: 'Price: high to low' }, { value: 'available', label: 'Most available' }]} onChange={(sort) => set({ sort })} clearable={false} />
      </FilterBar>
      {!rows.length && <Card><Empty title="No projects match">Try clearing a filter.</Empty></Card>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((p: any) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="block">
            <Card className="h-full p-4 transition-colors hover:border-brand">
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink"><Building2 size={20} /></span>
                <div className="min-w-0">
                  <h2 className="truncate font-display text-lg font-semibold">{p.name}</h2>
                  <p className="truncate text-[13px] text-muted">{p.location}</p>
                </div>
              </div>
              <p className="mt-3 text-sm">{p.configuration}</p>
              <p className="text-sm text-muted">{p.type} · from {lakhs(p.price_from_lakhs)}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {p.total_units > 0 ? <Badge tone="green">{p.available_units} of {p.total_units} available</Badge> : <Badge>No units added</Badge>}
                {!p.rera_number && <Badge tone="amber">MahaRERA missing</Badge>}
                {p.verify_note && <Badge tone="amber">Verify details</Badge>}
              </div>
            </Card>
          </Link>
        ))}
      </div>
      {modal}
    </Page>
  );
}
