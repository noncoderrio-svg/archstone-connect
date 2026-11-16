import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { HttpError, requireAuth } from './auth.ts';
import { get } from './db.ts';
import { account, publicGoogle } from './routes/account.ts';
import { admin, publicAuth } from './routes/admin.ts';
import { control, publicMedia } from './routes/control.ts';
import { crm } from './routes/crm.ts';
import { dialer } from './routes/dialer.ts';
import { growth } from './routes/growth.ts';
import { partners } from './routes/partners.ts';
import { payments } from './routes/payments.ts';
import { erase } from './routes/erase.ts';
import { legal } from './routes/legal.ts';
import { insights } from './routes/insights.ts';
import { messaging } from './routes/messaging.ts';
import { postsales, publicBuyer } from './routes/postsales.ts';
import { routing } from './routes/routing.ts';
import { sales } from './routes/sales.ts';
import { webhooks } from './routes/webhooks.ts';
import { workplace } from './routes/workplace.ts';
import { config } from './config.ts';
import { tickOnce } from './services/scheduler.ts';

/** A simple per-address limit for each minute, to blunt scripted abuse. */
function rateLimit(perMinute: number): RequestHandler {
  const seen = new Map<string, { count: number; resets: number }>();
  return (req, _res, next) => {
    const now = Date.now();
    const key = req.ip ?? '';
    const entry = seen.get(key);
    if (!entry || entry.resets < now) {
      if (seen.size > 5000) seen.clear();
      seen.set(key, { count: 1, resets: now + 60000 });
      return next();
    }
    entry.count += 1;
    if (entry.count > perMinute) return next(new HttpError(429, 'Too many requests. Please wait a minute.'));
    next();
  };
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': null, 'img-src': ["'self'", 'data:', 'https:'] } },
  }));
  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = buf; // Needed to check Meta's signature.
      },
    }),
  );

  // Hosts call this to learn whether the system is up. It shows nothing private.
  app.get('/healthz', (_req, res) => {
    get('SELECT 1 AS ok');
    res.json({ ok: true });
  });

  app.use('/webhooks', rateLimit(300), webhooks);
  app.use(legal);
  // Hosts that pause idle apps (such as shared Node.js hosting) call this from a cron job every minute.
  app.get('/cron/tick', rateLimit(30), async (req, res, next) => {
    const token = String(req.query.token ?? req.get('x-cron-token') ?? '');
    const expected = config.cronToken;
    if (!expected || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return next(new HttpError(404, 'Not found.'));
    try {
      res.json({ ok: true, ran: await tickOnce() });
    } catch (e) {
      next(e);
    }
  });
  app.use('/api', rateLimit(1200), publicAuth, publicGoogle);
  app.use('/public', rateLimit(600), publicMedia, publicBuyer);
  app.use('/api', requireAuth, erase, admin, control, insights, dialer, account, postsales, payments, partners, growth, routing, crm, sales, messaging, workplace);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  const dist = resolve('dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api|\/webhooks).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid input.' });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  };
  app.use(onError);
  return app;
}
