import { createSupabaseMock } from './helpers/supabaseMock';

// deactivateExpiredTrials reads/writes clients via supabaseAdmin, so mock it.
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import { deactivateExpiredTrials } from '../src/lib/clientAccess';

// Unambiguously past / future IST calendar days, so the test is stable whatever
// date it runs on.
const PAST = { trial: { start_date: '1999-12-01', days: 30, end_date: '2000-01-01' } };
const FUTURE = { trial: { start_date: '2999-12-01', days: 30, end_date: '2999-12-31' } };

beforeEach(() => __mock.reset());

describe('deactivateExpiredTrials', () => {
  it('flips is_active=false for ONLY the active clients whose trial has ended', async () => {
    __mock.queue('clients', {
      data: [
        { id: 'c-expired', settings: PAST },
        { id: 'c-future', settings: FUTURE },
        { id: 'c-notrial', settings: {} },
      ],
      error: null,
    });
    __mock.queue('clients', { data: null, error: null }); // the bulk update

    const r = await deactivateExpiredTrials();
    expect(r).toEqual({ scanned: 3, deactivated: 1 });

    const update = __mock.chainsFor('clients').find((c) => c.ops.some((o) => o.method === 'update'));
    expect(update).toBeTruthy();
    // sets is_active=false, targets only the expired id, guarded on is_active=true
    expect(update!.ops.find((o) => o.method === 'update')!.args[0]).toEqual({ is_active: false });
    expect(update!.ops.find((o) => o.method === 'in')!.args).toEqual(['id', ['c-expired']]);
    expect(update!.eqs['is_active']).toBe(true);
  });

  it('issues no update when nothing has expired', async () => {
    __mock.queue('clients', { data: [{ id: 'c1', settings: FUTURE }, { id: 'c2', settings: {} }], error: null });
    const r = await deactivateExpiredTrials();
    expect(r).toEqual({ scanned: 2, deactivated: 0 });
    expect(__mock.chainsFor('clients').some((c) => c.ops.some((o) => o.method === 'update'))).toBe(false);
  });

  it('fails safe (0/0, no throw) when the scan errors', async () => {
    __mock.queue('clients', { data: null, error: { message: 'boom' } });
    await expect(deactivateExpiredTrials()).resolves.toEqual({ scanned: 0, deactivated: 0 });
  });
});
