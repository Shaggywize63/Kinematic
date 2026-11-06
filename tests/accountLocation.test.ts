/** Account location fields survive validation, and the location master seeds itself once per org. */
jest.mock('../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

type Call = { table: string; op: string; arg?: unknown };
const calls: Call[] = [];
let existing = 0;
let rpcError: { message: string } | null = null;
const rpc = jest.fn(async () => ({ data: { states: 36, cities: 100 }, error: rpcError }));
jest.mock('../src/lib/supabase', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ limit: async () => { calls.push({ table, op: 'select' }); return { data: Array.from({ length: existing }, (_, i) => ({ id: String(i) })), error: null }; } }) }),
      insert: async (arg: unknown) => { calls.push({ table, op: 'insert', arg }); return { error: null }; },
    }),
    rpc: (...a: unknown[]) => (rpc as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

import { accountSchema } from '../src/validators/crm.validators';
import { ensureLocationMaster, INDIAN_STATES } from '../src/services/crm/locationSeed';

describe('accountSchema location fields', () => {
  it('keeps address, city, state, postal code and country instead of stripping them', () => {
    const r = accountSchema.parse({ name: 'Acme', address_line1: 'Plot 4', city: 'Cuttack', state: 'Odisha', postal_code: '754297', country: 'India' });
    expect(r).toMatchObject({ address_line1: 'Plot 4', city: 'Cuttack', state: 'Odisha', postal_code: '754297', country: 'India' });
  });
  it('allows clearing them with null', () => {
    expect(accountSchema.partial().parse({ state: null, city: null })).toEqual({ state: null, city: null });
  });
});

describe('INDIAN_STATES', () => {
  it('is the 28 states and 8 union territories with unique names and codes', () => {
    expect(INDIAN_STATES).toHaveLength(36);
    expect(new Set(INDIAN_STATES.map((s) => s.name)).size).toBe(36);
    expect(new Set(INDIAN_STATES.map((s) => s.code)).size).toBe(36);
  });
});

describe('ensureLocationMaster', () => {
  beforeEach(() => { calls.length = 0; rpc.mockClear(); rpcError = null; });
  it('does nothing for an org that already has states', async () => {
    existing = 5;
    await ensureLocationMaster('org-has');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('calls the seed function for an empty org, once', async () => {
    existing = 0;
    await ensureLocationMaster('org-empty');
    await ensureLocationMaster('org-empty');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('falls back to inserting the 36 states when the seed function is missing', async () => {
    existing = 0;
    rpcError = { message: 'function does not exist' };
    await ensureLocationMaster('org-fallback');
    const ins = calls.find((c) => c.op === 'insert');
    expect((ins?.arg as unknown[]).length).toBe(36);
  });
});
