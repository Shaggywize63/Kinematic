/**
 * HRMS field encryption + masking (src/lib/hrmsCrypto.ts).
 * The properties that matter: a value only opens with the same key AND the same context (employee + field), the key
 * comes from HRMS_DATA_KEY with a one-time warning for the fallback, rows sealed under the fallback stay readable once
 * HRMS_DATA_KEY is introduced, and the masks keep exactly the last four characters.
 */
import { logger } from '../src/lib/logger';
import {
  _resetHrmsCryptoForTests, decryptField, encryptField, hrmsKeySource, looksMaskedAccount, looksMaskedPan, maskAccountNumber, maskPan,
} from '../src/lib/hrmsCrypto';

const KEY = 'unit-test-hrms-data-key-0123456789abcdef';
const ENV_KEYS = ['HRMS_DATA_KEY', 'CLIENT_CRED_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.HRMS_DATA_KEY = KEY;
  _resetHrmsCryptoForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  _resetHrmsCryptoForTests();
  jest.restoreAllMocks();
});

describe('encryptField / decryptField', () => {
  it('round-trips and never contains the plaintext', () => {
    const sealed = encryptField('ABCPM1234F', 'emp-1:pan');
    expect(sealed.startsWith('h1:k:')).toBe(true);
    expect(sealed).not.toContain('ABCPM1234F');
    expect(decryptField(sealed, 'emp-1:pan')).toBe('ABCPM1234F');
  });

  it('seals the same value differently each time (fresh IV)', () => {
    expect(encryptField('ABCPM1234F', 'c')).not.toBe(encryptField('ABCPM1234F', 'c'));
  });

  it('does not open under another employee or field (context is authenticated)', () => {
    const sealed = encryptField('ABCPM1234F', 'emp-1:pan');
    expect(decryptField(sealed, 'emp-2:pan')).toBeNull();
    expect(decryptField(sealed, 'emp-1:bank')).toBeNull();
  });

  it('returns null for tampered, truncated, empty or foreign payloads', () => {
    const sealed = encryptField('secret-value', 'c');
    const parts = sealed.split(':');
    parts[4] = Buffer.from('tampered-bytes').toString('base64');
    expect(decryptField(parts.join(':'), 'c')).toBeNull();
    expect(decryptField(sealed.slice(0, -6), 'c')).toBeNull();
    for (const bad of ['', null, undefined, 'plain text', 'v1:iv:tag:ct']) expect(decryptField(bad as never, 'c')).toBeNull();
  });

  it('does not open under a different HRMS_DATA_KEY', () => {
    const sealed = encryptField('ABCPM1234F', 'c');
    process.env.HRMS_DATA_KEY = 'a-completely-different-key-0123456789abcdef';
    expect(decryptField(sealed, 'c')).toBeNull();
  });

  it('handles non-ASCII and long values', () => {
    const long = JSON.stringify({ accountHolder: 'Ananya Iyer ₹', accountNumber: '501001234567'.repeat(20) });
    expect(decryptField(encryptField(long, 'c'), 'c')).toBe(long);
  });
});

describe('key handling', () => {
  it('uses HRMS_DATA_KEY when set, with no warning', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    encryptField('x', 'c');
    expect(hrmsKeySource()).toBe('HRMS_DATA_KEY');
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a short HRMS_DATA_KEY rather than encrypting with a weak key', () => {
    process.env.HRMS_DATA_KEY = 'too-short';
    expect(() => encryptField('x', 'c')).toThrow(/at least 32/);
  });

  it('falls back to the secretBox key material and warns exactly once, without printing any key or value', () => {
    delete process.env.HRMS_DATA_KEY;
    process.env.CLIENT_CRED_KEY = 'fallback-material-for-the-test';
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const a = encryptField('ABCPM1234F', 'c');
    const b = encryptField('ABCPM1234F', 'c');
    expect(a.startsWith('h1:f:')).toBe(true);
    expect(decryptField(b, 'c')).toBe('ABCPM1234F');
    expect(hrmsKeySource()).toBe('fallback');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toMatch(/set HRMS_DATA_KEY before real data goes in/i);
    expect(logged).not.toContain('fallback-material-for-the-test');
    expect(logged).not.toContain('ABCPM1234F');
  });

  it('keeps rows sealed under the fallback readable after HRMS_DATA_KEY is introduced (and seals new ones with the new key)', () => {
    delete process.env.HRMS_DATA_KEY;
    process.env.CLIENT_CRED_KEY = 'fallback-material-for-the-test';
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const old = encryptField('ABCPM1234F', 'c');
    process.env.HRMS_DATA_KEY = KEY;
    expect(decryptField(old, 'c')).toBe('ABCPM1234F');
    expect(encryptField('ABCPM1234F', 'c').startsWith('h1:k:')).toBe(true);
  });

  it('never encrypts with a hard-coded key: no key material at all is an error', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(() => encryptField('x', 'c')).toThrow(/not configured/);
  });
});

describe('masks', () => {
  it('PAN keeps the last four characters', () => {
    expect(maskPan('ABCPM1234F')).toBe('XXXXXX234F');
    expect(maskPan('ABCPM1234F')).toHaveLength(10);
  });
  it('account number keeps the last four digits', () => {
    expect(maskAccountNumber('501001234567')).toBe('••••••••4567');
    expect(maskAccountNumber('501001234567')).toHaveLength(12);
  });
  it('short values are fully masked, never shown whole', () => {
    expect(maskPan('AB12')).toBe('XXXX');
    expect(maskAccountNumber('123')).toBe('•••');
  });
  it('recognises a masked PAN echo, but not a real PAN that happens to contain X', () => {
    for (const masked of ['XXXXXX234F', 'AB•••••34F', 'ABC***234F', 'XXXXXXXXXX']) expect(looksMaskedPan(masked)).toBe(true);
    for (const real of ['ABCPM1234F', 'AXXPX1234F', 'XXXPX1234X']) expect(looksMaskedPan(real)).toBe(false);
  });
  it('recognises a masked account number echo', () => {
    for (const masked of ['••••••••4567', '********4567', 'XXXXXXXX4567', 'xxxx4567']) expect(looksMaskedAccount(masked)).toBe(true);
    expect(looksMaskedAccount('501001234567')).toBe(false);
  });
});
