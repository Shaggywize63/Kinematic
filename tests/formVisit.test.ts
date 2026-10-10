/**
 * Check-in / check-out on forms: the pure sanitiser (services/formVisit.service.ts) and both submit
 * paths over HTTP (POST /forms/submit, POST /builder/forms/:id/submissions) plus the admin listing
 * (GET /forms/admin/submissions) that must expose check_in_at / check_out_at / check_in_gps /
 * check_out_gps / duration_minutes on every row.
 *
 * The rule: sanitise, NEVER reject. A bad or skewed timestamp must not cost a rep their submission.
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { ...(global as any).__testUser };
    next();
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const formsRouter = require('../src/routes/forms.routes').default as express.Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const builderRouter = require('../src/routes/builder.routes').default as express.Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../src/middleware/errorHandler') as { errorHandler: express.ErrorRequestHandler };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { clearClientFlagCache } = require('../src/lib/clientFlags') as { clearClientFlagCache: (id?: string | null) => void };
import {
  FORM_VISIT_FUTURE_SKEW_MS, parseVisitTimestamp, sanitiseVisitTimes, visitDurationMinutes, withVisitFields, parseLatLng, toLatLng,
} from '../src/services/formVisit.service';

const NOW = Date.parse('2026-10-09T08:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const minsFromNow = (m: number) => iso(NOW + m * 60_000);

describe('parseVisitTimestamp', () => {
  it.each([
    ['2026-10-09T08:00:00Z', NOW],
    ['2026-10-09T08:00:00.000Z', NOW],
    ['2026-10-09T08:00Z', NOW],
    ['2026-10-09T13:30:00+05:30', NOW],
    ['2026-10-09T13:30:00+0530', NOW],
    ['2026-10-09 08:00:00+00', NOW],
    ['2026-10-09 08:00:00', NOW],                       // no zone: read as UTC, never the server's local zone
    ['2026-10-09T08:00:00', NOW],
    ['2026-10-09T08:00:00+00:00', NOW],                 // how Postgres prints a timestamptz
    ['2026-10-09T08:00:00.123456+00:00', NOW + 123],
    ['  2026-10-09T08:00:00Z  ', NOW],
  ])('%s', (s, ms) => {
    expect(parseVisitTimestamp(s)).toBe(ms);
  });

  it.each(['garbage', '', '   ', '12', '2026-10-09', '2026-02-31T10:00:00Z', '2026-13-01T10:00:00Z', '2026-10-09T25:00:00Z', 'Oct 9 2026 10:00', null, undefined, 0, 1790000000000, {}, []])(
    'rejects %p', (v) => { expect(parseVisitTimestamp(v)).toBeNull(); },
  );
});

describe('visitDurationMinutes', () => {
  it('is whole minutes, rounded', () => {
    expect(visitDurationMinutes(NOW, NOW + 18 * 60_000)).toBe(18);
    expect(visitDurationMinutes(NOW, NOW + 89_000)).toBe(1);
    expect(visitDurationMinutes(NOW, NOW + 29_000)).toBe(0);
    expect(visitDurationMinutes(NOW, NOW)).toBe(0);
  });
  it('is null when out < in, over 24 h, or either side is missing', () => {
    expect(visitDurationMinutes(NOW, NOW - 1)).toBeNull();
    expect(visitDurationMinutes(NOW, NOW + 24 * 3_600_000)).toBe(1440);
    expect(visitDurationMinutes(NOW, NOW + 24 * 3_600_000 + 1)).toBeNull();
    expect(visitDurationMinutes(null, NOW)).toBeNull();
    expect(visitDurationMinutes(NOW, undefined)).toBeNull();
    expect(visitDurationMinutes(NaN, NOW)).toBeNull();
  });
});

describe('sanitiseVisitTimes', () => {
  const run = (input: any, autoCheckout = false) => sanitiseVisitTimes(input, { nowMs: NOW, autoCheckout });

  it('keeps a good pair (normalised to ISO UTC) and totals the time', () => {
    expect(run({ check_in_at: '2026-10-09T13:00:00+05:30', check_out_at: minsFromNow(-12) })).toEqual({
      check_in_at: minsFromNow(-30), check_out_at: minsFromNow(-12), duration_minutes: 18,
    });
  });

  it('never throws and turns an unparseable timestamp into null', () => {
    expect(run({ check_in_at: 'garbage', check_out_at: minsFromNow(-1) })).toEqual({ check_in_at: null, check_out_at: minsFromNow(-1), duration_minutes: null });
    expect(run({ check_in_at: minsFromNow(-5), check_out_at: 'nope' })).toEqual({ check_in_at: minsFromNow(-5), check_out_at: null, duration_minutes: null });
    expect(run({})).toEqual({ check_in_at: null, check_out_at: null, duration_minutes: null });
    expect(run({ check_in_at: 12345, check_out_at: {} })).toEqual({ check_in_at: null, check_out_at: null, duration_minutes: null });
  });

  it('clamps anything more than 5 minutes in the future to server now', () => {
    const r = run({ check_in_at: minsFromNow(-20), check_out_at: minsFromNow(90) });
    expect(r.check_out_at).toBe(iso(NOW));
    expect(r.duration_minutes).toBe(20);
    const both = run({ check_in_at: minsFromNow(60), check_out_at: minsFromNow(120) });
    expect(both).toEqual({ check_in_at: iso(NOW), check_out_at: iso(NOW), duration_minutes: 0 });
  });

  it('leaves a stamp within the 5 minute clock-skew allowance alone', () => {
    const at = iso(NOW + FORM_VISIT_FUTURE_SKEW_MS);
    expect(run({ check_in_at: minsFromNow(-1), check_out_at: at }).check_out_at).toBe(at);
    expect(run({ check_in_at: minsFromNow(-1), check_out_at: iso(NOW + FORM_VISIT_FUTURE_SKEW_MS + 1000) }).check_out_at).toBe(iso(NOW));
  });

  it('keeps both stamps when check_out is before check_in, with no duration', () => {
    expect(run({ check_in_at: minsFromNow(-10), check_out_at: minsFromNow(-30) })).toEqual({
      check_in_at: minsFromNow(-10), check_out_at: minsFromNow(-30), duration_minutes: null,
    });
  });

  it('stores no duration for a visit longer than 24 h (a forgotten check-out)', () => {
    const r = run({ check_in_at: iso(NOW - 25 * 3_600_000), check_out_at: iso(NOW) });
    expect(r.duration_minutes).toBeNull();
    expect(r.check_in_at).toBe(iso(NOW - 25 * 3_600_000));
  });

  describe('form_checkin_required: a check-in with no check-out is closed at server now', () => {
    it('when the rule is on', () => {
      expect(run({ check_in_at: minsFromNow(-18) }, true)).toEqual({ check_in_at: minsFromNow(-18), check_out_at: iso(NOW), duration_minutes: 18 });
      expect(run({ check_in_at: minsFromNow(-18), check_out_at: 'garbage' }, true).check_out_at).toBe(iso(NOW));
    });
    it('not when the rule is off', () => {
      expect(run({ check_in_at: minsFromNow(-18) }, false)).toEqual({ check_in_at: minsFromNow(-18), check_out_at: null, duration_minutes: null });
    });
    it('not without a (valid) check-in', () => {
      expect(run({}, true)).toEqual({ check_in_at: null, check_out_at: null, duration_minutes: null });
      expect(run({ check_in_at: 'garbage' }, true).check_out_at).toBeNull();
      expect(run({ check_out_at: minsFromNow(-3) }, true)).toEqual({ check_in_at: null, check_out_at: minsFromNow(-3), duration_minutes: null });
    });
    it('does not overwrite a check-out the app did send', () => {
      expect(run({ check_in_at: minsFromNow(-18), check_out_at: minsFromNow(-2) }, true).check_out_at).toBe(minsFromNow(-2));
    });
  });
});

describe('withVisitFields (the admin listing)', () => {
  it('exposes the five fields on every row, null when absent', () => {
    expect(withVisitFields({ id: 'a' })).toEqual({
      id: 'a', check_in_at: null, check_out_at: null, check_in_gps: null, check_out_gps: null, duration_minutes: null,
    });
  });
  it('computes the duration of an old row that has both times but none stored', () => {
    const r = withVisitFields({ check_in_at: '2026-10-09T04:30:00+00:00', check_out_at: '2026-10-09T04:50:00+00:00', duration_minutes: null });
    expect(r.duration_minutes).toBe(20);
  });
  it('keeps a stored duration (including 0) and never invents one without both times', () => {
    expect(withVisitFields({ check_in_at: '2026-10-09T04:30:00Z', check_out_at: '2026-10-09T04:50:00Z', duration_minutes: 7 }).duration_minutes).toBe(7);
    expect(withVisitFields({ check_in_at: '2026-10-09T04:30:00Z', check_out_at: '2026-10-09T04:30:00Z', duration_minutes: 0 }).duration_minutes).toBe(0);
    expect(withVisitFields({ check_in_at: '2026-10-09T04:30:00Z' }).duration_minutes).toBeNull();
    expect(withVisitFields({ check_in_at: '2026-10-09T04:50:00Z', check_out_at: '2026-10-09T04:30:00Z' }).duration_minutes).toBeNull();
    expect(withVisitFields({ check_in_at: 'junk', check_out_at: 'junk' }).duration_minutes).toBeNull();
  });
});

describe('GPS text parsing', () => {
  it('parses "lat,lng" and refuses junk, out-of-range values and the (0,0) no-fix placeholder', () => {
    expect(parseLatLng('13.0827, 80.2707')).toEqual({ lat: 13.0827, lng: 80.2707 });
    expect(parseLatLng('-33.8,151.2')).toEqual({ lat: -33.8, lng: 151.2 });
    for (const bad of ['', 'x', '13.0', '1,2,3', '91,0', '0,181', '0,0', '0.0, 0.0', null, undefined, 5]) {
      expect(parseLatLng(bad as any)).toBeNull();
    }
    expect(toLatLng('13', '80')).toEqual({ lat: 13, lng: 80 });
    expect(toLatLng(null, 80)).toBeNull();
    expect(toLatLng('', '')).toBeNull();
  });
});

// ── over HTTP ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/forms', formsRouter);
app.use('/builder', builderRouter);
app.use(errorHandler);

const ORG = '00000000-0000-4000-8000-0000000000aa';
const CA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';   // form_checkin_required: true
const CB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';   // nothing configured
const REP = '22222222-2222-4222-8222-222222222222';
const FORM_ID = '44444444-4444-4444-8444-444444444444';
const setUser = (u: Record<string, unknown>) => { (global as any).__testUser = u; };
const repA = { id: REP, org_id: ORG, role: 'field_executive', client_id: CA, name: 'Asha', email: 'asha@client.test' };
const repB = { ...repA, client_id: CB };

let CLIENT_SETTINGS: Record<string, Record<string, unknown>>;

const inserts = (table: string) => __mock.chainsFor(table).flatMap((c) => c.ops.filter((o) => o.method === 'insert').map((o) => o.args[0] as Record<string, any>));
const closeToNow = (isoStr: string) => Math.abs(Date.parse(isoStr) - Date.now()) < 15_000;
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ahead = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

beforeEach(() => {
  __mock.reset();
  clearClientFlagCache();
  CLIENT_SETTINGS = {
    [CA]: { attendance_rules: { form_checkin_required: true } },
    [CB]: {},
  };
  __mock.setDefault('clients', (chain) => ({ data: { id: chain.eqs.id, settings: CLIENT_SETTINGS[String(chain.eqs.id)] ?? {} } }));
  __mock.setDefault('builder_questions', { data: [] });
  __mock.setDefault('form_responses', { data: [] });
  __mock.setDefault('form_submissions', (chain) => {
    const ins = chain.ops.find((o) => o.method === 'insert');
    return { data: ins ? { id: 'sub-1', ...(ins.args[0] as object) } : [] };
  });
  __mock.setDefault('builder_submissions', (chain) => {
    const ins = chain.ops.find((o) => o.method === 'insert');
    return { data: ins ? { id: 'bsub-1', ...(ins.args[0] as object) } : [] };
  });
  setUser(repA);
});

describe('POST /forms/submit', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    template_id: FORM_ID, latitude: 13.08, longitude: 80.27, responses: [], ...over,
  });

  it('stores a good pair as sent (ISO) with the minutes spent', async () => {
    const res = await request(app).post('/forms/submit').send(body({
      check_in_at: ago(30), check_out_at: ago(12), check_in_gps: '13.08,80.27', check_out_gps: '13.09,80.28',
    }));
    expect(res.status).toBe(201);
    const row = inserts('form_submissions')[0];
    expect(Math.abs(Date.parse(row.check_in_at) - Date.parse(ago(30)))).toBeLessThan(2000);
    expect(row.duration_minutes).toBe(18);
    expect(row.check_in_gps).toBe('13.08,80.27');
    expect(row.check_out_gps).toBe('13.09,80.28');
  });

  it('never rejects: a garbage timestamp is stored as null and the submission still succeeds', async () => {
    const res = await request(app).post('/forms/submit').send(body({ check_in_at: 'not a time', check_out_at: ago(1) }));
    expect(res.status).toBe(201);
    const row = inserts('form_submissions')[0];
    expect(row.check_in_at).toBeNull();
    expect(row.duration_minutes).toBeNull();
  });

  it('clamps a check-out more than 5 minutes ahead to server time', async () => {
    const res = await request(app).post('/forms/submit').send(body({ check_in_at: ago(10), check_out_at: ahead(120) }));
    expect(res.status).toBe(201);
    const row = inserts('form_submissions')[0];
    expect(closeToNow(row.check_out_at)).toBe(true);
    expect(row.duration_minutes).toBe(10);
  });

  it('keeps both stamps and stores no duration when check-out precedes check-in', async () => {
    const res = await request(app).post('/forms/submit').send(body({ check_in_at: ago(5), check_out_at: ago(25) }));
    expect(res.status).toBe(201);
    const row = inserts('form_submissions')[0];
    expect(row.check_in_at).toBeTruthy();
    expect(row.check_out_at).toBeTruthy();
    expect(row.duration_minutes).toBeNull();
  });

  it('form_checkin_required client: a check-in without a check-out is closed at server now', async () => {
    const res = await request(app).post('/forms/submit').send(body({ check_in_at: ago(14) }));
    expect(res.status).toBe(201);
    const row = inserts('form_submissions')[0];
    expect(closeToNow(row.check_out_at)).toBe(true);
    expect(row.duration_minutes).toBe(14);
  });

  it('a client without the rule is unchanged: no check-out is invented', async () => {
    setUser(repB);
    const res = await request(app).post('/forms/submit').send(body({ check_in_at: ago(14) }));
    expect(res.status).toBe(201);
    const row = inserts('form_submissions')[0];
    expect(row.check_out_at).toBeNull();
    expect(row.duration_minutes).toBeNull();
  });

  it('a submission with no visit times at all stores nulls (old app builds)', async () => {
    setUser(repB);
    const res = await request(app).post('/forms/submit').send(body());
    expect(res.status).toBe(201);
    const row = inserts('form_submissions')[0];
    expect(row).toMatchObject({ check_in_at: null, check_out_at: null, duration_minutes: null, template_id: FORM_ID });
  });

  it('the client rule is only looked up when it can matter (a check-in with no check-out)', async () => {
    // (a fix is attached, so the unrelated require_location_for_forms flag is not consulted either)
    await request(app).post('/forms/submit').send(body({ check_in_at: ago(10), check_out_at: ago(2) }));
    expect(__mock.chainsFor('clients')).toHaveLength(0);
    await request(app).post('/forms/submit').send(body({ check_in_at: ago(10) }));
    expect(__mock.chainsFor('clients').length).toBeGreaterThan(0);
  });
});

describe('POST /builder/forms/:id/submissions', () => {
  const url = `/builder/forms/${FORM_ID}/submissions`;
  const body = (over: Record<string, unknown> = {}) => ({ answers: { q1: 'x' }, location_lat: 13.08, location_lng: 80.27, ...over });

  it('stores a good pair with the minutes spent', async () => {
    const res = await request(app).post(url).send(body({ check_in_at: ago(40), check_out_at: ago(10), check_in_gps: '13.08,80.27' }));
    expect(res.status).toBe(201);
    const row = inserts('builder_submissions')[0];
    expect(row.duration_minutes).toBe(30);
    expect(row.check_in_gps).toBe('13.08,80.27');
    expect(row.form_id).toBe(FORM_ID);
  });

  it('sanitises instead of rejecting', async () => {
    const res = await request(app).post(url).send(body({ check_in_at: 'junk', check_out_at: ahead(600) }));
    expect(res.status).toBe(201);
    const row = inserts('builder_submissions')[0];
    expect(row.check_in_at).toBeNull();
    expect(closeToNow(row.check_out_at)).toBe(true);
    expect(row.duration_minutes).toBeNull();
  });

  it('form_checkin_required client: closes an open visit at server now; others are unchanged', async () => {
    await request(app).post(url).send(body({ check_in_at: ago(9) }));
    const a = inserts('builder_submissions')[0];
    expect(closeToNow(a.check_out_at)).toBe(true);
    expect(a.duration_minutes).toBe(9);

    __mock.reset();
    __mock.setDefault('builder_questions', { data: [] });
    __mock.setDefault('builder_submissions', (chain) => ({ data: chain.ops.find((o) => o.method === 'insert') ? { id: 'b2' } : [] }));
    __mock.setDefault('clients', (chain) => ({ data: { id: chain.eqs.id, settings: CLIENT_SETTINGS[String(chain.eqs.id)] ?? {} } }));
    clearClientFlagCache();
    setUser(repB);
    await request(app).post(url).send(body({ check_in_at: ago(9) }));
    const b = inserts('builder_submissions')[0];
    expect(b.check_out_at).toBeNull();
    expect(b.duration_minutes).toBeNull();
  });
});

describe('GET /forms/admin/submissions exposes the visit fields on every row', () => {
  const admin = { id: '11111111-1111-4111-8111-111111111111', org_id: ORG, role: 'admin', client_id: CA, name: 'Meera', email: 'meera@client.test' };

  it('both tables, old rows get a computed duration, rows without visit data get nulls', async () => {
    setUser(admin);
    const submitted_at = '2026-10-09T05:00:00+00:00';
    __mock.setDefault('form_submissions', {
      data: [
        { id: 'f-old', submitted_at, user_id: REP, check_in_at: '2026-10-09T04:30:00+00:00', check_out_at: '2026-10-09T04:50:00+00:00', duration_minutes: null, check_in_gps: '13.0,80.2', check_out_gps: '13.1,80.3' },
        { id: 'f-new', submitted_at, user_id: REP, check_in_at: '2026-10-09T04:00:00+00:00', check_out_at: '2026-10-09T04:09:00+00:00', duration_minutes: 9 },
        { id: 'f-none', submitted_at, user_id: REP },
      ],
      count: 3,
    });
    __mock.setDefault('builder_submissions', {
      data: [{ id: 'b-open', submitted_at, user_id: REP, check_in_at: '2026-10-09T04:00:00+00:00', check_out_at: null }],
      count: 1,
    });
    const res = await request(app).get('/forms/admin/submissions?date_from=2026-10-09');
    expect(res.status).toBe(200);
    const rows: any[] = res.body.data.data ?? res.body.data.items ?? res.body.data;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    for (const id of ['f-old', 'f-new', 'f-none', 'b-open']) {
      for (const k of ['check_in_at', 'check_out_at', 'check_in_gps', 'check_out_gps', 'duration_minutes']) {
        expect({ id, k, present: k in byId[id] }).toEqual({ id, k, present: true });
      }
    }
    expect(byId['f-old']).toMatchObject({ duration_minutes: 20, check_in_gps: '13.0,80.2', check_out_gps: '13.1,80.3' });
    expect(byId['f-new'].duration_minutes).toBe(9);
    expect(byId['f-none']).toMatchObject({ check_in_at: null, check_out_at: null, check_in_gps: null, check_out_gps: null, duration_minutes: null });
    expect(byId['b-open']).toMatchObject({ check_out_at: null, duration_minutes: null, type: 'builder' });
  });
});
