import { ArrowLeft, Check, CheckCheck, Clock, FileText, FlaskConical, Film, Paperclip, Search, Send, Sparkles, StickyNote, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { STAGES } from '../../../shared/domain.ts';
import { DatePill, FilterPill, dateBounds, toOptions, useFilters } from '../components/Filters.tsx';
import { Badge, Button, Empty, ErrorNote, Input, Modal, Notice, Select, Spinner, Textarea, cx, useAction } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { initials, prettyPhone, timeAgo, timeOnly } from '../lib/format.ts';
import { LabelButton, LabelChip, useLabels } from '../components/Labels.tsx';
import { MediaPicker } from './Media.tsx';

const moodTone = { positive: 'green', negative: 'red', neutral: 'neutral' } as const;

export function Tick({ status }: { status: string }) {
  if (status === 'queued') return <Clock size={13} aria-label="Queued" />;
  if (status === 'sent') return <Check size={14} aria-label="Sent" />;
  if (status === 'delivered') return <CheckCheck size={14} aria-label="Delivered" />;
  if (status === 'read') return <CheckCheck size={14} className="text-sky-600 dark:text-sky-300" aria-label="Read" />;
  if (status === 'failed') return <TriangleAlert size={13} className="text-red-700" aria-label="Failed" />;
  return null;
}

function TemplatePicker({ leadId, onClose, onSent }: { leadId: number; onClose: () => void; onSent: () => void }) {
  const { data } = useApi('/templates');
  const [id, setId] = useState('');
  const { busy, run } = useAction();
  const approved = data?.templates.filter((t: any) => t.status === 'approved') ?? [];
  const chosen = approved.find((t: any) => String(t.id) === id);
  const send = async () => {
    if (await run(() => api.post(`/inbox/${leadId}/template`, { template_id: Number(id) }), 'Template sent')) onSent();
  };
  return (
    <Modal title="Send template" onClose={onClose}>
      <Select aria-label="Template" value={id} onChange={(e) => setId(e.target.value)}>
        <option value="">Choose an approved template</option>
        {approved.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </Select>
      {chosen && <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-sm whitespace-pre-line">{chosen.body}</p>}
      <div className="mt-3 flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="whatsapp" busy={busy} disabled={!id} onClick={send}>Send</Button></div>
    </Modal>
  );
}

export function Attachment({ m }: { m: any }) {
  if (!m.media_url) return null;
  if (m.media_type === 'image') return <a href={m.media_url} target="_blank" rel="noreferrer"><img src={m.media_url} alt="Attachment" className="mb-1 max-h-52 rounded-lg" /></a>;
  return (
    <a href={m.media_url} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-2 rounded-lg bg-black/5 px-2 py-1.5 text-[13px] dark:bg-white/10">
      {m.media_type === 'video' ? <Film size={16} /> : <FileText size={16} />}Open attachment
    </a>
  );
}

function Thread({ leadId }: { leadId: number }) {
  // On a phone, notes fold away so the messages keep the screen.
  const [showExtras, setShowExtras] = useState(false);
  const { aiEnabled, can, demoMode, whatsappLive, user } = useAuth();
  const { data, error, loading, reload } = useApi(`/inbox/${leadId}`, ['inbox']);
  const [text, setText] = useState('');
  const [simulate, setSimulate] = useState('');
  const [picking, setPicking] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [note, setNote] = useState('');
  const catalog = useLabels();
  const { data: directory } = useApi('/directory');
  const [language, setLanguage] = useState('English');
  const { busy, run } = useAction();
  const ai = useAction();
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [data?.messages.length]);

  if (loading) return <Spinner />;
  if (error || !data) return <div className="p-4"><ErrorNote>{error}</ErrorNote></div>;

  const send = async () => {
    if (await run(() => api.post(`/inbox/${leadId}/text`, { body: text }))) { setText(''); void reload(); }
  };
  const draft = async () => {
    const r = await ai.run(() => api.post(`/leads/${leadId}/ai/draft`, { language }));
    if (r) setText(r.text);
  };
  const sendSimulated = async () => {
    if (await run(() => api.post(`/inbox/${leadId}/simulate`, { body: simulate }))) { setSimulate(''); void reload(); }
  };

  const sendMedia = async (item: any) => {
    setAttaching(false);
    await run(() => api.post(`/inbox/${leadId}/media`, { media_id: item.id }), 'File sent');
    void reload();
  };
  const addNote = async () => {
    if (await run(() => api.post(`/leads/${leadId}/note`, { body: note }))) { setNote(''); void reload(); }
  };
  const assign = async (owner: string) => {
    await run(() => api.post('/leads/assign', { lead_ids: [leadId], owner_id: Number(owner) }), 'Conversation assigned');
    void reload();
  };

  const blocked = data.blockers.length > 0;
  const readOnly = !can('whatsapp.send') || user!.role === 'marketing';
  const timeline = [
    ...data.messages.map((m: any) => ({ ...m, kind: 'message' })),
    ...data.notes.map((n: any) => ({ ...n, kind: 'note', id: `note${n.id}` })),
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-2 py-2 sm:gap-3 sm:px-3 sm:py-2.5">
        <Link to="/inbox" aria-label="Back to conversations" className="flex size-10 shrink-0 items-center justify-center lg:hidden"><ArrowLeft size={20} /></Link>
        <div className="min-w-0 flex-1">
          <Link to={`/leads/${leadId}`} className="block truncate font-medium text-ink hover:underline">{data.lead.name}</Link>
          <p className="truncate text-[13px] text-muted tabular-nums">{prettyPhone(data.lead.phone)} · {data.lead.stage}</p>
          {!!data.lead.labels.length && <div className="scroll-thin mt-0.5 flex gap-1 overflow-x-auto sm:flex-wrap">{data.lead.labels.map((l: string) => <LabelChip key={l} name={l} catalog={catalog} />)}</div>}
        </div>
        {!readOnly && <LabelButton leadId={leadId} labels={data.lead.labels} onChange={reload} />}
        {data.lead.sentiment && <span className="max-sm:hidden"><Badge tone={moodTone[data.lead.sentiment as keyof typeof moodTone]}>{data.lead.sentiment}{data.lead.intent && data.lead.intent !== 'general' ? `: ${data.lead.intent}` : ''}</Badge></span>}
        {can('lead.reassign') && (
          <Select aria-label="Assign conversation" className="hidden h-8 w-36 text-[13px] sm:block" value={data.lead.owner_id ?? ''} onChange={(e) => assign(e.target.value)}>
            <option value="">Unassigned</option>
            {directory?.users.filter((u: any) => ['sales', 'telecaller', 'team_leader', 'site_head', 'sales_manager'].includes(u.role)).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        )}
        <span className="max-sm:hidden"><Badge tone={data.window_open ? 'green' : 'neutral'}>{data.window_open ? 'Window open' : 'Window closed'}</Badge></span>
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto bg-bg px-3 py-3">
        {!data.messages.length && <Empty title="No messages yet" />}
        {timeline.map((m: any) => {
          if (m.kind === 'note') {
            return (
              <div key={m.id} className="mx-auto max-w-[90%] rounded-lg bg-amber-50 px-3 py-1.5 text-[13px] text-amber-950 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="flex items-center gap-1 text-[11px] opacity-70"><StickyNote size={12} />Internal note · {m.sender} · {timeOnly(m.created_at)}</p>
                <p className="break-words whitespace-pre-line">{m.body}</p>
              </div>
            );
          }
          const mine = m.direction === 'out';
          const buttons: any[] = m.buttons ? JSON.parse(m.buttons) : [];
          return (
            <div key={m.id} className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
              <div className={cx('max-w-[82%] rounded-xl px-3 py-1.5 text-sm shadow-sm', mine ? 'bg-[#dcf3e5] text-slate-900 dark:bg-[#17452f] dark:text-slate-100' : 'bg-surface text-ink')}>
                <Attachment m={m} />
                <p className="break-words whitespace-pre-line">{m.body}</p>
                {buttons.map((b) => <p key={b.text} className="mt-1 rounded border border-black/10 py-0.5 text-center text-[13px] font-medium dark:border-white/15">{b.text}</p>)}
                <p className="mt-0.5 flex items-center justify-end gap-1 text-[11px] opacity-70">
                  {!!m.simulated && <span>simulated ·</span>}
                  {mine && <span>{m.sender ?? (m.source === 'phone' ? 'Phone' : 'Auto')}{m.source === 'phone' && m.sender ? ' on phone' : ''} ·</span>}
                  {timeOnly(m.created_at)}
                  {mine && <Tick status={m.status} />}
                </p>
                {m.status === 'failed' && <p className="text-xs text-red-700">{m.error}</p>}
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>

      {!readOnly && (
        <div className="space-y-2 border-t border-line bg-surface p-2 sm:p-3">
          {blocked && <Notice>{data.blockers[0]}</Notice>}
          {!blocked && !data.window_open && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] text-muted">WhatsApp allows free text only within 24 hours of the customer's last message.</p>
              <Button variant="whatsapp" onClick={() => setPicking(true)}>Send template</Button>
            </div>
          )}
          {!blocked && data.window_open && (
            <>
              <Textarea aria-label="Message" rows={2} placeholder="Type a reply" value={text} onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) void send(); }} />
              <div className="flex flex-wrap items-center gap-2">
                {aiEnabled && (
                  <>
                    <Select aria-label="Draft language" className="h-8 w-auto text-[13px]" value={language} onChange={(e) => setLanguage(e.target.value)}>
                      {['English', 'Hindi', 'Marathi'].map((l) => <option key={l}>{l}</option>)}
                    </Select>
                    <Button size="sm" busy={ai.busy} onClick={draft}><Sparkles size={14} />Draft reply</Button>
                  </>
                )}
                <Button size="sm" onClick={() => setPicking(true)}>Template</Button>
                <Button size="sm" onClick={() => setAttaching(true)}><Paperclip size={14} /><span className="max-sm:hidden">Send file</span><span className="sm:hidden">File</span></Button>
                <Button size="sm" className="sm:hidden" aria-expanded={showExtras} onClick={() => setShowExtras((v) => !v)}><StickyNote size={14} />Note</Button>
                <Button variant="whatsapp" className="ml-auto" busy={busy} disabled={!text.trim()} onClick={send}><Send size={15} />Send</Button>
              </div>
            </>
          )}
          <div className={cx('flex items-center gap-2 border-t border-line pt-2', !showExtras && data.window_open && !blocked && 'max-sm:hidden')}>
            <StickyNote size={15} className="shrink-0 text-muted" />
            <Input aria-label="Internal note" className="h-8 text-[13px]" placeholder="Internal note, never sent to the customer" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button size="sm" disabled={!note.trim()} onClick={addNote}>Add</Button>
          </div>
          {demoMode && !whatsappLive && can('settings.manage') && (
            <div className={cx('flex items-center gap-2 border-t border-dashed border-line pt-2', !showExtras && 'max-sm:hidden')}>
              <FlaskConical size={15} className="shrink-0 text-muted" />
              <Input aria-label="Simulate a customer reply" className="h-8 text-[13px]" placeholder="Demo: type as the customer" value={simulate} onChange={(e) => setSimulate(e.target.value)} />
              <Button size="sm" disabled={!simulate.trim()} onClick={sendSimulated}>Simulate</Button>
            </div>
          )}
        </div>
      )}
      {attaching && <MediaPicker onPick={sendMedia} onClose={() => setAttaching(false)} />}
      {picking && <TemplatePicker leadId={leadId} onClose={() => setPicking(false)} onSent={() => { setPicking(false); void reload(); }} />}
    </div>
  );
}

export default function Inbox() {
  const params = useParams();
  const nav = useNavigate();
  const activeId = params.id ? Number(params.id) : null;
  const [q, setQ] = useState('');
  const [view, setView] = useState<'all' | 'unread' | 'awaiting'>('all');
  const [search] = useSearchParams();
  const [number, setNumber] = useState(search.get('number') ?? '');
  const { data: numbers } = useApi('/wa-numbers/mine');
  const flag = view === 'unread' ? '&unread=1' : view === 'awaiting' ? '&awaiting=1' : '';
  const [label, setLabel] = useState('');
  const catalog = useLabels();
  const location = useLocation();
  const { f, set, clear, activeCount } = useFilters(['owner', 'project', 'stage', 'temperature', 'date', 'from', 'to'] as const);
  const [showMore, setShowMore] = useState(false);
  const { data: projects } = useApi('/projects');
  const { data: directory } = useApi('/directory');
  const extra = new URLSearchParams();
  for (const k of ['owner', 'project', 'stage', 'temperature'] as const) if (f[k]) extra.set(k, f[k]);
  const bounds = dateBounds(f.date, f.from, f.to);
  if (bounds.from) extra.set('message_from', bounds.from);
  if (bounds.to) extra.set('message_to', bounds.to);
  const { data, loading, error } = useApi(`/inbox?q=${encodeURIComponent(q)}${flag}${number ? `&number=${number}` : ''}${label ? `&label=${encodeURIComponent(label)}` : ''}&${extra}`, ['inbox']);
  const { can, demoMode, whatsappLive } = useAuth();
  const { run } = useAction();
  const newContact = async () => {
    const r = await run(() => api.post('/inbox-simulate-new'));
    if (r?.id) nav(`/inbox/${r.id}`);
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)] lg:grid-cols-[22rem_minmax(0,1fr)]">
      <aside className={cx('min-h-0 flex-col border-r border-line bg-surface', activeId ? 'hidden lg:flex' : 'flex')}>
        <div className="space-y-2 border-b border-line p-3">
          <h1 className="font-display text-xl font-semibold">WhatsApp Inbox</h1>
          {numbers?.monitor ? (
            <Select aria-label="Choose an inbox" className="h-9" value={number} onChange={(e) => setNumber(e.target.value)}>
              <option value="">All inboxes</option>
              {numbers.numbers.map((n: any) => <option key={n.id} value={n.id}>{n.label} ({n.user_name ?? 'Shared'})</option>)}
            </Select>
          ) : numbers?.numbers[0] && <p className="text-[13px] text-muted tabular-nums">Your number: {numbers.numbers[0].display_number}</p>}
          <div className="relative">
            <Search size={16} className="absolute top-3 left-3 text-muted" />
            <Input aria-label="Search conversations" className="pl-9" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant={view === 'all' ? 'primary' : 'secondary'} onClick={() => setView('all')}>All</Button>
            <Button size="sm" variant={view === 'unread' ? 'primary' : 'secondary'} onClick={() => setView('unread')}>Unread</Button>
            <Button size="sm" variant={view === 'awaiting' ? 'primary' : 'secondary'} onClick={() => setView('awaiting')}>Waiting</Button>
            {demoMode && !whatsappLive && can('settings.manage') && (
              <Button size="sm" className="ml-auto" onClick={newContact} title="Demo new contact" aria-label="Demo new contact"><FlaskConical size={14} />Demo</Button>
            )}
          </div>
          <button type="button" aria-expanded={showMore} onClick={() => setShowMore((v) => !v)} className="min-h-8 text-[13px] font-medium text-brand-ink">
            {showMore ? 'Hide filters' : `More filters${activeCount + (label ? 1 : 0) ? ` (${activeCount + (label ? 1 : 0)})` : ''}`}
          </button>
          {showMore && (
            <div className="flex flex-wrap gap-1.5">
              <FilterPill label="Label" value={label} options={catalog.map((l) => ({ value: l.name, label: l.name }))} onChange={setLabel} />
              <DatePill label="Last message" preset={f.date} from={f.from} to={f.to} onChange={(date, from, to) => set({ date, from, to })} />
              <FilterPill label="Assigned to" value={f.owner} options={[{ value: 'none', label: 'Unassigned' }, ...(directory?.users.filter((u: any) => ['sales', 'telecaller', 'team_leader', 'site_head', 'sales_manager'].includes(u.role)).map((u: any) => ({ value: String(u.id), label: u.name })) ?? [])]} onChange={(owner) => set({ owner })} />
              <FilterPill label="Project" value={f.project} options={projects?.projects.map((p: any) => ({ value: String(p.id), label: p.name })) ?? []} onChange={(project) => set({ project })} />
              <FilterPill label="Stage" value={f.stage} options={toOptions(STAGES)} onChange={(stage) => set({ stage })} />
              <FilterPill label="Score" value={f.temperature} options={toOptions(['Hot', 'Warm', 'Cold'])} onChange={(temperature) => set({ temperature })} />
              {activeCount > 0 && <button type="button" onClick={clear} className="h-9 px-1.5 text-[13px] font-medium text-accent-ink">Reset</button>}
            </div>
          )}
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {error && <div className="p-3"><ErrorNote>{error}</ErrorNote></div>}
          {loading && !data && <Spinner />}
          {data && !data.conversations.length && <Empty title="No conversations">Replies from customers will appear here.</Empty>}
          <ul>
            {data?.conversations.map((c: any) => (
              <li key={c.id}>
                <button onClick={() => nav(`/inbox/${c.id}${location.search}`)} className={cx('flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left', activeId === c.id ? 'bg-brand-soft' : 'hover:bg-surface-2')}>
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[13px] font-medium text-brand-ink">{initials(c.name)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex justify-between gap-2"><span className="truncate font-medium text-ink">{c.name}</span><span className="shrink-0 text-xs text-muted">{timeAgo(c.last_message_at)}</span></span>
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] text-muted">{numbers?.monitor && c.number_label ? `${c.number_label}: ` : c.last_direction === 'out' ? 'You: ' : ''}{c.last_body}</span>
                      {!!c.unread_count && <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[#128c4b] px-1 text-[11px] font-medium text-white">{c.unread_count}</span>}
                    </span>
                    {!!c.labels.length && <span className="mt-0.5 flex flex-wrap gap-1">{c.labels.map((l: string) => <LabelChip key={l} name={l} catalog={catalog} />)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className={cx('min-h-0 min-w-0', activeId ? 'block' : 'hidden lg:block')}>
        {activeId ? <Thread key={activeId} leadId={activeId} /> : <div className="flex h-full items-center justify-center bg-bg"><Empty title="Choose a conversation">Every message stays linked to its lead.</Empty></div>}
      </section>
    </div>
  );
}
