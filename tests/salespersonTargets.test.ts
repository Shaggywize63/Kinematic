/**
 * Stage 2 — SALES targets scored from WON crm_deals (an opt-in per client, e.g. Aadinath), plus the
 * per-salesperson drill-down endpoint. Driven against the Supabase double.
 *
 * What is pinned here:
 *   - resolveAchievementBasis reads config.targets.achievement_basis ('won_deals' opt-in; anything else
 *     resolves to 'manual', so Tata and every un-configured client are untouched);
 *   - wonSalesByOwner sums WON deals per owner in paise, bounded by owner / client / close-date window;
 *   - myProgress and the typed leaderboard score SALES off won deals on the won-deals basis, while
 *     COLLECTION — and every client on the manual basis — stay on logged entries;
 *   - salespersonTargetDetail: target / achieved / pending / pct, daily + weekly progress, the customers
 *     contributing this month, and a 6-month history, on either basis;
 *   - GET /crm/targets/salesperson/:userId validates the id as a UUID and is manager-gated.
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock, RecordedChain } from './helpers/supabaseMock';
import { fakeTable } from './helpers/fakeTable';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers['x-test-user'] ?? '{}'));
    next();
  },
}));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requireModule: () => (_req: any, _res: any, next: any) => next(),
  requireModuleAccess: () => (_req: any, _res: any, next: any) => next(),
  requireAnyModuleAccess: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/utils/demoCrm', () => ({ demoCrmMiddleware: (_req: any, _res: any, next: any) => next() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as te from '../src/services/crm/targetEntries.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CLIENT = '55555555-5555-5555-5555-555555555555';
const OTHER_CLIENT = '99999999-9999-9999-9999-999999999999';
const ROLE = '66666666-6666-6666-6666-666666666666';
const REP = '11111111-1111-1111-1111-111111111111';
const REP2 = '12121212-1212-1212-1212-121212121212';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const ACC = '22222222-2222-2222-2222-222222222222';

const admin = { id: ADMIN, org_id: ORG, client_id: CLIENT, role: 'admin' };
const rep = { id: REP, org_id: ORG, client_id: CLIENT, role: 'executive', org_role_id: ROLE, org_role_data_scope: 'own' };
const actorOf = (u: any) => ({ id: u.id, org_id: u.org_id, client_id: u.client_id, role: u.role, data_scope: u.org_role_data_scope ?? null });

/** crm_settings: the config for a client's own row, with an optional org-level default. */
function settings(byClient: Record<string, unknown | null>, orgDefault: unknown | null = null) {
  __mock.setDefault('crm_settings', (chain) => {
    const orgLevel = chain.ops.some((o) => o.method === 'is' && o.args[0] === 'client_id');
    const cfg = orgLevel ? orgDefault : byClient[String(chain.eqs['client_id'])] ?? null;
    return { data: cfg ? [{ config: cfg }] : [] };
  });
}

/** A WON crm_deals row. The nested stage is flattened to the dotted key the fakeTable `.eq` filter reads. */
const deal = (o: any = {}) => ({
  owner_id: REP, amount: 1000, actual_close_date: '2026-01-15', account_id: null, name: 'Deal',
  org_id: ORG, client_id: CLIENT, deleted_at: null, 'crm_deal_stages.stage_type': 'won', ...o,
});
const entry = (o: any = {}) => ({
  id: 'e', org_id: ORG, client_id: CLIENT, user_id: REP, kind: 'sales', amount: 1000, entry_date: '2026-01-15',
  lead_id: null, note: null, created_by: REP, created_at: '2026-01-15T10:00:00.000Z', deleted_at: null, ...o,
});
const trow = (o: any = {}) => ({ org_id: ORG, user_id: null, org_role_id: null, hierarchy_level_id: null, client_id: CLIENT, metric: 'sales_amount', period: 'monthly', target_value: 100000, ...o });

const opsOf = (c: RecordedChain, m: string) => c.ops.filter((o) => o.method === m).map((o) => o.args);
const lastChain = (table: string) => { const c = __mock.chainsFor(table); return c[c.length - 1]; };
const at = (iso: string) => Date.parse(iso);
const JAN = at('2026-01-20T06:00:00Z');                       // mid-Jan 2026 IST
const WON = { targets: { types: [{ key: 'sales' }, { key: 'collection' }], achievement_basis: 'won_deals' } };
const MANUAL = { targets: { types: [{ key: 'sales' }, { key: 'collection' }] } };

beforeEach(() => { __mock.reset(); te._resetTargetEntriesProbe(); });

// ── achievement basis ─────────────────────────────────────────────────────────
describe('resolveAchievementBasis', () => {
  it('is won_deals only for the literal opt-in, else manual (default, garbled, missing, no config)', async () => {
    for (const [cfg, expected] of [
      [WON, 'won_deals'],
      [{ targets: { types: [{ key: 'sales' }], achievement_basis: 'manual' } }, 'manual'],
      [{ targets: { types: [{ key: 'sales' }], achievement_basis: 'WON_DEALS' } }, 'manual'],  // case-sensitive
      [{ targets: { types: [{ key: 'sales' }], achievement_basis: 'leads' } }, 'manual'],
      [{ targets: { types: [{ key: 'sales' }] } }, 'manual'],                                   // no key
      [{}, 'manual'],
      [null, 'manual'],
    ] as const) {
      __mock.reset(); settings({ [CLIENT]: cfg });
      expect({ cfg, basis: await te.resolveAchievementBasis(ORG, CLIENT) }).toEqual({ cfg, basis: expected });
    }
  });
});

// ── wonSalesByOwner ─────────────────────────────────────────────────────────────
describe('wonSalesByOwner', () => {
  it('sums won deals per owner (paise-exact), excluding non-won, out-of-window and other-client deals', async () => {
    __mock.setDefault('crm_deals', fakeTable([
      deal({ owner_id: REP, amount: 1000, actual_close_date: '2026-01-05' }),
      deal({ owner_id: REP, amount: 500.5, actual_close_date: '2026-01-31' }),
      deal({ owner_id: REP2, amount: 2000, actual_close_date: '2026-01-10' }),
      deal({ owner_id: REP, amount: 999, actual_close_date: '2026-01-10', 'crm_deal_stages.stage_type': 'lost' }), // not won
      deal({ owner_id: REP, amount: 777, actual_close_date: '2025-12-31' }),                                       // before window
      deal({ owner_id: REP, amount: 888, actual_close_date: '2026-02-01' }),                                       // after window
    ]));
    const map = await te.wonSalesByOwner(ORG, CLIENT, [REP, REP2], '2026-01-01', '2026-01-31');
    expect(map.get(REP)).toEqual({ value: 1500.5, count: 2 });
    expect(map.get(REP2)).toEqual({ value: 2000, count: 1 });

    const q = lastChain('crm_deals');
    expect(opsOf(q, 'eq')).toContainEqual(['crm_deal_stages.stage_type', 'won']);
    expect(q.eqs).toMatchObject({ org_id: ORG, client_id: CLIENT });
    expect(opsOf(q, 'gte')).toContainEqual(['actual_close_date', '2026-01-01']);
    expect(opsOf(q, 'lte')).toContainEqual(['actual_close_date', '2026-01-31']);
    expect(opsOf(q, 'in')).toContainEqual(['owner_id', [REP, REP2]]);
    expect(q.ops.some((o) => o.method === 'range')).toBe(true);        // not capped at 1000
  });

  it('adds paise exactly (0.1 + 0.2 = 0.3)', async () => {
    __mock.setDefault('crm_deals', fakeTable([deal({ amount: '0.10' }), deal({ amount: 0.2 })]));
    expect((await te.wonSalesByOwner(ORG, CLIENT, [REP], '2026-01-01', '2026-01-31')).get(REP)).toEqual({ value: 0.3, count: 2 });
  });
});

// ── myProgress: basis switch ────────────────────────────────────────────────────
describe('myProgress on the won-deals basis', () => {
  const arrange = (cfg: unknown) => {
    settings({ [CLIENT]: cfg });
    __mock.setDefault('users', { data: [{ org_role_id: ROLE, hierarchy_level_id: null }] });
    __mock.setDefault('crm_targets', fakeTable([trow({ org_role_id: ROLE, target_value: 2000 })]));
    __mock.setDefault('crm_target_entries', fakeTable([
      entry({ kind: 'sales', amount: 9999, entry_date: '2026-01-10' }),       // IGNORED on won basis
      entry({ kind: 'collection', amount: 7, entry_date: '2026-01-10' }),     // collection stays manual
    ]));
    __mock.setDefault('crm_deals', fakeTable([deal({ owner_id: REP, amount: 1250, actual_close_date: '2026-01-10' })]));
  };

  it('scores SALES off won deals and leaves COLLECTION on logged entries', async () => {
    arrange(WON);
    const p = await te.myProgress(actorOf(rep), JAN);
    const sales = p.types.find((t) => t.key === 'sales')!;
    const collection = p.types.find((t) => t.key === 'collection')!;
    expect(sales).toMatchObject({ target: 2000, achieved: 1250, pct: 63 });  // 1250 from deals, NOT the 9999 entry
    expect(collection).toMatchObject({ achieved: 7 });
    // the manual-basis response shape is unchanged (no extra top-level keys)
    expect(Object.keys(p).sort()).toEqual(['period_end', 'period_start', 'types']);
  });

  it('on the manual basis SALES stays on entries and no deals are read (Tata path)', async () => {
    arrange(MANUAL);
    const p = await te.myProgress(actorOf(rep), JAN);
    expect(p.types.find((t) => t.key === 'sales')!.achieved).toBe(9999);
    expect(__mock.chainsFor('crm_deals')).toHaveLength(0);
  });
});

// ── typed leaderboard: basis switch ─────────────────────────────────────────────
describe('typedLeaderboard on the won-deals basis', () => {
  const Dealer = { id: REP, name: 'Asha', email: null, city: null, org_role_id: ROLE, hierarchy_level_id: null, role: 'executive', client_id: CLIENT, org_id: ORG };
  const Dealer2 = { id: REP2, name: 'Bala', email: null, city: null, org_role_id: ROLE, hierarchy_level_id: null, role: 'executive', client_id: CLIENT, org_id: ORG };
  const salesType = { key: 'sales' as const, label: 'Sales target', metric: 'sales_amount', period: 'monthly' as const, unit: 'INR' as const };

  it('scores each rep off their won deals, not their logged entries', async () => {
    settings({ [CLIENT]: WON });
    __mock.setDefault('users', fakeTable([Dealer, Dealer2]));
    __mock.setDefault('org_roles', { data: [{ id: ROLE, name: 'Dealer Rep' }] });
    __mock.setDefault('crm_targets', fakeTable([trow({ target_value: 100000 }), trow({ user_id: REP2, target_value: 40000 })]));
    __mock.setDefault('crm_target_entries', fakeTable([entry({ user_id: REP, amount: 99999, entry_date: '2026-01-10' })]));  // ignored
    __mock.setDefault('crm_deals', fakeTable([
      deal({ owner_id: REP, amount: 50000, actual_close_date: '2026-01-10' }),
      deal({ owner_id: REP2, amount: 40000, actual_close_date: '2026-01-10' }),
    ]));
    const board = await te.typedLeaderboard(ORG, CLIENT, salesType, { org_role_id: null, org_role_data_scope: null }, JAN);
    expect(board.entries).toEqual([
      { user_id: REP, name: 'Asha', role: 'Dealer Rep', target: 100000, achieved: 50000, pct: 50 },
      { user_id: REP2, name: 'Bala', role: 'Dealer Rep', target: 40000, achieved: 40000, pct: 100 },
    ]);
    expect(board.stats).toMatchObject({ total_achieved: 90000, meeting_target: 1 });
  });
});

// ── salesperson drill-down ──────────────────────────────────────────────────────
describe('salespersonTargetDetail', () => {
  const arrange = (cfg: unknown) => {
    settings({ [CLIENT]: cfg });
    __mock.setDefault('users', fakeTable([{ id: REP, name: 'Asha', email: null, org_role_id: ROLE, hierarchy_level_id: null }]));
    __mock.setDefault('crm_targets', fakeTable([trow({ user_id: REP, target_value: 100000 })]));
    __mock.setDefault('crm_accounts', fakeTable([{ id: ACC, name: 'Big Dealer' }]));
  };

  it('breaks down a rep\'s won-deal sales: target, pending, daily/weekly, customers and a 6-month history', async () => {
    arrange(WON);
    __mock.setDefault('crm_deals', fakeTable([
      deal({ amount: 30000, actual_close_date: '2026-01-05', account_id: ACC }),
      deal({ amount: 20000, actual_close_date: '2026-01-12', account_id: ACC }),
      deal({ amount: 10000, actual_close_date: '2026-01-12', account_id: null, name: 'Walk-in' }),
      deal({ amount: 5000, actual_close_date: '2025-12-15', account_id: ACC }),                                   // prior month
      deal({ amount: 1, actual_close_date: '2026-01-10', 'crm_deal_stages.stage_type': 'lost' }),                 // not won
    ]));
    const d = await te.salespersonTargetDetail(ORG, CLIENT, REP, undefined, JAN);
    expect(d).toMatchObject({
      user_id: REP, name: 'Asha', basis: 'won_deals',
      period_start: '2026-01-01', period_end: '2026-01-31',
      target: 100000, achieved: 60000, pending: 40000, pct: 60,
    });
    expect(d.daily).toEqual([
      { date: '2026-01-05', value: 30000, count: 1 },
      { date: '2026-01-12', value: 30000, count: 2 },
    ]);
    expect(d.weekly).toEqual([
      { week_start: '2026-01-05', value: 30000, count: 1 },     // 2026-01-05 is a Monday
      { week_start: '2026-01-12', value: 30000, count: 2 },
    ]);
    expect(d.customers).toEqual([
      { name: 'Big Dealer', value: 50000, count: 2 },
      { name: 'Walk-in', value: 10000, count: 1 },
    ]);
    expect(d.historical).toHaveLength(6);
    expect(d.historical[d.historical.length - 1]).toEqual({ month: '2026-01', target: 100000, achieved: 60000, pct: 60 });
    expect(d.historical.find((h) => h.month === '2025-12')).toEqual({ month: '2025-12', target: 100000, achieved: 5000, pct: 5 });
    expect(d.historical.map((h) => h.month)).toEqual(['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01']);
    // the deal scan spans the whole 6-month window, bounded to the one rep + client
    const q = lastChain('crm_deals');
    expect(q.eqs).toMatchObject({ org_id: ORG, client_id: CLIENT, owner_id: REP });
    expect(opsOf(q, 'gte')).toContainEqual(['actual_close_date', '2025-08-01']);
    expect(opsOf(q, 'lte')).toContainEqual(['actual_close_date', '2026-01-31']);
  });

  it('honours ?month and clamps pending at 0 when the target is beaten', async () => {
    arrange(WON);
    __mock.setDefault('crm_deals', fakeTable([deal({ amount: 150000, actual_close_date: '2025-11-20', account_id: ACC })]));
    const d = await te.salespersonTargetDetail(ORG, CLIENT, REP, '2025-11', JAN);
    expect(d).toMatchObject({ period_start: '2025-11-01', period_end: '2025-11-30', achieved: 150000, pending: 0, pct: 150 });
  });

  it('on the manual basis reads logged entries, not deals', async () => {
    arrange(MANUAL);
    __mock.setDefault('crm_target_entries', fakeTable([entry({ amount: 25000, entry_date: '2026-01-08' })]));
    const d = await te.salespersonTargetDetail(ORG, CLIENT, REP, undefined, JAN);
    expect(d).toMatchObject({ basis: 'manual', achieved: 25000, pending: 75000 });
    expect(__mock.chainsFor('crm_deals')).toHaveLength(0);
    expect(opsOf(lastChain('crm_target_entries'), 'eq')).toContainEqual(['kind', 'sales']);
  });
});

// ── the route ───────────────────────────────────────────────────────────────────
describe('GET /crm/targets/salesperson/:userId', () => {
  const app = express();
  app.use(express.json());
  app.use('/crm', crmRouter);
  const get = (id: string, u: object = admin, qs = '') => request(app).get(`/crm/targets/salesperson/${id}${qs}`).set('x-test-user', JSON.stringify(u));

  const arrange = (cfg: unknown = WON) => {
    settings({ [CLIENT]: cfg });
    __mock.setDefault('users', fakeTable([{ id: REP, name: 'Asha', email: null, org_role_id: ROLE, hierarchy_level_id: null }]));
    __mock.setDefault('crm_targets', fakeTable([trow({ user_id: REP, target_value: 100000 })]));
    // dated in the real current IST month, since the route resolves the window from Date.now()
    __mock.setDefault('crm_deals', fakeTable([deal({ amount: 60000, actual_close_date: te.istMonth().start, account_id: ACC })]));
    __mock.setDefault('crm_accounts', fakeTable([{ id: ACC, name: 'Big Dealer' }]));
  };

  it('answers a manager with { success, data } for the salesperson', async () => {
    arrange();
    const res = await get(REP);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ user_id: REP, basis: 'won_deals', target: 100000, achieved: 60000 });
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['achieved', 'basis', 'customers', 'daily', 'historical', 'name', 'pct', 'pending', 'period_end', 'period_start', 'target', 'user_id', 'weekly'],
    );
  });

  it('rejects a non-UUID id with 400, reading nothing', async () => {
    arrange();
    const res = await get('not-a-uuid');
    expect(res.status).toBe(400);
    expect(__mock.chainsFor('crm_deals')).toHaveLength(0);
  });

  it('is manager-gated: a plain executive gets 403', async () => {
    arrange();
    expect((await get(REP, rep)).status).toBe(403);
  });
});
