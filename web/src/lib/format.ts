// The server stores UTC as "YYYY-MM-DD HH:MM:SS". Staff always see India time.
const toDate = (s: string) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
const TZ = 'Asia/Kolkata';

export const dateTime = (s?: string | null) =>
  s ? toDate(s).toLocaleString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';

export const timeOnly = (s?: string | null) =>
  s ? toDate(s).toLocaleTimeString('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : '—';

export function timeAgo(s?: string | null) {
  if (!s) return '—';
  const mins = Math.round((Date.now() - toDate(s).getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export const ago = (s?: string | null) => { const t = timeAgo(s); return t === 'now' ? 'just now' : `${t} ago`; };

export const isOverdue = (s?: string | null) => Boolean(s && toDate(s).getTime() < Date.now());

/** Converts a browser datetime-local value to the server's UTC format. */
export const localToUtc = (value: string) => new Date(value).toISOString().slice(0, 19).replace('T', ' ');

export const lakhs = (v?: number | null) => {
  if (v === null || v === undefined) return '—';
  return v >= 100 ? `₹${(v / 100).toFixed(2).replace(/\.?0+$/, '')} Cr` : `₹${v} L`;
};

/** Full rupee figure from a lakhs value, for receipts and cost sheets. */
export const fullRupees = (l: number) => '₹' + Math.round(l * 100000).toLocaleString('en-IN');

export const inr = (v?: number | null) => (v === null || v === undefined ? '—' : `₹${Math.round(v).toLocaleString('en-IN')}`);

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');

export const stripPhone = (phone: string) => phone.replace(/\D/g, '');

/** A link that opens Google Calendar with the event filled in. Needs no Google set-up. */
export function googleCalendarLink(title: string, location: string, startUtc: string) {
  const start = toDate(startUtc);
  const end = new Date(start.getTime() + 3600000);
  const stamp = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const params = new URLSearchParams({ action: 'TEMPLATE', text: title, location, dates: `${stamp(start)}/${stamp(end)}` });
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** Downloads a contact card, which any phone can import. */
export function downloadVcard(lead: { name: string; phone: string; email?: string }) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${lead.name}`, `TEL;TYPE=CELL:${lead.phone}`, ...(lead.email ? [`EMAIL:${lead.email}`] : []), 'ORG:Archstone lead', 'END:VCARD'];
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/vcard' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${lead.name.replace(/[^\w ]+/g, '')}.vcf`;
  link.click();
  URL.revokeObjectURL(url);
}

/** "+919000010000" becomes "+91 90000 10000". Masked numbers are left alone. */
export const prettyPhone = (phone: string) => phone.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2');

/** Small CSV reader that handles quoted cells, for the import screen. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return body
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}
