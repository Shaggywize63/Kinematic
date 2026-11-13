/**
 * GET /crm/my-tasks — the caller's OWN assigned activities, each stamped with
 * who assigned it.
 *
 * Drives the real crm router over HTTP with Supabase mocked. The mock's
 * crm_activities responder applies the handler's own owner/assigned OR-filter
 * and status filter against a fixed dataset, so the test proves the handler
 * asks only for the caller's rows (never another rep's) — not merely that it
 * returns whatever it was handed. Separately asserts tenant scoping, the
 * status / overdue predicates the handler builds, and the assigner-name
 * stamping (including the null-assigner fallback).
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock, RecordedChain } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
// Authenticated as a plain field rep (own-scope), module gates open.
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: '33333333-3333-3333-3333-333333333333',
      org_id: '00000000-0000-0000-0000-0000000000aa',
      role: 'user',
      client_id: null,
      org_role_data_scope: 'own',
    };
    next();
  },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requireModule: () => (_req: any, _res: any, next: any) => next(),
  requireModuleAccess: () => (_req: any, _res: any, next: any) => next(),
  requireAnyModuleAccess: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/utils/demoCrm', () => ({ demoCrmMiddleware: (_req: any, _res: any, next: any) => next() }));

const ME = '33333333-3333-3333-3333-333333333333';
const OTHER = '99999999-9999-9999-9999-999999999999';
const BOSS = '22222222-2222-2222-2222-222222222222';
const ORG = '00000000-0000-0000-0000-0000000000aa';
const LEAD = '11111111-1111-1111-1111-111111111111';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const app = express();
app.use(express.json());
app.use('/crm', crmRouter);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message }));

const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

// Full dataset the "DB" holds. The mock responder filters it by the OR / status
// the handler built, so only rows the handler legitimately asked for come back.
const ALL_ROWS = [
  { id: 'a1', org_id: ORG, client_id: null, type: 'call', subject: 'Call my lead', body: null, status: 'open', due_at: FUTURE, completed_at: null, created_at: '2026-01-01T00:00:00.000Z', lead_id: LEAD, owner_id: ME, assigned_to: null, created_by: BOSS },
  { id: 'a2', org_id: ORG, client_id: null, type: 'task', subject: 'Follow up', body: null, status: 'open', due_at: PAST, completed_at: null, created_at: '2026-01-02T00:00:00.000Z', lead_id: LEAD, owner_id: null, assigned_to: ME, created_by: null },
  { id: 'a3', org_id: ORG, client_id: null, type: 'call', subject: 'Done deal', body: null, status: 'completed', due_at: PAST, completed_at: PAST, created_at: '2026-01-03T00:00:00.000Z', lead_id: LEAD, owner_id: ME, assigned_to: null, created_by: BOSS },
  { id: 'z9', org_id: ORG, client_id: null, type: 'call', subject: 'Someone elses', body: null, status: 'open', due_at: FUTURE, completed_at: null, created_at: '2026-01-04T00:00:00.000Z', lead_id: LEAD, owner_id: OTHER, assigned_to: OTHER, created_by: BOSS },
];

/** Apply the parts of the built query that discriminate rows: the mine-OR, status eq/in, overdue. */
function applyFilters(chain: RecordedChain, rows: typeof ALL_ROWS) {
  let out = rows.filter((r) => r.org_id === chain.eqs.org_id);
  // The "mine" OR group: owner_id.eq.X,assigned_to.eq.X
  const mineOr = chain.ors.find((o) => /owner_id\.eq\.|assigned_to\.eq\./.test(o));
  if (mineOr) {
    const m = mineOr.match(/owner_id\.eq\.([0-9a-f-]+)/i);
    const uid = m?.[1];
    out = out.filter((r) => r.owner_id === uid || r.assigned_to === uid);
  }
  // status = eq / in
  if (typeof chain.eqs.status === 'string') out = out.filter((r) => r.status === chain.eqs.status);
  const inOp = chain.ops.find((o) => o.method === 'in' && o.args[0] === 'status');
  if (inOp) {
    const set = inOp.args[1] as string[];
    out = out.filter((r) => set.includes(r.status));
  }
  // default actionable branch: excludes completed/cancelled + completed_at not null
  const excludesDone = chain.ors.some((o) => o.includes('status.not.in.(completed,done,cancelled)'));
  if (excludesDone) out = out.filter((r) => !['completed', 'done', 'cancelled'].includes(r.status) && !r.completed_at);
  // overdue predicates
  const overdue = chain.ops.some((o) => o.method === 'lt' && o.args[0] === 'due_at');
  if (overdue) out = out.filter((r) => !!r.due_at && String(r.due_at) < FUTURE && !r.completed_at);
  return out;
}

beforeEach(() => {
  __mock.reset();
  // crm_activities: filter ALL_ROWS by whatever the handler asked for, and
  // report the filtered count (so pagination.total reflects the real scope).
  __mock.setDefault('crm_activities', (chain) => {
    const rows = applyFilters(chain, ALL_ROWS);
    return { data: rows, count: rows.length };
  });
  // Name lookups for owner / assignee / created_by stamping.
  __mock.setDefault('users', {
    data: [
      { id: ME, name: 'Me Rep', email: 'me@x.com', role: 'user' },
      { id: BOSS, name: 'Boss Manager', email: 'boss@x.com', role: 'admin' },
    ],
  });
  __mock.setDefault('crm_leads', { data: [{ id: LEAD, first_name: 'Asha', last_name: 'K', phone: '9876543210', account_id: null }] });
  __mock.setDefault('crm_accounts', { data: [] });
  __mock.setDefault('crm_contacts', { data: [] });
  __mock.setDefault('crm_deals', { data: [] });
  __mock.setDefault('crm_custom_field_defs', { data: [] });
});

describe('GET /crm/my-tasks', () => {
  it('returns only the caller\'s own tasks (owner OR assigned), never another rep\'s', async () => {
    const res = await request(app).get('/crm/my-tasks?status=open');
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r: any) => r.id).sort();
    expect(ids).toEqual(['a1', 'a2']); // a3=completed filtered by status, z9=other rep excluded by scope
    expect(ids).not.toContain('z9');
    // The handler built the mine-OR and status filter it claims to.
    const chain = __mock.chainsFor('crm_activities')[0];
    expect(chain.ors).toContain(`owner_id.eq.${ME},assigned_to.eq.${ME}`);
    expect(chain.eqs.status).toBe('open');
    expect(res.body.pagination.total).toBe(2);
  });

  it('tenant-scopes by org_id and excludes soft-deleted rows', async () => {
    await request(app).get('/crm/my-tasks');
    const chain = __mock.chainsFor('crm_activities')[0];
    expect(chain.eqs.org_id).toBe(ORG);
    expect(chain.ops.some((o) => o.method === 'is' && o.args[0] === 'deleted_at' && o.args[1] === null)).toBe(true);
  });

  it('default view is the actionable worklist (open + undated, no completed/cancelled)', async () => {
    const res = await request(app).get('/crm/my-tasks');
    const ids = res.body.data.map((r: any) => r.id).sort();
    expect(ids).toEqual(['a1', 'a2']); // a3 completed is dropped by default
    const chain = __mock.chainsFor('crm_activities')[0];
    expect(chain.ors.some((o) => o.includes('status.not.in.(completed,done,cancelled)'))).toBe(true);
  });

  it('status=completed matches both "completed" and the legacy "done"', async () => {
    const res = await request(app).get('/crm/my-tasks?status=completed');
    const chain = __mock.chainsFor('crm_activities')[0];
    const inOp = chain.ops.find((o) => o.method === 'in' && o.args[0] === 'status');
    expect(inOp?.args[1]).toEqual(['completed', 'done']);
    expect(res.body.data.map((r: any) => r.id)).toEqual(['a3']);
  });

  it('overdue=true builds the past-due, not-completed predicate', async () => {
    const res = await request(app).get('/crm/my-tasks?overdue=true');
    const chain = __mock.chainsFor('crm_activities')[0];
    expect(chain.ops.some((o) => o.method === 'lt' && o.args[0] === 'due_at')).toBe(true);
    expect(chain.ops.some((o) => o.method === 'is' && o.args[0] === 'completed_at' && o.args[1] === null)).toBe(true);
    // a2 is past-due + open and mine; a1 is future; a3 is completed.
    expect(res.body.data.map((r: any) => r.id)).toEqual(['a2']);
    const a2 = res.body.data[0];
    expect(a2.is_overdue).toBe(true);
  });

  it('stamps assigned_by_name from the creator, and leaves it null when there is no creator', async () => {
    const res = await request(app).get('/crm/my-tasks?status=open');
    const byId: Record<string, any> = Object.fromEntries(res.body.data.map((r: any) => [r.id, r]));
    // a1 was created by BOSS → assigner resolves to Boss Manager.
    expect(byId.a1.assigned_by).toBe(BOSS);
    expect(byId.a1.assigned_by_name).toBe('Boss Manager');
    expect(byId.a1.owner_name).toBe('Me Rep');
    expect(byId.a1.lead_name).toBe('Asha K');
    // a2 has created_by null → null-assigner fallback.
    expect(byId.a2.assigned_by).toBeNull();
    expect(byId.a2.assigned_by_name).toBeNull();
  });
});
