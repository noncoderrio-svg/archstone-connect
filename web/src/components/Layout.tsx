import {
  Check, Palette, Activity, AlarmClock, Award, BadgeCheck, Bell, Building2, CalendarCheck, CalendarDays, ChartColumn, FolderOpen, Handshake, Landmark, LayoutDashboard, LogOut, Megaphone, Menu, MessageCircle, Moon, PanelLeftClose, PanelLeftOpen, Phone, ReceiptIndianRupee, Route, Search, Settings, Sparkles, Sun, Users, UserCog, Wallet, WifiOff, X,
} from 'lucide-react';
import { useEffect, useRef, useState, type FocusEvent, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BOOKING_ROLES, CLOSING_ROLES, LEAD_ROLES, ROLE_LABELS, type Action } from '../../../shared/domain.ts';
import { POPUP_KINDS, playChime } from '../lib/alerts.ts';
import { api, connectLiveUpdates, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { initials, timeAgo } from '../lib/format.ts';
import { inAndroidApp, keepDeviceRegistered, safeLink, takeNotificationLink } from '../lib/device.ts';
import { enableWebPush, webPushMissing } from '../lib/install.ts';
import { useConnection } from '../lib/offline.ts';
import { COLOR_THEMES, useColorTheme } from '../lib/theme.ts';
import { Assistant, openAssistant } from './Assistant.tsx';
import { CommandPalette } from './Palette.tsx';
import { Button, IconButton, Input, Logo, cx } from './ui.tsx';

type NavGroup = 'Daily work' | 'Sales' | 'Growth' | 'Admin';
interface NavItem { to: string; label: string; icon: ReactNode; group: NavGroup; need?: Action; mobile?: boolean; roles?: string[] }

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: <LayoutDashboard size={19} />, group: 'Daily work', mobile: true },
  { to: '/dial', label: 'Calling', icon: <Phone size={19} />, group: 'Daily work', mobile: true, roles: ['admin', ...LEAD_ROLES] },
  { to: '/leads', label: 'Leads', icon: <Users size={19} />, group: 'Daily work', mobile: true },
  { to: '/inbox', label: 'WhatsApp Inbox', icon: <MessageCircle size={19} />, group: 'Daily work', mobile: true },
  { to: '/followups', label: 'Follow-ups', icon: <AlarmClock size={19} />, group: 'Daily work', roles: ['admin', ...LEAD_ROLES] },
  { to: '/performance', label: 'Performance', icon: <Award size={19} />, group: 'Daily work', roles: ['admin', ...LEAD_ROLES] },
  { to: '/visits', label: 'Site Visits', icon: <CalendarCheck size={19} />, group: 'Sales', mobile: true },
  { to: '/calendar', label: 'Calendar', icon: <CalendarDays size={19} />, group: 'Sales' },
  { to: '/projects', label: 'Projects & Units', icon: <Building2 size={19} />, group: 'Sales' },
  { to: '/files', label: 'Property Files', icon: <FolderOpen size={19} />, group: 'Sales' },
  { to: '/approvals', label: 'Approvals', icon: <BadgeCheck size={19} />, group: 'Sales', roles: ['admin', ...CLOSING_ROLES] },
  { to: '/bookings', label: 'Bookings', icon: <ReceiptIndianRupee size={19} />, group: 'Sales', roles: [...BOOKING_ROLES] },
  { to: '/payments', label: 'Payment Follow-up', icon: <Wallet size={19} />, group: 'Sales', need: 'payment.followup' },
  { to: '/routing', label: 'Lead Routing', icon: <Route size={19} />, group: 'Growth', need: 'settings.manage' },
  { to: '/campaigns', label: 'Broadcasts', icon: <Megaphone size={19} />, group: 'Growth', need: 'campaign.create' },
  { to: '/partners', label: 'Channel Partners', icon: <Handshake size={19} />, group: 'Growth', need: 'partner.manage' },
  { to: '/redevelopment', label: 'Redevelopment', icon: <Landmark size={19} />, group: 'Growth', need: 'redevelopment.manage' },
  { to: '/reports', label: 'Reports', icon: <ChartColumn size={19} />, group: 'Admin', need: 'reports.view' },
  { to: '/monitor', label: 'Monitor', icon: <Activity size={19} />, group: 'Admin', need: 'whatsapp.monitor' },
  { to: '/team', label: 'Team', icon: <UserCog size={19} />, group: 'Admin', need: 'user.manage' },
  { to: '/settings', label: 'Settings', icon: <Settings size={19} />, group: 'Admin', need: 'settings.manage' },
];
const GROUPS: NavGroup[] = ['Daily work', 'Sales', 'Growth', 'Admin'];

/** Desktop sidebar width choice, remembered per browser. Ctrl+B (Cmd+B on Mac) toggles it. */
function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === '1');
  useEffect(() => localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '0'), [collapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return { collapsed, toggle: () => setCollapsed((c) => !c) };
}

/** Colour theme picker in the top bar. Each theme changes only the brand and menu colours, and is saved on this device. */
function ThemePicker({ theme, onPick }: { theme: string; onPick: (t: any) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <IconButton label="Colour theme" onClick={() => setOpen((o) => !o)} aria-expanded={open}><Palette size={19} /></IconButton>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="dialog absolute right-0 z-40 mt-1 w-52 rounded-2xl border border-line bg-surface p-1.5 shadow-xl" role="menu" aria-label="Colour theme">
            {COLOR_THEMES.map((t) => (
              <button key={t.key} type="button" role="menuitemradio" aria-checked={theme === t.key} onClick={() => { onPick(t.key); setOpen(false); }}
                className={cx('flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm hover:bg-surface-2', theme === t.key && 'bg-surface-2 font-medium text-ink')}>
                <span className="size-5 shrink-0 rounded-full ring-2 ring-white/70 dark:ring-black/30" style={{ background: t.swatch }} />
                <span className="flex-1">{t.label}</span>
                {theme === t.key && <Check size={15} className="text-brand-ink" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Label that floats beside an icon in the collapsed sidebar. Fixed position so the scrolling nav cannot clip it. */
function useRailTip(enabled: boolean) {
  const [tip, setTip] = useState<{ text: string; top: number; left: number } | null>(null);
  useEffect(() => { if (!enabled) setTip(null); }, [enabled]);
  const bind = (text: string) => enabled ? {
    onMouseEnter: (e: MouseEvent<HTMLElement>) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ text, top: r.top + r.height / 2, left: r.right + 10 }); },
    onMouseLeave: () => setTip(null),
    onFocus: (e: FocusEvent<HTMLElement>) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ text, top: r.top + r.height / 2, left: r.right + 10 }); },
    onBlur: () => setTip(null),
  } : {};
  const node = tip && (
    <span role="tooltip" className="pointer-events-none fixed z-50 -translate-y-1/2 rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-white shadow-lg ring-1 ring-white/10" style={{ top: tip.top, left: tip.left }}>
      {tip.text}
    </span>
  );
  return { bind, node };
}

function Sidebar({ items, onNavigate, collapsed = false, onToggle }: { items: NavItem[]; onNavigate?: () => void; collapsed?: boolean; onToggle?: () => void }) {
  const { user, logout } = useAuth();
  const { data: followUps } = useApi('/followups/summary', ['leads', 'notifications']);
  const { bind, node: tipNode } = useRailTip(collapsed);
  const overdue = followUps?.overdue ?? 0;
  const groups = GROUPS.map((g) => [g, items.filter((i) => i.group === g)] as const).filter(([, list]) => list.length);
  return (
    <div className="sidebar flex h-full flex-col overflow-hidden text-slate-300 lg:rounded-3xl lg:shadow-[0_18px_40px_-18px_rgb(0_0_0/0.55)] lg:ring-1 lg:ring-white/5">
      <div className={cx('flex items-start', collapsed ? 'flex-col items-center gap-2 px-2 pt-4 pb-3' : 'justify-between px-5 pt-5 pb-4')}>
        <Link to="/" onClick={onNavigate} className="block min-w-0" aria-label="Archstone Connect home" {...bind('Dashboard')}>
          {collapsed
            ? <img src="/mark.svg" alt="Archstone" className="size-10 rounded-xl ring-1 ring-white/15" />
            : (
              <>
                <Logo variant="light" className="w-36" />
                <span className="mt-2 block text-[10px] font-medium tracking-[0.2em] whitespace-nowrap text-slate-400 uppercase">Connect · Mandate CRM</span>
              </>
            )}
        </Link>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (Ctrl+B)`}
            className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none', !collapsed && '-mr-2')}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        )}
      </div>
      <nav className={cx('scroll-thin flex-1 overflow-x-hidden overflow-y-auto py-1', collapsed ? 'px-2' : 'px-2.5')} aria-label="Main">
        {groups.map(([group, list], gi) => (
          <div key={group} className={cx(gi > 0 && 'mt-3')}>
            {collapsed
              ? gi > 0 && <div className="mx-auto mb-3 h-px w-8 bg-white/10" aria-hidden="true" />
              : <p className="px-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.18em] text-slate-400 uppercase">{group}</p>}
            <div className="space-y-0.5">
              {list.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  onClick={onNavigate}
                  aria-label={collapsed ? item.label : undefined}
                  {...bind(item.label + (item.to === '/followups' && overdue ? ` · ${overdue} overdue` : ''))}
                  className={({ isActive }) =>
                    cx(
                      'group relative flex h-10 items-center rounded-xl text-sm transition-colors duration-150',
                      collapsed ? 'justify-center' : 'gap-3 px-3',
                      isActive ? 'bg-white font-semibold text-slate-900 shadow-[0_6px_16px_-8px_rgb(0_0_0/0.6)]' : 'hover:bg-white/8 hover:text-white',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className={cx('relative shrink-0 transition-transform duration-150 group-hover:translate-x-0.5', isActive && 'text-[var(--brand-strong)] dark:text-[var(--banner-from)]')}>
                        {item.icon}
                        {collapsed && item.to === '/followups' && overdue > 0 && (
                          <span className="absolute -top-1 -right-1.5 size-2.5 rounded-full bg-red-600 ring-2 ring-[#1B1F27]" aria-hidden="true" />
                        )}
                      </span>
                      {!collapsed && <span className="truncate">{item.label}</span>}
                      {!collapsed && item.to === '/followups' && overdue > 0 && (
                        <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-semibold text-white" title={`${overdue} overdue`}>{overdue}</span>
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className={cx('flex items-center border-t border-white/10 py-3', collapsed ? 'flex-col gap-2 px-2' : 'gap-2.5 px-3.5')}>
        <Link to="/account" onClick={onNavigate} className={cx('flex min-w-0 items-center gap-2.5 rounded-lg hover:opacity-85', !collapsed && 'flex-1')} aria-label="My Account" {...bind(`${user?.name ?? 'My Account'}${user ? ` · ${ROLE_LABELS[user.role]}` : ''}`)}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--banner-from)] text-[13px] font-semibold text-white ring-2 ring-white/15">{initials(user?.name ?? '')}</span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-white">{user?.name}</span>
              <span className="block truncate text-xs text-slate-400">{user && ROLE_LABELS[user.role]}</span>
            </span>
          )}
        </Link>
        <span {...bind('Sign out')}><IconButton label="Sign out" onClick={logout} className="text-slate-300 hover:bg-white/10 hover:text-white"><LogOut size={18} /></IconButton></span>
      </div>
      {tipNode}
    </div>
  );
}

const KIND_TABS: [string, string, string[]][] = [
  ['all', 'All', []], ['leads', 'Leads', ['new_lead']], ['followups', 'Follow-ups', ['followup', 'overdue', 'team']], ['messages', 'Messages', ['message']],
];

/** Interrupts for things that need action now, then moves itself out of the way. */
function LiveAlerts({ alerts, onClose, onOpen }: { alerts: any[]; onClose: (id: number) => void; onOpen: (alert: any) => void }) {
  if (!alerts.length) return null;
  return (
    <div className="fixed top-16 right-3 z-50 w-80 max-w-[calc(100vw-1.5rem)] space-y-2">
      {alerts.map((a) => (
        <div key={a.id} role="alert" className={cx('fade-in rounded-xl border-l-4 bg-surface p-3 shadow-xl ring-1 ring-line', a.kind === 'overdue' ? 'border-red-600' : a.kind === 'new_lead' ? 'border-accent' : 'border-brand')}>
          <p className="text-sm font-semibold text-ink">{a.title}</p>
          {a.body && <p className="truncate text-[13px] text-muted">{a.body}</p>}
          <div className="mt-2 flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => onClose(a.id)}>Dismiss</Button>
            <Button size="sm" variant="primary" onClick={() => onOpen(a)}>Open</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Installing the app does not turn notifications on, so remind people on any device that can get them but is not registered. */
function NotificationsReminder() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (inAndroidApp() || sessionStorage.getItem('push-reminder-hidden')) return;
    void webPushMissing().then(setShow).catch(() => undefined);
  }, []);
  if (!show) return null;
  const turnOn = async () => {
    setBusy(true);
    setError('');
    try {
      const { push_key } = await api.get('/account');
      await enableWebPush(push_key, (sub) => api.post('/account/push', sub));
      setShow(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-brand-soft px-4 py-1.5 text-[13px] text-brand-ink">
      <span className="flex items-center gap-1.5"><Bell size={14} />{error || 'Notifications are off on this device. Turn them on to hear about new leads and follow-ups.'}</span>
      <Button size="sm" variant="primary" busy={busy} onClick={() => void turnOn()}>Turn on</Button>
      <button type="button" className="underline-offset-2 hover:underline" onClick={() => { sessionStorage.setItem('push-reminder-hidden', '1'); setShow(false); }}>Not now</button>
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const { data, reload } = useApi('/notifications', ['notifications']);
  const [tab, setTab] = useState('all');
  const [live, setLive] = useState<any[]>([]);
  const seen = useRef<number | null>(null);
  const dismiss = (id: number) => setLive((l) => l.filter((a) => a.id !== id));

  useEffect(() => {
    if (!data) return;
    const newest = data.notifications[0]?.id ?? 0;
    if (seen.current === null) { seen.current = newest; return; } // Old alerts must not pop up after a refresh.
    const fresh = data.notifications.filter((n: any) => n.id > seen.current! && POPUP_KINDS.includes(n.kind));
    seen.current = newest;
    if (!fresh.length) return;
    setLive((l) => [...fresh, ...l].slice(0, 3));
    playChime(fresh[0].kind);
    for (const n of fresh) setTimeout(() => dismiss(n.id), 25000);
  }, [data]);

  const shown = data?.notifications.filter((n: any) => {
    const kinds = KIND_TABS.find(([key]) => key === tab)![2];
    return !kinds.length || kinds.includes(n.kind);
  }) ?? [];
  const toggle = async () => {
    setOpen((o) => !o);
    if (!open && data?.unread) {
      await api.post('/notifications/read');
      void reload();
    }
  };
  return (
    <div className="relative">
      <IconButton label={`Notifications${data?.unread ? `, ${data.unread} unread` : ''}`} onClick={toggle} aria-expanded={open}>
        <Bell size={19} />
        {!!data?.unread && <span className="absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-700 px-1 text-[10px] font-medium text-white">{data.unread}</span>}
      </IconButton>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="fade-in scroll-thin absolute right-0 z-40 mt-1 max-h-[min(24rem,calc(100dvh-6rem))] w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-line bg-surface shadow-xl">
            <p className="px-4 pt-2.5 text-sm font-semibold text-ink">Notifications</p>
            <div className="flex gap-1 border-b border-line px-3 py-1.5" role="tablist" aria-label="Notification type">
              {KIND_TABS.map(([key, label]) => (
                <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={cx('rounded-md px-2 py-1 text-xs', tab === key ? 'bg-brand-soft font-medium text-brand-ink' : 'text-muted hover:bg-surface-2')}>{label}</button>
              ))}
            </div>
            {!shown.length && <p className="px-4 py-6 text-center text-sm text-muted">You are all caught up.</p>}
            {shown.map((n: any) => (
              <button
                key={n.id}
                onClick={() => { setOpen(false); if (n.link) nav(n.link); }}
                className="block w-full border-b border-line px-4 py-2.5 text-left last:border-0 hover:bg-surface-2"
              >
                <span className="flex justify-between gap-2 text-sm font-medium text-ink"><span>{n.title}</span><span className="text-xs font-normal text-muted">{timeAgo(n.created_at)}</span></span>
                {n.body && <span className="block truncate text-[13px] text-muted">{n.body}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      <LiveAlerts alerts={live} onClose={dismiss} onOpen={(a) => { dismiss(a.id); if (a.link) nav(a.link); }} />
    </div>
  );
}

export function Layout() {
  const { can, user, demoMode, whatsappLive } = useAuth();
  const { theme, setTheme, dark, toggleDark: toggle } = useColorTheme();
  const sidebar = useSidebarCollapsed();
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { online, pending } = useConnection();
  const location = useLocation();
  const nav = useNavigate();
  const search = (e: FormEvent) => {
    e.preventDefault();
    nav(`/leads?q=${encodeURIComponent(query.trim())}`);
    setQuery('');
  };
  const items = NAV.filter((i) => (!i.need || can(i.need)) && (!i.roles || i.roles.includes(user!.role)));

  useEffect(() => connectLiveUpdates(), []);
  useEffect(() => keepDeviceRegistered(), []);
  useEffect(() => {
    window.archstoneOpen = (link) => { if (safeLink(link)) nav(link); };
    const link = takeNotificationLink();
    if (link) nav(link);
    return () => { delete window.archstoneOpen; };
  }, [nav]);
  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="flex h-dvh">
      <aside className={cx('hidden shrink-0 py-3 pl-3 transition-[width] duration-200 ease-out lg:block', sidebar.collapsed ? 'w-[84px]' : 'w-64')}>
        <Sidebar items={items} collapsed={sidebar.collapsed} onToggle={sidebar.toggle} />
      </aside>
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/50" onClick={() => setMenuOpen(false)} />
          <div className="dialog relative h-full w-64 overflow-hidden rounded-r-3xl"><Sidebar items={items} onNavigate={() => setMenuOpen(false)} /></div>
          <IconButton label="Close menu" className="absolute top-3 right-3 bg-surface" onClick={() => setMenuOpen(false)}><X size={18} /></IconButton>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {demoMode && !whatsappLive && (
          <p className="bg-amber-100 px-4 py-1 text-center text-[13px] text-amber-950">Demo mode: sample data, and WhatsApp messages are simulated, not sent.</p>
        )}
        <NotificationsReminder />
        {(!online || pending > 0) && (
          <p className="flex items-center justify-center gap-1.5 bg-slate-800 px-4 py-1 text-[13px] text-white">
            <WifiOff size={14} />
            {online
              ? `${pending} saved update${pending > 1 ? 's' : ''} waiting to send.`
              : `You are offline. Showing saved data.${pending ? ` ${pending} update${pending > 1 ? 's' : ''} will send when you reconnect.` : ''}`}
          </p>
        )}
        <header className="frost relative z-40 flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b border-line/70 px-2 pt-[env(safe-area-inset-top)] sm:gap-2 sm:px-3 lg:px-5">
          <IconButton label="Open menu" className="lg:hidden" onClick={() => setMenuOpen(true)}><Menu size={20} /></IconButton>          <span className="font-display text-base font-semibold text-ink sm:hidden">Archstone Connect</span>
          <form onSubmit={search} role="search" className="relative hidden max-w-md flex-1 sm:block">
            <Search size={16} className="absolute top-2.5 left-3 text-muted" />
            <Input aria-label="Search all leads" placeholder="Search leads  (Ctrl+K for everything)" className="h-9 bg-surface-2 pl-9" value={query} onChange={(e) => setQuery(e.target.value)} />
          </form>
          <div className="flex-1" />
          {can('ai.use') && <IconButton label="Open AI assistant" className="text-brand-ink lg:hidden" onClick={() => openAssistant()}><Sparkles size={19} /></IconButton>}
          <ThemePicker theme={theme} onPick={setTheme} />
          <IconButton label={dark ? 'Use light mode' : 'Use dark mode'} onClick={toggle}>{dark ? <Sun size={19} /> : <Moon size={19} />}</IconButton>
          <Notifications />
        </header>
        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto"><div key={location.pathname.split('/')[1]} className="fade-in h-full"><Outlet /></div></main>
        {/* A chat needs the whole screen for its messages and reply box. */}
        {!/^\/inbox\/\d+/.test(location.pathname) && (
          <div className="shrink-0 px-3 pt-1 pb-[calc(env(safe-area-inset-bottom)+0.6rem)] lg:hidden">
            <nav className="frost grid auto-cols-fr grid-flow-col gap-1 rounded-[1.4rem] p-1.5 shadow-[0_10px_30px_-12px_rgb(0_0_0/0.35)] ring-1 ring-line" aria-label="Quick">
              {items.filter((i) => i.mobile).map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => cx(
                  'flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[10.5px] transition-colors',
                  isActive ? 'bg-brand font-semibold text-white shadow-sm dark:text-slate-950' : 'text-muted hover:text-ink',
                )}>
                  {({ isActive }) => (
                    <>
                      <span className="shrink-0">{i.icon}</span>
                      <span className="max-w-full truncate">{i.label.replace('WhatsApp ', '').replace('Site ', '')}</span>
                    </>
                  )}
                </NavLink>
              ))}
            </nav>
          </div>
        )}
      </div>
      <Assistant />
      <CommandPalette pages={items.map((i) => ({ to: i.to, label: i.label }))} />
    </div>
  );
}

export const Page = ({ children }: { children: ReactNode }) => <div className="stagger mx-auto max-w-7xl px-4 py-4 pb-8 lg:px-6 lg:py-5">{children}</div>;
