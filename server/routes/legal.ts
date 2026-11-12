// Public privacy policy and data deletion pages. Meta requires both links before a WhatsApp app can be published.
// Served as plain HTML from the server, so they open without signing in and without JavaScript.
import { Router } from 'express';
import { config } from '../config.ts';

export const legal = Router();

const BUSINESS = 'Archstone Realty';
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** How people reach us about their data: an email set on the server, and the WhatsApp number in Settings. */
function contactLines() {
  const lines: string[] = [];
  if (config.privacyContactEmail) lines.push(`Email: <a href="mailto:${escape(config.privacyContactEmail)}">${escape(config.privacyContactEmail)}</a>`);
  if (config.whatsappDisplayNumber) lines.push(`WhatsApp: <a href="https://wa.me/${config.whatsappDisplayNumber}">+${config.whatsappDisplayNumber}</a>`);
  if (!lines.length) lines.push('Please contact our sales office using the details on our website or brochure.');
  return lines.map((l) => `<li>${l}</li>`).join('');
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | ${BUSINESS}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:2rem 1.25rem;color:#1b1f27}h1{font-size:1.8rem;margin:0 0 .25rem}h2{font-size:1.15rem;margin-top:1.75rem}p.meta{color:#6b7079;margin-top:0}a{color:#9a4215}</style>
</head><body>${body}</body></html>`;
}

legal.get('/privacy', (_req, res) => {
  res.type('html').send(page('Privacy policy', `
<h1>Privacy policy</h1>
<p class="meta">${BUSINESS} · Last updated 12 November 2026</p>
<p>${BUSINESS} uses a customer management system, Archstone Connect, to respond to property enquiries. This page explains what we collect, why, and the choices you have.</p>
<h2>What we collect</h2>
<ul>
<li>Your name, phone number and email, when you enquire through our website, a property portal, an advertisement, a channel partner, WhatsApp, a phone call or a site visit.</li>
<li>What you tell us about your requirements, such as the project, budget, home type and preferred timing.</li>
<li>Messages you exchange with us on WhatsApp, and notes our team keeps about calls and site visits.</li>
<li>If you book a home: booking, payment and document details needed to complete your purchase.</li>
</ul>
<h2>How we use it</h2>
<ul>
<li>To answer your enquiry, arrange site visits, and help you through booking, payments and handover.</li>
<li>To send WhatsApp messages you agreed to receive. You can reply STOP at any time to stop marketing messages.</li>
<li>To keep records required by law, including under RERA and tax rules.</li>
</ul>
<h2>Who we share it with</h2>
<p>We do not sell your data. We share it only with service providers who help us run this system (such as Meta for WhatsApp messages, and our hosting provider), with a channel partner who introduced you, and with authorities where the law requires.</p>
<h2>How long we keep it</h2>
<p>We keep enquiry records while they are useful for your enquiry, and booking records for as long as the law requires. You can ask us to delete your data at any time; see <a href="/data-deletion">data deletion</a>.</p>
<h2>Security</h2>
<p>Access is limited to our staff by role, sign-in is protected, and identity documents are stored encrypted.</p>
<h2>Your choices</h2>
<p>You can ask to see, correct or delete your data, or stop messages, by contacting us:</p>
<ul>${contactLines()}</ul>
`));
});

legal.get('/data-deletion', (_req, res) => {
  res.type('html').send(page('Data deletion', `
<h1>Delete your data</h1>
<p class="meta">${BUSINESS}</p>
<p>You can ask ${BUSINESS} to delete the personal data we hold about you, including your name, phone number, email, messages and notes.</p>
<h2>How to ask</h2>
<ol>
<li>Contact us using one of the details below, from the phone number or email you used with us.</li>
<li>Write "Please delete my data" and your name.</li>
</ol>
<ul>${contactLines()}</ul>
<h2>What happens next</h2>
<p>We confirm your request and erase your details within 30 days. Your name, phone, email, notes and message text are removed, and any documents you shared are deleted. To stop WhatsApp messages straight away, reply STOP to any of our messages.</p>
<p>If you have booked a home with us, we must keep the records the law requires for that purchase, such as the agreement and payment receipts. We will tell you if anything has to be kept, and why.</p>
`));
});
