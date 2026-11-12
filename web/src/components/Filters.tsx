import { CalendarDays, Check, ChevronDown, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cx } from './ui.tsx';

// ---------- Dates ----------
export const DATE_PRESETS: [string, string][] = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['last_7', 'Last 7 days'], ['last_30', 'Last 30 days'],
  ['last_90', 'Last 90 days'], ['this_month', 'This month'], ['last_month', 'Last month'],
];
export const FUTURE_PRESETS: [string, string][] = [['tomorrow', 'Tomorrow'], ['next_7', 'Next 7 days']];

const IST = 5.5 * 3600000;
const DAY = 86400000;

/** The office works on Indian days, so "today" must not shift with a phone's time zone. */
function istToday() {
  const now = new Date(Date.now() + IST);
  return { y: now.getUTCFullYear(), m: now.getUTCMonth(), d: now.getUTCDate() };
}
const istStart = (y: number, m: number, d: number) => Date.UTC(y, m, d) - IST;

export function dateBounds(preset: string, from = '', to = ''): { from?: string; to?: string } {
  if (!preset) return {};
  const { y, m, d } = istToday();
  const today = istStart(y, m, d);
  const range = (start: number, end: number) => ({ from: new Date(start).toISOString(), to: new Date(end - 1).toISOString() });
  switch (preset) {
    case 'today': return range(today, today + DAY);
    case 'yesterday': return range(today - DAY, today);
    case 'tomorrow': return range(today + DAY, today + 2 * DAY);
    case 'next_7': return range(today, today + 7 * DAY);
    case 'last_7': return range(today - 6 * DAY, today + DAY);
    case 'last_30': return range(today - 29 * DAY, today + DAY);
    case 'last_90': return range(today - 89 * DAY, today + DAY);
    case 'this_month': return range(istStart(y, m, 1), istStart(y, m + 1, 1));
    case 'last_month': return range(istStart(y, m - 1, 1), istStart(y, m, 1));
    case 'custom': {
      const parse = (v: string) => { const [a, b, c] = v.split('-').map(Number); return istStart(a, b - 1, c); };
      return {
        ...(from ? { from: new Date(parse(from)).toISOString() } : {}),
        ...(to ? { to: new Date(parse(to) + DAY - 1).toISOString() } : {}),
      };
    }
    default: return {};
  }
}

const toTime = (value: string) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`).getTime();

// ---------- State ----------
/** Filters live in the address, so Back, refresh and shared links keep them. */
export function useFilters<K extends string>(keys: readonly K[], options: { prefix?: string; defaults?: Partial<Record<K, string>> } = {}) {
  const [params, setParams] = useSearchParams();
  const { prefix = '', defaults = {} as Partial<Record<K, string>> } = options;
  const f = Object.fromEntries(keys.map((k) => [k, params.get(prefix + k) ?? defaults[k] ?? ''])) as Record<K, string>;

  const set = (patch: Partial<Record<K, string>>) => setParams((current) => {
    const next = new URLSearchParams(current);
    for (const [k, v] of Object.entries(patch) as [K, string][]) {
      if (v && v !== defaults[k]) next.set(prefix + k, v);
      else next.delete(prefix + k);
    }
    return next;
  }, { replace: true });

  const clear = () => setParams((current) => {
    const next = new URLSearchParams(current);
    for (const k of keys) if (k !== 'sort') next.delete(prefix + k);
    return next;
  }, { replace: true });

  const ignored = new Set(['from', 'to', 'sort']);
  const activeCount = keys.filter((k) => !ignored.has(k) && f[k] && f[k] !== defaults[k]).length;
  return { f, set, clear, activeCount };
}

export interface FilterSpec<T> {
  search?: (row: T) => unknown[];
  match?: Record<string, (row: T) => unknown>;
  date?: (row: T) => string | null | undefined;
  test?: (row: T) => boolean;
  sort?: Record<string, (a: T, b: T) => number>;
}

/** For lists the browser already holds in full. Long lists are filtered by the server instead. */
export function filterRows<T>(rows: T[] | undefined, f: Record<string, string>, spec: FilterSpec<T>): T[] {
  let out = rows ?? [];
  const words = (f.q ?? '').trim().toLowerCase();
  if (words && spec.search) out = out.filter((r) => spec.search!(r).join(' ').toLowerCase().includes(words));
  for (const [key, read] of Object.entries(spec.match ?? {})) {
    if (f[key]) out = out.filter((r) => String(read(r) ?? '') === f[key]);
  }
  if (f.date && spec.date) {
    const { from, to } = dateBounds(f.date, f.from, f.to);
    const start = from ? toTime(from) : -Infinity;
    const end = to ? toTime(to) : Infinity;
    out = out.filter((r) => {
      const value = spec.date!(r);
      if (!value) return false;
      const time = toTime(value);
      return time >= start && time <= end;
    });
  }
  if (spec.test) out = out.filter(spec.test);
  const sorter = f.sort ? spec.sort?.[f.sort] : undefined;
  return sorter ? [...out].sort(sorter) : out;
}

export const optionsFrom = <T,>(rows: T[] | undefined, read: (row: T) => unknown): Option[] =>
  [...new Set((rows ?? []).map(read).filter(Boolean).map(String))].sort().map((value) => ({ value, label: value }));

export const toOptions = (values: readonly string[]): Option[] => values.map((value) => ({ value, label: value }));

// ---------- Pieces ----------
export interface Option { value: string; label: string; count?: number }

function useDropdown() {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const toggle = () => {
    // A menu opened near the right edge would run off a phone screen.
    setAlignRight((box.current?.getBoundingClientRect().left ?? 0) + 256 > window.innerWidth);
    setOpen((v) => !v);
  };
  return { open, setOpen, toggle, box, alignRight };
}

function PillButton({ label, value, active, open, onClick, onClear, icon }: { label: string; value?: string; active: boolean; open: boolean; onClick: () => void; onClear?: () => void; icon?: ReactNode }) {
  return (
    <span className={cx('filter-pill inline-flex h-9 items-center rounded-lg border text-[13px] transition-colors', active ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line bg-surface text-body hover:bg-surface-2')}>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={onClick} className="flex h-full items-center gap-1.5 rounded-lg pr-1 pl-2.5 whitespace-nowrap">
        {icon}
        <span className={active ? 'opacity-80' : 'text-muted'}>{label}{value ? ':' : ''}</span>
        {value && <span className="max-w-36 truncate font-semibold">{value}</span>}
        {!(active && onClear) && <ChevronDown size={14} className={cx('transition-transform', open && 'rotate-180')} />}
      </button>
      {active && onClear && (
        <button type="button" aria-label={`Clear ${label}`} onClick={onClear} className="mr-1 flex size-6 items-center justify-center rounded-md hover:bg-black/8 dark:hover:bg-white/10"><X size={13} /></button>
      )}
    </span>
  );
}

// On a phone, menus rise from the bottom like a sheet, within reach of the thumb and never cut off.
const PANEL = 'fade-in absolute top-full z-30 mt-1.5 w-60 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-1.5 shadow-xl max-sm:fixed max-sm:inset-x-3 max-sm:top-auto max-sm:bottom-20 max-sm:z-50 max-sm:mt-0 max-sm:w-auto max-sm:max-w-none max-sm:rounded-2xl max-sm:p-2 max-sm:shadow-2xl';

/** One choice from a list. */
export function FilterPill({ label, value, options, onChange, all = 'All', clearable = true }: { label: string; value: string; options: Option[]; onChange: (value: string) => void; all?: string; clearable?: boolean }) {
  const d = useDropdown();
  const [find, setFind] = useState('');
  const chosen = options.find((o) => o.value === value);
  const shown = options.filter((o) => o.label.toLowerCase().includes(find.toLowerCase()));
  const pick = (v: string) => { onChange(v); d.setOpen(false); setFind(''); };
  return (
    <div ref={d.box} className="relative">
      <PillButton label={label} value={chosen?.label ?? (clearable ? all : undefined)} active={clearable && Boolean(value)} open={d.open} onClick={d.toggle} onClear={clearable ? () => onChange('') : undefined} />
      {d.open && (
        <div role="listbox" aria-label={label} className={cx(PANEL, d.alignRight ? 'right-0' : 'left-0')}>
          {options.length > 8 && <input autoFocus aria-label={`Find ${label}`} placeholder="Find…" value={find} onChange={(e) => setFind(e.target.value)} className="mb-1 h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px] text-ink focus:border-brand focus:outline-none" />}
          <div className="scroll-thin max-h-64 overflow-y-auto">
            {clearable && <Choice selected={!value} onClick={() => pick('')}>{all}</Choice>}
            {shown.map((o) => <Choice key={o.value} selected={o.value === value} count={o.count} onClick={() => pick(o.value)}>{o.label}</Choice>)}
            {!shown.length && <p className="px-2 py-2 text-[13px] text-muted">Nothing found</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function Choice({ selected, count, onClick, children }: { selected: boolean; count?: number; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="option" aria-selected={selected} onClick={onClick} className={cx('flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] max-sm:min-h-11 max-sm:text-sm', selected ? 'bg-brand-soft font-medium text-brand-ink' : 'text-body hover:bg-surface-2')}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count != null && <span className="text-xs text-muted tabular-nums">{count}</span>}
      {selected && <Check size={14} />}
    </button>
  );
}

/** Several choices at once, applied together. */
export function MultiPill({ label, value, options, onChange, all = 'All' }: { label: string; value: string; options: Option[]; onChange: (value: string) => void; all?: string }) {
  const d = useDropdown();
  const applied = value ? value.split(',') : [];
  const [draft, setDraft] = useState(applied);
  useEffect(() => { if (d.open) setDraft(applied); }, [d.open]);
  const flip = (v: string) => setDraft((x) => (x.includes(v) ? x.filter((i) => i !== v) : [...x, v]));
  const text = applied.length === 1 ? options.find((o) => o.value === applied[0])?.label : applied.length ? `${applied.length} selected` : all;
  return (
    <div ref={d.box} className="relative">
      <PillButton label={label} value={text} active={applied.length > 0} open={d.open} onClick={d.toggle} onClear={() => onChange('')} />
      {d.open && (
        <div aria-label={label} className={cx(PANEL, d.alignRight ? 'right-0' : 'left-0')}>
          {options.map((o) => (
            <label key={o.value} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-body hover:bg-surface-2 max-sm:min-h-11 max-sm:text-sm">
              <input type="checkbox" className="accent-[var(--brand)]" checked={draft.includes(o.value)} onChange={() => flip(o.value)} />{o.label}
            </label>
          ))}
          <div className="mt-1 flex justify-between border-t border-line px-1 pt-1.5">
            <button type="button" className="h-7 px-2 text-[13px] text-muted hover:text-ink" onClick={() => setDraft([])}>Clear</button>
            <button type="button" className="h-7 rounded-md bg-brand px-3 text-[13px] font-medium text-white dark:text-slate-950" onClick={() => { onChange(draft.join(',')); d.setOpen(false); }}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Date presets plus a custom range. */
export function DatePill({ label = 'Date', preset, from, to, onChange, extra = [] }: { label?: string; preset: string; from: string; to: string; onChange: (preset: string, from: string, to: string) => void; extra?: [string, string][] }) {
  const d = useDropdown();
  const [range, setRange] = useState({ from, to });
  useEffect(() => { if (d.open) setRange({ from, to }); }, [d.open]);
  const presets = [...extra, ...DATE_PRESETS];
  const short = (v: string) => (v ? new Date(`${v}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '…');
  const value = preset === 'custom' ? `${short(from)} to ${short(to)}` : presets.find(([k]) => k === preset)?.[1] ?? 'All time';
  const pick = (k: string) => { onChange(k, '', ''); d.setOpen(false); };
  return (
    <div ref={d.box} className="relative">
      <PillButton label={label} value={value} active={Boolean(preset)} open={d.open} onClick={d.toggle} onClear={() => onChange('', '', '')} icon={<CalendarDays size={14} />} />
      {d.open && (
        <div role="listbox" aria-label={label} className={cx(PANEL, d.alignRight ? 'right-0' : 'left-0')}>
          <Choice selected={!preset} onClick={() => pick('')}>All time</Choice>
          {presets.map(([k, text]) => <Choice key={k} selected={preset === k} onClick={() => pick(k)}>{text}</Choice>)}
          <div className="mt-1 space-y-1.5 border-t border-line px-1 pt-2">
            <p className="text-xs font-medium text-muted">Custom range</p>
            <div className="grid grid-cols-2 gap-1.5">
              <input type="date" aria-label="From date" value={range.from} max={range.to || undefined} onChange={(e) => setRange({ ...range, from: e.target.value })} className="h-8 min-w-0 rounded-md border border-line bg-surface px-1 text-xs text-ink" />
              <input type="date" aria-label="To date" value={range.to} min={range.from || undefined} onChange={(e) => setRange({ ...range, to: e.target.value })} className="h-8 min-w-0 rounded-md border border-line bg-surface px-1 text-xs text-ink" />
            </div>
            <button type="button" disabled={!range.from && !range.to} onClick={() => { onChange('custom', range.from, range.to); d.setOpen(false); }} className="h-7 w-full rounded-md bg-brand text-[13px] font-medium text-white disabled:opacity-50 dark:text-slate-950">Apply range</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A slider for an upper limit, such as maximum budget. */
export function RangePill({ label, value, min, max, step, format, onChange }: { label: string; value: string; min: number; max: number; step: number; format: (v: number) => string; onChange: (value: string) => void }) {
  const d = useDropdown();
  const [draft, setDraft] = useState(Number(value) || max);
  useEffect(() => { if (d.open) setDraft(Number(value) || max); }, [d.open]);
  return (
    <div ref={d.box} className="relative">
      <PillButton label={label} value={value ? format(Number(value)) : 'Any'} active={Boolean(value)} open={d.open} onClick={d.toggle} onClear={() => onChange('')} />
      {d.open && (
        <div className={cx(PANEL, 'p-3', d.alignRight ? 'right-0' : 'left-0')}>
          <p className="text-center text-sm font-semibold text-ink tabular-nums">Up to {format(draft)}</p>
          <input type="range" aria-label={label} min={min} max={max} step={step} value={draft} onChange={(e) => setDraft(Number(e.target.value))} className="mt-2 w-full accent-[var(--accent)]" />
          <div className="flex justify-between text-xs text-muted tabular-nums"><span>{format(min)}</span><span>{format(max)}</span></div>
          <button type="button" className="mt-2 h-8 w-full rounded-md bg-brand text-[13px] font-medium text-white dark:text-slate-950" onClick={() => { onChange(draft >= max ? '' : String(draft)); d.setOpen(false); }}>Apply</button>
        </div>
      )}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Search', label }: { value: string; onChange: (value: string) => void; placeholder?: string; label?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const t = setTimeout(() => onChange(text), 250);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <div className="relative min-w-0 flex-1 max-sm:basis-40 sm:min-w-44 sm:max-w-64">
      <Search size={15} className="absolute top-2.5 left-2.5 text-muted" />
      <input aria-label={label ?? placeholder} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-surface pr-8 pl-8 text-[13px] text-ink placeholder:truncate placeholder:text-muted focus:border-brand focus:outline-none" />
      {text && <button type="button" aria-label="Clear search" onClick={() => { setText(''); onChange(''); }} className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md text-muted hover:text-ink"><X size={13} /></button>}
    </div>
  );
}

/** Holds the filters for a list, with the result count and a reset. */
export function FilterBar({ search, children, activeCount = 0, onClear, shown, total, noun, trailing }: { search?: ReactNode; children?: ReactNode; activeCount?: number; onClear?: () => void; shown?: number; total?: number; noun?: string; trailing?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="filter-bar mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2">
      {search}
      {children && (
        <>
          {/* On a phone the pills stay folded away, so the list is still visible. */}
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cx('flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] sm:hidden', activeCount ? 'border-accent bg-accent-soft font-medium text-accent-ink' : 'border-line text-body')}>
            <SlidersHorizontal size={14} />Filters{activeCount ? ` (${activeCount})` : ''}
          </button>
          <div className={cx('contents', !open && 'max-sm:hidden')}>{children}</div>
        </>
      )}
      <span className="ml-auto flex items-center gap-2 empty:hidden">
        {shown != null && <span className="text-[13px] whitespace-nowrap text-muted tabular-nums max-sm:hidden" aria-live="polite">{total != null && total !== shown ? `${shown} of ${total}` : shown}{noun ? ` ${noun}` : ''}</span>}
        {activeCount > 0 && onClear && (
          <button type="button" onClick={onClear} className="flex h-9 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-accent-ink hover:bg-accent-soft"><RotateCcw size={13} />Reset</button>
        )}
        {trailing}
      </span>
    </div>
  );
}

/** Stage or status tabs with counts. */
export function CountTabs({ tabs, value, onChange, label }: { tabs: Option[]; value: string; onChange: (value: string) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="scroll-thin mb-3 flex gap-1.5 overflow-x-auto pb-1">
      {tabs.map((t) => {
        const on = t.value === value;
        return (
          <button key={t.value} type="button" role="tab" aria-selected={on} onClick={() => onChange(t.value)}
            className={cx('flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] whitespace-nowrap transition-colors max-sm:h-9', on ? 'border-brand bg-brand font-medium text-white dark:text-slate-950' : 'border-line bg-surface text-body hover:bg-surface-2')}>
            {t.label}
            {t.count != null && <span className={cx('rounded-full px-1.5 text-[11px] tabular-nums', on ? 'bg-white/25' : 'bg-surface-2 text-muted')}>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
