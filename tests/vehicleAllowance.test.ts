/**
 * Travel allowance by vehicle, with odometer readings.
 *
 * Two layers: the pure rules (pricing, what is missing, what blocks a submit), and the real
 * claim service driven against the Supabase double — asserting the rows it writes, that a
 * policy WITHOUT vehicle rates behaves exactly as before, and that odometer data is refused
 * (not half-saved) on a database that has not had migrations/expense_odometer.sql applied.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/ai.service', () => ({
  AIService: { callKiniAI: jest.fn().mockRejectedValue(new Error('no model in tests')) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as policy from '../src/services/expenses/policy.service';
import * as svc from '../src/services/expenses/expenses.service';
import * as va from '../src/services/expenses/vehicleAllowance';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const REP = '11111111-1111-1111-1111-111111111111';
const BOSS = '22222222-2222-2222-2222-222222222222';
const CLAIM = '44444444-4444-4444-4444-444444444444';
const asRep = { id: REP, org_id: ORG, client_id: null, role: 'executive', name: 'Asha' } as any;

const RATES = [
  { id: 'bike', label: 'Bike', rate_per_km: 4 },
  { id: 'car', label: 'Car', rate_per_km: 9.5 },
];
const photo = (n: string) => `https://x.test/storage/v1/object/public/kinematic-receipts/${ORG}/${REP}/${n}.jpg`;
const trip = (over: any = {}) => ({
  category: 'mileage', item_date: '2026-10-06', vehicle_type: 'bike',
  odometer_start: 1000, odometer_end: 1042.5,
  odometer_start_photo_url: photo('a'), odometer_end_photo_url: photo('b'), ...over,
});

// ── the pure rules ──────────────────────────────────────────────────────────
describe('vehicle rates', () => {
  it('are cleaned: labelled, non-negative, unique ids, capped', () => {
    const out = va.normalizeVehicleRates([
      { label: ' Bike ', rate_per_km: '4' },
      { id: 'bike', label: 'Another bike', rate_per_km: 5 },        // same id -> made unique
      { label: '', rate_per_km: 3 },                                  // no label -> dropped
      { label: 'Walk', rate_per_km: -1 },                             // negative -> dropped
      { label: 'Car', rate_per_km: 'abc' },                           // not a number -> dropped
      null, 'x',
    ]);
    expect(out.map((r) => r.label)).toEqual(['Bike', 'Another bike']);
    expect(out[0]).toEqual({ id: 'bike', label: 'Bike', rate_per_km: 4 });
    expect(new Set(out.map((r) => r.id)).size).toBe(2);
  });
  it('keep a stable id across a relabel', () => {
    expect(va.normalizeVehicleRates([{ id: 'bike', label: 'Motorcycle', rate_per_km: 4 }])[0].id).toBe('bike');
  });
  it('are empty for anything that is not a list', () => {
    expect(va.normalizeVehicleRates(undefined)).toEqual([]);
    expect(va.normalizeVehicleRates({})).toEqual([]);
  });
  it('cap at 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `V${i}`, rate_per_km: 1 }));
    expect(va.normalizeVehicleRates(many)).toHaveLength(20);
  });
});

describe('pricing a trip from the odometer', () => {
  it('works out the distance and prices it at the chosen vehicle', () => {
    const p = va.priceVehicleLine(trip({ amount: 99999, distance_km: 5000 }) as any, RATES);
    expect(p.distance_km).toBe(42.5);
    expect(p.amount).toBe(170);                                        // 42.5 x 4 — the client's numbers are ignored
    expect(va.priceVehicleLine(trip({ vehicle_type: 'car' }) as any, RATES).amount).toBe(403.75);
  });
  it('leaves a trip unpriced until both readings are in', () => {
    const p = va.priceVehicleLine(trip({ odometer_end: null, amount: 50 }) as any, RATES);
    expect(p.distance_km).toBeNull();
    expect(p.amount).toBe(0);
  });
  it('prices an unknown vehicle at 0 (and the submit check asks for a vehicle)', () => {
    expect(va.priceVehicleLine(trip({ vehicle_type: 'rocket' }) as any, RATES).amount).toBe(0);
  });
  it('does not touch other categories', () => {
    const food = { category: 'food', amount: 120 };
    expect(va.priceVehicleLine(food as any, RATES)).toBe(food);
  });
  it('refuses a reading after the trip that is lower than the reading before it', () => {
    expect(() => va.assertOdometerOrder([trip({ odometer_start: 500, odometer_end: 400 }) as any]))
      .toThrow(expect.objectContaining({ code: 'ODOMETER_INVALID' }));
    expect(() => va.assertOdometerOrder([trip() as any, { category: 'food' } as any])).not.toThrow();
    expect(() => va.assertOdometerOrder([trip({ odometer_end: null }) as any])).not.toThrow();   // a draft in progress
  });
});

describe('what a trip still needs before it can be submitted', () => {
  const rules = { vehicle_rates: RATES, odometer_photos_required: true };
  it('nothing, when it is complete', () => expect(va.odometerProblems(trip() as any, rules)).toEqual([]));
  it('the vehicle', () => {
    expect(va.odometerProblems(trip({ vehicle_type: null }) as any, rules).map((p) => p.code)).toEqual(['vehicle_missing']);
  });
  it('both readings', () => {
    expect(va.odometerProblems(trip({ odometer_end: null }) as any, rules).map((p) => p.code)).toEqual(['odometer_missing']);
  });
  it('an end reading that is below the start', () => {
    expect(va.odometerProblems(trip({ odometer_end: 10 }) as any, rules).map((p) => p.code)).toEqual(['odometer_invalid']);
  });
  it('both photos', () => {
    expect(va.odometerProblems(trip({ odometer_end_photo_url: null }) as any, rules).map((p) => p.code)).toEqual(['odometer_photo_missing']);
    expect(va.odometerProblems(trip({ odometer_start_photo_url: null, odometer_end_photo_url: null }) as any, rules)).toHaveLength(1);
  });
  it('but not the photos when the policy does not require them', () => {
    expect(va.odometerProblems(trip({ odometer_start_photo_url: null }) as any, { ...rules, odometer_photos_required: false })).toEqual([]);
  });
  it('is nothing at all for a policy without vehicle rates, or for a non-mileage line', () => {
    expect(va.odometerProblems({ category: 'mileage', distance_km: 12 } as any, { vehicle_rates: [] })).toEqual([]);
    expect(va.odometerProblems({ category: 'food' } as any, rules)).toEqual([]);
  });
});

// ── the policy ──────────────────────────────────────────────────────────────
const rulesOf = (o: any = {}) => policy.normalizeRules(o);
const pol = (o: any = {}): policy.ExpensePolicy => ({ ...policy.BUILT_IN_POLICY, name: 'Agri policy', ...o });

describe('policy rules', () => {
  it('default to no vehicle rates, so every existing policy is unchanged', () => {
    const r = rulesOf();
    expect(r.vehicle_rates).toEqual([]);
    expect(r.odometer_photos_required).toBe(true);
    expect(r.mileage_rate).toBe(12);
  });
  it('carry the rates through normalisation', () => {
    const r = rulesOf({ vehicle_rates: [{ label: 'Bike', rate_per_km: 4 }, { label: '', rate_per_km: 1 }], odometer_photos_required: false });
    expect(r.vehicle_rates).toEqual([{ id: 'bike', label: 'Bike', rate_per_km: 4 }]);
    expect(r.odometer_photos_required).toBe(false);
  });
  it('are sent to the apps inside the policy', () => {
    const shaped = policy.toClientShape(pol({ rules: rulesOf({ vehicle_rates: RATES }) }));
    expect(shaped.rules.vehicle_rates).toHaveLength(2);
  });
});

describe('policy evaluation of trips', () => {
  const agri = pol({ rules: rulesOf({ vehicle_rates: RATES }) });
  it('blocks an incomplete trip even under a "flag" policy', () => {
    const { violations } = policy.evaluateAgainstPolicy(agri, [{ id: 'l1', ...trip({ odometer_end: null }), amount: 0 }]);
    const v = violations.find((x) => x.code === 'odometer_missing');
    expect(v).toMatchObject({ blocking: true, severity: 'high', item_id: 'l1' });
  });
  it('lets a complete trip through', () => {
    const { violations } = policy.evaluateAgainstPolicy(agri, [{ id: 'l1', ...trip(), distance_km: 42.5, amount: 170 }]);
    expect(violations.filter((x) => x.blocking)).toEqual([]);
  });
  it('says nothing about a plain mileage line under a policy without vehicle rates', () => {
    const { violations } = policy.evaluateAgainstPolicy(pol(), [{ id: 'l1', category: 'mileage', distance_km: 20, amount: 240, item_date: '2026-10-06' }]);
    expect(violations.some((x) => /odometer|vehicle/.test(x.code))).toBe(false);
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

beforeEach(() => { __mock.reset(); va._resetOdometerProbe(); });

describe('saving a trip under a vehicle policy', () => {
  const agri = pol({ rules: rulesOf({ vehicle_rates: RATES }) });

  it('stores the distance and amount the server worked out, plus the odometer fields', async () => {
    arrange(agri, draft());
    await svc.createClaim(asRep, { items: [trip({ amount: 99999, distance_km: 5000 }) as any] });
    const row = insertsOf('expense_claim_items')[0][0];
    expect(row).toMatchObject({
      category: 'mileage', vehicle_type: 'bike', odometer_start: 1000, odometer_end: 1042.5,
      distance_km: 42.5, amount: 170,
    });
    expect(row.odometer_start_photo_url).toBe(photo('a'));
    expect(insertsOf('expense_claims')[0]).toMatchObject({ total_amount: 170, distance_km: 42.5 });
  });

  it('saves a trip that only has its starting reading so far, as a draft', async () => {
    arrange(agri, draft());
    await svc.createClaim(asRep, { items: [trip({ odometer_end: null, odometer_end_photo_url: null }) as any] });
    expect(insertsOf('expense_claim_items')[0][0]).toMatchObject({ odometer_start: 1000, odometer_end: null, amount: 0, distance_km: null });
  });

  it('refuses a reading after the trip that is below the one before it', async () => {
    arrange(agri, draft());
    await expect(svc.createClaim(asRep, { items: [trip({ odometer_start: 500, odometer_end: 400 }) as any] }))
      .rejects.toMatchObject({ code: 'ODOMETER_INVALID' });
    expect(insertsOf('expense_claims')).toHaveLength(0);
  });

  it("refuses another person's photo as an odometer photo", async () => {
    arrange(agri, draft());
    const stolen = `https://x.test/storage/v1/object/public/kinematic-receipts/${ORG}/99999999-9999-9999-9999-999999999999/z.jpg`;
    await expect(svc.createClaim(asRep, { items: [trip({ odometer_end_photo_url: stolen }) as any] }))
      .rejects.toMatchObject({ code: 'RECEIPT_FORBIDDEN' });
  });

  it('on update, a client that never mentions the odometer does not wipe it', async () => {
    const saved = { id: 'l1', claim_id: CLAIM, ...trip(), distance_km: 42.5, amount: 170 };
    arrange(agri, draft(), [saved]);
    await svc.updateClaim(asRep, CLAIM, { items: [{ id: 'l1', category: 'food', amount: 80 } as any] });
    const row = updatesOf('expense_claim_items')[0];
    expect('odometer_start' in row).toBe(false);
    expect('vehicle_type' in row).toBe(false);
  });

  it('on update, an explicit empty photo clears just that photo', async () => {
    arrange(agri, draft(), [{ id: 'l1', claim_id: CLAIM, ...trip(), distance_km: 42.5, amount: 170 }]);
    await svc.updateClaim(asRep, CLAIM, { items: [{ ...trip(), id: 'l1', odometer_end_photo_url: '' } as any] });
    expect(updatesOf('expense_claim_items')[0].odometer_end_photo_url).toBeNull();
  });
});

describe('a policy without vehicle rates is untouched', () => {
  it('prices a mileage line at the flat rate and writes no odometer columns', async () => {
    arrange(pol({ rules: rulesOf({ mileage_rate: 10 }) }), draft());
    await svc.createClaim(asRep, { items: [{ category: 'mileage', distance_km: 20, item_date: '2026-10-06' } as any] });
    const row = insertsOf('expense_claim_items')[0][0];
    expect(row.amount).toBe(200);
    expect(Object.keys(row).some((k) => k.startsWith('odometer') || k === 'vehicle_type')).toBe(false);
  });
});

describe('before the database migration has been applied', () => {
  it('refuses odometer data with a clear message instead of a half-saved claim', async () => {
    arrange(pol({ rules: rulesOf({ vehicle_rates: RATES }) }), draft());
    __mock.setDefault('expense_claim_items', { data: null, error: { message: 'column expense_claim_items.vehicle_type does not exist' } });
    await expect(svc.createClaim(asRep, { items: [trip() as any] })).rejects.toMatchObject({ code: 'ODOMETER_NOT_ENABLED', statusCode: 409 });
    expect(insertsOf('expense_claims')).toHaveLength(0);
  });
  it('still saves ordinary claims, never touching the missing columns', async () => {
    arrange(pol(), draft());
    __mock.setDefault('expense_claim_items', { data: null, error: { message: 'column expense_claim_items.vehicle_type does not exist' } });
    await svc.createClaim(asRep, { items: [{ category: 'food', amount: 100 } as any] }).catch(() => undefined);
    expect(insertsOf('expense_claims')).toHaveLength(1);
  });
});

describe('submitting trips', () => {
  const agri = pol({ rules: rulesOf({ vehicle_rates: RATES }) });
  const dated = (o: any) => ({ id: 'l1', claim_id: CLAIM, item_date: new Date().toISOString().slice(0, 10), ...o });

  it('is blocked while a trip is missing its odometer photo', async () => {
    arrange(agri, draft(), [dated({ ...trip({ odometer_end_photo_url: null }), item_date: new Date().toISOString().slice(0, 10), distance_km: 42.5, amount: 170 })]);
    const err: any = await svc.submitClaim(asRep, CLAIM).catch((e) => e);
    expect(err).toBeInstanceOf(svc.PolicyBlockedError);
    expect(err.violations.map((v: any) => v.code)).toContain('odometer_photo_missing');
    expect(updatesOf('expense_claims').find((u) => u.status === 'submitted')).toBeUndefined();
  });

  it('goes through when the trip is complete, repriced at the current rate', async () => {
    // saved at 3/km, but the policy now pays 4/km for a bike
    arrange(agri, draft(), [dated({ ...trip(), distance_km: 42.5, amount: 127.5 })]);
    await svc.submitClaim(asRep, CLAIM);
    expect(updatesOf('expense_claim_items').some((u) => u.amount === 170)).toBe(true);
    expect(updatesOf('expense_claims').find((u) => u.status === 'submitted')).toBeDefined();
  });
});

describe('the claims CSV', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildClaimsCsv } = require('../src/services/expenses/claimReports.service');
  const claim = { id: CLAIM, claim_no: 'EXP-1', user_name: 'Asha', employee_id: 'E1', status: 'approved', total_amount: 170 };

  it('adds the vehicle and odometer columns when a trip is in the report', () => {
    const csv = buildClaimsCsv([claim], [{ id: 'l1', claim_id: CLAIM, category: 'mileage', amount: 170, item_date: '2026-10-06', ...trip(), distance_km: 42.5 }]);
    const [head, row] = csv.split('\n');
    expect(head.endsWith('Distance (km),Vehicle,Odometer before,Odometer after')).toBe(true);
    expect(row.endsWith('42.5,bike,1000,1042.5')).toBe(true);
  });
  it('leaves the export exactly as it was for claims without any', () => {
    const csv = buildClaimsCsv([claim], [{ id: 'l1', claim_id: CLAIM, category: 'food', amount: 90, item_date: '2026-10-06' }]);
    const [head, row] = csv.split('\n');
    expect(head.endsWith('Reimbursement ref')).toBe(true);
    expect(head).not.toMatch(/Odometer|Vehicle/);
    expect(row.split(',').length).toBe(head.split(',').length);
  });
  it('keeps the other lines of a mixed report aligned with the header', () => {
    const csv = buildClaimsCsv([claim], [
      { id: 'l1', claim_id: CLAIM, category: 'mileage', amount: 170, item_date: '2026-10-06', ...trip(), distance_km: 42.5 },
      { id: 'l2', claim_id: CLAIM, category: 'food', amount: 90, item_date: '2026-10-07' },
    ]);
    const rows = csv.split('\n');
    expect(rows[2].split(',').length).toBe(rows[0].split(',').length);
    expect(rows[2].endsWith(',,,,')).toBe(true);
  });
});
