// The Android app download: an admin uploads the APK, staff download it from /app (with a QR code) or the sign-in page.
// The file lives on the data disk, so a new app version never needs a redeploy.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import { config } from '../config.ts';
import { getSetting, nowIso, setSetting } from '../db.ts';
import { audit } from '../services/core.ts';
import { dataDir } from '../services/secrets.ts';
import { featureOn } from '../services/workplace.ts';

export const mobileApp = Router();
export const appPublic = Router();

const MB = 1024 * 1024;
export const MAX_APK = 80 * MB;
const appDir = () => join(dataDir(), 'app');
const apkPath = () => join(appDir(), 'archstone-connect.apk');

interface ApkInfo { version: string; notes: string; size: number; sha256: string; uploaded_at: string; uploaded_by: string }
interface AppLinks { ios_url: string }

const apkInfo = () => {
  const info = getSetting<ApkInfo | null>('mobile_app_apk', null);
  return info && existsSync(apkPath()) ? info : null;
};
const links = () => getSetting<AppLinks>('mobile_app_links', { ios_url: '' });
const adminOnly = (req: Request) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can manage the mobile app.');
};
const sizeMb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** What the sign-in page and the download page show. Nothing when the feature is switched off. */
export function publicAppInfo() {
  if (!featureOn('app')) return { android: null, ios_url: '' };
  const apk = apkInfo();
  return {
    android: apk ? { version: apk.version, size: apk.size, updated: apk.uploaded_at, notes: apk.notes } : null,
    ios_url: links().ios_url,
  };
}

// ---------- Admin ----------
mobileApp.get('/mobile-app', (req, res) => {
  adminOnly(req);
  res.json({ apk: apkInfo(), links: links(), download_page: `${config.appUrl}/app`, max_size: MAX_APK });
});

mobileApp.post('/mobile-app/apk', async (req, res) => {
  adminOnly(req);
  const q = z.object({
    version: z.string().trim().min(1, 'Enter the version, like 1.2.0.').max(20).regex(/^[\w.\- ]+$/, 'Use letters, numbers and dots for the version.'),
    notes: z.string().trim().max(300).default(''),
  }).parse(req.query);
  const tooLarge = new HttpError(413, `The app file is over the ${MAX_APK / MB} MB limit.`);
  const refuse = (error: HttpError) => {
    res.setHeader('Connection', 'close');
    throw error;
  };
  if ((Number(req.headers['content-length']) || 0) > MAX_APK) refuse(tooLarge);

  mkdirSync(appDir(), { recursive: true });
  const partial = join(appDir(), `upload-${Date.now()}.part`);
  const hash = createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  // Written to disk as it arrives, so a 15 MB app never sits in the server's memory.
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > MAX_APK) return done(tooLarge);
      if (head.length < 4) head = Buffer.concat([head, chunk]).subarray(0, 4);
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, createWriteStream(partial));
  } catch (e) {
    rmSync(partial, { force: true });
    if (e instanceof HttpError) refuse(e);
    if ((e as NodeJS.ErrnoException).code === 'ENOSPC') refuse(new HttpError(507, 'The server disk is full.'));
    throw e;
  }
  // An APK is a ZIP file, which always starts with "PK".
  if (size < 1024 || head[0] !== 0x50 || head[1] !== 0x4b) {
    rmSync(partial, { force: true });
    throw new HttpError(415, 'That is not an Android app file. Choose the .apk file.');
  }
  renameSync(partial, apkPath());
  const info: ApkInfo = { version: q.version, notes: q.notes, size, sha256: hash.digest('hex'), uploaded_at: nowIso(), uploaded_by: req.user.name };
  setSetting('mobile_app_apk', info);
  audit(req, 'mobile_app.upload', 'settings', '', `Android ${q.version}, ${sizeMb(size)}`);
  res.status(201).json({ apk: info });
});

mobileApp.delete('/mobile-app/apk', (req, res) => {
  adminOnly(req);
  rmSync(apkPath(), { force: true });
  setSetting('mobile_app_apk', null);
  audit(req, 'mobile_app.remove', 'settings');
  res.json({ ok: true });
});

mobileApp.put('/mobile-app/links', (req, res) => {
  adminOnly(req);
  const b = z.object({
    ios_url: z.union([z.literal(''), z.string().trim().url('Enter a full link starting with https://').startsWith('https://', 'The link must start with https://').max(300)]),
  }).parse(req.body);
  setSetting('mobile_app_links', b);
  audit(req, 'mobile_app.links', 'settings', '', b.ios_url ? 'iPhone link set' : 'iPhone link removed');
  res.json({ ok: true });
});

// ---------- Public ----------
appPublic.get('/public/app-info', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json(publicAppInfo());
});

/** The APK itself. Also answers the old address from the README, so earlier links keep working. */
appPublic.get(['/app/download', '/archstone-connect-app.apk'], (_req, res) => {
  const apk = featureOn('app') ? apkInfo() : null;
  if (!apk) return res.status(404).type('text').send('The Android app has not been uploaded yet. Please ask your administrator.');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="Archstone-Connect-${apk.version.replace(/[^\w.-]/g, '')}.apk"`);
  res.sendFile(apkPath());
});

appPublic.get('/app/qr.svg', async (_req, res) => {
  const svg = await QRCode.toString(`${config.appUrl}/app`, { type: 'svg', margin: 1, color: { dark: '#1b1f27', light: '#ffffff' } });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('image/svg+xml').send(svg);
});

/** A plain page that works on any phone, without signing in and without JavaScript. */
appPublic.get('/app', (_req, res) => {
  const info = publicAppInfo();
  const apk = info.android;
  const android = apk
    ? `<a class="btn" href="/app/download">Download for Android</a>
       <p class="meta">Version ${escape(apk.version)} · ${sizeMb(apk.size)} · updated ${escape(apk.updated.slice(0, 10))}</p>
       ${apk.notes ? `<p class="notes">${escape(apk.notes)}</p>` : ''}
       <ol>
         <li>Tap <b>Download for Android</b> and open the file when it finishes.</li>
         <li>If Android asks, allow installs from this source (Chrome or Files). The app is not from the Play Store, so this is expected.</li>
         <li>Tap <b>Install</b>, open <b>Archstone Connect</b> and sign in with your CRM account.</li>
       </ol>`
    : `<p class="soon">The Android app is not available yet. Your administrator will share it here.</p>`;
  const ios = info.ios_url
    ? `<a class="btn ghost" href="${escape(info.ios_url)}">Get it on iPhone</a>`
    : `<p class="meta">On iPhone, open this CRM in Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>.</p>`;
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Archstone Connect app</title><meta name="theme-color" content="#1b1f27"><link rel="icon" href="/icon-192.png">
<style>
:root{color-scheme:light}
body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f2ef;color:#1b1f27}
header{background:#1b1f27;padding:1.5rem 1.25rem;text-align:center}header img{height:44px}
main{max-width:30rem;margin:-1rem auto 2rem;background:#fff;border-radius:1.25rem;padding:1.75rem 1.5rem;box-shadow:0 10px 30px -15px rgba(0,0,0,.35)}
h1{font-size:1.5rem;margin:0 0 .25rem}p.lead{margin:0 0 1.25rem;color:#4d525b}
.btn{display:block;text-align:center;background:#e86920;color:#fff;text-decoration:none;font-weight:600;padding:.95rem 1rem;border-radius:.85rem;font-size:1.05rem}
.btn:hover{background:#b9531b}.btn.ghost{background:#fff;color:#9a4215;border:2px solid #e86920;margin-top:1rem}
.meta{color:#6b7079;font-size:.9rem;text-align:center;margin:.5rem 0 0}.notes{background:#fcebdf;border-radius:.6rem;padding:.6rem .8rem;font-size:.92rem}
ol{padding-left:1.2rem;font-size:.95rem;color:#3a3f48}li{margin:.35rem 0}.soon{background:#fcebdf;border-radius:.6rem;padding:.8rem}
.qr{display:none;text-align:center;margin-top:1.5rem;border-top:1px solid #eee;padding-top:1.25rem}.qr img{width:170px;height:170px}
@media (min-width:700px){.qr{display:block}}
</style></head><body>
<header><img src="/logo-light.svg" alt="Archstone"></header>
<main>
<h1>Archstone Connect</h1>
<p class="lead">The CRM app for the Archstone sales team: leads, calls, follow-ups, site visits and WhatsApp, with alerts on your phone.</p>
${android}
${ios}
<div class="qr"><img src="/app/qr.svg" alt="QR code for this page"><p class="meta">On a computer? Scan this with your phone camera.</p></div>
</main></body></html>`);
});
