/**
 * GET /analytics/mobile-home — today's attendance record carries the mode of transport. The apps replace the record
 * they hold with this one on every Home refresh; it used to leave `transport_mode` out, so "Travel mode not set"
 * came back after each refresh even though the mode had been saved. The keys appear only when a mode was recorded
 * (clients that never ask for it get the payload they always got).
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import { getMobileHome } from '../src/controllers/analytics.controller';
import { dbToday } from '../src/utils';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const REP = '33333333-3333-4333-8333-333333333333';
const USER = { id: REP, org_id: ORG, client_id: null, role: 'executive', email: 'rep@example.com' };

function home() {
  return new Promise<{ res: any; today: any }>((resolve, reject) => {
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn((body) => resolve({ res, today: body?.data?.today })),
    };
    (getMobileHome as any)({ user: USER, query: {} }, res, (err: unknown) => reject(err ?? new Error('next() called')));
  });
}

const record = (over: Record<string, unknown> = {}) => ({
  id: 'att1', user_id: REP, org_id: ORG, client_id: null, date: dbToday(), status: 'checked_in',
  checkin_at: new Date().toISOString(), checkout_at: null, breaks: [], ...over,
});

beforeEach(() => __mock.reset());

describe('mobile-home today record — mode of transport', () => {
  it('sends the saved mode and its label', async () => {
    __mock.queue('attendance', { data: [record({ transport_mode: 'public_transport' })] });

    const { res, today } = await home();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(today).toMatchObject({ id: 'att1', status: 'checked_in', transport_mode: 'public_transport', transport_label: 'Public transport' });
  });

  it('adds neither key when no mode was recorded', async () => {
    __mock.queue('attendance', { data: [record()] });

    const { today } = await home();

    expect(today).toBeTruthy();
    expect(today).not.toHaveProperty('transport_mode');
    expect(today).not.toHaveProperty('transport_label');
  });

  it('adds neither key when the mode is empty', async () => {
    __mock.queue('attendance', { data: [record({ transport_mode: null })] });

    const { today } = await home();

    expect(today).not.toHaveProperty('transport_mode');
  });
});
