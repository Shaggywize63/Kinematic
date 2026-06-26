import crypto from 'crypto';

// Reversible encryption for client "Login as" credentials stored at rest.
//
// Used ONLY for the super-admin client-login feature: the password a
// super-admin stores on a client record is encrypted here and decrypted
// server-side at login time (never returned to the browser). The key is
// derived from a server secret so no new env var is required; set
// CLIENT_CRED_KEY explicitly to make the ciphertext independent of Supabase
// key rotation. If the key material changes, existing ciphertext becomes
// unreadable and the password must be re-entered.
const KEY = crypto
  .createHash('sha256')
  .update(
    process.env.CLIENT_CRED_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_JWT_SECRET ||
      'kinematic-insecure-fallback-key',
  )
  .digest();

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload || typeof payload !== 'string') return null;
  try {
    const [v, ivb, tagb, encb] = payload.split(':');
    if (v !== 'v1' || !ivb || !tagb || !encb) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivb, 'base64'));
    decipher.setAuthTag(Buffer.from(tagb, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encb, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
