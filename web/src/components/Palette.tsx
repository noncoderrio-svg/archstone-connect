import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { cx } from './ui.tsx';

interface Item { label: string; hint: string; to: string }

/** Ctrl+K: jump to any screen or lead from the keyboard. */
export function CommandPalette({ pages }: { pages: { to: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [leads, setLeads] = useState<Item[]>([]);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const nav = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) { setQ(''); setLeads([]); setTimeout(() => input.current?.focus()); }
  }, [open]);

  useEffect(() => {
    setIndex(0);
    if (q.trim().length < 2) return setLeads([]);
    const t = setTimeout(() => {
      api.get(`/leads?q=${encodeURIComponent(q)}`)
        .then((r) => setLeads(r.leads.slice(0, 6).map((l: any) => ({ label: l.name, hint: l.stage, to: `/leads/${l.id}` }))))
        .catch(() => setLeads([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const items = useMemo(() => {
    const matched = pages.filter((p) => p.label.toLowerCase().includes(q.toLowerCase())).map((p) => ({ label: p.label, hint: 'Go to', to: p.to }));
    return [...leads, ...matched].slice(0, 9);
  }, [leads, pages, q]);

  if (!open) return null;
  const go = (item?: Item) => {
    if (item) { nav(item.to); setOpen(false); }
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-slate-950/50 p-4 pt-[12dvh]" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div role="dialog" aria-label="Command palette" className="fade-in w-full max-w-lg overflow-hidden rounded-xl bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={17} className="text-muted" />
          <input ref={input} aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search leads or screens"
            className="h-12 w-full bg-transparent text-sm text-ink outline-none"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, items.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
              if (e.key === 'Enter') go(items[index]);
            }} />
        </div>
        <ul className="max-h-80 overflow-y-auto py-1">
          {!items.length && <li className="px-4 py-3 text-sm text-muted">Nothing found.</li>}
          {items.map((item, i) => (
            <li key={item.to}>
              <button onMouseEnter={() => setIndex(i)} onClick={() => go(item)} className={cx('flex w-full items-center justify-between px-4 py-2 text-left text-sm', i === index && 'bg-surface-2')}>
                <span className="text-ink">{item.label}</span><span className="text-xs text-muted">{item.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
