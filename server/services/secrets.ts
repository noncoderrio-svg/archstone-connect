import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.ts';

export const dataDir = () => dirname(config.dbPath);

let cached: Buffer | null = null;

/** The app's encryption key: from SECRET_KEY, or a file created on first use. */
function key() {
  if (cached) return cached;
  if (config.secretKey) {
    cached = createHash('sha256').update(config.secretKey).digest();
    return cached;
  }
  const path = join(dataDir(), 'secret.key');
  if (!existsSync(path)) {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  cached = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
  return cached;
}

/** AES-256-GCM. Output is iv + auth tag + ciphertext. */
export function encrypt(data: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(data: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
}

export const encryptText = (text: string) => encrypt(Buffer.from(text, 'utf8')).toString('base64');
export const decryptText = (text: string) => decrypt(Buffer.from(text, 'base64')).toString('utf8');

// ---------- Two-factor codes (RFC 6238) ----------
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(data: Buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string) {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '')) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

export const currentStep = () => Math.floor(Date.now() / 1000 / STEP_SECONDS);

/** Returns the matching step, allowing one step of clock drift, or null. */
export function matchTotp(secret: string, code: string, afterStep: number) {
  const now = currentStep();
  for (const step of [now - 1, now, now + 1]) {
    if (step > afterStep && totpCode(secret, step) === code) return step;
  }
  return null;
}
