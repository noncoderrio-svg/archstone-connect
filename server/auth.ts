import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import { ACTIONS, PERMISSIONS, type Action, type Role } from '../shared/domain.ts';
import { config } from './config.ts';
import { all, get, getSetting, minutesFromNow, nowIso, run } from './db.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = 'archstone_session';
const SESSION_MINUTES = 60 * 12;
const REMEMBER_MINUTES = 60 * 24 * 30;
const REMEMBER_LIMIT_DAYS = 90;

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  must_change_password: number;
  two_factor: boolean;
  project_ids: number[];
  data_scope: string;
  permissions: Action[];
}

/**
 * What this person may do: the role's permissions, then any changes made for them.
 * Admins always keep everything, so an account can never lock everyone out.
 */
export function permissionsFor(userId: number, role: Role): Action[] {
  if (role === 'admin') return [...ACTIONS];
  const roles = getSetting<Partial<Record<Role, Action[]>>>('role_permissions', {});
  const set = new Set<Action>(roles[role] ?? PERMISSIONS[role]);
  for (const o of all<{ action: Action; allowed: number }>('SELECT action, allowed FROM user_permissions WHERE user_id = ?', userId)) {
    if (o.allowed) set.add(o.action);
    else set.delete(o.action);
  }
  return [...set];
}

declare global {
  namespace Express {
    interface Request {
      user: SessionUser;
    }
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [, saltHex, keyHex] = stored.split('$');
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Temporary password that a user must replace at first login. */
export const generatePassword = () => randomBytes(9).toString('base64url');

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const writeCookie = (res: Response, token: string, minutes: number) => res.cookie(COOKIE, token, {
  httpOnly: true,
  sameSite: 'strict',
  secure: config.secureCookies,
  maxAge: minutes * 60000,
  path: '/',
});

export function createSession(res: Response, userId: number, ip: string, remember = false) {
  const token = randomBytes(32).toString('base64url');
  const minutes = remember ? REMEMBER_MINUTES : SESSION_MINUTES;
  run('INSERT INTO sessions(token_hash, user_id, expires_at, ip, remember) VALUES(?, ?, ?, ?, ?)', hashToken(token), userId, minutesFromNow(minutes), ip, remember ? 1 : 0);
  writeCookie(res, token, minutes);
}

const readCookie = (req: Request) => {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
};

export function destroySession(req: Request, res: Response) {
  const token = readCookie(req);
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
  res.clearCookie(COOKIE, { path: '/' });
}

export const destroyUserSessions = (userId: number) => run('DELETE FROM sessions WHERE user_id = ?', userId);

export const sessionRemembered = (req: Request) =>
  Boolean(get('SELECT 1 AS x FROM sessions WHERE token_hash = ? AND remember = 1', hashToken(readCookie(req))));

/**
 * Someone who keeps using the CRM stays signed in, renewed at most once a day.
 * The hard limit still asks for the password now and then, in case a phone is lost.
 */
function renewRemembered(req: Request, res: Response) {
  const token = readCookie(req);
  const hash = hashToken(token);
  const session = get<any>('SELECT expires_at FROM sessions WHERE token_hash = ? AND remember = 1', hash);
  if (!session || session.expires_at > minutesFromNow(REMEMBER_MINUTES - 1440)) return;
  run(`UPDATE sessions SET expires_at = MIN(?, datetime(created_at, '+${REMEMBER_LIMIT_DAYS} days')) WHERE token_hash = ?`, minutesFromNow(REMEMBER_MINUTES), hash);
  const { expires_at } = get<any>('SELECT expires_at FROM sessions WHERE token_hash = ?', hash)!;
  const left = (new Date(`${expires_at.replace(' ', 'T')}Z`).getTime() - Date.now()) / 60000;
  if (left > 0) writeCookie(res, token, left);
}

export function loadUser(req: Request): SessionUser | null {
  const token = readCookie(req);
  if (!token) return null;
  const row = get<any>(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.must_change_password, u.status, u.totp_enabled, u.data_scope
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    hashToken(token),
    nowIso(),
  );
  if (!row || row.status !== 'active') return null;
  const project_ids = all<{ project_id: number }>('SELECT project_id FROM user_projects WHERE user_id = ?', row.id).map((r) => r.project_id);
  const { status: _status, totp_enabled, ...user } = row;
  return { ...user, two_factor: Boolean(totp_enabled), project_ids, permissions: permissionsFor(row.id, row.role) };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = loadUser(req);
  if (!user) throw new HttpError(401, 'Please sign in.');
  req.user = user;
  renewRemembered(req, res);
  const passwordRoute = req.path === '/auth/password' || req.path === '/auth/logout' || req.path === '/auth/me';
  if (user.must_change_password && !passwordRoute) throw new HttpError(403, 'Please set a new password first.');
  if (adminNeedsTwoFactor(user) && !passwordRoute && !req.path.startsWith('/account')) {
    throw new HttpError(403, 'Please set up two-factor login first.');
  }
  next();
}

/** On a live system, admin accounts cannot work without two-factor login. */
export const adminNeedsTwoFactor = (user: SessionUser) => !config.demoMode && user.role === 'admin' && !user.two_factor;

export const requirePermission = (action: Action) => (req: Request, _res: Response, next: NextFunction) => {
  assertCan(req.user, action);
  next();
};

export function assertCan(user: SessionUser, action: Action) {
  if (!user.permissions.includes(action)) throw new HttpError(403, 'You do not have permission to do that.');
}

// Slows password guessing per IP + email. In memory, so it resets on restart.
const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60000;

export function assertNotLocked(key: string) {
  const entry = attempts.get(key);
  if (entry && entry.count >= MAX_ATTEMPTS) {
    if (entry.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    attempts.delete(key);
  }
}
export function recordFailure(key: string) {
  const entry = attempts.get(key) ?? { count: 0, until: 0 };
  entry.count += 1;
  entry.until = Date.now() + LOCK_MS;
  attempts.set(key, entry);
}
export const clearFailures = (key: string) => attempts.delete(key);
