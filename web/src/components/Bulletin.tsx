import { Megaphone } from 'lucide-react';
import { useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';

export const BULLETIN_KINDS: Record<string, string> = { news: 'News', target: 'Target', launch: 'New launch', offer: 'Offer', birthday: 'Birthday' };

/** Admin-written messages scrolling under the top bar, in Archstone charcoal and orange. Hidden when there is nothing to show. */
export function BulletinBar() {
  const { on, can } = useAuth();
  const allowed = on('bulletin') && can('bulletin.view');
  const { data } = useApi<{ bulletins: { id: number; text: string; kind: string }[] }>(allowed ? '/bulletins/current' : null, ['bulletins']);
  const items = allowed ? data?.bulletins ?? [] : [];
  if (!items.length) return null;
  const line = items.map((b) => (
    <span key={b.id} className="inline-flex items-center gap-2 pr-12">
      <span className="rounded-full bg-[#e86920] px-2 py-px text-[11px] font-semibold tracking-wide text-white uppercase">{BULLETIN_KINDS[b.kind] ?? 'News'}</span>
      <span>{b.text}</span>
    </span>
  ));
  return (
    <div className="bulletin relative flex h-8 shrink-0 items-center overflow-hidden bg-[#1b1f27] text-[13px] text-white" role="region" aria-label="Company bulletin">
      <span className="z-10 flex h-full shrink-0 items-center gap-1.5 bg-[#b9531b] px-3 font-semibold"><Megaphone size={14} aria-hidden /><span className="hidden sm:inline">Bulletin</span></span>
      <div className="min-w-0 flex-1 overflow-hidden">
        {/* Two copies side by side make the scroll seamless. Screen readers get the list once. */}
        <div className="bulletin-track flex w-max whitespace-nowrap">
          <div className="flex pl-4">{line}</div>
          <div className="flex pl-4" aria-hidden>{line}</div>
        </div>
      </div>
    </div>
  );
}
