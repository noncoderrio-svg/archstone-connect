import { config } from '../config.ts';
import { all, get, getSetting, minutesFromNow, nowIso, run, setSetting } from '../db.ts';
import { ingestLead } from './leads.ts';
import { decryptText } from './secrets.ts';
import { sendAutomation } from './whatsapp.ts';

const LEAD_FIELDS = 'id,created_time,field_data,campaign_name,adset_name,ad_name,form_id,platform';
const graph = (path: string) => `https://graph.facebook.com/${config.whatsapp.apiVersion}/${path}`;

async function ask(path: string, token: string) {
  const url = path.startsWith('https://') ? path : graph(path);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `Meta error ${res.status}`);
  return data;
}

const tokenFor = (pageId?: string) => {
  const page = pageId ? get<{ token: string }>('SELECT token FROM meta_pages WHERE page_id = ?', pageId) : undefined;
  return page ? decryptText(page.token) : config.metaPageToken;
};

/** Reads "₹1.60_cr_-_₹1.85_cr" or "80 lakhs" as the top of the range, in lakhs. */
export function budgetLakhs(text: string) {
  const clean = text.toLowerCase().replace(/[_,]/g, ' ');
  const amounts = [...clean.matchAll(/(\d+(?:\.\d+)?)\s*(cr|crore|l\b|lac|lakh)?/g)].filter((m) => m[1]);
  if (!amounts.length) return null;
  const unit = [...amounts].reverse().find((m) => m[2])?.[2] ?? '';
  if (!unit) return null;
  const value = Number(amounts[amounts.length - 1][1]);
  return Math.round((unit.startsWith('cr') ? value * 100 : value) * 100) / 100;
}

/** Forms name their questions freely, so each value accepts the common spellings. */
function answers(fieldData: { name: string; values?: string[] }[] = []) {
  const clean = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const find = (...names: string[]) => fieldData.find((f) => names.includes(clean(f.name)))?.values?.[0]?.trim() ?? '';
  const known = new Set(['fullname', 'name', 'firstname', 'lastname', 'phonenumber', 'phone', 'mobilenumber', 'mobile', 'whatsappnumber', 'email', 'emailaddress', 'phonenumberverified']);
  const first = find('firstname');
  const asked = (word: RegExp) => fieldData.find((f) => word.test(clean(f.name)))?.values?.[0] ?? '';
  const home = asked(/configuration|bhk|flattype|hometype/).replace(/_+/g, ' ').trim();
  // Forms also say work_email, email_id or e-mail. Failing that, any answer shaped like an email counts.
  const isEmail = (f: { values?: string[] }) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.values?.[0]?.trim() ?? '');
  const emailField = fieldData.find((f) => clean(f.name).includes('mail') && isEmail(f)) ?? fieldData.find(isEmail);
  return {
    configuration: home.replace(/\bbhk\b/i, 'BHK'),
    budget_lakhs: budgetLakhs(asked(/budget/)),
    name: find('fullname', 'name') || [first, find('lastname')].filter(Boolean).join(' '),
    phone: find('phonenumber', 'phone', 'mobilenumber', 'mobile', 'whatsappnumber'),
    email: emailField?.values?.[0]?.trim() ?? '',
    // Custom questions, such as budget or preferred home, stay readable on the lead.
    notes: fieldData.filter((f) => f !== emailField && !known.has(clean(f.name)) && f.values?.length).map((f) => `${f.name.replace(/_/g, ' ').trim()}: ${f.values!.join(', ').replace(/_+/g, ' ').trim()}`).join('\n'),
  };
}

/** Safe to call twice for one Meta lead, so the webhook and the catch-up pull can overlap. */
export async function saveMetaLead(data: any, formName = '') {
  const metaId = String(data.id);
  if (get('SELECT 1 AS x FROM meta_seen WHERE meta_lead_id = ?', metaId)) return null;
  const a = answers(data.field_data);
  if (!a.phone) throw new Error(`Meta lead ${metaId} has no phone number.`);
  const result = ingestLead({
    name: a.name.length >= 2 ? a.name : 'Meta Lead',
    phone: a.phone,
    email: a.email,
    source: 'Meta Ads',
    notes: a.notes,
    configuration: a.configuration,
    budget_lakhs: a.budget_lakhs,
    utm_source: data.platform || 'meta',
    utm_campaign: data.campaign_name ?? '',
    adset: data.adset_name ?? '',
    ad: data.ad_name ?? '',
    form_name: formName,
  });
  run('INSERT OR IGNORE INTO meta_seen(meta_lead_id, lead_id) VALUES(?, ?)', metaId, result.id);
  if (result.created) {
    const lead = get<any>('SELECT * FROM leads WHERE id = ?', result.id);
    if (lead) await sendAutomation('welcome', lead).catch((e) => console.error('Welcome message failed:', e.message));
  }
  return result;
}

const formNameFor = async (formId: string | undefined, token: string) => {
  if (!formId) return '';
  return (await ask(`${formId}?fields=name`, token).catch(() => null))?.name ?? '';
};

/** Called by the instant Meta notification. */
export async function pullMetaLead(leadgenId: string, pageId?: string) {
  const token = tokenFor(pageId);
  const data = await ask(`${leadgenId}?fields=${LEAD_FIELDS}`, token);
  return saveMetaLead(data, await formNameFor(data.form_id, token));
}

/** Fetches anything the instant notification missed, such as during a restart. */
export async function syncPage(page: { id: number; page_id: string; token: string; last_sync_at: string | null }) {
  const token = decryptText(page.token);
  const since = Math.floor(new Date(`${(page.last_sync_at ?? minutesFromNow(-24 * 60)).replace(' ', 'T')}Z`).getTime() / 1000) - 3600;
  const filtering = encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: since }]));
  let saved = 0;
  const forms = await ask(`${page.page_id}/leadgen_forms?fields=id,name&limit=100`, token);
  for (const form of forms.data ?? []) {
    let next: string | undefined = `${form.id}/leads?fields=${LEAD_FIELDS}&limit=100&filtering=${filtering}`;
    while (next) {
      const batch: any = await ask(next, token);
      for (const lead of batch.data ?? []) {
        try {
          if (await saveMetaLead(lead, form.name)) saved += 1;
        } catch (e) {
          console.error('Meta lead failed:', (e as Error).message);
        }
      }
      next = batch.paging?.next;
    }
  }
  run(`UPDATE meta_pages SET last_sync_at = ?, last_error = '', leads_pulled = leads_pulled + ? WHERE id = ?`, nowIso(), saved, page.id);
  return saved;
}

let syncing = false;

/** Runs every 15 minutes. One page failing must not stop the others. */
export async function syncMetaLeads(force = false) {
  const last = getSetting<string>('meta_sync_last', '');
  if (syncing || (!force && last && last > minutesFromNow(-15))) return;
  const pages = all<any>('SELECT * FROM meta_pages WHERE enabled = 1');
  if (!pages.length) return;
  syncing = true;
  setSetting('meta_sync_last', nowIso());
  try {
    for (const page of pages) {
      try {
        await syncPage(page);
      } catch (e) {
        run('UPDATE meta_pages SET last_error = ? WHERE id = ?', (e as Error).message.slice(0, 200), page.id);
      }
    }
  } finally {
    syncing = false;
  }
}

/** Confirms a page and token work before they are saved. */
export const checkMetaPage = (pageId: string, token: string) => ask(`${pageId}?fields=name`, token);
