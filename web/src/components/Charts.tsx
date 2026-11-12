import { Empty } from './ui.tsx';

/** Horizontal bars in one hue: labels and values stay in text colours, the mark carries size. */
export function BarList({ rows, format = (v) => String(v), emptyTitle = 'No data yet' }: {
  rows: { label: string; value: number }[];
  format?: (v: number) => string;
  emptyTitle?: string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  if (!max) return <Empty title={emptyTitle} />;
  return (
    <ul className="space-y-2 px-4 pb-4">
      {rows.map((r) => (
        <li key={r.label} title={`${r.label}: ${format(r.value)}`} className="group">
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="truncate text-body">{r.label}</span>
            <span className="font-medium text-ink tabular-nums">{format(r.value)}</span>
          </div>
          <div className="h-2 rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-brand transition-opacity group-hover:opacity-80" style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Pipeline funnel: bar length plus the share kept from the first stage. */
export function Funnel({ rows }: { rows: { stage: string; count: number }[] }) {
  const peak = Math.max(...rows.map((r) => r.count), 0);
  if (!peak) return <Empty title="No leads in the pipeline yet" />;
  return (
    <ul className="space-y-1.5 px-4 pb-4">
      {rows.map((r) => (
        <li key={r.stage} className="grid grid-cols-[minmax(0,9.5rem)_1fr_2.25rem] items-center gap-2 text-[13px]" title={`${r.stage}: ${r.count}`}>
          <span className="truncate text-body">{r.stage}</span>
          <div className="h-5 rounded bg-surface-2">
            <div className="h-full rounded bg-brand" style={{ width: r.count ? `${Math.max(2, (r.count / peak) * 100)}%` : 0 }} />
          </div>
          <span className="text-right font-medium text-ink tabular-nums">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}
