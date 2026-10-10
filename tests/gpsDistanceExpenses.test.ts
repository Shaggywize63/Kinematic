/**
 * Claim the day's distance from GPS (expense-policy rule `gps_distance`) and the rejection notification.
 *
 *   - the rule itself: normalised like odometer_camera_only, returned to the apps, saved through the
 *     policy API, kept when an older editor omits it;
 *   - a mileage line with a vehicle, a distance and NO odometer data is checked against the GPS travel
 *     service when saved (allowed = serverKm x 1.10 + 0.5), priced at the vehicle's rate by the server,
 *     and de-duplicated per user + date across live claims;
 *   - odometer lines, and every line under a policy without the rule, behave exactly as before;
 *   - decide(): a rejection's notification data carries the reason, claim_no and decision.
 *
 * The travel maths is tests/travel.test.ts; here the travel service is replaced by a stub.
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/ai.service', () => ({
  AIService: { callKiniAI: jest.fn().mockRejectedValue(new Error('no model in tests')) },
}));
jest.mock('../src/services/travel.store', () => ({ dayTravel: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dayTravel } = require('../src/services/travel.store') as { dayTravel: jest.Mock };
import * as policy from '../src/services/expenses/policy.service';
import * as svc from '../src/services/expenses/expenses.service';
import * as va from '../src/services/expenses/vehicleAllowance';
import { reconcileGpsKm, allowedGpsKm } from '../src/services/expenses/gpsDistance';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const expensesRouter = require('../src/routes/expenses.routes').default as express.Router;

const ORG = '00000000-0000-0000-0000-0000000000aa';
const REP = '11111111-1111-1111-1111-111111111111';
const BOSS = '22222222-2222-2222-2222-222222222222';
const CLAIM = '44444444-4444-4444-4444-444444444444';
const POLICY_ID = '55555555-5555-5555-5555-555555555555';
const DATE = '2026-10-06';
const asRep = { id: REP, org_id: ORG, client_id: null, role: 'executive', name: 'Asha', data_scope: 'own' } as any;
const asBoss = { id: BOSS, org_id: ORG, role: 'supervisor', client_id: null, data_scope: 'team' } as any;

const RATES = [
  { id: 'bike', label: 'Bike', rate_per_km: 4 },
  { id: 'car', label: 'Car', rate_per_km: 9.5 },
];
const rulesOf = (o: any = {}) => policy.normalizeRules(o);
const pol = (o: Partial<policy.ExpensePolicy> = {}): policy.ExpensePolicy => ({ ...policy.BUILT_IN_POLICY, name: 'Test policy', ...o });
const GPS_POLICY = () => pol({ rules: rulesOf({ vehicle_rates: RATES, gps_distance: true }) });
const photo = (n: string) => `https://x.test/storage/v1/object/public/kinematic-receipts/${ORG}/${REP}/${n}.jpg`;
const gpsLine = (over: any = {}) => ({ category: 'mileage', item_date: DATE, vehicle_type: 'bike', distance_km: 20, from_location: 'Office', to_location: 'Plant', ...over });
const odoLine = (over: any = {}) => ({
  category: 'mileage', item_date: DATE, vehicle_type: 'bike', odometer_start: 1000, odometer_end: 1042.5,
  odometer_start_photo_url: photo('a'), odometer_end_photo_url: photo('b'), ...over,
});
const travel = (total_km: number) => ({ date: DATE, user_id: REP, attendance_id: 'att-1', total_km, method: 'gps_trail', legs: [], stops: [] });

// ── the rule ────────────────────────────────────────────────────────────────
describe('policy rule gps_distance', () => {
  it('defaults to false and is on only for a real boolean true', () => {
    expect(rulesOf().gps_distance).toBe(false);
    expect(rulesOf({ gps_distance: true }).gps_distance).toBe(true);
    for (const bad of ['true', 1, 'yes', null, undefined, {}]) expect(rulesOf({ gps_distance: bad }).gps_distance).toBe(false);
  });

  it('survives re-normalising its own output', () => {
    const once = rulesOf({ vehicle_rates: RATES, gps_distance: true });
    expect(rulesOf(once)).toEqual(once);
  });

  it('is in the policy the apps read (data.rules)', () => {
    expect(policy.toClientShape(GPS_POLICY()).rules.gps_distance).toBe(true);
    expect(policy.toClientShape(pol()).rules.gps_distance).toBe(false);
    expect(policy.toClientShape(policy.BUILT_IN_POLICY).rules).toHaveProperty('gps_distance', false);
  });

  it('is kept when an older editor saves rules without it, and replaced when the editor sends it', () => {
    const stored = rulesOf({ vehicle_rates: RATES, gps_distance: true });
    expect(policy.mergeUiRuleKeys({ mileage_rate: 9 }, stored).gps_distance).toBe(true);
    expect(policy.mergeUiRuleKeys({ mileage_rate: 9, gps_distance: false }, stored).gps_distance).toBe(false);
    expect(policy.mergeUiRuleKeys({ mileage_rate: 9, gps_distance: true }, rulesOf()).gps_distance).toBe(true);
    // the presentation keys are still kept as before
    expect(policy.PRESERVED_RULE_KEYS).toEqual(expect.arrayContaining([...policy.UI_RULE_KEYS, 'gps_distance']));
    expect(policy.UI_RULE_KEYS).not.toContain('gps_distance');
  });

  it('is in the presets as false', () => {
    for (const p of policy.policyPresets()) expect(p.rules.gps_distance).toBe(false);
  });
});

describe('the policy API accepts and persists gps_distance', () => {
  const asAdmin = { id: '33333333-3333-3333-3333-333333333333', org_id: ORG, role: 'admin', client_id: null, data_scope: 'all' } as any;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = req.headers['x-role'] === 'rep' ? { ...asAdmin, id: REP, role: 'executive' } : asAdmin; next(); });
  app.use('/expenses', expensesRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message, code: err.code }));

  const updates = () => __mock.chainsFor('expense_policies').flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any));

  beforeEach(() => {
    __mock.reset();
    __mock.setDefault('expense_policies', { data: [{
      id: POLICY_ID, org_id: ORG, client_id: null, name: 'Agri policy', is_active: true, priority: 100, currency: 'INR',
      applies_to: { everyone: true }, deleted_at: null, rules: rulesOf({ vehicle_rates: RATES, gps_distance: true }),
    }] });
    __mock.setDefault('users', { data: [{ id: REP, role: 'executive', org_role_id: null, name: 'Asha' }] });
  });

  it('PUT /policies/:id stores gps_distance:true and the apps get it from GET /policy', async () => {
    const res = await request(app).put(`/expenses/policies/${POLICY_ID}`).send({ rules: { vehicle_rates: RATES, gps_distance: true } });
    expect(res.status).toBe(200);
    expect(updates()[0].rules.gps_distance).toBe(true);
    const mine = await request(app).get('/expenses/policy').set('x-role', 'rep');
    expect(mine.body.data.rules.gps_distance).toBe(true);
  });

  it('PUT with gps_distance:false turns it off; an old-style body keeps what is stored', async () => {
    await request(app).put(`/expenses/policies/${POLICY_ID}`).send({ rules: { gps_distance: false } });
    expect(updates()[0].rules.gps_distance).toBe(false);
    __mock.reset();
    __mock.setDefault('expense_policies', { data: [{
      id: POLICY_ID, org_id: ORG, client_id: null, name: 'Agri policy', is_active: true, priority: 100, currency: 'INR',
      applies_to: { everyone: true }, deleted_at: null, rules: rulesOf({ vehicle_rates: RATES, gps_distance: true }),
    }] });
    const res = await request(app).put(`/expenses/policies/${POLICY_ID}`).send({ rules: { mileage_rate: 10 } });
    expect(res.status).toBe(200);
    expect(updates()[0].rules.gps_distance).toBe(true);
  });

  it('refuses a non-boolean gps_distance', async () => {
    const res = await request(app).put(`/expenses/policies/${POLICY_ID}`).send({ rules: { gps_distance: 'yes' } });
    expect(res.status).toBe(400);
  });

  it('POST /policies creates one with it', async () => {
    const res = await request(app).post('/expenses/policies').send({ name: 'GPS', rules: { vehicle_rates: RATES, gps_distance: true } });
    expect(res.status).toBe(201);
    const insert = __mock.chainsFor('expense_policies').flatMap((c) => c.ops.filter((o) => o.method === 'insert').map((o) => o.args[0] as any))[0];
    expect(insert.rules.gps_distance).toBe(true);
  });
});

// ── the pure reconciliation ─────────────────────────────────────────────────
describe('reconcileGpsKm: allowed = serverKm x 1.10 + 0.5', () => {
  it('allowedGpsKm', () => {
    expect(allowedGpsKm(0)).toBeCloseTo(0.5, 10);
    expect(allowedGpsKm(20)).toBeCloseTo(22.5, 10);
  });

  it('keeps a claim at or under what the server measured, or within the allowance', () => {
    expect(reconcileGpsKm(18, 20, DATE)).toEqual({ km: 18, clamped: false });
    expect(reconcileGpsKm(20, 20, DATE)).toEqual({ km: 20, clamped: false });
    expect(reconcileGpsKm(22.5, 20, DATE)).toEqual({ km: 22.5, clamped: false });          // exactly the limit
    expect(reconcileGpsKm(12.345, 12, DATE)).toEqual({ km: 12.35, clamped: false });       // rounded to 2 dp
  });

  it('replaces a claim over the allowance with the measured distance', () => {
    expect(reconcileGpsKm(22.51, 20, DATE)).toEqual({ km: 20, clamped: true });
    expect(reconcileGpsKm(500, 23.456, DATE)).toEqual({ km: 23.46, clamped: true });
  });

  it('refuses a real distance when nothing was recorded, and tolerates up to 0.5 km', () => {
    expect(() => reconcileGpsKm(5, 0, DATE)).toThrow('No GPS travel recorded for 2026-10-06');
    try { reconcileGpsKm(5, 0, DATE); } catch (e: any) { expect(e).toMatchObject({ statusCode: 400, code: 'NO_GPS_TRAVEL' }); }
    expect(reconcileGpsKm(0.5, 0, DATE)).toEqual({ km: 0.5, clamped: false });
    expect(() => reconcileGpsKm(0.51, 0, DATE)).toThrow(/No GPS travel recorded/);
  });
});

// ── which lines are GPS-distance lines ──────────────────────────────────────
describe('isGpsDistanceLine', () => {
  const R = rulesOf({ vehicle_rates: RATES, gps_distance: true });

  it('a mileage line with a known vehicle and a distance, and no odometer data', () => {
    expect(va.isGpsDistanceLine(gpsLine(), R)).toBe(true);
  });

  it('never when the policy has not opted in, has no vehicle rates, or the line is not mileage', () => {
    expect(va.isGpsDistanceLine(gpsLine(), rulesOf({ vehicle_rates: RATES }))).toBe(false);
    expect(va.isGpsDistanceLine(gpsLine(), rulesOf({ gps_distance: true }))).toBe(false);
    expect(va.isGpsDistanceLine(gpsLine({ category: 'food' }), R)).toBe(false);
    expect(va.isGpsDistanceLine(gpsLine(), null)).toBe(false);
  });

  it('needs a vehicle that exists in the rates (a blank one is the sole vehicle, as elsewhere)', () => {
    expect(va.isGpsDistanceLine(gpsLine({ vehicle_type: 'rocket' }), R)).toBe(false);
    expect(va.isGpsDistanceLine(gpsLine({ vehicle_type: null }), R)).toBe(false);                    // two vehicles: rep must pick
    expect(va.isGpsDistanceLine(gpsLine({ vehicle_type: '' }), rulesOf({ vehicle_rates: [RATES[0]], gps_distance: true }))).toBe(true);
  });

  it('needs a positive distance', () => {
    for (const d of [0, null, undefined, -3, 'abc']) expect(va.isGpsDistanceLine(gpsLine({ distance_km: d }), R)).toBe(false);
    expect(va.isGpsDistanceLine(gpsLine({ distance_km: '12.5' }), R)).toBe(true);
  });

  it('any odometer reading or photo makes it an odometer line', () => {
    expect(va.isGpsDistanceLine(gpsLine({ odometer_start: 1000 }), R)).toBe(false);
    expect(va.isGpsDistanceLine(gpsLine({ odometer_end: 1010 }), R)).toBe(false);
    expect(va.isGpsDistanceLine(gpsLine({ odometer_start_photo_url: photo('a') }), R)).toBe(false);
    expect(va.isGpsDistanceLine(gpsLine({ odometer_end_photo_url: photo('b') }), R)).toBe(false);
    // explicit nulls / blanks are "no odometer data"
    expect(va.isGpsDistanceLine(gpsLine({ odometer_start: null, odometer_end: null, odometer_start_photo_url: '', odometer_end_photo_url: null }), R)).toBe(true);
  });

  it('priceGpsLine: distance x the vehicle rate, odometer cleared, never the client\'s amount', () => {
    const out: any = va.priceGpsLine({ ...gpsLine(), amount: 99999 }, RATES, 21.456);
    expect(out).toMatchObject({ distance_km: 21.46, amount: 85.84, vehicle_type: 'bike', odometer_start: null, odometer_end: null, odometer_start_photo_url: null, odometer_end_photo_url: null });
    expect(va.priceGpsLine(gpsLine({ vehicle_type: 'car' }), RATES, 10).amount).toBe(95);
    expect((va.priceGpsLine(gpsLine({ vehicle_type: '' }), [RATES[0]], 10) as any).vehicle_type).toBe('bike');
  });
});

describe('policy evaluation of GPS-distance lines', () => {
  const today = new Date().toISOString().slice(0, 10);
  const line = { id: 'l1', category: 'mileage', item_date: today, vehicle_type: 'bike', distance_km: 20, amount: 80 };

  it('a GPS line has no odometer problems', () => {
    const v = policy.evaluateAgainstPolicy(GPS_POLICY(), [line]).violations;
    expect(v.filter((x) => x.blocking)).toEqual([]);
    expect(v.some((x) => /odometer/.test(x.code))).toBe(false);
  });

  it('the very same line under a policy without gps_distance is still blocked for its odometer', () => {
    const v = policy.evaluateAgainstPolicy(pol({ rules: rulesOf({ vehicle_rates: RATES }) }), [line]).violations;
    expect(v.map((x) => x.code)).toEqual(expect.arrayContaining(['odometer_missing', 'odometer_photo_missing']));
    expect(v.filter((x) => x.blocking).length).toBeGreaterThan(0);
  });

  it('a line with odometer data under a gps_distance policy is judged as an odometer line', () => {
    const v = policy.evaluateAgainstPolicy(GPS_POLICY(), [{ ...line, odometer_start: 1000 }]).violations;
    expect(v.map((x) => x.code)).toEqual(expect.arrayContaining(['odometer_missing']));
  });
});

// ── the claim service ───────────────────────────────────────────────────────
const updatesOf = (table: string) =>
  __mock.chainsFor(table).flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any));
const insertsOf = (table: string) =>
  __mock.chainsFor(table).flatMap((c) => c.ops.filter((o) => o.method === 'insert').map((o) => o.args[0] as any));

function arrange(p: policy.ExpensePolicy, claim: any, items: any[] = []) {
  __mock.setDefault('expense_policies', { data: [{ ...p, id: 'p1', client_id: null, rules: p.rules, applies_to: p.applies_to, is_active: true, deleted_at: null }] });
  __mock.setDefault('expense_claims', { data: [claim] });
  __mock.setDefault('expense_claim_items', { data: items });
  __mock.setDefault('expense_approvals', { data: [] });
  __mock.setDefault('users', { data: [{ id: REP, supervisor_id: BOSS, role: 'executive', org_role_id: null, name: 'Asha' }, { id: BOSS, supervisor_id: null, role: 'executive', org_role_id: null, name: 'Boss' }] });
  __mock.setDefault('notifications', { data: [] });
}
const draft = (over: any = {}) => ({ id: CLAIM, org_id: ORG, user_id: REP, status: 'draft', claim_no: 'EXP-1', currency: 'INR', total_amount: 0, submit_count: 0, ...over });
/** An existing line of someone's claim, as the de-dupe query returns it (with its embedded claim). */
const existing = (over: any = {}, claim: any = {}) => ({
  id: 'old-1', claim_id: 'other-claim', item_date: DATE, vehicle_type: 'bike',
  odometer_start: null, odometer_end: null, odometer_start_photo_url: null, odometer_end_photo_url: null,
  claim: { claim_no: 'EXP-77', status: 'submitted', user_id: REP, org_id: ORG, ...claim }, ...over,
});

beforeEach(() => {
  __mock.reset();
  va._resetOdometerProbe();
  dayTravel.mockReset();
  dayTravel.mockResolvedValue(travel(20));
});

describe('saving a GPS-distance line', () => {
  it('stores the rep\'s distance when it is within the allowance, priced by the server at the vehicle\'s rate', async () => {
    arrange(GPS_POLICY(), draft());
    await svc.createClaim(asRep, { items: [gpsLine({ distance_km: 21, amount: 99999 }) as any] });
    expect(dayTravel).toHaveBeenCalledWith(REP, DATE, { orgId: ORG });
    const row = insertsOf('expense_claim_items')[0][0];
    expect(row).toMatchObject({ category: 'mileage', vehicle_type: 'bike', distance_km: 21, amount: 84 });
    expect(row.odometer_start).toBeNull();
    expect(row.odometer_end).toBeNull();
    expect(row.odometer_start_photo_url).toBeNull();
    expect(row.odometer_end_photo_url).toBeNull();
    expect(insertsOf('expense_claims')[0]).toMatchObject({ total_amount: 84, distance_km: 21, status: 'draft' });
  });

  it('replaces a distance over the allowance with the measured one', async () => {
    arrange(GPS_POLICY(), draft());
    await svc.createClaim(asRep, { items: [gpsLine({ distance_km: 60 }) as any] });
    expect(insertsOf('expense_claim_items')[0][0]).toMatchObject({ distance_km: 20, amount: 80 });
  });

  it('never lets the client type the amount, and prices each line at its own vehicle', async () => {
    arrange(GPS_POLICY(), draft());
    dayTravel.mockImplementation(async (_u: string, d: string) => travel(d === DATE ? 20 : 10));
    await svc.createClaim(asRep, { items: [gpsLine({ amount: 1 }) as any, gpsLine({ item_date: '2026-10-07', vehicle_type: 'car', distance_km: 10, amount: 0 }) as any] });
    const rows = insertsOf('expense_claim_items')[0];
    expect(rows.map((r: any) => [r.item_date, r.vehicle_type, r.distance_km, r.amount])).toEqual([[DATE, 'bike', 20, 80], ['2026-10-07', 'car', 10, 95]]);
  });

  it('refuses a distance when the GPS recorded nothing that day (400), and saves nothing', async () => {
    arrange(GPS_POLICY(), draft());
    dayTravel.mockResolvedValue(travel(0));
    await expect(svc.createClaim(asRep, { items: [gpsLine({ distance_km: 12 }) as any] }))
      .rejects.toMatchObject({ statusCode: 400, code: 'NO_GPS_TRAVEL', message: 'No GPS travel recorded for 2026-10-06' });
    expect(insertsOf('expense_claims')).toHaveLength(0);
    expect(insertsOf('expense_claim_items')).toHaveLength(0);
  });

  it('still saves a half-kilometre line on a day with no recorded travel', async () => {
    arrange(GPS_POLICY(), draft());
    dayTravel.mockResolvedValue(travel(0));
    await svc.createClaim(asRep, { items: [gpsLine({ distance_km: 0.4 }) as any] });
    expect(insertsOf('expense_claim_items')[0][0]).toMatchObject({ distance_km: 0.4, amount: 1.6 });
  });

  it('a line with no vehicle under a one-vehicle policy takes that vehicle', async () => {
    arrange(pol({ rules: rulesOf({ vehicle_rates: [RATES[0]], gps_distance: true }) }), draft());
    await svc.createClaim(asRep, { items: [gpsLine({ vehicle_type: '' }) as any] });
    expect(insertsOf('expense_claim_items')[0][0]).toMatchObject({ vehicle_type: 'bike', distance_km: 20, amount: 80 });
  });

  it('needs the date of the trip', async () => {
    arrange(GPS_POLICY(), draft());
    await expect(svc.createClaim(asRep, { items: [gpsLine({ item_date: null }) as any] })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
    expect(dayTravel).not.toHaveBeenCalled();
  });

  it('does not save a made-up number when the travel service is down (503)', async () => {
    arrange(GPS_POLICY(), draft());
    dayTravel.mockRejectedValue(new Error('db down'));
    await expect(svc.createClaim(asRep, { items: [gpsLine() as any] })).rejects.toMatchObject({ statusCode: 503, code: 'TRAVEL_UNAVAILABLE' });
    expect(insertsOf('expense_claims')).toHaveLength(0);
  });

  it('is refused cleanly on a database without the vehicle column', async () => {
    arrange(GPS_POLICY(), draft());
    __mock.setDefault('expense_claim_items', { data: null, error: { message: 'column expense_claim_items.vehicle_type does not exist' } });
    await expect(svc.createClaim(asRep, { items: [gpsLine() as any] })).rejects.toMatchObject({ code: 'ODOMETER_NOT_ENABLED' });
    expect(dayTravel).not.toHaveBeenCalled();
  });

  it('a line WITH odometer data behaves as today: priced from the readings, no GPS check', async () => {
    arrange(GPS_POLICY(), draft());
    await svc.createClaim(asRep, { items: [odoLine({ amount: 99999, distance_km: 5000 }) as any] });
    expect(dayTravel).not.toHaveBeenCalled();
    expect(insertsOf('expense_claim_items')[0][0]).toMatchObject({ odometer_start: 1000, odometer_end: 1042.5, distance_km: 42.5, amount: 170 });
  });

  it('non-mileage lines are untouched', async () => {
    arrange(GPS_POLICY(), draft());
    await svc.createClaim(asRep, { items: [{ category: 'food', amount: 100 } as any] });
    expect(dayTravel).not.toHaveBeenCalled();
    expect(insertsOf('expense_claim_items')[0][0]).toMatchObject({ category: 'food', amount: 100 });
  });

  it('a policy WITHOUT gps_distance is byte-for-byte as before: the same line is not GPS-checked and is not priced', async () => {
    arrange(pol({ rules: rulesOf({ vehicle_rates: RATES }) }), draft());
    await svc.createClaim(asRep, { items: [gpsLine({ amount: 99999 }) as any] });
    expect(dayTravel).not.toHaveBeenCalled();
    const row = insertsOf('expense_claim_items')[0][0];
    expect(row).toMatchObject({ vehicle_type: 'bike', distance_km: null, amount: 0 });
    expect(Object.keys(row)).not.toContain('odometer_start');
  });

  it('a policy with gps_distance but no vehicle rates is as before too', async () => {
    arrange(pol({ rules: rulesOf({ gps_distance: true, mileage_rate: 10 }) }), draft());
    await svc.createClaim(asRep, { items: [{ category: 'mileage', distance_km: 20, item_date: DATE } as any] });
    expect(dayTravel).not.toHaveBeenCalled();
    expect(insertsOf('expense_claim_items')[0][0].amount).toBe(200);
  });
});

describe('one GPS claim per person per date', () => {
  it('a second GPS line for a date already on a live claim is a 409 naming that claim', async () => {
    arrange(GPS_POLICY(), draft(), [existing()]);
    await expect(svc.createClaim(asRep, { items: [gpsLine() as any] }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TRAVEL_ALREADY_CLAIMED', message: 'Travel for 2026-10-06 is already claimed on EXP-77' });
    expect(dayTravel).not.toHaveBeenCalled();
    expect(insertsOf('expense_claims')).toHaveLength(0);
  });

  it('counts a draft, submitted, approved or reimbursed claim; ignores a cancelled or rejected one', async () => {
    for (const status of ['draft', 'submitted', 'approved', 'reimbursed']) {
      __mock.reset();
      arrange(GPS_POLICY(), draft(), [existing({}, { status })]);
      await expect(svc.createClaim(asRep, { items: [gpsLine() as any] })).rejects.toMatchObject({ statusCode: 409 });
    }
    for (const status of ['cancelled', 'rejected']) {
      __mock.reset();
      arrange(GPS_POLICY(), draft(), [existing({}, { status })]);
      await svc.createClaim(asRep, { items: [gpsLine() as any] });
      expect(insertsOf('expense_claims')).toHaveLength(1);
    }
  });

  it('only the same person, the same date, and only GPS lines count', async () => {
    const cases: Array<[string, any]> = [
      ['someone else\'s claim', existing({}, { user_id: BOSS })],
      ['another date', existing({ item_date: '2026-10-05' })],
      ['an odometer line', existing({ odometer_start: 100, odometer_end: 140 })],
      ['an odometer photo only', existing({ odometer_start_photo_url: photo('a') })],
      ['a flat-rate mileage line (no vehicle)', existing({ vehicle_type: null })],
    ];
    for (const [label, row] of cases) {
      __mock.reset();
      arrange(GPS_POLICY(), draft(), [row]);
      await svc.createClaim(asRep, { items: [gpsLine() as any] });
      expect({ label, saved: insertsOf('expense_claims').length }).toEqual({ label, saved: 1 });
    }
  });

  it('two GPS lines for the same date in one request are refused as well', async () => {
    arrange(GPS_POLICY(), draft());
    await expect(svc.createClaim(asRep, { items: [gpsLine() as any, gpsLine({ distance_km: 5 }) as any] }))
      .rejects.toMatchObject({ statusCode: 409, message: 'Travel for 2026-10-06 is already claimed on this claim' });
    expect(insertsOf('expense_claims')).toHaveLength(0);
  });

  it('the lookup is scoped to the caller, their org, and live claims', async () => {
    arrange(GPS_POLICY(), draft());
    await svc.createClaim(asRep, { items: [gpsLine() as any] });
    const q = __mock.chainsFor('expense_claim_items').find((c) => c.ops.some((o) => o.method === 'in' && o.args[0] === 'item_date'))!;
    expect(q.eqs).toMatchObject({ org_id: ORG, 'claim.org_id': ORG, 'claim.user_id': REP, category: 'mileage' });
    const neq = q.ops.filter((o) => o.method === 'neq').map((o) => `${o.args[0]}:${o.args[1]}`);
    expect(neq).toEqual(expect.arrayContaining(['claim.status:cancelled', 'claim.status:rejected']));
  });

  it('editing the claim that already holds the date does not conflict with itself', async () => {
    const own = { id: 'l1', claim_id: CLAIM, item_date: DATE, vehicle_type: 'bike', distance_km: 20, amount: 80, category: 'mileage' };
    arrange(GPS_POLICY(), draft(), [{ ...own, claim: { claim_no: 'EXP-1', status: 'draft', user_id: REP, org_id: ORG } }]);
    await svc.updateClaim(asRep, CLAIM, { items: [{ ...gpsLine({ distance_km: 19 }), id: 'l1' } as any] });
    expect(updatesOf('expense_claim_items')[0]).toMatchObject({ distance_km: 19, amount: 76, vehicle_type: 'bike', odometer_start: null });
    const q = __mock.chainsFor('expense_claim_items').find((c) => c.ops.some((o) => o.method === 'in' && o.args[0] === 'item_date'))!;
    expect(q.ops.some((o) => o.method === 'neq' && o.args[0] === 'claim_id' && o.args[1] === CLAIM)).toBe(true);
  });

  it('but another claim holding the date still blocks an edit', async () => {
    arrange(GPS_POLICY(), draft(), [existing()]);
    await expect(svc.updateClaim(asRep, CLAIM, { items: [gpsLine() as any] })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('updateClaim re-measures: an edit that inflates the distance is cut back to the measured one', async () => {
    arrange(GPS_POLICY(), draft());
    await svc.updateClaim(asRep, CLAIM, { items: [gpsLine({ distance_km: 80 }) as any] });
    expect(insertsOf('expense_claim_items')[0]).toMatchObject({ distance_km: 20, amount: 80 });
  });

  it('a line turned from odometer to GPS clears the stale readings', async () => {
    arrange(GPS_POLICY(), draft(), [{ id: 'l1', claim_id: CLAIM, ...odoLine(), distance_km: 42.5, amount: 170 }]);
    await svc.updateClaim(asRep, CLAIM, { items: [{ ...gpsLine({ distance_km: 20 }), id: 'l1' } as any] });
    expect(updatesOf('expense_claim_items')[0]).toMatchObject({
      distance_km: 20, amount: 80, odometer_start: null, odometer_end: null, odometer_start_photo_url: null, odometer_end_photo_url: null,
    });
  });
});

describe('previewing and submitting GPS-distance lines', () => {
  const today = new Date().toISOString().slice(0, 10);
  const saved = (over: any = {}) => ({ id: 'l1', claim_id: CLAIM, category: 'mileage', item_date: today, vehicle_type: 'bike', distance_km: 21, amount: 84, ...over });

  it('checkClaim previews it at the sent distance and raises no odometer problem (and does not call the travel service)', async () => {
    arrange(GPS_POLICY(), draft());
    const r: any = await svc.checkClaim(asRep, { items: [gpsLine({ item_date: today, amount: 1 }) as any] });
    expect(dayTravel).not.toHaveBeenCalled();
    expect(r.total).toBe(80);
    expect(r.blocking).toBe(false);
    expect(r.violations.some((v: any) => /odometer/.test(v.code))).toBe(false);
  });

  it('submitClaim lets a GPS line through without odometer data and keeps its measured distance', async () => {
    arrange(GPS_POLICY(), draft(), [saved()]);
    await svc.submitClaim(asRep, CLAIM);
    expect(updatesOf('expense_claims').find((u) => u.status === 'submitted')).toBeDefined();
    // not wiped like an odometer-less line would be
    expect(updatesOf('expense_claim_items').some((u) => u.distance_km === null || u.amount === 0)).toBe(false);
  });

  it('submitClaim re-prices a GPS line at the vehicle\'s current rate (distance unchanged)', async () => {
    arrange(GPS_POLICY(), draft(), [saved({ amount: 63 })]);                // saved when bikes paid 3/km
    await svc.submitClaim(asRep, CLAIM);
    expect(updatesOf('expense_claim_items').some((u) => u.amount === 84 && !('distance_km' in u))).toBe(true);
  });

  it('the same stored line under a policy without gps_distance is blocked for its odometer, exactly as before', async () => {
    arrange(pol({ rules: rulesOf({ vehicle_rates: RATES }) }), draft(), [saved()]);
    const err: any = await svc.submitClaim(asRep, CLAIM).catch((e) => e);
    expect(err).toBeInstanceOf(svc.PolicyBlockedError);
    expect(err.violations.map((v: any) => v.code)).toContain('odometer_missing');
  });

  it('an odometer line under a gps_distance policy is still blocked while a photo is missing', async () => {
    arrange(GPS_POLICY(), draft(), [saved({ ...odoLine({ odometer_end_photo_url: null }), item_date: today, distance_km: 42.5, amount: 170 })]);
    const err: any = await svc.submitClaim(asRep, CLAIM).catch((e) => e);
    expect(err).toBeInstanceOf(svc.PolicyBlockedError);
    expect(err.violations.map((v: any) => v.code)).toContain('odometer_photo_missing');
  });
});

// ── C6: the rejection notification ──────────────────────────────────────────
describe('decide(): notifying the claimant of a rejection', () => {
  const snapshot = (over: any = {}) => pol({ id: 'p1', name: 'Field rep', rules: rulesOf(over) });
  const submitted = (over: any = {}) => ({
    id: CLAIM, org_id: ORG, user_id: REP, status: 'submitted', claim_no: 'EXP-1042', currency: 'INR', total_amount: 1500,
    approver_id: BOSS, current_level: 1, submit_count: 1, policy_snapshot: snapshot(), ai_summary: 'x', ...over,
  });
  const lines = [
    { id: 'l1', claim_id: CLAIM, category: 'food', amount: 600, item_date: '2026-10-01' },
    { id: 'l2', claim_id: CLAIM, category: 'travel', amount: 900, item_date: '2026-10-02' },
  ];
  const arrangeDecision = (claim: any) => {
    __mock.setDefault('expense_policies', { data: [] });
    __mock.setDefault('expense_claims', { data: [claim] });
    __mock.setDefault('expense_claim_items', { data: lines });
    __mock.setDefault('expense_approvals', { data: [] });
    __mock.setDefault('users', { data: [{ id: BOSS, supervisor_id: null, role: 'executive', org_role_id: null, name: 'Boss' }] });
    __mock.setDefault('notifications', { data: [] });
  };

  it('puts the reason, claim number and decision in the notification data (body unchanged)', async () => {
    arrangeDecision(submitted());
    await svc.decide(asBoss, CLAIM, { decision: 'rejected', note: 'Receipts are unreadable' });
    const n = insertsOf('notifications')[0];
    expect(n).toMatchObject({ user_id: REP, title: 'Expense claim rejected', body: 'EXP-1042 was rejected: Receipts are unreadable' });
    expect(n.data).toEqual({
      kind: 'expense_decision', type: 'expense_decision', claim_id: CLAIM, decision: 'rejected', claim_no: 'EXP-1042', reason: 'Receipts are unreadable',
    });
  });

  it('trims the remark and truncates the reason to 500 characters', async () => {
    arrangeDecision(submitted());
    await svc.decide(asBoss, CLAIM, { decision: 'rejected', note: `  ${'x'.repeat(900)}  ` });
    const n = insertsOf('notifications')[0];
    expect(n.data.reason).toBe('x'.repeat(500));
    expect(typeof n.data.reason).toBe('string');
  });

  it('a claim without a number still carries claim_no as a string', async () => {
    arrangeDecision(submitted({ claim_no: null }));
    await svc.decide(asBoss, CLAIM, { decision: 'rejected', note: 'No' });
    const n = insertsOf('notifications')[0];
    expect(n.data.claim_no).toBe('');
    expect(n.body).toBe('Your claim was rejected: No');
  });

  it('a claim whose every line is rejected is a rejection with the same data', async () => {
    arrangeDecision(submitted());
    await svc.decide(asBoss, CLAIM, {
      decision: 'approved', note: 'Nothing here is claimable',
      items: [{ id: 'l1', decision: 'rejected', note: 'No receipt' }, { id: 'l2', decision: 'rejected', note: 'Duplicate' }],
    });
    const n = insertsOf('notifications')[0];
    expect(n.data).toMatchObject({ decision: 'rejected', reason: 'Nothing here is claimable', claim_no: 'EXP-1042' });
  });

  it('an approval with some lines rejected tells the claimant how many and why (body only)', async () => {
    arrangeDecision(submitted());
    const p: any = await svc.decide(asBoss, CLAIM, { decision: 'approved', items: [{ id: 'l2', decision: 'rejected', note: 'Personal travel' }] });
    expect(p).toMatchObject({ status: 'approved', rejected_lines: 1 });
    const n = insertsOf('notifications')[0];
    expect(n.title).toBe('Expense claim partly approved');
    expect(n.body).toBe('EXP-1042: INR 600 of INR 1500 approved. 1 line(s) rejected — Personal travel.');
    expect(n.data).toEqual({ kind: 'expense_decision', type: 'expense_decision', claim_id: CLAIM, decision: 'approved' });
  });

  it('lists the distinct reasons of several rejected lines', async () => {
    const three = [...lines, { id: 'l3', claim_id: CLAIM, category: 'misc', amount: 100, item_date: '2026-10-03' }, { id: 'l4', claim_id: CLAIM, category: 'toll', amount: 50, item_date: '2026-10-04' }];
    arrangeDecision(submitted({ total_amount: 1650 }));
    __mock.setDefault('expense_claim_items', { data: three });
    await svc.decide(asBoss, CLAIM, {
      decision: 'approved',
      items: [{ id: 'l2', decision: 'rejected', note: 'Personal travel' }, { id: 'l3', decision: 'rejected', note: 'No receipt' }, { id: 'l4', decision: 'rejected', note: 'No receipt' }],
    });
    const n = insertsOf('notifications')[0];
    expect(n.body).toContain('3 line(s) rejected — Personal travel; No receipt.');
  });

  it('a plain approval is unchanged', async () => {
    arrangeDecision(submitted());
    await svc.decide(asBoss, CLAIM, { decision: 'approved' });
    const n = insertsOf('notifications')[0];
    expect(n).toMatchObject({ title: 'Expense claim approved', body: 'EXP-1042 for INR 1500 was approved.' });
    expect(n.data).toEqual({ kind: 'expense_decision', type: 'expense_decision', claim_id: CLAIM, decision: 'approved' });
  });
});
