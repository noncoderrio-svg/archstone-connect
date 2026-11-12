import { Tag } from 'lucide-react';
import { useState } from 'react';
import { api, useApi } from '../lib/api.ts';
import { Button, Modal, cx, useAction } from './ui.tsx';

export const LABEL_COLORS: Record<string, string> = {
  teal: 'bg-cyan-100 text-cyan-900 dark:bg-cyan-950/60 dark:text-cyan-200',
  green: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
  red: 'bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200',
  violet: 'bg-violet-100 text-violet-900 dark:bg-violet-950/60 dark:text-violet-200',
  slate: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100',
};

export function LabelChip({ name, catalog }: { name: string; catalog: { name: string; color: string }[] }) {
  const color = catalog.find((l) => l.name === name)?.color ?? 'slate';
  return <span className={cx('inline-block rounded-full px-1.5 py-px text-[11px] font-medium whitespace-nowrap', LABEL_COLORS[color])}>{name}</span>;
}

/** The label list set by the admin, shared by every screen. */
export function useLabels() {
  const { data } = useApi('/directory');
  return (data?.labels ?? []) as { name: string; color: string }[];
}

/** Lets staff tag a lead or chat with one tap. */
export function LabelButton({ leadId, labels, onChange }: { leadId: number; labels: string[]; onChange: () => void }) {
  const catalog = useLabels();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(labels);
  const { busy, run } = useAction();
  const save = async () => {
    if (await run(() => api.post(`/leads/${leadId}/labels`, { labels: picked }), 'Labels saved')) { setOpen(false); onChange(); }
  };
  return (
    <>
      <Button size="sm" onClick={() => { setPicked(labels); setOpen(true); }}><Tag size={14} />Label</Button>
      {open && (
        <Modal title="Labels" onClose={() => setOpen(false)}>
          <div className="flex flex-wrap gap-2">
            {catalog.map((l) => {
              const on = picked.includes(l.name);
              return (
                <button key={l.name} aria-pressed={on} onClick={() => setPicked(on ? picked.filter((x) => x !== l.name) : [...picked, l.name])}
                  className={cx('rounded-full border-2 px-2.5 py-1 text-[13px] font-medium', LABEL_COLORS[l.color], on ? 'border-brand' : 'border-transparent opacity-70')}>
                  {on ? '✓ ' : ''}{l.name}
                </button>
              );
            })}
          </div>
          <div className="mt-4 flex justify-end gap-2"><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Save</Button></div>
        </Modal>
      )}
    </>
  );
}
