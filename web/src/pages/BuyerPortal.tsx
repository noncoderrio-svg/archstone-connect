import { CheckCircle2, Circle, CircleDot } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Logo } from '../components/ui.tsx';
import { lakhs } from '../lib/format.ts';

/** The buyer's own page. It opens from a private link, with no login. */
export default function BuyerPortal({ token }: { token: string }) {
  const [data, setData] = useState<any>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    document.documentElement.classList.remove('dark');
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex';
    document.head.append(robots);
    fetch(`/public/buyer/${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .then(setData, () => setFailed(true));
  }, [token]);

  if (failed) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6 text-center">
        <div><Logo className="mx-auto mb-6 w-60" /><h1 className="font-display text-2xl font-semibold">This link is not available</h1><p className="text-muted">Please ask your Archstone contact for a new link.</p></div>
      </main>
    );
  }
  if (!data) return <p className="p-10 text-center text-muted" role="status">Loading your home details…</p>;

  const paidShare = data.amount_lakhs ? Math.min(100, Math.round((data.collected_lakhs / data.amount_lakhs) * 100)) : 0;
  const stageIndex = data.handover_stages.indexOf(data.handover_status);

  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <header className="space-y-4">
        <Logo className="w-48" />
        <div><p className="text-sm text-muted">Welcome, {data.buyer}</p><h1 className="font-display text-2xl leading-tight font-semibold">{data.project}</h1></div>
      </header>

      <section className="card rounded-xl border border-line bg-surface p-4">
        <p className="text-ink">Tower {data.tower}, Unit {data.unit}{data.configuration ? ` · ${data.configuration}` : ''}</p>
        <p className="text-sm text-muted">{data.location}{data.rera ? ` · MahaRERA ${data.rera}` : ''}</p>
        <div className="mt-3 flex justify-between text-sm"><span>Paid {lakhs(data.collected_lakhs)}</span><span className="text-muted">of {lakhs(data.amount_lakhs)}</span></div>
        <div className="mt-1 h-2 rounded-full bg-surface-2" role="img" aria-label={`${paidShare}% paid`}><div className="h-full rounded-full bg-brand" style={{ width: `${paidShare}%` }} /></div>
      </section>

      <section className="card rounded-xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold">Handover progress</h2>
        <ol className="mt-2 space-y-1.5">
          {data.handover_stages.map((s: string, i: number) => (
            <li key={s} className="flex items-center gap-2 text-sm">
              {i < stageIndex ? <CheckCircle2 size={17} className="text-emerald-700" /> : i === stageIndex ? <CircleDot size={17} className="text-brand" /> : <Circle size={17} className="text-muted" />}
              <span className={i === stageIndex ? 'font-medium text-ink' : i > stageIndex ? 'text-muted' : ''}>{s}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="card rounded-xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold">Payment schedule</h2>
        {!data.payments.length && <p className="mt-1 text-sm text-muted">Your schedule will appear here soon.</p>}
        <ul className="mt-1 divide-y divide-line">
          {data.payments.map((p: any) => (
            <li key={p.label + p.due_date} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span><span className="block text-ink">{p.label}</span><span className="text-xs text-muted">{p.paid_at ? `Paid · Receipt ${p.receipt_number}` : `Due ${p.due_date}`}</span></span>
              <span className={p.paid_at ? 'font-medium text-emerald-700' : 'font-medium text-ink'}>{lakhs(p.amount_lakhs)}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-center text-[13px] text-muted">Questions? {data.contact ? `Speak to ${data.contact}, your Archstone contact.` : 'Speak to your Archstone contact.'} Please keep this link private.</p>
    </main>
  );
}
