/**
 * Form reference numbers (SRPR2627-1): the financial-year code, the prefix rules and the final format. The counter
 * itself is a database function (migration_form_ref_no.sql); only the pure rules are tested here.
 */
jest.mock('../src/lib/supabase', () => ({ supabaseAdmin: {} }));
jest.mock('../src/lib/clientFlags', () => ({ getClientSettings: jest.fn(async () => ({})) }));
jest.mock('../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { financialYearCode, formatFormRef, normalizePrefix, allocateFormRef } from '../src/lib/formRef';

describe('financialYearCode (Indian FY, Apr–Mar, IST)', () => {
  it('is 2627 for any day from 1 Apr 2026 to 31 Mar 2027', () => {
    expect(financialYearCode(new Date('2026-04-01T00:00:00+05:30'))).toBe('2627');
    expect(financialYearCode(new Date('2026-11-02T10:00:00Z'))).toBe('2627');
    expect(financialYearCode(new Date('2027-03-31T23:59:59+05:30'))).toBe('2627');
  });

  it('rolls over at midnight IST on 1 April, not midnight UTC', () => {
    // 31 Mar 2027 20:00 UTC is already 1 Apr 01:30 IST → the new year
    expect(financialYearCode(new Date('2027-03-31T20:00:00Z'))).toBe('2728');
    expect(financialYearCode(new Date('2027-03-31T18:29:59Z'))).toBe('2627');
  });

  it('is the previous year in Jan–Mar', () => {
    expect(financialYearCode(new Date('2026-01-15T12:00:00Z'))).toBe('2526');
  });

  it('pads across the century', () => {
    expect(financialYearCode(new Date('2099-06-01T00:00:00Z'))).toBe('9900');
    expect(financialYearCode(new Date('2108-06-01T00:00:00Z'))).toBe('0809');
  });
});

describe('normalizePrefix', () => {
  it('upper-cases and trims a valid prefix', () => {
    expect(normalizePrefix(' srpr ')).toBe('SRPR');
    expect(normalizePrefix('SR2')).toBe('SR2');
  });
  it('rejects anything that is not 1–12 letters/digits', () => {
    for (const bad of [undefined, null, 42, '', '   ', 'SR PR', 'SR-PR', 'SR/PR', 'A'.repeat(13)]) {
      expect(normalizePrefix(bad)).toBeNull();
    }
  });
});

describe('formatFormRef', () => {
  it('is prefix + FY + dash + running number', () => {
    expect(formatFormRef('SRPR', '2627', 1)).toBe('SRPR2627-1');
    expect(formatFormRef('SRPR', '2627', 128)).toBe('SRPR2627-128');
  });
});

describe('allocateFormRef', () => {
  it('gives nothing when there is no client, and never throws', async () => {
    await expect(allocateFormRef(null)).resolves.toBeNull();
    await expect(allocateFormRef(undefined)).resolves.toBeNull();
  });
  it('gives nothing for a client with no prefix setting (their submissions are untouched)', async () => {
    await expect(allocateFormRef('c0218852-0a19-4dd0-b9fa-72f9e32ed0d8')).resolves.toBeNull();
  });
});
