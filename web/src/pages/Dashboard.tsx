import { AlarmClock, CalendarCheck, Clock, Flame, Handshake, Phone, Plus, Sparkles, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLE_LABELS, isLeadRole, isManager } from '../../../shared/domain.ts';
import { BarList, Funnel } from '../components/Charts.tsx';
import { DatePill, FilterBar, FilterPill, dateBounds, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { openAssistant } from '../components/Assistant.tsx';
import { ConfirmErase, EraseBooking, EraseButton } from '../components/Erase.tsx';
import { Badge, Button, Card, CardHeader, CountUp, Empty, ErrorNote, Spinner, Stat, TempBadge } from '../components/ui.tsx';
import { AddLeadModal } from './Leads.tsx';
import { api, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { dateTime, isOverdue, lakhs, timeAgo, timeOnly, ago } from '../lib/format.ts';

const STATS: Record<string, (s: any) => { label: string; value: any; hint?: string; alert?: boolean }[]> = {
  telecaller: (s) => [
    { label: 'Awaiting first call', value: s.awaitingResponse, alert: s.awaitingResponse > 0 },
    { label: 'Calls today', value: s.callsToday },
    { label: 'Unread WhatsApp', value: s.unread },
    { label: 'Overdue follow-ups', value: s.overdueTasks, alert: s.overdueTasks > 0 },
  ],
  closing_manager: (s) => [
    { label: 'My leads', value: s.totalLeads },
    { label: 'Hot leads', value: s.hot },
    { label: 'Booked this month', value: s.bookedThisMonth },
    { label: 'Overdue follow-ups', value: s.overdueTasks, alert: s.overdueTasks > 0 },
  ],
  site_head: (s) => [
    { label: 'Project leads', value: s.totalLeads },
    { label: 'Booked this month', value: s.bookedThisMonth },
    { label: 'Revenue this month', value: lakhs(s.revenueLakhs) },
    { label: 'Approvals waiting', value: s.pendingApprovals, alert: s.pendingApprovals > 0 },
  ],
  payment_followup: (s) => [
    { label: 'Buyers', value: s.totalLeads },
    { label: 'Booked this month', value: s.bookedThisMonth },
  ],
  default: (s) => [
    { label: 'New leads today', value: s.newToday, hint: `${s.totalLeads} in total` },
    { label: 'Awaiting first response', value: s.awaitingResponse, alert: s.awaitingResponse > 0 },
    { label: 'Booked this month', value: s.bookedThisMonth, hint: `${lakhs(s.revenueLakhs)} revenue` },
    { label: 'Approvals waiting', value: s.pendingApprovals, alert: s.pendingApprovals > 0 },
  ],
};

const goalValue = (g: any, v: number) => (g.unit === 'lakhs' ? lakhs(v) : v);

/** This month's goals for the person's own role, and how much of the target is met. */
function Targets({ p }: { p: any }) {
  if (!p.goals?.length) return null;
  return (
    <Card>
      <CardHeader title="This month" action={<span className="flex items-center gap-1.5">
        {p.streak > 0 && <Badge tone="amber"><Flame size={12} />{p.streak} day streak</Badge>}
        {p.score != null && <Badge tone={p.score >= 100 ? 'green' : p.score >= 60 ? 'brand' : 'red'}>Target met {p.score}%</Badge>}
      </span>} />
      <ul className="space-y-2 px-4">
        {p.goals.map((g: any) => (
          <li key={g.key} className="text-[13px]">
            <span className="flex justify-between"><span>{g.label}</span><span className="font-medium text-ink tabular-nums">{goalValue(g, g.actual)}{g.target ? ` / ${goalValue(g, g.target)}` : ''}</span></span>
            {g.target > 0 && <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-2"><span className="grow-x block h-full origin-left rounded-full bg-brand" style={{ width: `${g.progress}%` }} /></span>}
          </li>
        ))}
      </ul>
      <p className="px-4 py-3 text-xs text-muted">{p.score == null ? 'No target set for this month yet. ' : ''}{p.calls ? `${p.connect_rate}% connect rate · ${p.talk_minutes} min talk time` : ''}</p>
    </Card>
  );
}

/** The greeting banner: the date, the day's key numbers, and the quick actions this person can take. */
function Banner({ greeting, name, role, numbers, onAddLead }: { greeting: string; name: string; role: string; numbers: { label: string; value: number }[]; onAddLead?: () => void }) {
  const { can } = useAuth();
  const date = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' });
  const action = 'inline-flex h-10 items-center gap-1.5 rounded-xl bg-white/15 px-3.5 text-sm font-medium text-white ring-1 ring-white/25 transition-colors hover:bg-white/25';
  const works = isLeadRole(role);
  return (
    <section className="banner mb-4 rounded-3xl px-5 py-5 shadow-[0_18px_40px_-22px_rgb(0_0_0/0.6)] sm:px-7 sm:py-6">
      <p className="text-[13px] font-medium text-white/80">{date} · {ROLE_LABELS[role as keyof typeof ROLE_LABELS]}</p>
      <h1 className="mt-0.5 font-display text-[28px] leading-tight font-semibold text-white sm:text-[34px]">{greeting}, {name}</h1>
      {!!numbers.length && (
        <dl className="mt-4 flex flex-wrap gap-x-7 gap-y-3">
          {numbers.map((n) => (
            <div key={n.label}>
              <dt className="text-[12px] text-white/75">{n.label}</dt>
              <dd className="text-2xl font-semibold text-white tabular-nums"><CountUp value={n.value} /></dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {works && <Link to="/dial" className={action}><Phone size={15} />Start calling</Link>}
        {onAddLead && <button type="button" className={action} onClick={onAddLead}><Plus size={15} />Add lead</button>}
        {works && <Link to="/followups" className={action}><AlarmClock size={15} />Follow-ups</Link>}
        {can('payment.followup') && <Link to="/payments" className={action}><Wallet size={15} />Payment follow-up</Link>}
        {can('partner.manage') && <Link to="/partners" className={action}><Handshake size={15} />Partners</Link>}
        {can('ai.use') && <button type="button" className={action} onClick={() => openAssistant('Give me a plan for today based on my priorities.')}><Sparkles size={15} />Plan my day</button>}
      </div>
    </section>
  );
}

/** Admin only: the newest bookings, with erase for mistakes. */
function LatestBookings({ rows, onChange }: { rows: any[]; onChange: () => void }) {
  const [erasing, setErasing] = useState<number | null>(null);
  return (
    <Card>
      <CardHeader title="Latest bookings" action={<Link to="/bookings" className="text-sm text-brand-ink hover:underline">All bookings</Link>} />
      {!rows.length ? <Empty title="No bookings yet" /> : (
        <ul className="divide-y divide-line">
          {rows.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1"><Link to={`/leads/${b.lead_id}`} className="block truncate font-medium text-ink hover:underline">{b.lead_name}</Link>
                <span className="block truncate text-xs text-muted">{b.project_name} · {b.tower}-{b.unit_number} · {ago(b.created_at)}</span></span>
              <span className="font-medium text-ink tabular-nums">{lakhs(b.amount_lakhs)}</span>
              {b.status !== 'active' && <Badge tone="red">Cancelled</Badge>}
              <EraseButton onClick={() => setErasing(b.id)} />
            </li>
          ))}
        </ul>
      )}
      {erasing && <EraseBooking bookingId={erasing} onClose={() => setErasing(null)} onDone={() => { setErasing(null); onChange(); }} />}
    </Card>
  );
}

/** Admins and Site Heads: this month's best telecallers. Leads they own and leads they passed on both count. */
function TopTelecallers({ rows }: { rows: any[] }) {
  return (
    <Card>
      <CardHeader title="Top telecallers" hint="This month, by bookings, then site visits, qualified leads and calls" />
      {!rows.length ? <Empty title="No telecaller results yet this month" /> : (
        <ol className="divide-y divide-line">
          {rows.map((t, i) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-brand-ink">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{t.name}</span>
              <span className="flex gap-3 text-xs text-muted tabular-nums">
                <span><b className="text-ink">{t.bookings}</b> booked</span><span><b className="text-ink">{t.visits}</b> visits</span>
                <span className="max-sm:hidden"><b className="text-ink">{t.qualified}</b> qualified</span><span className="max-sm:hidden"><b className="text-ink">{t.calls}</b> calls</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export default function Dashboard() {
  const { user, can } = useAuth();
  const [adding, setAdding] = useState(false);
  const { f, set, clear, activeCount } = useFilters(['date', 'from', 'to', 'project', 'owner'] as const);
  const manager = isManager(user!.role);
  const query = new URLSearchParams();
  const bounds = dateBounds(f.date, f.from, f.to);
  if (bounds.from) query.set('created_from', bounds.from);
  if (bounds.to) query.set('created_to', bounds.to);
  if (f.project) query.set('project', f.project);
  if (f.owner) query.set('owner', f.owner);
  const { data, error, loading, reload } = useApi(`/dashboard?${query}`, ['leads', 'visits', 'inbox', 'approvals']);
  const { data: brief } = useApi('/brief', ['leads', 'visits', 'inbox']);
  const { data: projects } = useApi(manager ? '/projects' : null);
  const { data: directory } = useApi(manager ? '/directory' : null);
  const showTeamPerformance = isManager(user!.role);
  const { data: performance } = useApi(showTeamPerformance ? `/performance?${query}` : null, ['leads']);
  if (loading && !data) return <Spinner />;
  if (error || !data) return <Page><ErrorNote>{error}</ErrorNote></Page>;

  const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const stats = (STATS[user!.role] ?? STATS.default)(data.stats);
  const firstName = user!.name.split(' ')[0];
  const showTeam = data.leaderboard.length > 0;
  const worker = !isManager(user!.role) && isLeadRole(user!.role);

  // The day's key numbers for the banner. Payment Follow-up has no calls or visits, so sees their buyers instead.
  const dayNumbers = user!.role === 'payment_followup'
    ? [{ label: 'Buyers', value: data.stats.totalLeads }, { label: 'Booked this month', value: data.stats.bookedThisMonth }]
    : [
        { label: 'New leads today', value: data.stats.newToday },
        { label: 'Calls today', value: data.stats.callsToday },
        { label: 'Site visits today', value: data.visitsToday.length },
        { label: 'Overdue follow-ups', value: data.stats.overdueTasks },
      ];

  const finishTask = async (id: number) => {
    await api.post(`/tasks/${id}/complete`);
    void reload();
  };

  return (
    <Page>
      <Banner greeting={greeting} name={firstName} role={user!.role} numbers={dayNumbers} onAddLead={can('lead.create') ? () => setAdding(true) : undefined} />
      {manager && (
        <FilterBar activeCount={activeCount} onClear={clear}>
          <DatePill label="Leads created" preset={f.date} from={f.from} to={f.to} onChange={(date, from, to) => set({ date, from, to })} />
          <FilterPill label="Project" value={f.project} options={projects?.projects.map((p: any) => ({ value: String(p.id), label: p.name })) ?? []} onChange={(project) => set({ project })} />
          <FilterPill label="Assigned to" value={f.owner} options={directory?.users.filter((u: any) => isLeadRole(u.role)).map((u: any) => ({ value: String(u.id), label: u.name })) ?? []} onChange={(owner) => set({ owner })} />
        </FilterBar>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => <Stat key={s.label} label={s.label} value={s.value} hint={s.hint} tone={s.alert ? 'alert' : undefined} />)}
      </div>

      {brief && (
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Card className="border-brand/30 bg-brand-soft/40 lg:col-span-2">
            <CardHeader title="Today's priorities" action={<Button size="sm" onClick={() => openAssistant('Give me a plan for today based on my priorities.')}><Sparkles size={14} />Ask AI</Button>} />
            <ul className="list-disc space-y-1 px-8 pb-4 text-sm">{brief.items.map((i: string) => <li key={i}>{i}</li>)}</ul>
          </Card>
          <Targets p={brief.progress} />
        </div>
      )}

      {!worker && !!data.channels.length && (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {data.channels.map((c: any) => (
            <Card key={c.label} className="px-3.5 py-3"><p className="truncate text-[13px] text-muted">{c.label}</p><p className="text-xl font-semibold text-ink tabular-nums">{c.value}</p><p className="text-xs text-muted">{c.today} today</p></Card>
          ))}
        </div>
      )}

      {performance && (
        <Card className="mt-4">
          <CardHeader title="Team follow-ups" hint={f.date ? 'For the selected period' : 'Last 30 days'} action={<Link to="/performance" className="text-sm text-brand-ink hover:underline">Full performance</Link>} />
          <div className="grid grid-cols-2 gap-3 px-4 pb-3 sm:grid-cols-4">
            {[['Due', performance.totals.due], ['On time', performance.totals.on_time_rate == null ? '—' : `${performance.totals.on_time_rate}%`], ['Done late', performance.totals.late], ['Missed', performance.totals.missed]].map(([label, value]) => (
              <div key={String(label)}><p className="text-[13px] text-muted">{label}</p><p className="text-xl font-semibold text-ink tabular-nums">{value}</p></div>
            ))}
          </div>
          {!!performance.agents.filter((a: any) => a.missed > 0).length && (
            <ul className="divide-y divide-line border-t border-line">
              {[...performance.agents].filter((a: any) => a.missed > 0).sort((a: any, b: any) => b.missed - a.missed).slice(0, 3).map((a: any) => (
                <li key={a.id}><Link to={`/followups?owner=${a.id}`} className="flex items-center justify-between px-4 py-2 text-sm hover:bg-surface-2"><span className="text-ink">{a.name}</span><Badge tone="red">{a.missed} missed</Badge></Link></li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {worker && (
          <Card className="lg:col-span-2">
            <CardHeader title={user!.role === 'telecaller' ? 'Call queue' : 'Priority leads'} hint="New leads first, then highest score" action={<Link to="/leads" className="text-sm text-brand-ink hover:underline">All leads</Link>} />
            {!data.queue.length && <Empty title="Your queue is clear" />}
            <ul className="divide-y divide-line">
              {data.queue.map((l: any) => (
                <li key={l.id}>
                  <Link to={`/leads/${l.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{l.name}</span>
                      <span className="block truncate text-[13px] text-muted">{l.project_name ?? 'No project'} · {l.source} · {ago(l.created_at)}</span>
                    </span>
                    <TempBadge value={l.temperature} />
                    <Phone size={16} className="hidden text-muted sm:block" />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {!worker && (
          <Card className="lg:col-span-2">
            <CardHeader title="Sales funnel" hint="Leads currently in each stage" />
            <Funnel rows={data.funnel} />
          </Card>
        )}

        <Card>
          <CardHeader title="Today's site visits" action={<Link to="/visits" className="text-sm text-brand-ink hover:underline">View all</Link>} />
          {!data.visitsToday.length && <Empty title="No visits today" />}
          <ul className="divide-y divide-line">
            {data.visitsToday.map((v: any) => (
              <li key={v.id}>
                <Link to={`/leads/${v.lead_id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                  <CalendarCheck size={17} className="shrink-0 text-brand-ink" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">{v.lead_name}</span>
                    <span className="block truncate text-[13px] text-muted">{timeOnly(v.scheduled_at)} · {v.project_name}</span>
                  </span>
                  <Badge tone={v.status === 'Scheduled' ? 'brand' : 'green'}>{v.status}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card className={worker ? 'lg:col-span-2' : ''}>
          <CardHeader title="My follow-ups" />
          {!data.myTasks.length && <Empty title="Nothing due" />}
          <ul className="divide-y divide-line">
            {data.myTasks.map((t: any) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                <Clock size={16} className={isOverdue(t.due_at) ? 'shrink-0 text-red-700 dark:text-red-400' : 'shrink-0 text-muted'} />
                <Link to={`/leads/${t.lead_id}`} className="min-w-0 flex-1 hover:underline">
                  <span className="block truncate font-medium text-ink">{t.type}: {t.lead_name}</span>
                  <span className={isOverdue(t.due_at) ? 'text-[13px] text-red-700 dark:text-red-400' : 'text-[13px] text-muted'}>
                    {isOverdue(t.due_at) ? 'Overdue · ' : ''}{dateTime(t.due_at)}
                  </span>
                </Link>
                <Button size="sm" onClick={() => finishTask(t.id)}>Done</Button>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Lead sources" />
          <BarList rows={data.bySource} />
        </Card>

        {!!data.callOutcomes.length && (
          <Card>
            <CardHeader title="Call outcomes" hint="This month" />
            <BarList rows={data.callOutcomes} />
          </Card>
        )}

        {data.latest_bookings && <LatestBookings rows={data.latest_bookings} onChange={reload} />}
        {data.top_telecallers && <TopTelecallers rows={data.top_telecallers} />}
        {showTeam && (
          <Card className="lg:col-span-2">
            <CardHeader title="Team leaderboard" hint="This month's results" />
            <div className="overflow-x-auto pb-1">
              <table className="w-full min-w-[30rem] text-sm">
                <thead><tr className="border-b border-line text-left text-[13px] text-muted">
                  <th className="px-4 py-2 font-medium">Name</th><th className="px-2 py-2 text-right font-medium">Leads</th><th className="px-2 py-2 text-right font-medium">Calls today</th><th className="px-2 py-2 text-right font-medium">Visits</th><th className="px-4 py-2 text-right font-medium">Booked</th>
                </tr></thead>
                <tbody className="divide-y divide-line">
                  {data.leaderboard.map((u: any) => (
                    <tr key={u.id}>
                      <td className="px-4 py-2"><span className="font-medium text-ink">{u.name}</span><span className="ml-2 text-xs text-muted">{ROLE_LABELS[u.role as keyof typeof ROLE_LABELS]}</span></td>
                      <td className="px-2 py-2 text-right tabular-nums">{u.leads}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{u.calls_today}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{u.visits_month}</td>
                      <td className="px-4 py-2 text-right font-medium text-ink tabular-nums">{u.booked_month}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
      {adding && <AddLeadModal onClose={() => { setAdding(false); void reload(); }} />}
    </Page>
  );
}
