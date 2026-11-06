/** An account write survives a database that lacks the optional location columns. */
jest.mock('../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
import { AppError } from '../src/utils';
import { writeAccountResilient } from '../src/services/crm/accountWrite';

const missing = (col: string) => new AppError(500, `Could not find the '${col}' column of 'crm_accounts' in the schema cache`, 'DB_ERROR');

describe('writeAccountResilient', () => {
  it('passes the payload through untouched when nothing is missing', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const r = await writeAccountResilient({ name: 'A', city: 'Cuttack' }, 'create', async (p) => { seen.push(p); return 'ok'; });
    expect(r).toBe('ok');
    expect(seen).toEqual([{ name: 'A', city: 'Cuttack' }]);
  });

  it('drops a missing column on create and keeps the value in custom_fields.location', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const r = await writeAccountResilient(
      { name: 'A', address_line1: 'Sevoke Road', city: 'Siliguri', custom_fields: { x: 1 } }, 'create',
      async (p) => { seen.push(p); if ('address_line1' in p) throw missing('address_line1'); return 'saved'; },
    );
    expect(r).toBe('saved');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ name: 'A', city: 'Siliguri', custom_fields: { x: 1, location: { address_line1: 'Sevoke Road' } } });
  });

  it('keeps dropping one column at a time until the write goes through', async () => {
    const absent = new Set(['address_line1', 'state', 'postal_code']);
    const r = await writeAccountResilient(
      { name: 'A', address_line1: 'x', state: 'West Bengal', postal_code: '734001', city: 'Siliguri' }, 'create',
      async (p) => { const bad = Object.keys(p).find((k) => absent.has(k)); if (bad) throw missing(bad); return p; },
    );
    expect(r).toEqual({ name: 'A', city: 'Siliguri', custom_fields: { location: { address_line1: 'x', state: 'West Bengal', postal_code: '734001' } } });
  });

  it('does not touch custom_fields on a patch (it would replace the stored values)', async () => {
    const r = await writeAccountResilient({ state: 'Odisha' }, 'patch', async (p) => { if ('state' in p) throw missing('state'); return p; });
    expect(r).toEqual({});
  });

  it('rethrows an error that is not about an optional column', async () => {
    await expect(writeAccountResilient({ name: 'A' }, 'create', async () => { throw new AppError(500, 'duplicate key', 'DB_ERROR'); })).rejects.toThrow('duplicate key');
    await expect(writeAccountResilient({ name: 'A' }, 'create', async () => { throw missing('name'); })).rejects.toThrow("'name'");
  });
});
