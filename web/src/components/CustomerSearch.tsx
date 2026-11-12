import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { Input, cx } from './ui.tsx';

export interface Customer { id: number; name: string; phone: string; stage: string; project_name?: string }

/** Find a customer by name or phone. Only customers this person may see are offered, because the server filters them. */
export function CustomerSearch({ label = 'Customer', value, onChange }: { label?: string; value: Customer | null; onChange: (c: Customer | null) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api.get(`/leads?q=${encodeURIComponent(term)}`)
        .then((d: any) => { if (live) setResults(d.leads.slice(0, 8)); })
        .catch(() => { if (live) setResults([]); })
        .finally(() => { if (live) setLoading(false); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [q]);

  if (value) {
    return (
      <div>
        <p className="mb-1 text-sm font-medium text-ink">{label}</p>
        <div className="flex items-center justify-between gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{value.name}</p>
            <p className="truncate text-xs text-muted">{value.phone} · {value.stage}</p>
          </div>
          <button type="button" onClick={() => onChange(null)} className="rounded-lg p-1 text-muted hover:bg-surface hover:text-ink" aria-label="Choose someone else"><X size={16} /></button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink" htmlFor="customer-search">{label}</label>
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <Input id="customer-search" className="pl-9" placeholder="Search by name or phone" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </div>
      {q.trim().length >= 2 && (
        <ul className="mt-1 max-h-56 overflow-y-auto rounded-xl border border-line bg-surface" role="listbox" aria-label="Matching customers">
          {loading && !results.length && <li className="px-3 py-2 text-sm text-muted">Searching…</li>}
          {!loading && !results.length && <li className="px-3 py-2 text-sm text-muted">No customer found</li>}
          {results.map((c) => (
            <li key={c.id}>
              <button type="button" role="option" aria-selected={false} onClick={() => { onChange(c); setQ(''); }}
                className={cx('flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2')}>
                <span className="min-w-0 truncate font-medium text-ink">{c.name}</span>
                <span className="shrink-0 text-xs text-muted">{c.phone}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
