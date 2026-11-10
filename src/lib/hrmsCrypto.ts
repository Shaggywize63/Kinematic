import crypto from 'crypto';
import { logger } from './logger';
import { AppError } from '../utils';

// Field-level encryption for HRMS personal data at rest (PAN, bank details) plus the masking helpers the API uses.
//
// AES-256-GCM. Each value gets a fresh 12-byte IV and is bound to a context string (`<employee id>:pan`) as
// additional authenticated data, so a ciphertext copied onto another employee's row does not decrypt.
//
// Key: env HRMS_DATA_KEY (at least 32 characters; a random 32-byte value as hex or base64 is ideal). If it is not
// set we fall back to the same key material secretBox.ts uses (CLIENT_CRED_KEY, else the Supabase service key or JWT
// secret) and log ONE warning. The fallback ties the data to a secret that is rotated for other reasons, so set
// HRMS_DATA_KEY before real data goes in. The key actually used is derived with HKDF under an HRMS-specific label, so
// it is never the same key as secretBox's even when the material is shared.
//
// Payload: `h1:<k|f>:<iv>:<tag>:<ciphertext>` (base64 parts). The second field says which key sealed it (k = HRMS_DATA_KEY,
// f = fallback), so rows written under the fallback stay readable after HRMS_DATA_KEY is introduced: decryption picks the
// key by that marker, and new writes use the current primary.
//
// Nothing here ever logs a plaintext or a key.

const VERSION = 'h1';
type KeyId = 'k' | 'f';

let warnedFallback = false;
const derived = new Map<string, Buffer>();

function material(id: KeyId): string | null {
  if (id === 'k') return process.env.HRMS_DATA_KEY || null;
  return process.env.CLIENT_CRED_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_JWT_SECRET || null;
}

function keyFor(id: KeyId): Buffer {
  const m = material(id);
  if (!m) {
    throw new AppError(500, 'HRMS encryption key is not configured', 'HRMS_KEY_MISSING');
  }
  if (id === 'k' && m.length < 32) {
    throw new AppError(500, 'HRMS_DATA_KEY must be at least 32 characters', 'HRMS_KEY_INVALID');
  }
  const cacheKey = `${id}:${m}`;
  let k = derived.get(cacheKey);
  if (!k) {
    k = Buffer.from(crypto.hkdfSync('sha256', m, 'kinematic-hrms', 'hrms-data-v1', 32));
    derived.set(cacheKey, k);
  }
  return k;
}

/** The key new values are sealed with: HRMS_DATA_KEY when set, otherwise the secretBox material (with one warning). */
function primary(): KeyId {
  if (process.env.HRMS_DATA_KEY) return 'k';
  if (!warnedFallback) {
    warnedFallback = true;
    logger.warn('[hrms] HRMS_DATA_KEY is not set: PAN and bank details are encrypted with a key derived from the server secret. Set HRMS_DATA_KEY before real data goes in.');
  }
  return 'f';
}

/** Which key new values would be sealed with (for diagnostics and tests). */
export function hrmsKeySource(): 'HRMS_DATA_KEY' | 'fallback' {
  return process.env.HRMS_DATA_KEY ? 'HRMS_DATA_KEY' : 'fallback';
}

export function _resetHrmsCryptoForTests(): void {
  warnedFallback = false;
  derived.clear();
}

/** Seal a value. `context` is bound as additional authenticated data and must be passed again to decrypt. */
export function encryptField(plain: string, context: string): string {
  const id = primary();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(id), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [VERSION, id, iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

/** Open a sealed value. Returns null when there is nothing to open or it cannot be opened (wrong key, wrong context, tampered). */
export function decryptField(payload: string | null | undefined, context: string): string | null {
  if (!payload || typeof payload !== 'string') return null;
  try {
    const [v, id, ivb, tagb, encb] = payload.split(':');
    if (v !== VERSION || (id !== 'k' && id !== 'f') || !ivb || !tagb || !encb) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(id), Buffer.from(ivb, 'base64'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagb, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encb, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ── masking ─────────────────────────────────────────────────────────────────

const maskKeepingLast4 = (value: string, ch: string): string => {
  const v = value.trim();
  return v.length <= 4 ? ch.repeat(v.length) : ch.repeat(v.length - 4) + v.slice(-4);
};

/** ABCDE1234F -> XXXXXX234F (last four characters visible). */
export const maskPan = (pan: string): string => maskKeepingLast4(pan, 'X');

/** 501000123456 -> ••••••••3456 (last four digits visible). */
export const maskAccountNumber = (account: string): string => maskKeepingLast4(account, '•');

/** What a PAN shows as when its ciphertext cannot be opened. */
export const PAN_UNREADABLE = 'XXXXXXXXXX';

/**
 * True for a value that is a mask rather than a real PAN: it has a bullet or asterisk, or a run of four or more X.
 * A real PAN can never have that run (letters 1-3 are an arbitrary series but letter 4 is a holder type that is never
 * X), so a genuine PAN such as AXXPX1234F is not mistaken for a mask.
 */
export const looksMaskedPan = (v: string): boolean => /[•*]/.test(v) || /X{4,}/i.test(v);

/** True for an account number that is a mask (bullets, asterisks or X in place of digits). Real account numbers are digits. */
export const looksMaskedAccount = (v: string): boolean => /[•*xX]/.test(v);
