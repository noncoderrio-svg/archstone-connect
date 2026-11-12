import {
  ArrowLeft, ArrowRightLeft, Bot, CalendarPlus, CheckCircle2, ClipboardList, Contact, Download, FileText, HardDriveUpload, IndianRupee, MessageCircle, Phone,
  PhoneCall, ShieldAlert, ShieldCheck, Sparkles, StickyNote, Upload,
} from 'lucide-react';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BUYER_FIELDS, DISPOSITIONS, DOCUMENT_TYPES, LANGUAGES, LOST_REASONS, STAGES, isManager, isViewOnly, CLOSING_ROLES } from '../../../shared/domain.ts';
import { openAssistant } from '../components/Assistant.tsx';
import { LabelButton, LabelChip, useLabels } from '../components/Labels.tsx';
import { Page } from '../components/Layout.tsx';
import {
  Badge, Button, Card, CardHeader, Empty, ErrorNote, Modal, Notice, Select, SelectField, Spinner, TempBadge, TextField, Textarea, TextareaField, useAction, useToast,
} from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { dateTime, downloadVcard, googleCalendarLink, isOverdue, lakhs, localToUtc, prettyPhone } from '../lib/format.ts';
import { callSeconds, emailLink, placeCall, smsLink } from '../lib/calling.ts';
import { postOrQueue } from '../lib/offline.ts';

const ACTIVITY_ICONS: Record<string, ReactNode> = {
  call: <Phone size={15} />, whatsapp: <MessageCircle size={15} />, note: <StickyNote size={15} />, visit: <CalendarPlus size={15} />,
  task: <ClipboardList size={15} />, compliance: <ShieldAlert size={15} />, approval: <CheckCircle2 size={15} />,
  bot: <Bot size={15} />, payment: <IndianRupee size={15} />, document: <FileText size={15} />,
};

function CallModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [disposition, setDisposition] = useState<string>('Connected');
  const [notes, setNotes] = useState('');
  const { busy, run } = useAction();
  const toast = useToast();
  const submit = async () => {
    const result = await run(() => postOrQueue(`/leads/${id}/call`, { disposition, notes, duration_seconds: callSeconds() }));
    if (result) {
      toast(result === 'sent' ? 'Call logged' : 'Saved. It will send when you are back online.');
      onClose();
    }
  };
  return (
    <Modal title="Log call" onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        {DISPOSITIONS.map((d) => (
          <Button key={d} variant={d === disposition ? 'primary' : 'secondary'} onClick={() => setDisposition(d)}>{d}</Button>
        ))}
      </div>
      <div className="mt-3"><TextareaField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <div className="mt-3 flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={submit}>Save</Button></div>
    </Modal>
  );
}

function TaskModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [f, setF] = useState({ type: 'Call back', due: '', notes: '' });
  const { busy, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/leads/${id}/tasks`, { type: f.type, due_at: localToUtc(f.due), notes: f.notes }), 'Follow-up set')) onClose();
  };
  return (
    <Modal title="Set follow-up" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <SelectField label="Type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          {['Call back', 'Send WhatsApp', 'Send cost sheet', 'Meeting', 'Email'].map((t) => <option key={t}>{t}</option>)}
        </SelectField>
        <TextField label="Due" type="datetime-local" required value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
        <TextareaField label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function VisitModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const { data } = useApi('/projects');
  const [f, setF] = useState({ project_id: lead.project_id ?? '', when: '', pickup: false });
  const { busy, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post('/visits', { lead_id: lead.id, project_id: Number(f.project_id), scheduled_at: localToUtc(f.when), pickup: f.pickup }));
    if (r) onClose();
  };
  return (
    <Modal title="Schedule site visit" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <SelectField label="Project" required value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
          <option value="">Choose a project</option>
          {data?.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SelectField>
        <TextField label="Date and time" type="datetime-local" required value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[#C85A1E]" checked={f.pickup} onChange={(e) => setF({ ...f, pickup: e.target.checked })} />Customer needs pickup</label>
        <p className="text-[13px] text-muted">A check-in code is sent on WhatsApp when the customer has allowed messages.</p>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Schedule</Button></div>
      </form>
    </Modal>
  );
}

function HandoffModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { data } = useApi('/directory');
  const [f, setF] = useState({ sales_id: '', notes: '' });
  const { busy, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/leads/${id}/handoff`, { sales_id: Number(f.sales_id), notes: f.notes }), 'Lead handed to closing manager')) onClose();
  };
  return (
    <Modal title="Hand off to a closing manager" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <SelectField label="Closing manager" required value={f.sales_id} onChange={(e) => setF({ ...f, sales_id: e.target.value })}>
          <option value="">Choose</option>
          {data?.users.filter((u: any) => (CLOSING_ROLES as readonly string[]).includes(u.role)).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </SelectField>
        <TextareaField label="Handoff notes" required hint="What the customer wants, and the best time to call." value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Hand off</Button></div>
      </form>
    </Modal>
  );
}

function BookingModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const { data } = useApi(lead.project_id ? `/projects/${lead.project_id}/units` : null, ['inventory']);
  const [f, setF] = useState({ unit_id: '', amount: '', discount: '0', note: '' });
  const { busy, run } = useAction();
  const toast = useToast();
  const { user } = useAuth();
  const units = data?.units.filter((u: any) => !u.pending_booking && (u.status === 'Available' || (u.status === 'Hold' && u.lead_id === lead.id))) ?? [];
  const pick = (unitId: string) => {
    const u = units.find((x: any) => String(x.id) === unitId);
    setF({ ...f, unit_id: unitId, amount: u?.price_lakhs ? String(u.price_lakhs) : '' });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { lead_id: lead.id, amount_lakhs: Number(f.amount), discount_percent: Number(f.discount), note: f.note };
    const r = await run(() => api.post(`/units/${f.unit_id}/book`, body));
    if (r) { toast(r.status === 'booked' ? 'Flat booked' : 'Booking sent for approval'); onClose(); }
  };
  return (
    <Modal title={user!.role === 'admin' ? 'Book a flat' : 'Request booking'} onClose={onClose}>
      {!lead.project_id ? <Notice>Choose a project for this lead first.</Notice> : (
        <form onSubmit={submit} className="space-y-3">
          <SelectField label="Unit" required value={f.unit_id} onChange={(e) => pick(e.target.value)}>
            <option value="">{units.length ? 'Choose an available unit' : 'No units available'}</option>
            {units.map((u: any) => <option key={u.id} value={u.id}>Tower {u.tower} · {u.number} · {u.configuration} · {lakhs(u.price_lakhs)}</option>)}
          </SelectField>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Amount (₹ Lakhs)" type="number" step="0.01" min="1" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            <TextField label="Discount (%)" type="number" step="0.1" min="0" max="50" value={f.discount} onChange={(e) => setF({ ...f, discount: e.target.value })} />
          </div>
          <TextareaField label="Note for approver" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>{user!.role === 'admin' ? 'Book now' : 'Send for approval'}</Button></div>
        </form>
      )}
    </Modal>
  );
}

function EditModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const { data } = useApi('/projects');
  const [f, setF] = useState({
    name: lead.name, email: lead.email, project_id: lead.project_id ?? '', configuration: lead.configuration, budget_lakhs: lead.budget_lakhs ?? '',
    preferred_location: lead.preferred_location, timeline: lead.timeline, notes: lead.notes, labels: (lead.labels as string[]).join(', '),
  });
  const [profile, setProfile] = useState<Record<string, string>>(JSON.parse(lead.profile || '{}'));
  const { busy, run } = useAction();
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, profile, project_id: f.project_id ? Number(f.project_id) : null, budget_lakhs: f.budget_lakhs === '' ? null : Number(f.budget_lakhs), labels: f.labels.split(',').map((l: string) => l.trim()).filter(Boolean) };
    if (await run(() => api.patch(`/leads/${lead.id}`, body), 'Lead updated')) onClose();
  };
  return (
    <Modal title="Edit requirement" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextField label="Full name" required value={f.name} onChange={(e) => set('name', e.target.value)} />
        <TextField label="Email" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Project" value={f.project_id} onChange={(e) => set('project_id', e.target.value)}>
            <option value="">Not decided</option>{data?.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </SelectField>
          <TextField label="Configuration" value={f.configuration} onChange={(e) => set('configuration', e.target.value)} />
          <TextField label="Budget (₹ Lakhs)" type="number" value={f.budget_lakhs} onChange={(e) => set('budget_lakhs', e.target.value)} />
          <TextField label="Preferred location" value={f.preferred_location} onChange={(e) => set('preferred_location', e.target.value)} />
        </div>
        <SelectField label="Buying timeline" value={f.timeline} onChange={(e) => set('timeline', e.target.value)}>
          <option value="">Unknown</option>{['Immediately', 'Within 3 months', 'Within 6 months', 'Exploring'].map((t) => <option key={t}>{t}</option>)}
        </SelectField>
        <details className="rounded-lg border border-line px-3 py-2">
          <summary className="min-h-8 cursor-pointer py-1 text-sm font-medium text-ink">Buyer details</summary>
          <div className="mt-2 grid grid-cols-2 gap-3 pb-1">
            {BUYER_FIELDS.map((b) => ('options' in b ? (
              <SelectField key={b.key} label={b.label} value={profile[b.key] ?? ''} onChange={(e) => setProfile({ ...profile, [b.key]: e.target.value })}>
                <option value="">Not known</option>{b.options.map((o) => <option key={o}>{o}</option>)}
              </SelectField>
            ) : (
              <TextField key={b.key} label={b.label} type={'type' in b ? b.type : 'text'} value={profile[b.key] ?? ''} onChange={(e) => setProfile({ ...profile, [b.key]: e.target.value })} />
            )))}
          </div>
        </details>
        <TextField label="Labels" hint="Separate with commas." value={f.labels} onChange={(e) => set('labels', e.target.value)} />
        <TextareaField label="Notes" value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function ScriptModal({ project, onClose }: { project: any; onClose: () => void }) {
  return (
    <Modal title={`Call script: ${project.name}`} onClose={onClose} wide>
      <h3 className="text-[13px] font-semibold">Script</h3>
      <p className="mb-3 text-sm whitespace-pre-line">{project.call_script || 'No script added yet. Add one in Projects.'}</p>
      <h3 className="text-[13px] font-semibold">Objection handling</h3>
      <p className="text-sm whitespace-pre-line">{project.objections || 'Nothing added yet.'}</p>
    </Modal>
  );
}

function CostSheetModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const { data } = useApi(lead.project_id ? `/projects/${lead.project_id}/units` : null);
  const [unit, setUnit] = useState('');
  const [discount, setDiscount] = useState('0');
  const units = data?.units.filter((u: any) => u.price_lakhs && !['Booked', 'Sold'].includes(u.status)) ?? [];
  return (
    <Modal title="Create cost sheet" onClose={onClose}>
      {!lead.project_id ? <Notice>Choose a project for this lead first.</Notice> : (
        <div className="space-y-3">
          <SelectField label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="">{units.length ? 'Choose a unit' : 'No priced units available'}</option>
            {units.map((u: any) => <option key={u.id} value={u.id}>Tower {u.tower} · {u.number} · {u.configuration} · {lakhs(u.price_lakhs)}</option>)}
          </SelectField>
          <TextField label="Discount (%)" type="number" min="0" max="50" step="0.1" value={discount} onChange={(e) => setDiscount(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!unit} onClick={() => { window.open(`/leads/${lead.id}/cost-sheet?unit=${unit}&discount=${discount || 0}`, '_blank'); onClose(); }}>Open cost sheet</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Documents({ leadId, documents, onChange }: { leadId: number; documents: any[]; onChange: () => void }) {
  const { can } = useAuth();
  const [type, setType] = useState<string>(DOCUMENT_TYPES[0]);
  const input = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  const upload = async (file?: File) => {
    if (!file) return;
    await run(() => api.upload(`/leads/${leadId}/documents?type=${encodeURIComponent(type)}&name=${encodeURIComponent(file.name)}`, file), 'Document uploaded');
    if (input.current) input.current.value = '';
    onChange();
  };
  const review = async (id: number, status: string) => {
    await run(() => api.post(`/documents/${id}/review`, { status }));
    onChange();
  };
  const toDrive = async (id: number) => {
    await run(() => api.post(`/documents/${id}/drive`), 'Copied to Google Drive');
    onChange();
  };
  return (
    <Card>
      <CardHeader title="KYC and documents" hint="Stored encrypted. PDF, JPG or PNG, up to 10 MB." />
      <div className="flex gap-2 px-4 pb-3">
        <Select aria-label="Document type" value={type} onChange={(e) => setType(e.target.value)}>{DOCUMENT_TYPES.map((t) => <option key={t}>{t}</option>)}</Select>
        <input ref={input} type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" aria-label="Choose a document" onChange={(e) => upload(e.target.files?.[0])} />
        <Button busy={busy} onClick={() => input.current?.click()}><Upload size={15} />Upload</Button>
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {documents.map((d) => (
          <li key={d.id} className="px-4 py-2">
            <div className="flex items-center justify-between gap-2">
              <a href={`/api/documents/${d.id}/file`} className="min-w-0 truncate text-sm font-medium text-ink hover:underline"><Download size={13} className="mr-1 inline" />{d.type}</a>
              <Badge tone={d.status === 'verified' ? 'green' : d.status === 'rejected' ? 'red' : 'amber'}>{d.status}</Badge>
            </div>
            <p className="truncate text-xs text-muted">{d.filename} · {d.uploaded_by_name}{d.in_drive ? ' · In Drive' : ''}</p>
            <div className="mt-1 flex gap-1.5">
              {d.status === 'pending' && can('booking.manage') && (
                <>
                  <Button size="sm" onClick={() => review(d.id, 'verified')}>Verify</Button>
                  <Button size="sm" onClick={() => review(d.id, 'rejected')}>Reject</Button>
                </>
              )}
              {!d.in_drive && <Button size="sm" variant="ghost" onClick={() => toDrive(d.id)}><HardDriveUpload size={14} />Drive</Button>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PartnerCard({ lead, onChange }: { lead: any; onChange: () => void }) {
  const { can } = useAuth();
  const allowed = can('partner.manage');
  const { data } = useApi(allowed ? '/partners' : null);
  const { run } = useAction();
  if (!allowed && !lead.partner_name) return null;
  const set = async (value: string) => {
    await run(() => api.post(`/leads/${lead.id}/partner`, { partner_id: value ? Number(value) : null }), 'Partner updated');
    onChange();
  };
  return (
    <Card className="px-4 py-3">
      <h2 className="mb-1 text-[15px] font-semibold">Channel partner</h2>
      {allowed
        ? <Select aria-label="Channel partner" value={lead.partner_id ?? ''} onChange={(e) => set(e.target.value)}>
            <option value="">None</option>
            {data?.partners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        : <p className="text-sm">{lead.partner_name}</p>}
    </Card>
  );
}

function StageSelect({ lead, onChange }: { lead: any; onChange: () => void }) {
  const { data: directory } = useApi('/directory');
  const [pendingLost, setPendingLost] = useState(false);
  const [reason, setReason] = useState<string>(LOST_REASONS[0]);
  const { busy, run } = useAction();
  const change = async (stage: string, lost_reason?: string) => {
    if (stage === 'Lost' && !lost_reason) return setPendingLost(true);
    await run(() => api.post(`/leads/${lead.id}/stage`, { stage, lost_reason }));
    setPendingLost(false);
    onChange();
  };
  return (
    <>
      <Select aria-label="Stage" className="w-auto font-medium" value={lead.stage} onChange={(e) => change(e.target.value)}>
        {[...STAGES, ...(directory?.customStages ?? [])].map((s: string) => <option key={s} disabled={s === 'Booked'}>{s}</option>)}
      </Select>
      {pendingLost && (
        <Modal title="Why was this lead lost?" onClose={() => setPendingLost(false)}>
          <SelectField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            {LOST_REASONS.map((r) => <option key={r}>{r}</option>)}
          </SelectField>
          <div className="mt-3 flex justify-end gap-2"><Button onClick={() => setPendingLost(false)}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => change('Lost', reason)}>Mark lost</Button></div>
        </Modal>
      )}
    </>
  );
}

const Info = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex justify-between gap-4 py-1.5 text-sm"><dt className="text-muted">{label}</dt><dd className="text-right font-medium text-ink">{children || '—'}</dd></div>
);

function MatchingHomes({ leadId }: { leadId: number }) {
  const { data } = useApi(`/leads/${leadId}/matches`, ['leads', 'inventory']);
  if (!data?.homes.length) return null;
  return (
    <Card>
      <CardHeader title="Matching homes" hint={`${data.total} available ${data.total === 1 ? 'home fits' : 'homes fit'} this requirement`} />
      <ul className="divide-y divide-line">
        {data.homes.map((h: any) => (
          <li key={h.id}>
            <Link to={`/projects/${h.project_id}`} className="block px-4 py-2 hover:bg-surface-2">
              <span className="flex justify-between gap-2 text-sm"><span className="font-medium text-ink">{h.project_name}</span><Badge tone={h.score >= 80 ? 'green' : 'brand'}>{h.score}% match</Badge></span>
              <span className="block text-xs text-muted">{h.configuration} · Tower {h.tower} · {lakhs(h.price_lakhs)}</span>
              <span className="block text-xs text-muted">{h.reasons.join(' · ')}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function LeadDetail() {
  const id = Number(useParams().id);
  const { user, aiEnabled, can, telephonyLive, demoMode } = useAuth();
  const { data, error, loading, reload } = useApi(`/leads/${id}`, ['leads', 'inbox', 'visits', 'approvals']);
  const [modal, setModal] = useState<'call' | 'task' | 'visit' | 'handoff' | 'book' | 'cost' | 'edit' | 'script' | null>(null);
  const { data: next, reload: reloadNext } = useApi(`/leads/${id}/next-action`, ['leads', 'inbox', 'visits']);
  const [note, setNote] = useState('');
  const [managerNote, setManagerNote] = useState('');
  const catalog = useLabels();
  const [summary, setSummary] = useState('');
  const { busy, run } = useAction();
  const ai = useAction();

  if (loading) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error || 'Lead not found.'}</ErrorNote></Page>;
  const { lead, project, timeline, tasks, visits, approvals, calls, documents, booking } = data;
  const leader = isManager(user!.role);
  const addManagerNote = async () => {
    if (await run(() => api.post(`/leads/${id}/manager-note`, { body: managerNote }), 'Manager note added')) { setManagerNote(''); void reload(); }
  };
  const buyer: Record<string, string> = JSON.parse(lead.profile || '{}');
  const close = () => { setModal(null); void reload(); void reloadNext(); };
  const readOnly = isViewOnly(user!.role);
  const language = LANGUAGES.find((l) => l.code === lead.language)?.label;
  const canHandoff = isManager(user!.role) || (user!.role === 'telecaller' && lead.owner_id === user!.id);
  const canBook = can('unit.book');

  const addNote = async () => {
    if (await run(() => postOrQueue(`/leads/${id}/note`, { body: note }))) { setNote(''); void reload(); }
  };
  const officeCall = async () => {
    if (await run(() => api.post(`/leads/${id}/dial`), 'Your phone will ring first, then the customer')) setModal('call');
  };
  const saveToGoogle = () => run(() => api.post(`/leads/${id}/google-contact`), 'Saved to Google Contacts');
  const toggleDnc = async () => {
    await run(() => api.patch(`/leads/${id}`, { do_not_contact: !lead.do_not_contact }));
    void reload();
  };
  const summarize = async () => {
    const r = await ai.run(() => api.post(`/leads/${id}/ai/summary`));
    if (r) setSummary(r.text);
  };
  const finishTask = async (taskId: number) => {
    await run(() => api.post(`/tasks/${taskId}/complete`));
    void reload();
  };

  return (
    <Page>
      <Link to="/leads" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft size={15} />Leads</Link>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-[26px] leading-tight font-semibold">{lead.name}</h1>
            <TempBadge value={lead.temperature} />
            <Badge tone="brand">Score {lead.score}</Badge>
          </div>
          <p className="mt-0.5 text-muted">
            <span className="tabular-nums">{prettyPhone(lead.phone)}</span>{lead.email ? ` · ${lead.email}` : ''} · {lead.source}
          </p>
          {lead.score_reason && <p className="text-[13px] text-muted">Score reason: {lead.score_reason}</p>}
          <div className="mt-1 flex flex-wrap gap-1.5">
            {lead.sentiment && <Badge tone={lead.sentiment === 'positive' ? 'green' : lead.sentiment === 'negative' ? 'red' : 'neutral'}>{lead.sentiment}</Badge>}
            {lead.intent && lead.intent !== 'general' && <Badge>Asked about {lead.intent}</Badge>}
            {language && <Badge>{language}</Badge>}
            {(lead.labels as string[]).map((l) => <LabelChip key={l} name={l} catalog={catalog} />)}
          </div>
        </div>
        {!readOnly && <StageSelect lead={lead} onChange={reload} />}
      </div>

      {!!lead.do_not_contact && <div className="mb-3"><Notice>Do not contact: calls and messages are blocked for this person.</Notice></div>}
      {lead.wa_opted_out_at && <div className="mb-3"><Notice>This person opted out of WhatsApp. No messages can be sent.</Notice></div>}

      {next && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand/30 bg-brand-soft/50 px-4 py-2.5">
          <Sparkles size={16} className="text-brand-ink" />
          <p className="min-w-0 flex-1 text-sm"><b className="text-ink">Next: {next.action}.</b> {next.reason}</p>
          <Button size="sm" onClick={() => openAssistant('What should I say to this customer next?')}>Ask AI</Button>
        </div>
      )}

      {!readOnly && (
        <div className="mb-4 flex flex-wrap gap-2 max-sm:grid max-sm:grid-cols-3 max-sm:[&_button]:w-full max-sm:[&_button]:px-1">
          {!lead.phone_masked && !lead.do_not_contact && (
            <Button variant="primary" onClick={async () => { await run(() => placeCall(id, lead.phone)); setModal('call'); }}><Phone size={16} />Call</Button>
          )}
          {(telephonyLive || demoMode) && can('call.office') && !lead.do_not_contact && <Button busy={busy} onClick={officeCall}><PhoneCall size={16} />Office line</Button>}
          <Link to={`/inbox/${id}`}><Button variant="whatsapp"><MessageCircle size={16} />WhatsApp</Button></Link>
          <LabelButton leadId={id} labels={lead.labels} onChange={reload} />
          {!lead.phone_masked && !lead.do_not_contact && <a href={smsLink(lead.phone, lead.name)} onClick={() => void api.post(`/leads/${id}/touch`, { channel: 'sms' })}><Button>SMS</Button></a>}
          {lead.email && !lead.do_not_contact && <a href={emailLink(lead.email)} onClick={() => void api.post(`/leads/${id}/touch`, { channel: 'email' })}><Button>Email</Button></a>}
          <Button onClick={() => setModal('call')}><ClipboardList size={16} />Log call</Button>
          <Button onClick={() => setModal('task')}><CalendarPlus size={16} />Follow-up</Button>
          <Button onClick={() => setModal('visit')}><CalendarPlus size={16} />Site visit</Button>
          {canHandoff && <Button onClick={() => setModal('handoff')}><ArrowRightLeft size={16} />Hand off</Button>}
          <Button onClick={() => setModal('edit')}><FileText size={16} />Edit</Button>
          {project && <Button onClick={() => setModal('script')}><ClipboardList size={16} />Script</Button>}
          <Button onClick={() => setModal('cost')}><IndianRupee size={16} />Cost sheet</Button>
          {canBook && lead.stage !== 'Booked' && <Button onClick={() => setModal('book')}><FileText size={16} />Booking</Button>}
          {booking && <Link to="/bookings"><Button><FileText size={16} />View booking</Button></Link>}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="AI assistant" hint="A short summary from this lead's own history" action={
              <Button size="sm" busy={ai.busy} disabled={!aiEnabled} onClick={summarize} title={aiEnabled ? undefined : 'Add a Gemini key in the server settings'}><Sparkles size={15} />Summarise</Button>
            } />
            <p className="px-4 pb-3.5 text-sm whitespace-pre-line text-muted">
              {summary || (aiEnabled ? 'Get a quick overview and the next best action.' : 'AI is off until a Gemini key is added.')}
            </p>
          </Card>

          <Card>
            <CardHeader title="Activity" hint="Calls, WhatsApp, visits and changes in one timeline" />
            {!readOnly && (
              <div className="flex gap-2 px-4 pb-3">
                <Textarea aria-label="Add a note" rows={1} placeholder="Add a note" value={note} onChange={(e) => setNote(e.target.value)} />
                <Button busy={busy} disabled={!note.trim()} onClick={addNote}>Add</Button>
              </div>
            )}
            {leader && (
              <div className="flex gap-2 border-t border-line px-4 py-3">
                <Textarea aria-label="Add a manager note" rows={1} placeholder="Manager note, hidden from agents" value={managerNote} onChange={(e) => setManagerNote(e.target.value)} />
                <Button busy={busy} disabled={!managerNote.trim()} onClick={addManagerNote}>Add</Button>
              </div>
            )}
            <ol className="border-t border-line">
              {timeline.map((a: any) => (
                <li key={a.id} className="flex gap-3 border-b border-line px-4 py-2.5 last:border-0">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-ink">{ACTIVITY_ICONS[a.type] ?? <FileText size={15} />}</span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap justify-between gap-x-3 text-sm"><span className="font-medium text-ink">{a.title}</span><span className="text-xs text-muted">{dateTime(a.created_at)}</span></p>
                    {a.body && <p className="text-sm break-words whitespace-pre-line">{a.body}</p>}
                    {a.actor && <p className="text-xs text-muted">{a.actor}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="px-4 py-3">
            <h2 className="text-[15px] font-semibold">Requirement</h2>
            <dl className="mt-1 divide-y divide-line">
              <Info label="Project">{project?.name}</Info>
              <Info label="Configuration">{lead.configuration}</Info>
              <Info label="Budget">{lakhs(lead.budget_lakhs)}</Info>
              <Info label="Timeline">{lead.timeline}</Info>
              <Info label="Assigned to">{lead.owner_name}</Info>
              <Info label="Pre-sales">{lead.presales_name}</Info>
              {BUYER_FIELDS.map((b) => buyer[b.key] ? <Info key={b.key} label={b.label}>{buyer[b.key]}</Info> : null)}
            </dl>
            {(lead.utm_campaign || lead.adset || lead.ad || lead.form_name) && (
              <>
                <h3 className="mt-3 text-[13px] font-semibold text-muted">Lead origin</h3>
                <dl className="divide-y divide-line">
                  {lead.utm_campaign && <Info label="Campaign">{lead.utm_campaign}</Info>}
                  {lead.adset && <Info label="Ad set">{lead.adset}</Info>}
                  {lead.ad && <Info label="Ad">{lead.ad}</Info>}
                  {lead.form_name && <Info label="Form">{lead.form_name}</Info>}
                </dl>
              </>
            )}
            {project && !project.rera_number && <p className="mt-2 text-[13px] text-amber-800 dark:text-amber-300">This project's MahaRERA number is missing.</p>}
          </Card>

          <MatchingHomes leadId={id} />

          <Card>
            <CardHeader title="Follow-ups" />
            {!tasks.length && <Empty title="No follow-ups" />}
            <ul className="divide-y divide-line">
              {tasks.map((t: any) => (
                <li key={t.id} className="flex items-center gap-2 px-4 py-2">
                  <div className="min-w-0 flex-1">
                    <p className={t.completed_at ? 'truncate text-sm text-muted line-through' : 'truncate text-sm font-medium text-ink'}>{t.type}</p>
                    <p className={!t.completed_at && isOverdue(t.due_at) ? 'text-xs text-red-700 dark:text-red-400' : 'text-xs text-muted'}>{dateTime(t.due_at)} · {t.owner_name}</p>
                  </div>
                  {!t.completed_at && !readOnly && <Button size="sm" onClick={() => finishTask(t.id)}>Done</Button>}
                </li>
              ))}
            </ul>
          </Card>

          {!!visits.length && (
            <Card>
              <CardHeader title="Site visits" />
              <ul className="divide-y divide-line">
                {visits.map((v: any) => (
                  <li key={v.id} className="px-4 py-2 text-sm">
                    <span className="flex justify-between gap-2"><span className="font-medium text-ink">{v.project_name}</span><Badge tone={v.status === 'Scheduled' ? 'brand' : v.status === 'No Show' ? 'red' : 'green'}>{v.status}</Badge></span>
                    <span className="flex justify-between gap-2 text-xs text-muted">
                      {dateTime(v.scheduled_at)}
                      {v.status === 'Scheduled' && <a className="text-brand-ink hover:underline" target="_blank" rel="noreferrer" href={googleCalendarLink(`Site visit: ${lead.name}`, v.project_name, v.scheduled_at)}>Add to calendar</a>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {!!calls.length && (
            <Card>
              <CardHeader title="Calls" />
              <ul className="divide-y divide-line">
                {calls.map((c: any) => (
                  <li key={c.id} className="px-4 py-2 text-sm">
                    <span className="flex justify-between gap-2">
                      <span className="font-medium text-ink capitalize">{c.status}{c.duration_seconds ? `, ${Math.floor(c.duration_seconds / 60)}m ${c.duration_seconds % 60}s` : ''}</span>
                      {!!c.simulated && <Badge>Simulated</Badge>}
                    </span>
                    <span className="text-xs text-muted">{dateTime(c.created_at)} · {c.caller}</span>
                    {!!c.has_recording && <audio controls preload="none" src={`/api/calls/${c.id}/recording`} className="mt-1 h-8 w-full" />}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {!readOnly && <Documents leadId={id} documents={documents} onChange={reload} />}
          <PartnerCard lead={lead} onChange={reload} />

          {!!approvals.length && (
            <Card>
              <CardHeader title="Requests" />
              <ul className="divide-y divide-line">
                {approvals.map((a: any) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <span className="capitalize">{a.type} · {lakhs(a.amount_lakhs)}</span>
                    <Badge tone={a.status === 'approved' ? 'green' : a.status === 'rejected' ? 'red' : 'amber'}>{a.status}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="px-4 py-3">
            <h2 className="text-[15px] font-semibold">Consent</h2>
            <p className="mt-1 flex items-start gap-1.5 text-sm">
              {lead.wa_opt_in ? <ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" /> : <ShieldAlert size={16} className="mt-0.5 shrink-0 text-muted" />}
              <span>{lead.wa_opt_in ? `WhatsApp consent: ${lead.wa_opt_in_source}` : 'No marketing consent recorded'}</span>
            </p>
            {!readOnly && <Button size="sm" className="mt-2" onClick={toggleDnc}>{lead.do_not_contact ? 'Remove do not contact' : 'Mark do not contact'}</Button>}
            {!readOnly && !lead.phone_masked && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" onClick={() => downloadVcard(lead)}><Contact size={14} />Save contact</Button>
                <Button size="sm" variant="ghost" onClick={saveToGoogle}>To Google</Button>
              </div>
            )}
            {can('lead.delete') && (
              <Button size="sm" variant="ghost" className="mt-2 ml-1 text-red-700 dark:text-red-400" onClick={async () => {
                if (confirm('Erase this person\'s personal data? This cannot be undone.')) {
                  await run(() => api.post(`/leads/${id}/erase`), 'Personal data erased');
                  location.assign('/leads');
                }
              }}>Erase data</Button>
            )}
          </Card>
        </div>
      </div>

      {modal === 'call' && <CallModal id={id} onClose={close} />}
      {modal === 'task' && <TaskModal id={id} onClose={close} />}
      {modal === 'visit' && <VisitModal lead={lead} onClose={close} />}
      {modal === 'handoff' && <HandoffModal id={id} onClose={close} />}
      {modal === 'book' && <BookingModal lead={lead} onClose={close} />}
      {modal === 'cost' && <CostSheetModal lead={lead} onClose={close} />}
      {modal === 'edit' && <EditModal lead={lead} onClose={close} />}
      {modal === 'script' && project && <ScriptModal project={project} onClose={close} />}
    </Page>
  );
}
