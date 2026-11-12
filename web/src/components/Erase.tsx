import { Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api, useApi } from '../lib/api.ts';
import { lakhs } from '../lib/format.ts';
import { Button, ErrorNote, Modal, Notice, Spinner, TextField, TextareaField, useAction } from './ui.tsx';

/** The red button that opens an erase window. Only shown to admins; the server refuses everyone else anyway. */
export function EraseButton({ label = 'Erase', onClick, size = 'sm' }: { label?: string; onClick: () => void; size?: 'sm' | 'md' }) {
  return <Button size={size} variant="ghost" className="text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40" onClick={onClick}><Trash2 size={14} />{label}</Button>;
}

/**
 * A confirmation window for permanent removal. Shows what will go, then needs a typed word
 * (and a reason, when asked) before the red button works.
 */
export function ConfirmErase({ title, children, word, needReason, action, actionLabel = 'Erase for good', onClose, onDone }: {
  title: string; children: ReactNode; word?: string; needReason?: boolean;
  action: (reason: string) => Promise<unknown>; actionLabel?: string; onClose: () => void; onDone: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const ready = (!word || typed === word) && (!needReason || reason.trim().length >= 3);
  const go = async () => { if (await run(() => action(reason.trim()).then(() => true), 'Erased')) onDone(); };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {children}
        <Notice>This cannot be undone. It is written to the audit log.</Notice>
        {needReason && <TextareaField label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />}
        {word && <TextField label={`Type ${word} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={busy} disabled={!ready} onClick={go}>{actionLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Erase a booking: shows exactly what goes (stages, receipts and their value, follow-up notes, commission) and what happens to the flat. */
export function EraseBooking({ bookingId, onClose, onDone }: { bookingId: number; onClose: () => void; onDone: () => void }) {
  const { data, error } = useApi(`/erase/bookings/${bookingId}`);
  if (error) return <Modal title="Erase booking" onClose={onClose}><ErrorNote>{error}</ErrorNote></Modal>;
  if (!data) return <Modal title="Erase booking" onClose={onClose}><Spinner /></Modal>;
  const { booking: b, removes: r } = data;
  return (
    <ConfirmErase title={`Erase booking: ${b.lead_name}`} word="ERASE" needReason onClose={onClose} onDone={onDone}
      action={(reason) => api.post(`/erase/bookings/${bookingId}`, { reason, confirm: 'ERASE' })}>
      <p className="text-muted">{b.project_name} · Flat {b.flat} · {lakhs(b.amount_lakhs)} · {b.status === 'active' ? 'Active' : 'Cancelled'}</p>
      <div>
        <p className="mb-1 font-medium text-ink">This removes for good:</p>
        <ul className="list-disc space-y-0.5 pl-5">
          <li>The booking record</li>
          <li>{r.payment_stages} payment stage{r.payment_stages === 1 ? '' : 's'}</li>
          <li>{r.receipts} receipt{r.receipts === 1 ? '' : 's'}{r.receipts ? `, worth ${lakhs(r.receipts_lakhs)}` : ''}</li>
          <li>{r.followups} payment follow-up note{r.followups === 1 ? '' : 's'}</li>
          <li>{r.commission ? `Commission of ${lakhs(r.commission.amount_lakhs)} for ${r.commission.partner_name} (${r.commission.status})` : 'No commission'}</li>
        </ul>
      </div>
      <p className="text-ink">{data.flat}</p>
      <p className="text-ink">{data.customer}</p>
      <p className="text-[13px] text-muted">To keep the record instead, use Cancel booking.</p>
    </ConfirmErase>
  );
}
