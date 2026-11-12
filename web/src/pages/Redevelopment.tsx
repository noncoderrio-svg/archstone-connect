import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { REDEVELOPMENT_SCHEMES, REDEVELOPMENT_STAGES } from '../../../shared/domain.ts';
import { FilterBar, FilterPill, SearchBox, filterRows, optionsFrom, toOptions, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, Empty, ErrorNote, Modal, PageHeader, SelectField, Spinner, TextField, Textarea, TextareaField, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { dateTime } from '../lib/format.ts';

function DealForm({ deal, onClose }: { deal: any | null; onClose: () => void }) {
  const [f, setF] = useState({
    name: deal?.name ?? '', scheme: deal?.scheme ?? 'SRA', location: deal?.location ?? '', area_sqft: deal?.area_sqft ?? '', tenements: deal?.tenements ?? '',
    contact_name: deal?.contact_name ?? '', contact_phone: deal?.contact_phone ?? '', notes: deal?.notes ?? '',
  });
  const { busy, run } = useAction();
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, area_sqft: f.area_sqft === '' ? null : Number(f.area_sqft), tenements: f.tenements === '' ? null : Number(f.tenements), owner_id: deal?.owner_id };
    const save = () => (deal ? api.put(`/redevelopment/${deal.id}`, body) : api.post('/redevelopment', body));
    if (await run(save, 'Saved')) onClose();
  };
  return (
    <Modal title={deal ? `Edit ${deal.name}` : 'Add opportunity'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextField label="Society or land name" required value={f.name} onChange={(e) => set('name', e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Scheme" value={f.scheme} onChange={(e) => set('scheme', e.target.value)}>{REDEVELOPMENT_SCHEMES.map((s) => <option key={s}>{s}</option>)}</SelectField>
          <TextField label="Location" value={f.location} onChange={(e) => set('location', e.target.value)} />
          <TextField label="Plot area (sq ft)" type="number" value={f.area_sqft} onChange={(e) => set('area_sqft', e.target.value)} />
          <TextField label="Tenements" type="number" value={f.tenements} onChange={(e) => set('tenements', e.target.value)} />
          <TextField label="Contact name" value={f.contact_name} onChange={(e) => set('contact_name', e.target.value)} />
          <TextField label="Contact phone" type="tel" value={f.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} />
        </div>
        <TextareaField label="Notes" value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function DealModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, reload } = useApi(`/redevelopment/${id}`);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const { busy, run } = useAction();
  if (!data) return <Modal title="Opportunity" onClose={onClose}><Spinner /></Modal>;
  const { deal, log } = data;
  const setStage = async (stage: string) => {
    await run(() => api.post(`/redevelopment/${id}/stage`, { stage }));
    void reload();
  };
  const addNote = async () => {
    if (await run(() => api.post(`/redevelopment/${id}/log`, { body: note }))) { setNote(''); void reload(); }
  };
  return (
    <Modal title={deal.name} onClose={onClose} wide>
      <p className="text-sm text-muted">
        {deal.scheme}{deal.location ? ` · ${deal.location}` : ''}{deal.area_sqft ? ` · ${deal.area_sqft.toLocaleString('en-IN')} sq ft` : ''}{deal.tenements ? ` · ${deal.tenements} tenements` : ''}
      </p>
      {deal.contact_name && <p className="text-sm">Contact: {deal.contact_name} {deal.contact_phone}</p>}
      {deal.notes && <p className="mt-1 text-sm whitespace-pre-line">{deal.notes}</p>}
      <div className="mt-3 flex items-end gap-2">
        <div className="flex-1">
          <SelectField label="Stage" value={deal.stage} onChange={(e) => setStage(e.target.value)}>{REDEVELOPMENT_STAGES.map((s) => <option key={s}>{s}</option>)}</SelectField>
        </div>
        <Button onClick={() => setEditing(true)}>Edit details</Button>
      </div>
      <div className="mt-3 flex gap-2">
        <Textarea aria-label="Add an update" rows={1} placeholder="Add an update" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button busy={busy} disabled={!note.trim()} onClick={addNote}>Add</Button>
      </div>
      <ol className="mt-3 divide-y divide-line">
        {log.map((l: any) => (
          <li key={l.id} className="py-2 text-sm">
            <p className="break-words whitespace-pre-line text-ink">{l.body}</p>
            <p className="text-xs text-muted">{l.actor ?? 'System'} · {dateTime(l.created_at)}</p>
          </li>
        ))}
      </ol>
      {editing && <DealForm deal={deal} onClose={() => { setEditing(false); void reload(); }} />}
    </Modal>
  );
}

export default function Redevelopment() {
  const { data, error, loading, reload } = useApi('/redevelopment');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const { f, set, clear, activeCount } = useFilters(['q', 'scheme', 'owner'] as const);
  if (loading) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;
  const rows = filterRows<any>(data.deals, f, {
    search: (d) => [d.name, d.owner_name, d.scheme, d.location],
    match: { scheme: (d) => d.scheme, owner: (d) => d.owner_name },
  });
  const stages = REDEVELOPMENT_STAGES.filter((s) => s !== 'Dropped' || rows.some((d: any) => d.stage === s));
  return (
    <Page>
      <PageHeader title="Redevelopment" subtitle="SRA, private, government and BMC land opportunities"
        actions={<Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} />Add opportunity</Button>} />
      {!!data.deals.length && (
        <FilterBar search={<SearchBox placeholder="Search opportunities" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={rows.length} total={data.deals.length} noun="opportunities">
          <FilterPill label="Scheme" value={f.scheme} options={toOptions(REDEVELOPMENT_SCHEMES)} onChange={(scheme) => set({ scheme })} />
          <FilterPill label="Assigned to" value={f.owner} options={optionsFrom<any>(data.deals, (d) => d.owner_name)} onChange={(owner) => set({ owner })} />
        </FilterBar>
      )}
      {!data.deals.length ? <Card><Empty title="No opportunities yet" /></Card> : (
        <div className="scroll-thin flex gap-3 overflow-x-auto pb-3">
          {stages.map((stage) => {
            const deals = rows.filter((d: any) => d.stage === stage);
            return (
              <div key={stage} className="w-60 shrink-0 rounded-xl border border-line bg-surface-2 p-2">
                <div className="flex justify-between px-1.5 py-1 text-[13px] font-medium text-ink"><span>{stage}</span><span className="text-muted">{deals.length}</span></div>
                <div className="mt-1 min-h-14 space-y-2">
                  {deals.map((d: any) => (
                    <button key={d.id} onClick={() => setOpen(d.id)} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-left hover:border-brand">
                      <span className="block truncate font-medium text-ink">{d.name}</span>
                      <span className="mt-1 flex items-center justify-between gap-2"><Badge tone="brand">{d.scheme}</Badge><span className="truncate text-xs text-muted">{d.owner_name}</span></span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {adding && <DealForm deal={null} onClose={() => { setAdding(false); void reload(); }} />}
      {open && <DealModal id={open} onClose={() => { setOpen(null); void reload(); }} />}
    </Page>
  );
}
