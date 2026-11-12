import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, type SessionUser } from '../auth.ts';
import { config, whatsappLive } from '../config.ts';
import { all, get, getSetting, minutesFromNow, nowIso, run, setSetting, tx } from '../db.ts';
import { classifyWithAi } from './ai.ts';
import { BOT_GREETING, botStep, type BotLanguage, type BotProject } from './bot.ts';
import { broadcast, leadScope, normalizePhone, notify } from './core.ts';
import { classifyMessage } from './insight.ts';
import { assignLead, ingestLead, logActivity, markResponded, nextTelecaller, rescore } from './leads.ts';
import { decryptText } from './secrets.ts';

const STOP_WORDS = ['stop', 'unsubscribe', 'opt out', 'optout', 'cancel', 'band karo', 'बंद करो', 'रोको'];
const WINDOW_MS = 24 * 3600 * 1000;

const asUtc = (s: string) => new Date(s.replace(' ', 'T') + 'Z').getTime();

export const formatIst = (s: string) =>
  new Date(asUtc(s)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

/** WhatsApp allows free-form replies only for 24 hours after the customer last wrote. */
export const windowOpen = (lead: { last_inbound_at: string | null }) =>
  Boolean(lead.last_inbound_at && Date.now() - asUtc(lead.last_inbound_at) < WINDOW_MS);

// ---------- Template rendering ----------
export const templateVars = (body: string) => [...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

function varsFor(lead: any, extra: Record<string, string> = {}) {
  const project = lead.project_id ? get<any>('SELECT * FROM projects WHERE id = ?', lead.project_id) : null;
  const owner = lead.owner_id ? get<any>('SELECT name FROM users WHERE id = ?', lead.owner_id) : null;
  const price = project?.price_from_lakhs;
  return {
    name: lead.name.split(' ')[0],
    project: project?.name ?? 'our projects',
    location: project?.location ?? 'Mumbai',
    price: price ? (price >= 100 ? `₹${(price / 100).toFixed(2)} Cr` : `₹${price} Lakhs`) : '',
    rera: project?.rera_number ?? '',
    agent: owner?.name ?? 'Archstone',
    visit_time: '',
    ...extra,
  } as Record<string, string>;
}

export const renderTemplate = (body: string, vars: Record<string, string>) =>
  body.replace(/\{\{(\w+)\}\}/g, (_m, key) => vars[key] ?? '');

/** Names every reason this contact must not receive this template. Empty means allowed. */
export function sendBlockers(lead: any, template?: any): string[] {
  const reasons: string[] = [];
  if (lead.do_not_contact) reasons.push('Contact is on the do-not-contact list.');
  if (lead.wa_opted_out_at) reasons.push('Contact has opted out of WhatsApp messages.');
  if (template) {
    if (template.status !== 'approved') reasons.push('Template is not approved.');
    if (template.category === 'MARKETING' && !lead.wa_opt_in) reasons.push('Contact has not opted in to marketing messages.');
    if (template.category === 'MARKETING') {
      const project = lead.project_id ? get<any>('SELECT name, rera_number FROM projects WHERE id = ?', lead.project_id) : null;
      if (project && !project.rera_number) reasons.push(`${project.name} has no MahaRERA number yet.`);
    }
  }
  return reasons;
}

// ---------- Provider ----------
/**
 * The number a message goes out on: the one this conversation already uses,
 * then the sender's own number, then the lead owner's, then the company number.
 */
export function pickNumber(lead: any, actorId?: number | null) {
  const active = (sql: string, v: number) => get<any>(`SELECT * FROM wa_numbers WHERE status = 'active' AND ${sql} = ?`, v);
  return (
    (lead.wa_number_id && active('id', lead.wa_number_id)) ||
    (actorId && active('user_id', actorId)) ||
    (lead.owner_id && active('user_id', lead.owner_id)) ||
    null
  );
}

const numberLive = (n: any | null) => (n ? Boolean((n.token || config.whatsapp.token) && !n.phone_number_id.startsWith('demo')) : whatsappLive());

async function deliver(phone: string, payload: Record<string, unknown>, number?: any | null): Promise<string> {
  const { apiVersion } = config.whatsapp;
  const phoneNumberId = number?.phone_number_id ?? config.whatsapp.phoneNumberId;
  const token = number?.token ? decryptText(number.token) : config.whatsapp.token;
  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone.replace('+', ''), ...payload }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `WhatsApp API error ${res.status}`);
  return data.messages?.[0]?.id;
}

const simulatedId = () => `demo.${randomBytes(9).toString('hex')}`;

/** Demo mode only: walks a message through the same status updates Meta would send. */
function simulateProgress(waId: string) {
  const step = (status: string, ms: number) =>
    setTimeout(() => applyStatus(waId, status), ms).unref();
  step('delivered', 1200);
  step('read', 3500);
}

// ---------- Sending ----------
function insertOutbound(args: {
  leadId: number; body: string; templateId?: number | null; campaignId?: number | null; status: string; actorId?: number | null;
  mediaUrl?: string; mediaType?: string;
}) {
  const lead = get<any>('SELECT id, wa_number_id, owner_id FROM leads WHERE id = ?', args.leadId);
  const number = pickNumber(lead, args.actorId);
  const { id } = run(
    `INSERT INTO wa_messages(lead_id, direction, body, template_id, campaign_id, status, simulated, actor_id, media_url, media_type, number_id)
     VALUES(?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args.leadId, args.body, args.templateId ?? null, args.campaignId ?? null, args.status, numberLive(number) ? 0 : 1, args.actorId ?? null,
    args.mediaUrl ?? '', args.mediaType ?? '', number?.id ?? null,
  );
  run('UPDATE leads SET last_message_at = ?, wa_number_id = COALESCE(wa_number_id, ?) WHERE id = ?', nowIso(), number?.id ?? null, args.leadId);
  return id;
}

/** The media part of a template message, in the form the Cloud API expects. */
function headerComponent(type: string, url: string) {
  const kind = type.toLowerCase();
  const media = kind === 'document' ? { link: url, filename: 'Archstone-Group.pdf' } : { link: url };
  return { type: 'header', parameters: [{ type: kind, [kind]: media }] };
}

async function dispatch(messageId: number, extra: Record<string, string> = {}) {
  const m = get<any>(
    `SELECT m.*, l.phone, t.name AS template_name, t.language, t.body AS template_body, t.header_type, t.header_url
     FROM wa_messages m JOIN leads l ON l.id = m.lead_id LEFT JOIN wa_templates t ON t.id = m.template_id WHERE m.id = ?`,
    messageId,
  )!;
  try {
    let waId: string;
    const number = m.number_id ? get<any>('SELECT * FROM wa_numbers WHERE id = ?', m.number_id) : null;
    if (numberLive(number)) {
      const lead = get<any>('SELECT * FROM leads WHERE id = ?', m.lead_id);
      const vars = varsFor(lead, extra);
      let payload: Record<string, unknown>;
      if (m.template_id) {
        const components: unknown[] = [];
        if (m.header_type && m.header_type !== 'NONE') components.push(headerComponent(m.header_type, m.header_url));
        const names = templateVars(m.template_body);
        if (names.length) components.push({ type: 'body', parameters: names.map((k) => ({ type: 'text', text: vars[k] || '-' })) });
        payload = { type: 'template', template: { name: m.template_name, language: { code: m.language }, components } };
      } else if (m.media_type === 'document') {
        payload = { type: 'document', document: { link: m.media_url, caption: m.body, filename: 'Archstone-Group.pdf' } };
      } else if (m.media_type) {
        payload = { type: m.media_type, [m.media_type]: { link: m.media_url, caption: m.body } };
      } else {
        payload = { type: 'text', text: { body: m.body } };
      }
      waId = await deliver(m.phone, payload, number);
    } else {
      waId = simulatedId();
      simulateProgress(waId);
    }
    run(`UPDATE wa_messages SET status = 'sent', wa_id = ? WHERE id = ?`, waId, messageId);
  } catch (e) {
    run(`UPDATE wa_messages SET status = 'failed', error = ? WHERE id = ?`, (e as Error).message.slice(0, 300), messageId);
  }
  broadcast('inbox');
}

export async function sendText(lead: any, body: string, actorId: number | null) {
  const blockers = sendBlockers(lead);
  if (blockers.length) throw new HttpError(422, blockers[0]);
  if (!windowOpen(lead)) throw new HttpError(422, 'The 24-hour reply window is closed. Send an approved template instead.');
  const id = insertOutbound({ leadId: lead.id, body, status: 'queued', actorId });
  markResponded(lead.id);
  if (actorId) run(`UPDATE leads SET bot_state = 'done' WHERE id = ?`, lead.id); // A person has taken over.
  logActivity(lead.id, 'whatsapp', 'WhatsApp message sent', body, actorId);
  await dispatch(id);
  return get('SELECT * FROM wa_messages WHERE id = ?', id);
}

export async function sendTemplate(lead: any, templateId: number, actorId: number | null, extra: Record<string, string> = {}) {
  const template = get<any>('SELECT * FROM wa_templates WHERE id = ?', templateId);
  if (!template) throw new HttpError(404, 'Template not found.');
  const blockers = sendBlockers(lead, template);
  if (blockers.length) throw new HttpError(422, blockers[0]);
  const body = renderTemplate(template.body, varsFor(lead, extra));
  const media = template.header_type !== 'NONE' ? { mediaUrl: template.header_url, mediaType: template.header_type.toLowerCase() } : {};
  const id = insertOutbound({ leadId: lead.id, body, templateId, status: 'queued', actorId, ...media });
  if (actorId) markResponded(lead.id);
  logActivity(lead.id, 'whatsapp', `WhatsApp template sent: ${template.name}`, body, actorId);
  await dispatch(id, extra);
  return get('SELECT * FROM wa_messages WHERE id = ?', id);
}

/** Sends an image, video or document link, such as a brochure, inside the 24-hour window. */
export async function sendMediaMessage(lead: any, url: string, kind: string, caption: string, actorId: number) {
  const blockers = sendBlockers(lead);
  if (blockers.length) throw new HttpError(422, blockers[0]);
  if (!windowOpen(lead)) throw new HttpError(422, 'The 24-hour reply window is closed. Send an approved template instead.');
  const id = insertOutbound({ leadId: lead.id, body: caption, status: 'queued', actorId, mediaUrl: url, mediaType: kind });
  markResponded(lead.id);
  logActivity(lead.id, 'whatsapp', 'File sent on WhatsApp', caption, actorId);
  await dispatch(id);
  return get('SELECT * FROM wa_messages WHERE id = ?', id);
}

export const sendDocument = (lead: any, url: string, caption: string, actorId: number) => sendMediaMessage(lead, url, 'document', caption, actorId);

/** Sends an approved template to a staff phone, for example a daily report. */
export async function sendToStaff(phone: string, templateName: string, vars: Record<string, string>) {
  const template = get<any>('SELECT * FROM wa_templates WHERE name = ?', templateName);
  if (!template || template.status !== 'approved') return 'template not approved';
  if (!whatsappLive()) return 'simulated';
  const names = templateVars(template.body);
  await deliver(normalizePhone(phone), {
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
      components: names.length ? [{ type: 'body', parameters: names.map((k) => ({ type: 'text', text: vars[k] || '-' })) }] : [],
    },
  });
  return 'sent';
}

/** Runs an automation's template, quietly skipping contacts it must not reach. */
export async function sendAutomation(key: string, lead: any, extra: Record<string, string> = {}) {
  // A welcome is unasked-for contact, so it needs consent even though it is a utility template.
  if (key === 'welcome' && !lead.wa_opt_in) return false;
  const auto = get<any>('SELECT * FROM automations WHERE key = ? AND enabled = 1', key);
  if (!auto?.template_id) return false;
  const template = get<any>('SELECT * FROM wa_templates WHERE id = ?', auto.template_id);
  if (!template || sendBlockers(lead, template).length) return false;
  await sendTemplate(lead, auto.template_id, null, extra);
  return true;
}

// ---------- Receiving ----------
const statusRank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

export function applyStatus(waId: string, status: string, error = '') {
  const m = get<any>('SELECT id, status FROM wa_messages WHERE wa_id = ?', waId);
  if (!m || m.status === 'revoked' || !(status in statusRank) || statusRank[status] <= statusRank[m.status]) return;
  run('UPDATE wa_messages SET status = ?, error = ? WHERE id = ?', status, error, m.id);
  broadcast('inbox');
}

function isAfterHours() {
  const h = getSetting('business_hours', { start: 10, end: 19 });
  const ist = new Date(Date.now() + 5.5 * 3600000).getUTCHours();
  return ist < h.start || ist >= h.end;
}

async function botSay(leadId: number, body: string) {
  await dispatch(insertOutbound({ leadId, body, status: 'queued' }));
}

/** Runs the chatbot for this message. Returns true if the bot handled it. */
async function runBot(lead: any, text: string, isNew: boolean) {
  const auto = get<any>(`SELECT enabled FROM automations WHERE key = 'chatbot'`);
  if (!auto?.enabled || lead.do_not_contact) return false;
  const projects = all<BotProject>(
    `SELECT id, name, location, configuration, price_from_lakhs, brochure_url FROM projects WHERE status = 'ongoing' ORDER BY name`,
  );
  if (isNew) {
    if (!projects.length) return false;
    // A hoarding QR code pre-fills the project name in the first message.
    const named = projects.find((p) => text.toLowerCase().includes(p.name.toLowerCase()));
    if (named) run('UPDATE leads SET project_id = ? WHERE id = ?', named.id, lead.id);
    run(`UPDATE leads SET bot_state = 'language', bot_tries = 0 WHERE id = ?`, lead.id);
    await botSay(lead.id, BOT_GREETING);
    return true;
  }
  if (!lead.bot_state || lead.bot_state === 'done') return false;

  const step = botStep(lead.bot_state, lead.bot_tries, text, projects, (lead.language || 'en') as BotLanguage);
  run('UPDATE leads SET bot_state = ?, bot_tries = ? WHERE id = ?', step.state, step.tries, lead.id);
  if (step.language) {
    run('UPDATE leads SET language = ? WHERE id = ?', step.language, lead.id);
    const owner = lead.owner_id ? get<any>('SELECT languages FROM users WHERE id = ?', lead.owner_id) : null;
    if (owner?.languages && !owner.languages.split(',').includes(step.language)) {
      const better = nextTelecaller(lead.project_id, step.language);
      if (better && better.id !== lead.owner_id) assignLead(lead.id, better.id, better.id, `Speaks the customer's language (${step.language})`);
    }
  }
  const s = step.save ?? {};
  if ('project_id' in s) run('UPDATE leads SET project_id = ? WHERE id = ?', s.project_id ?? null, lead.id);
  if (s.configuration) run('UPDATE leads SET configuration = ? WHERE id = ?', s.configuration, lead.id);
  if (s.timeline) run('UPDATE leads SET timeline = ? WHERE id = ?', s.timeline, lead.id);
  if (s.budget_lakhs) run('UPDATE leads SET budget_lakhs = ? WHERE id = ?', s.budget_lakhs, lead.id);
  await botSay(lead.id, step.reply);

  if (step.finished || step.handover) {
    const title = step.finished ? 'Chatbot finished collecting details' : 'Chatbot handed over to the team';
    logActivity(lead.id, 'bot', title, step.wantsVisit ? 'Customer wants a site visit.' : '');
    notify(lead.owner_id, step.wantsVisit ? 'Customer wants a site visit' : 'WhatsApp lead is ready for you', lead.name, `/leads/${lead.id}`);
    if (step.wantsVisit && lead.owner_id) {
      run('INSERT INTO tasks(lead_id, owner_id, type, due_at, notes) VALUES(?, ?, ?, ?, ?)', lead.id, lead.owner_id, 'Call back', minutesFromNow(60), 'Fix a site visit time');
    }
  }
  return true;
}

export async function receiveInbound(msg: { phone: string; name?: string; body: string; waId?: string; simulated?: boolean; numberId?: number | null }) {
  const phone = normalizePhone(msg.phone);
  if (msg.waId && get('SELECT 1 AS x FROM wa_messages WHERE wa_id = ?', msg.waId)) return; // Meta retries webhooks.
  const number = msg.numberId ? get<any>('SELECT id, user_id, phone_app FROM wa_numbers WHERE id = ?', msg.numberId) : null;

  const { leadId, isNew } = tx(() => {
    let lead = get<any>('SELECT COALESCE(merged_into, id) AS id FROM leads WHERE phone = ?', phone);
    let isNew = false;
    if (!lead) {
      const r = ingestLead({
        name: msg.name?.trim() || 'WhatsApp Enquiry',
        phone,
        source: 'WhatsApp',
        wa_opt_in: true,
        wa_opt_in_source: 'Customer messaged first on WhatsApp',
        owner_id: number?.user_id ?? undefined, // Someone's own number means it is their lead.
      });
      lead = { id: r.id };
      isNew = true;
    }
    run(
      `INSERT INTO wa_messages(lead_id, direction, body, status, wa_id, simulated, number_id) VALUES(?, 'in', ?, 'received', ?, ?, ?)`,
      lead.id, msg.body, msg.waId ?? simulatedId(), msg.simulated ? 1 : 0, number?.id ?? null,
    );
    run(
      `UPDATE leads SET last_inbound_at = ?, last_message_at = ?, unread_count = unread_count + 1, wa_number_id = COALESCE(?, wa_number_id) WHERE id = ?`,
      nowIso(), nowIso(), number?.id ?? null, lead.id,
    );
    logActivity(lead.id, 'whatsapp', 'WhatsApp reply received', msg.body);
    return { leadId: lead.id as number, isNew };
  });

  const insight = classifyMessage(msg.body);
  run('UPDATE leads SET sentiment = ?, intent = ? WHERE id = ?', insight.sentiment, insight.intent, leadId);
  void classifyWithAi(msg.body)
    .then((better) => { if (better) run('UPDATE leads SET sentiment = ?, intent = ? WHERE id = ?', better.sentiment, better.intent, leadId); })
    .catch(() => undefined); // The rule-based result stands.

  const lead = get<any>('SELECT * FROM leads WHERE id = ?', leadId)!;
  const text = msg.body.trim().toLowerCase();
  if (STOP_WORDS.includes(text)) {
    run('UPDATE leads SET wa_opted_out_at = ?, wa_opt_in = 0 WHERE id = ?', nowIso(), leadId);
    logActivity(leadId, 'compliance', 'Opted out of WhatsApp', `Customer sent "${msg.body}"`);
  } else if (!number?.phone_app && await runBot(lead, msg.body, isNew)) { // A person is on that phone, so the bot stays out of it.
    rescore(leadId);
  } else {
    rescore(leadId);
    // The name stays out of the title, because titles appear on the lock screen.
    notify(lead.owner_id, 'New WhatsApp message', `${lead.name}: ${msg.body.slice(0, 80)}`, `/inbox/${leadId}`, { kind: 'message' });
    if (!number?.phone_app && (isAfterHours() || isNew)) {
      const reply = get<any>(`SELECT enabled FROM automations WHERE key = 'after_hours'`);
      const lastBot = get<any>(
        `SELECT 1 AS x FROM wa_messages WHERE lead_id = ? AND direction = 'out' AND actor_id IS NULL AND created_at > ?`,
        leadId, minutesFromNow(-720),
      );
      if (reply?.enabled && !lastBot) {
        const body = isNew
          ? `Namaste! Thank you for contacting Archstone. Our team will reach out to you shortly.`
          : `Thank you for contacting Archstone. Our office is closed now, and we will reply during business hours.`;
        const id = insertOutbound({ leadId, body, status: 'queued' });
        await dispatch(id);
      }
    }
  }
  broadcast('inbox');
  broadcast('leads');
}

// ---------- Numbers also used in the WhatsApp Business app (Meta's coexistence) ----------
/** Anything without text still shows up in the chat, so a conversation has no silent gaps. */
const messageText = (m: any): string =>
  m.text?.body ?? m[m.type]?.caption ?? m.button?.text ?? m.interactive?.button_reply?.title ?? `[${String(m.type ?? 'unknown').replace(/_/g, ' ')}]`;

/**
 * Phone chats need a lead to sit on, but they are not enquiries: no alerts, no
 * routing, no welcome workflow, and no marketing consent is assumed.
 */
function leadForChat(phone: string, name: string | undefined, number: any | null) {
  const found = get<any>('SELECT COALESCE(merged_into, id) AS id FROM leads WHERE phone = ?', phone);
  if (found) return found.id as number;
  const { id } = run(`INSERT INTO leads(name, phone, source, owner_id) VALUES(?, ?, 'WhatsApp', ?)`, name?.trim() || 'WhatsApp contact', phone, number?.user_id ?? null);
  logActivity(id, 'created', 'Lead created from a WhatsApp phone chat');
  return id;
}

/** A message a member of staff sent from the WhatsApp Business app on their phone. */
export function receivePhoneEcho(echo: any, number: any | null, contactName?: string) {
  if (echo.type === 'revoke') {
    run(`UPDATE wa_messages SET status = 'revoked' WHERE wa_id = ?`, String(echo.revoke?.original_message_id ?? ''));
    broadcast('inbox');
    return;
  }
  if (echo.type === 'edit') {
    const original = get<any>('SELECT id, lead_id, body FROM wa_messages WHERE wa_id = ?', String(echo.edit?.original_message_id ?? ''));
    if (!original) return;
    run('UPDATE wa_messages SET body = ? WHERE id = ?', messageText(echo.edit?.message ?? {}), original.id);
    logActivity(original.lead_id, 'whatsapp', 'WhatsApp message edited on phone', `Was: ${original.body}`, number?.user_id ?? null);
    broadcast('inbox');
    return;
  }
  // Meta leaves the phone out for customers using a username. Leads are matched by phone, so there is nothing to attach it to.
  if (!echo.to || !echo.id || get('SELECT 1 AS x FROM wa_messages WHERE wa_id = ?', echo.id)) return;
  const body = messageText(echo);
  const actorId = number?.user_id ?? null;
  tx(() => {
    const leadId = leadForChat(normalizePhone(`+${echo.to}`), contactName, number);
    run(
      `INSERT INTO wa_messages(lead_id, direction, body, status, wa_id, actor_id, number_id, source) VALUES(?, 'out', ?, 'sent', ?, ?, ?, 'phone')`,
      leadId, body, echo.id, actorId, number?.id ?? null,
    );
    run(`UPDATE leads SET last_message_at = ?, unread_count = 0, bot_state = 'done', wa_number_id = COALESCE(wa_number_id, ?) WHERE id = ?`, nowIso(), number?.id ?? null, leadId);
    logActivity(leadId, 'whatsapp', 'WhatsApp sent from phone', body, actorId);
    markResponded(leadId);
  });
  broadcast('inbox');
  broadcast('leads');
}

/** Past chats Meta shares once when a number is connected. Old messages must not alert anyone. */
export function importHistory(value: any, number: any | null) {
  const business = String(value.metadata?.display_phone_number ?? '').replace(/\D/g, '');
  const setStatus = (status: string) => { if (number) run('UPDATE wa_numbers SET history_status = ? WHERE id = ?', status, number.id); };
  for (const part of value.history ?? []) {
    if (part.errors?.length) { setStatus('declined'); continue; }
    for (const thread of part.threads ?? []) {
      const customer = thread.id ?? thread.context?.wa_id;
      if (!customer) continue;
      let phone = '';
      try { phone = normalizePhone(`+${customer}`); } catch { continue; } // One odd number must not lose the rest of the import.
      tx(() => {
        const leadId = leadForChat(phone, undefined, number);
        for (const m of thread.messages ?? []) {
          if (!m.id || get('SELECT 1 AS x FROM wa_messages WHERE wa_id = ?', m.id)) continue;
          const mine = !m.from_user_id && String(m.from ?? '').replace(/\D/g, '') === business;
          const at = new Date(Number(m.timestamp) * 1000).toISOString().slice(0, 19).replace('T', ' ');
          run(
            `INSERT INTO wa_messages(lead_id, direction, body, status, wa_id, actor_id, number_id, source, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, 'phone', ?)`,
            leadId, mine ? 'out' : 'in', messageText(m), mine ? String(m.history_context?.status ?? 'sent').toLowerCase() : 'received', m.id,
            mine ? number?.user_id ?? null : null, number?.id ?? null, at,
          );
          run(`UPDATE leads SET last_message_at = MAX(COALESCE(last_message_at, ''), ?), wa_number_id = COALESCE(wa_number_id, ?) WHERE id = ?`, at, number?.id ?? null, leadId);
        }
      });
    }
    const progress = Number(part.metadata?.progress);
    if (Number.isFinite(progress)) setStatus(progress >= 100 ? 'done' : `importing ${progress}%`);
  }
  broadcast('inbox');
}

/** Asks Meta for this number's contacts, then its past chats. They arrive later on the webhook. */
export async function requestHistorySync(number: any) {
  if (!numberLive(number)) throw new HttpError(400, 'Connect this number to Meta first.');
  const token = number.token ? decryptText(number.token) : config.whatsapp.token;
  for (const sync_type of ['smb_app_state_sync', 'history']) {
    const res = await fetch(`https://graph.facebook.com/${config.whatsapp.apiVersion}/${number.phone_number_id}/smb_app_data`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', sync_type }),
    });
    if (!res.ok) {
      const data: any = await res.json().catch(() => ({}));
      throw new HttpError(502, data?.error?.message ?? `Meta error ${res.status}`);
    }
  }
  run(`UPDATE wa_numbers SET history_status = 'requested' WHERE id = ?`, number.id);
}

/** Handles a verified webhook payload from Meta. */
export async function handleWebhook(payload: any) {
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field === 'smb_message_echoes' || change.field === 'history') {
        const value = change.value ?? {};
        const id = value.metadata?.phone_number_id;
        const number = id ? get<any>('SELECT id, user_id FROM wa_numbers WHERE phone_number_id = ?', String(id)) : null;
        if (change.field === 'history') { importHistory(value, number); continue; }
        // Echoes prove a person is using this number on a phone, so the bot must stop answering on it.
        if (number) run('UPDATE wa_numbers SET phone_app = 1 WHERE id = ?', number.id);
        for (const echo of value.message_echoes ?? []) {
          receivePhoneEcho(echo, number, (value.contacts ?? []).find((c: any) => c.wa_id === echo.to)?.profile?.name);
        }
        continue;
      }
      if (change.field === 'phone_number_quality_update') {
        setSetting('wa_quality', { event: String(change.value?.event ?? ''), limit: String(change.value?.current_limit ?? ''), at: nowIso() });
        const display = String(change.value?.display_phone_number ?? '').replace(/\D/g, '');
        if (display) run(`UPDATE wa_numbers SET quality = ? WHERE replace(display_number, '+', '') = ?`, String(change.value?.event ?? ''), display);
        continue;
      }
      if (change.field === 'message_template_status_update') {
        const v = change.value;
        const status = String(v.event).toLowerCase();
        if (['approved', 'rejected'].includes(status)) {
          run('UPDATE wa_templates SET status = ?, reject_reason = ? WHERE name = ?', status, v.reason ?? '', v.message_template_name);
          broadcast('templates');
        }
        continue;
      }
      const value = change.value ?? {};
      for (const status of value.statuses ?? []) applyStatus(status.id, status.status, status.errors?.[0]?.title ?? '');
      for (const message of value.messages ?? []) {
        const contact = (value.contacts ?? []).find((c: any) => c.wa_id === message.from);
        const body = message.text?.body ?? message.button?.text ?? message.interactive?.button_reply?.title ?? `[${message.type} message]`;
        const number = value.metadata?.phone_number_id ? get<any>('SELECT id FROM wa_numbers WHERE phone_number_id = ?', String(value.metadata.phone_number_id)) : null;
        await receiveInbound({ phone: `+${message.from}`, name: contact?.profile?.name, body, waId: message.id, numberId: number?.id });
      }
    }
  }
}

export function verifySignature(rawBody: Buffer, header: string | undefined) {
  if (!config.whatsapp.appSecret || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------- Templates ----------
export interface TemplateButton { type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'; text: string; value?: string }

/** Meta reviews a sample of any template media, sent through its resumable upload. */
async function uploadSample(url: string) {
  const { apiVersion, token } = config.whatsapp;
  if (!config.metaAppId) throw new HttpError(422, 'Add the Meta app ID in Settings, Integrations to submit templates with media.');
  const file = await fetch(url);
  if (!file.ok) throw new HttpError(422, 'The media link could not be opened.');
  const data = Buffer.from(await file.arrayBuffer());
  const type = file.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
  const session = await fetch(
    `https://graph.facebook.com/${apiVersion}/${config.metaAppId}/uploads?file_length=${data.length}&file_type=${encodeURIComponent(type)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  const started: any = await session.json().catch(() => ({}));
  if (!session.ok || !started.id) throw new HttpError(502, 'Meta did not accept the media upload.');
  const upload = await fetch(`https://graph.facebook.com/${apiVersion}/${started.id}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}`, file_offset: '0' },
    body: new Uint8Array(data),
  });
  const done: any = await upload.json().catch(() => ({}));
  if (!upload.ok || !done.h) throw new HttpError(502, 'Meta did not accept the media upload.');
  return done.h as string;
}

export async function submitTemplate(template: any) {
  if (!whatsappLive()) {
    run(`UPDATE wa_templates SET status = 'approved', reject_reason = '' WHERE id = ?`, template.id);
    return { simulated: true };
  }
  const vars = templateVars(template.body);
  let position = 0;
  const text = template.body.replace(/\{\{\w+\}\}/g, () => `{{${++position}}}`);
  const components: unknown[] = [];
  if (template.header_type !== 'NONE') {
    components.push({ type: 'HEADER', format: template.header_type, example: { header_handle: [await uploadSample(template.header_url)] } });
  }
  components.push({ type: 'BODY', text, ...(vars.length ? { example: { body_text: [vars.map((v) => `Sample ${v}`)] } } : {}) });
  const buttons: TemplateButton[] = JSON.parse(template.buttons);
  if (buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map((b) => ({
        type: b.type,
        text: b.text,
        ...(b.type === 'URL' ? { url: b.value } : {}),
        ...(b.type === 'PHONE_NUMBER' ? { phone_number: b.value } : {}),
      })),
    });
  }
  const res = await fetch(`https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.businessAccountId}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: template.name, category: template.category, language: template.language, components }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, data?.error?.message ?? 'Meta rejected the template.');
  run(`UPDATE wa_templates SET status = 'pending' WHERE id = ?`, template.id);
  return { simulated: false };
}

// ---------- Campaigns ----------
export interface Segment {
  project_id?: number | null;
  stages?: string[];
  sources?: string[];
  temperature?: string[];
  labels?: string[];
  budget_min?: number | null;
  budget_max?: number | null;
  inactive_days?: number | null;
}

/** Which leads a person's broadcast may reach. Null means all of them. */
export function creatorLeadIds(userId: number | null): Set<number> | null {
  const u = userId ? get<any>('SELECT id, role, data_scope FROM users WHERE id = ?', userId) : null;
  if (!u) return null;
  const project_ids = all<any>('SELECT project_id FROM user_projects WHERE user_id = ?', userId).map((p) => p.project_id as number);
  const scope = leadScope({ ...u, project_ids } as SessionUser);
  if (!scope.params.length && scope.sql === 'l.deleted_at IS NULL') return null;
  return new Set(all<{ id: number }>(`SELECT l.id FROM leads l WHERE ${scope.sql}`, ...scope.params).map((l) => l.id));
}

export function segmentLeads(segment: Segment) {
  const where = ['l.deleted_at IS NULL'];
  const params: (string | number)[] = [];
  const list = (column: string, values?: (string | number)[]) => {
    if (!values?.length) return;
    where.push(`${column} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  };
  list('l.stage', segment.stages);
  list('l.source', segment.sources);
  list('l.temperature', segment.temperature);
  if (segment.project_id) { where.push('l.project_id = ?'); params.push(segment.project_id); }
  if (segment.labels?.length) {
    where.push(`(${segment.labels.map(() => 'l.labels LIKE ?').join(' OR ')})`);
    params.push(...segment.labels.map((l) => `%${JSON.stringify(l)}%`));
  }
  if (segment.budget_min != null) { where.push('l.budget_lakhs >= ?'); params.push(segment.budget_min); }
  if (segment.budget_max != null) { where.push('l.budget_lakhs <= ?'); params.push(segment.budget_max); }
  if (segment.inactive_days) { where.push('l.last_activity_at <= ?'); params.push(minutesFromNow(-segment.inactive_days * 1440)); }
  return all<any>(`SELECT l.* FROM leads l WHERE ${where.join(' AND ')}`, ...params);
}

export function audiencePreview(segment: Segment, templateId: number | null, allowed: Set<number> | null) {
  const leads = segmentLeads(segment).filter((l) => !allowed || allowed.has(l.id));
  const template = templateId ? get<any>('SELECT * FROM wa_templates WHERE id = ?', templateId) : undefined;
  const excluded: Record<string, number> = {};
  let eligible = 0;
  for (const lead of leads) {
    const blockers = sendBlockers(lead, template ? { ...template, status: 'approved' } : { category: 'MARKETING', status: 'approved' });
    if (!blockers.length) eligible++;
    else excluded[blockers[0]] = (excluded[blockers[0]] ?? 0) + 1;
  }
  const rate = getSetting<number | null>('wa_cost_per_message', null);
  return { matched: leads.length, eligible, excluded, estimated_cost: rate === null ? null : Math.round(rate * eligible) };
}

/** Queues one message per eligible contact. The unique index blocks double sends. */
export function queueCampaign(campaignId: number) {
  return tx(() => {
    const c = get<any>('SELECT * FROM wa_campaigns WHERE id = ?', campaignId)!;
    const template = get<any>('SELECT * FROM wa_templates WHERE id = ?', c.template_id)!;
    if (template.status !== 'approved') throw new HttpError(422, 'The template must be approved before sending.');
    if (c.project_id) {
      const project = get<any>('SELECT name, rera_number FROM projects WHERE id = ?', c.project_id);
      if (project && !project.rera_number) throw new HttpError(422, `Add the MahaRERA number for ${project.name} first.`);
    }
    const segment: Segment = JSON.parse(c.segment);
    // A broadcast only ever reaches leads its creator was allowed to see.
    const allowed = creatorLeadIds(c.created_by);
    const number = c.number_id ? get<any>('SELECT * FROM wa_numbers WHERE id = ?', c.number_id) : null;
    let queued = 0;
    for (const lead of segmentLeads({ ...segment, project_id: c.project_id ?? segment.project_id })) {
      if (allowed && !allowed.has(lead.id)) continue;
      if (sendBlockers(lead, template).length) continue;
      const body = renderTemplate(template.body, varsFor(lead));
      const r = run(
        `INSERT OR IGNORE INTO wa_messages(lead_id, direction, body, template_id, campaign_id, status, simulated, media_url, media_type, number_id)
         VALUES(?, 'out', ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        lead.id, body, template.id, campaignId, numberLive(number) ? 0 : 1,
        template.header_type === 'NONE' ? '' : template.header_url, template.header_type === 'NONE' ? '' : template.header_type.toLowerCase(),
        number?.id ?? null,
      );
      queued += r.changes;
    }
    run(`UPDATE wa_campaigns SET status = 'sending', sent_at = ? WHERE id = ?`, nowIso(), campaignId);
    return queued;
  });
}

/** Sends a batch of queued campaign messages. Called on a timer, which paces the sending. */
export async function processQueue(limit = 40) {
  // Stay under the number's Meta tier. Anything over the limit waits for tomorrow.
  const dailyLimit = getSetting('wa_daily_limit', 1000);
  const sentToday = get<{ n: number }>(
    `SELECT COUNT(*) n FROM wa_messages WHERE campaign_id IS NOT NULL AND status != 'queued' AND created_at >= ?`,
    `${nowIso().slice(0, 10)} 00:00:00`,
  )!.n;
  const room = Math.max(0, dailyLimit - sentToday);
  const batch = all<any>(
    `SELECT id, lead_id, campaign_id, number_id FROM wa_messages WHERE status = 'queued' AND campaign_id IS NOT NULL ORDER BY id LIMIT ?`,
    Math.min(limit, room),
  );
  // Each staff number also has its own limit, so one person cannot exhaust another's.
  const numberRoom = new Map<number, number>();
  for (const m of batch) {
    if (m.number_id) {
      if (!numberRoom.has(m.number_id)) {
        const n = get<any>('SELECT daily_limit FROM wa_numbers WHERE id = ?', m.number_id);
        const used = get<{ n: number }>(
          `SELECT COUNT(*) n FROM wa_messages WHERE number_id = ? AND campaign_id IS NOT NULL AND status != 'queued' AND created_at >= ?`,
          m.number_id, `${nowIso().slice(0, 10)} 00:00:00`,
        )!.n;
        numberRoom.set(m.number_id, (n?.daily_limit ?? 0) - used);
      }
      if (numberRoom.get(m.number_id)! <= 0) continue;
      numberRoom.set(m.number_id, numberRoom.get(m.number_id)! - 1);
    }
    const lead = get<any>('SELECT * FROM leads WHERE id = ?', m.lead_id);
    // A contact may have opted out after the campaign was queued.
    if (lead?.do_not_contact || lead?.wa_opted_out_at) {
      run(`UPDATE wa_messages SET status = 'failed', error = 'Opted out before sending' WHERE id = ?`, m.id);
      continue;
    }
    await dispatch(m.id);
    logActivity(m.lead_id, 'whatsapp', 'Campaign message sent', '');
    run('UPDATE leads SET last_message_at = ? WHERE id = ?', nowIso(), m.lead_id);
  }
  run(
    `UPDATE wa_campaigns SET status = 'sent' WHERE status = 'sending'
     AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.campaign_id = wa_campaigns.id AND m.status = 'queued')`,
  );
  if (batch.length) broadcast('campaigns');
  return batch.length;
}
