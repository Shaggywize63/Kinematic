/**
 * GET /analytics/activity-feed — the Home "Recent activity" feed. An ad-hoc mobile submit arrives with
 * `outlet_name` NULL, so every card used to say "Unknown Store". The feed now adds (additively)
 * `customer_name`, `title` and `subtitle`, taken from the submission's own answers with ONE extra read of
 * form_responses + builder_questions(label). This drives the real controller against the chainable
 * Supabase double and checks: the new fields, the priority, blank answers, no responses, a failing
 * extra query (the feed must still be served, without the new fields), the IN-list cap / id validation,
 * and that every legacy field and the existing scoping are exactly as before.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import { getActivityFeed } from '../src/controllers/analytics.controller';
import { logger } from '../src/lib/logger';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const CLIENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_CLIENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REP = '33333333-3333-4333-8333-333333333333';
const USER = { id: REP, org_id: ORG, client_id: CLIENT, role: 'admin' };

const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NEW_FIELDS = ['customer_name', 'title', 'subtitle'];

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  __mock.reset();
  warnSpy = jest.spyOn(logger, 'warn').mockImplementation((() => undefined) as any);
});

/** A form_submissions row as the feed's select returns it. */
function sub(n: number, over: Record<string, unknown> = {}) {
  return {
    id: sid(n),
    submitted_at: `2026-10-11T0${n % 10}:00:00.000Z`,
    is_converted: false,
    outlet_name: null,
    users: { name: 'Rep One', city: 'Pune' },
    builder_forms: { title: 'Site Visit' },
    ...over,
  };
}

/** A form_responses row as the extra query returns it. */
const resp = (n: number, label: string | null, value_text: string | null) => ({
  submission_id: sid(n),
  value_text,
  builder_questions: label === null ? null : { label },
});

// asyncHandler does not hand its promise back, so wait for the response itself (or an error to `next`).
function feed(query: Record<string, string> = {}, user: Record<string, unknown> = USER) {
  return new Promise<{ res: any; body: any; data: any[] }>((resolve, reject) => {
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn((body) => resolve({ res, body, data: body?.data as any[] })),
    };
    (getActivityFeed as any)({ user, query }, res, (err: unknown) => reject(err ?? new Error('next() called')));
  });
}

const responsesChains = () => __mock.chainsFor('form_responses');

describe('GET /analytics/activity-feed — customer name, title, subtitle', () => {
  it('names an ad-hoc submit (outlet_name NULL) after the customer answer, form name as subtitle', async () => {
    __mock.queue('form_submissions', { data: [sub(1)] });
    __mock.queue('form_responses', { data: [resp(1, 'Remarks', 'ok'), resp(1, 'Customer Name', 'Acme Traders')] });

    const { res, data } = await feed();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: sid(1),
      customer_name: 'Acme Traders',
      title: 'Acme Traders',
      subtitle: 'Site Visit',
      // legacy fields untouched
      outlet_name: 'Unknown Store',
      form_name: 'Site Visit',
      description: 'Rep One submitted Site Visit',
    });
  });

  it('sends the exact additive shape', async () => {
    __mock.queue('form_submissions', { data: [sub(1)] });
    __mock.queue('form_responses', { data: [resp(1, 'Customer Name', 'Acme Traders')] });

    const { data } = await feed();

    expect(data[0]).toEqual({
      id: sid(1),
      outlet_name: 'Unknown Store',
      submitted_at: '2026-10-11T01:00:00.000Z',
      is_converted: false,
      user: { name: 'Rep One', zones: { city: 'Pune', name: '' } },
      description: 'Rep One submitted Site Visit',
      form_name: 'Site Visit',
      customer_name: 'Acme Traders',
      title: 'Acme Traders',
      subtitle: 'Site Visit',
    });
  });

  it('picks the best label by priority, whatever order the answers come back in', async () => {
    __mock.queue('form_submissions', { data: [sub(1), sub(2)] });
    __mock.queue('form_responses', {
      data: [
        resp(1, 'Outlet Name', 'Outlet A'),
        resp(1, 'Shop Name', 'Shop B'),
        resp(1, ' customer NAME ', 'Customer C'),
        resp(2, 'Shop Name', 'Shop D'),
        resp(2, 'Party Name', 'Party E'),
      ],
    });

    const { data } = await feed();
    const byId = Object.fromEntries(data.map((d) => [d.id, d]));

    expect(byId[sid(1)].customer_name).toBe('Customer C');
    expect(byId[sid(2)].customer_name).toBe('Party E'); // 'party name' outranks 'shop name'
  });

  it('ignores empty / whitespace answers and falls through to the next best question', async () => {
    __mock.queue('form_submissions', { data: [sub(1), sub(2)] });
    __mock.queue('form_responses', {
      data: [
        resp(1, 'Customer Name', '   '),
        resp(1, 'Shop Name', '  Kiosk  '),
        resp(2, 'Customer Name', ''),
        resp(2, 'Customer', null),
      ],
    });

    const { data } = await feed();
    const byId = Object.fromEntries(data.map((d) => [d.id, d]));

    expect(byId[sid(1)]).toMatchObject({ customer_name: 'Kiosk', title: 'Kiosk', subtitle: 'Site Visit' });
    // nothing usable: no customer, no real outlet -> the form name is the title
    expect(byId[sid(2)]).toMatchObject({ customer_name: null, title: 'Site Visit', subtitle: null, outlet_name: 'Unknown Store' });
  });

  it('with no responses for a submission: customer_name null, title from the real outlet', async () => {
    __mock.queue('form_submissions', { data: [sub(1, { outlet_name: 'Reliance Fresh' }), sub(2)] });
    __mock.queue('form_responses', { data: [] });

    const { data } = await feed();
    const byId = Object.fromEntries(data.map((d) => [d.id, d]));

    expect(byId[sid(1)]).toMatchObject({
      customer_name: null,
      title: 'Reliance Fresh',
      subtitle: 'Site Visit',
      outlet_name: 'Reliance Fresh',
    });
    expect(byId[sid(2)]).toMatchObject({ customer_name: null, title: 'Site Visit', subtitle: null, outlet_name: 'Unknown Store' });
  });

  it('a customer answer beats a real outlet name', async () => {
    __mock.queue('form_submissions', { data: [sub(1, { outlet_name: 'Reliance Fresh' })] });
    __mock.queue('form_responses', { data: [resp(1, 'Customer Name', 'Acme')] });

    const { data } = await feed();

    expect(data[0]).toMatchObject({ customer_name: 'Acme', title: 'Acme', subtitle: 'Site Visit', outlet_name: 'Reliance Fresh' });
  });

  it('does not treat a stored "Unknown Store" outlet as real, and bottoms out at "Form submission"', async () => {
    __mock.queue('form_submissions', { data: [sub(1, { outlet_name: 'Unknown Store', builder_forms: null })] });
    __mock.queue('form_responses', { data: [] });

    const { data } = await feed();

    expect(data[0]).toMatchObject({
      customer_name: null,
      title: 'Form submission',
      subtitle: null,
      outlet_name: 'Unknown Store',
      form_name: 'General Form', // the legacy display fallback is unchanged
      description: 'Rep One submitted Form',
    });
  });

  it('survives an answer whose question was deleted (no builder_questions embed)', async () => {
    __mock.queue('form_submissions', { data: [sub(1)] });
    __mock.queue('form_responses', { data: [resp(1, null, 'orphan answer'), resp(1, 'Customer', 'Acme')] });

    const { data } = await feed();

    expect(data[0].customer_name).toBe('Acme');
  });

  it('keeps the feed newest-first', async () => {
    __mock.queue('form_submissions', { data: [sub(1), sub(3), sub(2)] });
    __mock.queue('form_responses', { data: [] });

    const { data } = await feed();

    expect(data.map((d) => d.id)).toEqual([sid(3), sid(2), sid(1)]);
  });
});

describe('GET /analytics/activity-feed — the extra query', () => {
  it('is exactly ONE form_responses read for the page, by submission id, with the question label embedded', async () => {
    __mock.queue('form_submissions', { data: [sub(1), sub(2), sub(3)] });
    __mock.queue('form_responses', { data: [] });

    await feed();

    expect(responsesChains()).toHaveLength(1);
    const ops = responsesChains()[0].ops;
    const select = ops.find((o) => o.method === 'select')!;
    expect(String(select.args[0])).toMatch(/builder_questions\(label\)/);
    const inOp = ops.find((o) => o.method === 'in')!;
    expect(inOp.args[0]).toBe('submission_id');
    expect(inOp.args[1]).toEqual([sid(1), sid(2), sid(3)]);
  });

  it('runs after the submissions query and is not issued when there are no submissions', async () => {
    __mock.queue('form_submissions', { data: [] });

    const { res, data } = await feed();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(data).toEqual([]);
    expect(responsesChains()).toHaveLength(0);
  });

  it('only looks up valid UUIDs, and de-duplicates them', async () => {
    __mock.queue('form_submissions', { data: [sub(1), sub(1), { ...sub(2), id: "x'),user_id.neq.(" }, { ...sub(3), id: null }] });
    __mock.queue('form_responses', { data: [] });

    const { data } = await feed();

    const inOp = responsesChains()[0].ops.find((o) => o.method === 'in')!;
    expect(inOp.args[1]).toEqual([sid(1)]);
    // the rows themselves are still served
    expect(data).toHaveLength(4);
  });

  it('skips the lookup when no id is a valid UUID, but still serves the feed with null customer names', async () => {
    __mock.queue('form_submissions', { data: [{ ...sub(1), id: 'not-a-uuid', outlet_name: 'Reliance Fresh' }] });

    const { data } = await feed();

    expect(responsesChains()).toHaveLength(0);
    expect(data[0]).toMatchObject({ customer_name: null, title: 'Reliance Fresh', subtitle: 'Site Visit' });
  });

  it('caps the IN list at the default limit of 20', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => sub(i + 1));
    __mock.queue('form_submissions', { data: rows });
    __mock.queue('form_responses', { data: [] });

    await feed();

    const sq = __mock.chainsFor('form_submissions')[0];
    expect(sq.ops.find((o) => o.method === 'limit')!.args[0]).toBe(20);
    const inOp = responsesChains()[0].ops.find((o) => o.method === 'in')!;
    expect(inOp.args[1]).toHaveLength(20);
  });

  it('never exceeds 50 ids even when ?limit asks for more', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => sub(i + 1));
    __mock.queue('form_submissions', { data: rows });
    __mock.queue('form_responses', { data: [] });

    await feed({ limit: '500' });

    const sq = __mock.chainsFor('form_submissions')[0];
    expect(sq.ops.find((o) => o.method === 'limit')!.args[0]).toBe(50);
    const inOp = responsesChains()[0].ops.find((o) => o.method === 'in')!;
    expect(inOp.args[1]).toHaveLength(50);
  });

  it('follows a smaller ?limit', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => sub(i + 1));
    __mock.queue('form_submissions', { data: rows });
    __mock.queue('form_responses', { data: [] });

    await feed({ limit: '5' });

    const inOp = responsesChains()[0].ops.find((o) => o.method === 'in')!;
    expect(inOp.args[1]).toHaveLength(5);
  });
});

describe('GET /analytics/activity-feed — the extra query fails', () => {
  const LEGACY = {
    id: sid(1),
    outlet_name: 'Unknown Store',
    submitted_at: '2026-10-11T01:00:00.000Z',
    is_converted: false,
    user: { name: 'Rep One', zones: { city: 'Pune', name: '' } },
    description: 'Rep One submitted Site Visit',
    form_name: 'Site Visit',
  };

  it('a query error is logged as a warning and the feed is returned without the new fields', async () => {
    __mock.queue('form_submissions', { data: [sub(1)] });
    __mock.queue('form_responses', { data: null, error: { message: 'relation "form_responses" does not exist' } });

    const { res, body, data } = await feed();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.success).toBe(true);
    expect(data).toEqual([LEGACY]);
    for (const k of NEW_FIELDS) expect(Object.keys(data[0])).not.toContain(k);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/does not exist/);
  });

  it('a thrown exception is treated the same way', async () => {
    __mock.queue('form_submissions', { data: [sub(1)] });
    __mock.queue('form_responses', () => {
      throw new Error('socket hang up');
    });

    const { res, data } = await feed();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(data).toEqual([LEGACY]);
    for (const k of NEW_FIELDS) expect(Object.keys(data[0])).not.toContain(k);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/socket hang up/);
  });
});

describe('GET /analytics/activity-feed — legacy behaviour and scoping are unchanged', () => {
  it('keeps outlet_name (with its fallback), form_name and description exactly as before', async () => {
    __mock.queue('form_submissions', {
      data: [
        sub(1, { outlet_name: 'Reliance Fresh', builder_forms: { title: 'Product Audit' }, users: { name: 'Arjun', city: null } }),
        sub(2, { outlet_name: '', builder_forms: null, users: null }),
      ],
    });
    __mock.queue('form_responses', { data: [resp(1, 'Customer Name', 'Acme'), resp(2, 'Customer Name', 'Globex')] });

    const { data } = await feed();
    const byId = Object.fromEntries(data.map((d) => [d.id, d]));

    expect(byId[sid(1)]).toMatchObject({
      outlet_name: 'Reliance Fresh',
      form_name: 'Product Audit',
      description: 'Arjun submitted Product Audit',
      user: { name: 'Arjun', zones: { city: '', name: '' } },
      is_converted: false,
    });
    expect(byId[sid(2)]).toMatchObject({
      outlet_name: 'Unknown Store',
      form_name: 'General Form',
      description: 'Unknown submitted Form',
      user: { name: 'Unknown', zones: { city: '', name: '' } },
    });
  });

  it('keeps the org + client-or-own scoping on the submissions query', async () => {
    __mock.queue('form_submissions', { data: [] });

    await feed();

    const c = __mock.chainsFor('form_submissions')[0];
    expect(c.eqs.org_id).toBe(ORG);
    expect(c.ors).toEqual([`client_id.eq.${CLIENT},user_id.eq.${REP}`]);
    expect(String(c.ops.find((o) => o.method === 'select')!.args[0])).toBe(
      'id, submitted_at, is_converted, outlet_name, users!user_id(name, city), builder_forms:builder_forms!fk_submission_template(title)',
    );
  });

  it('keeps ?client_id scoping when the caller has no client of its own', async () => {
    __mock.queue('form_submissions', { data: [] });

    await feed({ client_id: OTHER_CLIENT }, { ...USER, client_id: undefined });

    const c = __mock.chainsFor('form_submissions')[0];
    expect(c.eqs.org_id).toBe(ORG);
    expect(c.eqs.client_id).toBe(OTHER_CLIENT);
    expect(c.ors).toEqual([]);
  });

  it('keeps the own-submissions default when there is no client at all', async () => {
    __mock.queue('form_submissions', { data: [] });

    await feed({}, { ...USER, client_id: undefined });

    const c = __mock.chainsFor('form_submissions')[0];
    expect(c.eqs.org_id).toBe(ORG);
    expect(c.eqs.user_id).toBe(REP);
  });

  it('serves the demo org its fixtures, with no database read', async () => {
    const { res, data } = await feed({}, { ...USER, org_id: '00000000-0000-0000-0000-000000000999' });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(Array.isArray(data)).toBe(true);
    expect(__mock.chains).toHaveLength(0);
  });
});
