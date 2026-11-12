import { Printer } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Button, ErrorNote, Logo, Notice, Spinner } from '../components/ui.tsx';
import { useApi } from '../lib/api.ts';
import { fullRupees } from '../lib/format.ts';
import { COMPANY } from '../../../shared/domain.ts';

/** Printable cost sheet, opened in its own tab. */
export default function CostSheet() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { data, error } = useApi(`/leads/${id}/cost-sheet?unit_id=${params.get('unit')}&discount=${params.get('discount') ?? 0}`);
  if (error) return <div className="p-6"><ErrorNote>{error}</ErrorNote></div>;
  if (!data) return <Spinner />;
  return (
    <div className="mx-auto max-w-2xl bg-white p-8 text-slate-800">
      <div className="flex items-start justify-between border-b border-slate-300 pb-4">
        <Logo variant="print" className="w-56" />
        <div className="text-right">
          <h1 className="font-display text-2xl font-semibold text-slate-900">Cost Sheet</h1>
          <p className="text-sm">{new Date().toLocaleDateString('en-IN', { dateStyle: 'long', timeZone: 'Asia/Kolkata' })}</p>
          {data.project.rera_number && <p className="text-sm">MahaRERA: {data.project.rera_number}</p>}
        </div>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <dt className="text-slate-500">Customer</dt><dd className="font-medium">{data.lead.name}</dd>
        <dt className="text-slate-500">Project</dt><dd className="font-medium">{data.project.name}, {data.project.location}</dd>
        <dt className="text-slate-500">Unit</dt><dd className="font-medium">Tower {data.unit.tower}, {data.unit.number} (Floor {data.unit.floor})</dd>
        <dt className="text-slate-500">Configuration</dt><dd className="font-medium">{data.unit.configuration || '—'}{data.unit.carpet_sqft ? `, ${data.unit.carpet_sqft} sq ft carpet` : ''}</dd>
      </dl>
      <table className="mt-5 w-full text-sm">
        <tbody className="divide-y divide-slate-200">
          {data.lines.map((l: any) => (
            <tr key={l.label} className={l.label === 'Agreement value' ? 'font-semibold text-slate-900' : ''}>
              <td className="py-1.5">{l.label}</td>
              <td className="py-1.5 text-right tabular-nums">{l.amount < 0 ? `− ${fullRupees(-l.amount)}` : fullRupees(l.amount)}</td>
            </tr>
          ))}
          <tr className="text-base font-semibold text-slate-900"><td className="py-2">Total</td><td className="py-2 text-right tabular-nums">{fullRupees(data.total)}</td></tr>
        </tbody>
      </table>
      {data.missing.length > 0 && <div className="mt-3 print:hidden"><Notice>Not included, because rates are not set on this project: {data.missing.join(', ')}.</Notice></div>}
      <p className="mt-6 text-xs text-slate-500">
        Indicative only, and subject to the final agreement and the rates in force at registration.
        {data.missing.length > 0 && ` Excludes ${data.missing.join(', ')}.`} Prepared by {data.prepared_by}.
      </p>
      <p className="mt-1 text-xs text-slate-500">{[COMPANY.name, COMPANY.address].filter(Boolean).join(', ')}</p>
      <Button variant="primary" className="mt-5 print:hidden" onClick={() => window.print()}><Printer size={15} />Print or save as PDF</Button>
    </div>
  );
}
