import { ArrowLeft, Bot, Clock, History, Megaphone, Pencil, Plus, Smartphone, StickyNote, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ROLE_LABELS, isViewOnly } from '../../../shared/domain.ts';
import { CountTabs, DatePill, FilterBar, FilterPill, SearchBox, dateBounds, filterRows, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, IconButton, Modal, Notice, PageHeader, SelectField, Spinner, Stat, TextField, cx, useAction } from '../components/ui.tsx';
import { useApi, api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { dateTime, initials, prettyPhone, timeAgo } from '../lib/format.ts';
import { Attachment, Tick } from './Inbox.tsx';

function NumberModal({ number, onClose }: { number: any | null; onClose: () => void }) {
  const { data } = useApi('/directory');
  const [f, setF] = useState({
    label: number?.label ?? '', display_number: number?.display_number ?? '', phone_number_id: number?.phone_number_id ?? '', token: '',
    user_id: number?.user_id ?? '', daily_limit: String(number?.daily_limit ?? 250), status: number?.status ?? 'active',
  });
  const [phoneApp, setPhoneApp] = useState(Boolean(number?.phone_app));
  const { busy, run } = useAction();
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, user_id: f.user_id ? Number(f.user_id) : null, daily_limit: Number(f.daily_limit), token: f.token || undefined, phone_app: phoneApp };
    const save = () => (number ? api.put(`/wa-numbers/${number.id}`, body) : api.post('/wa-numbers', body));
    if (await run(save, 'Number saved')) onClose();
  };
  return (
    <Modal title={number ? `Edit ${number.label}` : 'Add a WhatsApp number'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextField label="Name" placeholder="e.g. Rahul sales line" required value={f.label} onChange={(e) => set('label', e.target.value)} />
        <TextField label="WhatsApp number" placeholder="+919876543210" required value={f.display_number} onChange={(e) => set('display_number', e.target.value)} />
        <TextField label="Phone number ID" hint="From Meta. For testing, start it with demo." required value={f.phone_number_id} onChange={(e) => set('phone_number_id', e.target.value)} />
        <TextField label="Access token (optional)" hint="Stored encrypted. Leave blank to use the company token." type="password" autoComplete="off" value={f.token} onChange={(e) => set('token', e.target.value)} />
        <SelectField label="Assigned to" value={f.user_id} onChange={(e) => set('user_id', e.target.value)}>
          <option value="">Shared company inbox</option>
          {data?.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </SelectField>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Broadcast limit per day" type="number" min="1" value={f.daily_limit} onChange={(e) => set('daily_limit', e.target.value)} />
          <SelectField label="Status" value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="active">Active</option><option value="paused">Paused</option>
          </SelectField>
        </div>
        <label className="flex items-start gap-2 text-sm text-body">
          <input type="checkbox" className="mt-0.5 accent-[var(--brand)]" checked={phoneApp} onChange={(e) => setPhoneApp(e.target.checked)} />
          <span>Staff also use the WhatsApp Business app on this number<span className="block text-[13px] text-muted">Automatic replies stay off on this number, so they never talk over a person.</span></span>
        </label>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

const waited = (since: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(`${since.replace(' ', 'T')}Z`).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
};

function NumberCard({ label, sub, chats, waiting, slow, since, on, onClick }: { label: string; sub: string; chats: number; waiting: number; slow: number; since?: string | null; on: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cx('w-52 shrink-0 rounded-xl border bg-surface p-3 text-left transition-colors', on ? 'border-brand ring-1 ring-brand' : 'border-line hover:bg-surface-2')}>
      <p className="truncate text-sm font-medium text-ink">{label}</p>
      <p className="truncate text-xs text-muted tabular-nums">{sub}</p>
      <p className="mt-2 flex items-center gap-3 text-[13px] tabular-nums">
        <span className="text-body">{chats} chat{chats === 1 ? '' : 's'}</span>
        <span className={cx(slow ? 'font-medium text-red-700 dark:text-red-300' : waiting ? 'font-medium text-amber-700 dark:text-amber-300' : 'text-muted')}>{waiting} waiting</span>
      </p>
      <p className="mt-0.5 h-4 text-xs text-muted">{since ? `Longest wait ${waited(since)}` : ''}</p>
    </button>
  );
}

function Who({ m }: { m: any }) {
  const parts = m.source === 'phone' ? [<Smartphone key="i" size={11} />, m.sender ?? 'Phone'] : m.campaign_id ? [<Megaphone key="i" size={11} />, 'Broadcast'] : m.sender ? [m.sender] : [<Bot key="i" size={11} />, 'Automatic'];
  return <span className="inline-flex items-center gap-1">{parts}</span>;
}

function ChatView({ leadId, num, onBack, onSwitch }: { leadId: number; num: number; onBack: () => void; onSwitch: (num: number) => void }) {
  const { can, user } = useAuth();
  const { data, error } = useApi(`/conversations/${leadId}?number=${num}`, ['inbox']);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [data?.messages.length, leadId, num]); // Only the chat scrolls, never the page.
  if (error) return <div className="p-4"><Button size="sm" onClick={onBack}>Back</Button><div className="mt-3"><ErrorNote>{error}</ErrorNote></div></div>;
  if (!data) return <Spinner />;
  const timeline = [
    ...data.messages.map((m: any) => ({ ...m, kind: 'message' })),
    ...data.notes.map((n: any) => ({ ...n, kind: 'note', id: `note${n.id}` })),
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5">
        <IconButton label="Back to chats" className="size-8 lg:hidden" onClick={onBack}><ArrowLeft size={17} /></IconButton>
        <div className="min-w-0 flex-1 basis-40">
          <p className="truncate font-medium text-ink">{data.lead.name}</p>
          <p className="truncate text-[13px] text-muted tabular-nums">{prettyPhone(data.lead.phone)} · {data.lead.stage} · Assigned to {data.lead.owner_name ?? 'nobody'}</p>
          <p className="truncate text-[13px] text-muted">On {data.number.label}{data.number.user_name ? ` (${data.number.user_name})` : ''}</p>
        </div>
        <span className="flex gap-1">
          <Link to={`/leads/${data.lead.id}`}><Button size="sm">Open lead</Button></Link>
          {can('whatsapp.send') && !isViewOnly(user!.role) && <Link to={`/inbox/${data.lead.id}`}><Button size="sm" variant="whatsapp">Reply</Button></Link>}
        </span>
      </div>
      {!!data.other_numbers.length && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5 text-[13px] text-muted">
          Also talking on
          {data.other_numbers.map((o: any) => <button key={o.num} type="button" onClick={() => onSwitch(o.num)} className="rounded-full border border-line px-2 py-0.5 text-body hover:bg-surface-2">{o.label} ({o.total})</button>)}
        </div>
      )}
      <div ref={box} className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto bg-surface-2 p-3">
        {data.total > data.limit && <p className="text-center text-xs text-muted">Showing the latest {data.limit} of {data.total} messages</p>}
        {timeline.map((m: any) => {
          if (m.kind === 'note') {
            return (
              <div key={m.id} className="mx-auto max-w-[90%] rounded-lg bg-amber-50 px-3 py-1.5 text-[13px] text-amber-950 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="flex items-center gap-1 text-[11px] opacity-70"><StickyNote size={12} />Internal note · {m.sender} · {dateTime(m.created_at)}</p>
                <p className="break-words whitespace-pre-line">{m.body}</p>
              </div>
            );
          }
          const out = m.direction === 'out';
          return (
            <div key={m.id} className={cx('flex', out ? 'justify-end' : 'justify-start')}>
              <div className={cx('max-w-[85%] rounded-lg px-3 py-1.5 text-sm shadow-sm', out ? 'bg-brand-soft text-ink' : 'bg-surface text-ink')}>
                <Attachment m={m} />
                <p className={cx('break-words whitespace-pre-line', m.status === 'revoked' && 'line-through opacity-60')}>{m.body}</p>
                {m.status === 'revoked' && <p className="text-[11px] font-medium text-red-700 dark:text-red-300">Deleted on phone</p>}
                {m.error && <p className="text-[11px] text-red-700 dark:text-red-300">{m.error}</p>}
                <p className="mt-0.5 flex items-center justify-end gap-1 text-[11px] opacity-70">
                  {!!m.simulated && <span>simulated ·</span>}
                  {out && <><Who m={m} /><span>·</span></>}
                  {dateTime(m.created_at)}
                  {out && <Tick status={m.status} />}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <p className="border-t border-line px-3 py-1.5 text-xs text-muted">View only. Staff keep their unread count, and your viewing is recorded in the audit log.</p>
    </div>
  );
}

function Conversations() {
  const { f, set, clear, activeCount } = useFilters(['number', 'status', 'staff', 'q', 'date', 'from', 'to'] as const, { prefix: 'chat_' });
  const [params, setParams] = useSearchParams();
  const [limit, setLimit] = useState(100);
  const { data: directory } = useApi('/directory');
  const open = params.get('open')?.split('-').map(Number);
  const show = (key: string | null) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (key) next.set('open', key); else next.delete('open');
    return next;
  }); // Pushed, not replaced, so the phone's Back button returns to the list.
  const { from, to } = dateBounds(f.date, f.from, f.to);
  const query = new URLSearchParams(Object.entries({ number: f.number, status: f.status, staff: f.staff, q: f.q, from: from ?? '', to: to ?? '', limit: String(limit) }).filter(([, v]) => v));
  const { data, error } = useApi(`/conversations?${query}`, ['inbox']);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  const { tabs, numbers, conversations, total } = data;
  const tabList = [
    { value: '', label: 'All', count: tabs.all },
    { value: 'awaiting', label: 'Waiting for reply', count: tabs.awaiting },
    { value: 'slow', label: `Waiting over ${data.slow_minutes / 60} hour`, count: tabs.slow },
    { value: 'unassigned', label: 'Not assigned', count: tabs.unassigned },
    { value: 'failed', label: 'Failed', count: tabs.failed },
  ];
  return (
    <>
      {/* On a phone an open chat gets the whole screen. */}
      <div className={cx(open && 'max-lg:hidden')}>
      {!!data.simulated && <div className="mb-3"><Notice>Some of these are test messages. Real chats appear here once each number is connected to Meta.</Notice></div>}
      <div className="scroll-thin mb-3 flex gap-2 overflow-x-auto pb-1">
        <NumberCard label="All numbers" sub={`${numbers.length} number${numbers.length === 1 ? '' : 's'}`} chats={numbers.reduce((s: number, n: any) => s + n.chats, 0)} waiting={numbers.reduce((s: number, n: any) => s + n.waiting, 0)} slow={numbers.reduce((s: number, n: any) => s + n.slow, 0)} on={!f.number} onClick={() => set({ number: '' })} />
        {numbers.map((n: any) => (
          <NumberCard key={n.id} label={n.label} sub={[n.display_number, n.user_name ?? 'Shared inbox'].filter(Boolean).join(' · ')} chats={n.chats} waiting={n.waiting} slow={n.slow} since={n.longest_wait_since} on={f.number === String(n.id)} onClick={() => set({ number: String(n.id) })} />
        ))}
      </div>
      <FilterBar search={<SearchBox placeholder="Search words in any chat" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={conversations.length} total={total} noun="chats">
        <FilterPill label="Staff" value={f.staff} options={(directory?.users ?? []).map((u: any) => ({ value: String(u.id), label: u.name }))} onChange={(staff) => set({ staff })} />
        <DatePill label="Last message" preset={f.date} from={f.from} to={f.to} onChange={(date, a, b) => set({ date, from: a, to: b })} />
      </FilterBar>
      <CountTabs label="Chat status" tabs={tabList} value={f.status} onChange={(status) => set({ status })} />
      </div>
      <Card className="grid h-[calc(100dvh-13rem)] min-h-[28rem] overflow-hidden lg:grid-cols-[22rem_1fr]">
        <div className={cx('scroll-thin min-h-0 overflow-y-auto lg:border-r lg:border-line', open && 'max-lg:hidden')}>
          {!conversations.length && <Empty title="No chats here">{activeCount ? 'Try removing a filter.' : 'Chats appear as soon as a connected number sends or receives a message.'}</Empty>}
          <ul className="divide-y divide-line">
            {conversations.map((c: any) => {
              const key = `${c.lead_id}-${c.num}`;
              const on = open?.[0] === c.lead_id && open?.[1] === c.num;
              return (
                <li key={key}>
                  <button type="button" aria-current={on} onClick={() => show(key)} className={cx('flex w-full gap-2.5 px-3 py-2.5 text-left', on ? 'bg-brand-soft' : 'hover:bg-surface-2')}>
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[13px] font-medium text-body">{initials(c.name)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium text-ink">{c.name}</span>
                        <span className="shrink-0 text-xs text-muted">{timeAgo(c.last_at)}</span>
                      </span>
                      <span className="block truncate text-[13px] text-muted">{c.found ?? `${c.last_direction === 'out' ? 'Sent: ' : ''}${c.last_body}`}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <span className="max-w-32 truncate">{c.number_label}</span>
                        {c.waiting_since && <span className="inline-flex items-center gap-0.5 font-medium text-amber-700 dark:text-amber-300"><Clock size={11} />{waited(c.waiting_since)}</span>}
                        {c.last_status === 'failed' && <span className="inline-flex items-center gap-0.5 font-medium text-red-700 dark:text-red-300"><TriangleAlert size={11} />Failed</span>}
                        {c.replied_by && <span className="truncate">Replied by {c.replied_by}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {conversations.length < total && <div className="p-3 text-center"><Button size="sm" onClick={() => setLimit((l) => Math.min(l + 100, 500))} disabled={limit >= 500}>{limit >= 500 ? 'Use filters to see older chats' : 'Show more'}</Button></div>}
        </div>
        <div className={cx('min-h-0 min-w-0', !open && 'max-lg:hidden')}>
          {open ? <ChatView key={open.join('-')} leadId={open[0]} num={open[1]} onBack={() => show(null)} onSwitch={(num) => show(`${open[0]}-${num}`)} /> : <div className="flex h-full items-center justify-center"><Empty title="Choose a chat">You can read any number's conversation here.</Empty></div>}
        </div>
      </Card>
    </>
  );
}

function Numbers({ onView }: { onView: (id: number) => void }) {
  const { can } = useAuth();
  const { data, error, reload } = useApi('/wa-numbers', ['inbox']);
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const history = useAction();
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  const importChats = async (n: any) => {
    if (await history.run(() => api.post(`/wa-numbers/${n.id}/history-sync`), 'Past chats requested')) void reload();
  };
  return (
    <>
      <div className="mb-3 space-y-2">
        <Notice>Only numbers connected through Meta's WhatsApp Business Platform appear here. Chats on the normal WhatsApp app cannot be read. A number can stay on the WhatsApp Business app too, if a Meta partner connects it using coexistence.</Notice>
        {can('settings.manage') && <div className="flex justify-end"><Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} />Add number</Button></div>}
      </div>
      <Card>
        {!data.numbers.length && <Empty title="No numbers yet">Add one for each staff member who needs their own inbox.</Empty>}
        <ul className="divide-y divide-line">
          {data.numbers.map((n: any) => (
            <li key={n.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-44 flex-1">
                <p className="font-medium text-ink">{n.label}{n.status === 'paused' && <span className="ml-2"><Badge tone="red">Paused</Badge></span>}{n.quality && <span className="ml-2"><Badge tone="amber">{n.quality}</Badge></span>}{!!n.phone_app && <span className="ml-2"><Badge>Also on phone</Badge></span>}</p>
                <p className="text-[13px] text-muted tabular-nums">{n.display_number} · {n.user_name ?? 'Shared inbox'}{n.history_status ? ` · Past chats: ${n.history_status}` : ''}</p>
              </div>
              <dl className="flex gap-5 text-sm">
                {[['Sent today', `${n.sent_today}`], ['Received', n.received_today], ['Failed', n.failed_today], ['Chats', n.conversations], ['Limit', n.daily_limit]].map(([k, v]) => (
                  <div key={String(k)}><dt className="text-xs text-muted">{k}</dt><dd className="font-medium text-ink tabular-nums">{v}</dd></div>
                ))}
              </dl>
              <span className="flex gap-1">
                <Button size="sm" onClick={() => onView(n.id)}>View chats</Button>
                {!!n.phone_app && !n.history_status && can('settings.manage') && <Button size="sm" busy={history.busy} onClick={() => importChats(n)}><History size={14} />Import past chats</Button>}
                {can('settings.manage') && <IconButton label={`Edit ${n.label}`} className="size-8" onClick={() => setEditing(n)}><Pencil size={15} /></IconButton>}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      {editing && <NumberModal number={editing === 'new' ? null : editing} onClose={() => { setEditing(null); void reload(); }} />}
    </>
  );
}

function Live() {
  const { data, error } = useApi('/monitor', ['leads', 'inbox', 'campaigns']);
  const { f, set, clear, activeCount } = useFilters(['q', 'role', 'online'] as const);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;
  const { totals, feed, pending_broadcasts } = data;
  const staff = filterRows<any>(data.staff, f, {
    search: (u) => [u.name, u.display_number],
    match: { role: (u) => u.role },
    test: (u) => !f.online || (f.online === 'in' ? u.sessions > 0 : !u.sessions),
  });
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Messages sent today" value={totals.sent} />
        <Stat label="Messages received" value={totals.received} />
        <Stat label="Unanswered chats" value={totals.unanswered} tone={totals.unanswered ? 'alert' : undefined} />
        <Stat label="Failed today" value={totals.failed} tone={totals.failed ? 'alert' : undefined} />
      </div>
      {!!pending_broadcasts.length && (
        <div className="mb-4"><Notice>{pending_broadcasts.length} broadcast{pending_broadcasts.length > 1 ? 's' : ''} waiting for approval. <Link to="/campaigns" className="underline">Review</Link></Notice></div>
      )}
      <FilterBar search={<SearchBox placeholder="Search staff or number" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={staff.length} total={data.staff.length} noun="staff">
        <FilterPill label="Role" value={f.role} options={Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))} onChange={(role) => set({ role })} />
        <FilterPill label="Status" value={f.online} options={[{ value: 'in', label: 'Signed in' }, { value: 'out', label: 'Signed out' }]} onChange={(online) => set({ online })} />
      </FilterBar>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Staff activity today" />
          <div className="overflow-x-auto pb-1">
            <table className="w-full min-w-[34rem] text-sm">
              <thead><tr className="border-b border-line text-left text-[13px] text-muted">
                <th className="px-4 py-2 font-medium">Name</th>
                {['Messages', 'Calls', 'Actions', 'Broadcasts'].map((h) => <th key={h} className="px-2 py-2 text-right font-medium">{h}</th>)}
                <th className="px-4 py-2 text-right font-medium">Last sign-in</th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {staff.map((u: any) => (
                  <tr key={u.id}>
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-1.5 font-medium text-ink"><span className={cx('size-2 rounded-full', u.sessions ? 'bg-emerald-500' : 'bg-line')} title={u.sessions ? 'Signed in' : 'Signed out'} />{u.name}</span>
                      <span className="text-xs text-muted">{ROLE_LABELS[u.role as keyof typeof ROLE_LABELS]}{u.display_number ? ` · ${u.display_number}` : ''}</span>
                    </td>
                    {[u.messages, u.calls, u.actions, u.broadcasts].map((v, i) => <td key={i} className="px-2 py-2 text-right tabular-nums">{v}</td>)}
                    <td className="px-4 py-2 text-right text-[13px] whitespace-nowrap text-muted">{dateTime(u.last_login_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card>
          <CardHeader title="Live activity" />
          {!feed.length && <Empty title="Nothing yet" />}
          <ul className="scroll-thin max-h-[28rem] divide-y divide-line overflow-y-auto">
            {feed.map((a: any) => (
              <li key={a.id} className="px-4 py-2 text-sm">
                <Link to={`/leads/${a.lead_id}`} className="font-medium text-ink hover:underline">{a.lead_name}</Link>
                <p className="text-[13px]">{a.title}</p>
                <p className="text-xs text-muted">{a.actor ?? 'Automatic'} · {timeAgo(a.created_at)}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

export default function Monitor() {
  const [tab, setTab] = useState<'Chats' | 'Live' | 'Numbers'>('Chats');
  const titles = { Chats: 'All chats', Live: 'Live', Numbers: 'WhatsApp numbers' };
  const [, setParams] = useSearchParams();
  const view = (id: number) => { setParams({ chat_number: String(id) }); setTab('Chats'); };
  return (
    <Page>
      <PageHeader title="Monitor" subtitle="See every number, inbox and staff action in one place" />
      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
        {(['Chats', 'Live', 'Numbers'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={cx('-mb-px border-b-2 px-3 py-2 text-sm', tab === t ? 'border-brand font-medium text-brand-ink' : 'border-transparent text-muted')}>{titles[t]}</button>
        ))}
      </div>
      {tab === 'Chats' ? <Conversations /> : tab === 'Live' ? <Live /> : <Numbers onView={view} />}
    </Page>
  );
}
