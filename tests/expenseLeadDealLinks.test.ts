/**
 * Expenses linked to a CRM lead and a deal, and the per-lead / per-deal cost roll-up.
 *
 *   - resolveLinks (through createClaim / updateClaim): validation, deal -> lead / account derivation,
 *     the "deal belongs to another lead" refusal, clearing, and connected-B2B-only storage;
 *   - a tenant database without the new columns still saves the claim (and keeps the older link columns);
 *   - stampLinks adds lead_name / deal_name; filters on the list, the admin list and the CSV export;
 *   - the roll-up: spent / pending / draft / rejected, the percentage of opportunity value, visits,
 *     who may see the per-claim rows, and zeros (never a 500) when the columns are missing.
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock, RecordedChain } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/ai.service', () => ({
  AIService: { callKiniAI: jest.fn().mockRejectedValue(new Error('no model in tests')) },
}));
// Authenticated as an org admin for the CRM router; module gates open.
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: '33333333-3333-3333-3333-333333333333', org_id: '00000000-0000-0000-0000-0000000000aa', role: 'admin', client_id: null };
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as svc from '../src/services/expenses/expenses.service';
import * as reports from '../src/services/expenses/claimReports.service';
import * as input from '../src/services/expenses/expenseInput';
import * as rollup from '../src/services/crm/expenseRollup.service';
import { SPARK_CLIENT_ID } from '../src/lib/b2bClients';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const expensesRouter = require('../src/routes/expenses.routes').default as express.Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const ORG = '00000000-0000-0000-0000-0000000000aa';
const REP = '11111111-1111-1111-1111-111111111111';
const OTHER_REP = '22222222-2222-2222-2222-222222222222';
const CLAIM = '44444444-4444-4444-4444-444444444444';
const LEAD = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const LEAD2 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
const DEAL = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
const ACC_DEAL = 'cccccccc-cccc-cccc-cccc-ccccccccccc1';
const ACC_LEAD = 'cccccccc-cccc-cccc-cccc-ccccccccccc2';
const ACC_EXPLICIT = 'cccccccc-cccc-cccc-cccc-ccccccccccc3';

const asSpark = { id: REP, org_id: ORG, client_id: SPARK_CLIENT_ID, role: 'executive', data_scope: 'own' } as any;
const asOther = { id: REP, org_id: ORG, client_id: null, role: 'executive', data_scope: 'own' } as any;
const asAdmin = { id: '33333333-3333-3333-3333-333333333333', org_id: ORG, client_id: null, role: 'admin', data_scope: null } as any;

const draft = (over: any = {}) => ({ id: CLAIM, org_id: ORG, user_id: REP, status: 'draft', claim_no: 'EXP-1', currency: 'INR', total_amount: 0, submit_count: 0, ...over });
const insertsOf = (table: string) =>
  __mock.chainsFor(table).flatMap((c) => c.ops.filter((o) => o.method === 'insert').map((o) => o.args[0] as any));
const updatesOf = (table: string) =>
  __mock.chainsFor(table).flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any));
const selectOf = (c: RecordedChain) => String(c.ops.find((o) => o.method === 'select')?.args[0] ?? '');
const missingColumn = (col: string, table = 'expense_claims') =>
  ({ code: 'PGRST204', message: `Could not find the '${col}' column of '${table}' in the schema cache` });
const line = { category: 'food', amount: 100, item_date: '2026-10-05' };

/** The CRM tables a link resolves against. `deal` / `lead` are what the lookups find (undefined = no such row). */
function arrange(o: { claim?: any; deal?: any; lead?: any } = {}) {
  __mock.setDefault('expense_policies', { data: [] });
  __mock.setDefault('expense_claims', { data: [o.claim ?? draft()] });
  __mock.setDefault('expense_claim_items', { data: [] });
  __mock.setDefault('expense_approvals', { data: [] });
  __mock.setDefault('crm_accounts', { data: [{ id: ACC_EXPLICIT }] });
  __mock.setDefault('crm_deals', (c) => ({ data: selectOf(c) === 'id, name' ? [{ id: DEAL, name: 'Tower B steel' }] : (o.deal ? [o.deal] : []) }));
  __mock.setDefault('crm_leads', (c) => ({ data: selectOf(c).startsWith('id, first_name') ? [{ id: LEAD, first_name: 'Asha', last_name: 'Rao', company: 'Rao Infra' }] : (o.lead ? [o.lead] : []) }));
  __mock.setDefault('users', { data: [{ id: REP, name: 'Asha', supervisor_id: null, role: 'executive', org_role_id: null }] });
  __mock.setDefault('notifications', { data: [] });
}
const createWith = (actor: any, body: any) => svc.createClaim(actor, { items: [line], ...body });
const storedLinks = () => insertsOf('expense_claims')[0];

beforeEach(() => __mock.reset());

// ── the request body ────────────────────────────────────────────────────────
describe('createSchema', () => {
  it('accepts lead_id / deal_id and reads "" as clear', () => {
    const r: any = input.createSchema.parse({ lead_id: LEAD, deal_id: '' });
    expect(r.lead_id).toBe(LEAD);
    expect(r.deal_id).toBeNull();
    expect((input.createSchema.parse({ lead_id: null }) as any).lead_id).toBeNull();
  });
  it('names a bad id', () => {
    const r = input.createSchema.safeParse({ deal_id: 'nope' });
    expect(r.success ? 'OK' : input.firstProblem((r as any).error)).toBe('linked deal is not a valid id');
    const l = input.createSchema.safeParse({ lead_id: 'nope' });
    expect(l.success ? 'OK' : input.firstProblem((l as any).error)).toBe('linked lead is not a valid id');
  });
});

// ── resolveLinks: validation, derivation, mismatch, clearing ────────────────
describe('linking a claim to a lead and a deal', () => {
  it('derives the lead and the account from a deal given on its own', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD, account_id: ACC_DEAL } });
    await createWith(asSpark, { deal_id: DEAL });
    expect(storedLinks()).toMatchObject({ deal_id: DEAL, lead_id: LEAD, account_id: ACC_DEAL });
  });

  it('derives the account from a lead given on its own (no deal)', async () => {
    arrange({ lead: { id: LEAD, account_id: ACC_LEAD } });
    await createWith(asSpark, { lead_id: LEAD });
    expect(storedLinks()).toMatchObject({ lead_id: LEAD, account_id: ACC_LEAD });
    expect(storedLinks()).not.toHaveProperty('deal_id');
  });

  it('prefers the deal\'s account over the lead\'s', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD, account_id: ACC_DEAL }, lead: { id: LEAD, account_id: ACC_LEAD } });
    await createWith(asSpark, { lead_id: LEAD, deal_id: DEAL });
    expect(storedLinks()).toMatchObject({ lead_id: LEAD, deal_id: DEAL, account_id: ACC_DEAL });
  });

  it('keeps an explicit account (checked against the org) instead of deriving one', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD, account_id: ACC_DEAL } });
    await createWith(asSpark, { deal_id: DEAL, account_id: ACC_EXPLICIT });
    expect(storedLinks().account_id).toBe(ACC_EXPLICIT);
    expect(__mock.chainsFor('crm_accounts')).toHaveLength(1);
  });

  it('does not touch the account when the deal and lead have none', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD, account_id: null } });
    await createWith(asSpark, { deal_id: DEAL });
    expect(storedLinks()).not.toHaveProperty('account_id');
  });

  it('refuses a deal that belongs to another lead', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD2, account_id: null }, lead: { id: LEAD, account_id: null } });
    await expect(createWith(asSpark, { lead_id: LEAD, deal_id: DEAL })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION', message: 'That deal belongs to another lead' });
    expect(insertsOf('expense_claims')).toHaveLength(0);
  });

  it('accepts a lead on a deal that has no lead of its own', async () => {
    arrange({ deal: { id: DEAL, lead_id: null, account_id: null }, lead: { id: LEAD, account_id: null } });
    await createWith(asSpark, { lead_id: LEAD, deal_id: DEAL });
    expect(storedLinks()).toMatchObject({ lead_id: LEAD, deal_id: DEAL });
  });

  it('says so when the lead or the deal is not in the org', async () => {
    arrange();
    await expect(createWith(asSpark, { lead_id: LEAD })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION', message: 'Linked lead not found' });
    await expect(createWith(asSpark, { deal_id: DEAL })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION', message: 'Linked deal not found' });
    expect(insertsOf('expense_claims')).toHaveLength(0);
  });

  it('looks the lead and deal up in the actor\'s org and skips deleted ones', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD, account_id: null }, lead: { id: LEAD, account_id: null } });
    await createWith(asSpark, { lead_id: LEAD, deal_id: DEAL });
    for (const t of ['crm_leads', 'crm_deals']) {
      const c = __mock.chainsFor(t)[0];
      expect(c.eqs.org_id).toBe(ORG);
      expect(c.ops).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    }
  });

  it('null clears a link on update; clearing the deal leaves the lead alone', async () => {
    arrange({ claim: draft({ lead_id: LEAD, deal_id: DEAL }) });
    await svc.updateClaim(asSpark, CLAIM, { items: [line], deal_id: null });
    const u = updatesOf('expense_claims').find((x) => 'deal_id' in x)!;
    expect(u.deal_id).toBeNull();
    expect(u).not.toHaveProperty('lead_id');
    __mock.reset();
    arrange({ claim: draft({ lead_id: LEAD, deal_id: DEAL }) });
    await svc.updateClaim(asSpark, CLAIM, { items: [line], lead_id: null, deal_id: null });
    const both = updatesOf('expense_claims').find((x) => 'lead_id' in x)!;
    expect(both).toMatchObject({ lead_id: null, deal_id: null });
  });

  it('leaves the links alone when the body does not mention them', async () => {
    arrange({ claim: draft({ lead_id: LEAD, deal_id: DEAL }) });
    await svc.updateClaim(asSpark, CLAIM, { items: [line], title: 'renamed' });
    for (const u of updatesOf('expense_claims')) { expect(u).not.toHaveProperty('lead_id'); expect(u).not.toHaveProperty('deal_id'); }
  });

  it('stores nothing for a client that is not connected-B2B, and does not even look the rows up', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD, account_id: ACC_DEAL }, lead: { id: LEAD, account_id: null } });
    await createWith(asOther, { lead_id: LEAD, deal_id: DEAL });
    for (const k of ['lead_id', 'deal_id', 'account_id']) expect(storedLinks()).not.toHaveProperty(k);
    expect(__mock.chainsFor('crm_leads')).toHaveLength(0);
    expect(__mock.chainsFor('crm_deals')).toHaveLength(0);
    // ...and an unknown id from such a client is not an error either
    __mock.reset();
    arrange();
    await expect(createWith(asOther, { lead_id: LEAD })).resolves.toBeDefined();
  });
});

// ── a tenant database without the new columns ───────────────────────────────
describe('a database without the lead_id / deal_id columns', () => {
  it('retries a create without ONLY the two new columns, keeping the older links', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD, account_id: ACC_DEAL } });
    __mock.queue('expense_claims', { error: missingColumn('lead_id') });
    const c: any = await createWith(asSpark, { clarification: 'Site visit', deal_id: DEAL });
    expect(c.id).toBe(CLAIM);
    const inserts = insertsOf('expense_claims');
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toMatchObject({ lead_id: LEAD, deal_id: DEAL, account_id: ACC_DEAL, clarification: 'Site visit' });
    expect(inserts[1]).toMatchObject({ account_id: ACC_DEAL, clarification: 'Site visit', status: 'draft', user_id: REP });
    expect(inserts[1]).not.toHaveProperty('lead_id');
    expect(inserts[1]).not.toHaveProperty('deal_id');
    expect(insertsOf('expense_claim_items')).toHaveLength(1);
  });

  it('falls back to dropping every link key when that is not enough', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD, account_id: ACC_DEAL } });
    __mock.queue('expense_claims', { error: missingColumn('lead_id') });
    __mock.queue('expense_claims', { error: missingColumn('account_id') });
    await createWith(asSpark, { clarification: 'x', deal_id: DEAL });
    const inserts = insertsOf('expense_claims');
    expect(inserts).toHaveLength(3);
    for (const k of svc.CLAIM_LINK_KEYS) expect(inserts[2]).not.toHaveProperty(k);
    expect(inserts[2]).toMatchObject({ status: 'draft', user_id: REP });
  });

  it('drops every link key straight away when the missing column is an older one', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD, account_id: null } });
    __mock.queue('expense_claims', { error: missingColumn('form_submission_id') });
    await createWith(asSpark, { clarification: 'x', deal_id: DEAL });
    const inserts = insertsOf('expense_claims');
    expect(inserts).toHaveLength(2);
    for (const k of svc.CLAIM_LINK_KEYS) expect(inserts[1]).not.toHaveProperty(k);
  });

  it('an update degrades the same way and still saves the title and lines', async () => {
    arrange({ claim: draft(), lead: { id: LEAD, account_id: ACC_LEAD } });
    __mock.queue('expense_claims', { data: [draft()] });                  // loadOwnClaim
    __mock.queue('expense_claims', { error: missingColumn('lead_id') });   // the update
    await svc.updateClaim(asSpark, CLAIM, { title: 'T', items: [line], lead_id: LEAD, clarification: 'why' });
    const ups = updatesOf('expense_claims').filter((x) => 'total_amount' in x);
    expect(ups).toHaveLength(2);
    expect(ups[0]).toMatchObject({ lead_id: LEAD, clarification: 'why', account_id: ACC_LEAD });
    expect(ups[1]).toMatchObject({ title: 'T', clarification: 'why', account_id: ACC_LEAD });
    expect(ups[1]).not.toHaveProperty('lead_id');
  });

  it('a real (non-column) error is still reported, not retried', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD, account_id: null } });
    __mock.queue('expense_claims', { error: { code: '23503', message: 'violates foreign key' } });
    await expect(createWith(asSpark, { deal_id: DEAL })).rejects.toMatchObject({ statusCode: 400 });
    expect(insertsOf('expense_claims')).toHaveLength(1);
  });
});

// ── names on the claim JSON ─────────────────────────────────────────────────
describe('stampLinks', () => {
  it('adds lead_name and deal_name (person, else company, else email) in two batched lookups', async () => {
    __mock.setDefault('crm_leads', { data: [
      { id: 'l1', first_name: 'Asha', last_name: 'Rao', company: 'Rao Infra', email: 'a@x.in' },
      { id: 'l2', first_name: null, last_name: null, company: 'Patel Steel', email: 'p@x.in' },
      { id: 'l3', first_name: ' ', last_name: null, company: null, email: 'solo@x.in' },
    ] });
    __mock.setDefault('crm_deals', { data: [{ id: 'd1', name: 'Tower B' }] });
    const rows = await svc.stampLinks([
      { id: 'c1', lead_id: 'l1', deal_id: 'd1' }, { id: 'c2', lead_id: 'l2' }, { id: 'c3', lead_id: 'l3', deal_id: 'gone' }, { id: 'c4' },
      { id: 'c5', lead_id: 'l1' },
    ]);
    expect(rows[0]).toMatchObject({ lead_id: 'l1', deal_id: 'd1', lead_name: 'Asha Rao', deal_name: 'Tower B' });
    expect(rows[1]).toMatchObject({ lead_name: 'Patel Steel', deal_id: null, deal_name: null });
    expect(rows[2]).toMatchObject({ lead_name: 'solo@x.in', deal_name: null });
    expect(rows[3]).toMatchObject({ lead_id: null, deal_id: null, lead_name: null, deal_name: null });
    expect(__mock.chainsFor('crm_leads')).toHaveLength(1);
    expect(__mock.chainsFor('crm_deals')).toHaveLength(1);
  });

  it('never fails the list when a lookup throws or errors', async () => {
    __mock.setDefault('crm_leads', () => { throw new Error('connection reset'); });
    __mock.setDefault('crm_deals', { error: { message: 'boom' } });
    const rows = await svc.stampLinks([{ id: 'c1', lead_id: 'l1', deal_id: 'd1' }]);
    expect(rows[0]).toMatchObject({ lead_id: 'l1', deal_id: 'd1', lead_name: null, deal_name: null });
  });

  it('is on the detail, create and patch responses (they all go through getClaim)', async () => {
    arrange({ claim: draft({ lead_id: LEAD, deal_id: DEAL }) });
    const c: any = await svc.getClaim(asSpark, CLAIM);
    expect(c).toMatchObject({ lead_id: LEAD, deal_id: DEAL, lead_name: 'Asha Rao', deal_name: 'Tower B steel' });
    const made: any = await createWith(asSpark, {});
    expect(made).toHaveProperty('lead_name');
    const patched: any = await svc.updateClaim(asSpark, CLAIM, { items: [line] });
    expect(patched).toHaveProperty('deal_name');
  });
});

// ── filters: my claims, the admin list and the CSV share them ───────────────
describe('lead / deal filters', () => {
  it('listMyClaims filters by real ids only', async () => {
    arrange();
    await svc.listMyClaims(asSpark, undefined, { lead_id: LEAD, deal_id: DEAL });
    const c = __mock.chainsFor('expense_claims')[0];
    expect(c.eqs).toMatchObject({ org_id: ORG, user_id: REP, lead_id: LEAD, deal_id: DEAL });
    __mock.reset(); arrange();
    await svc.listMyClaims(asSpark, undefined, { lead_id: 'not-a-uuid', deal_id: '' });
    expect(__mock.chainsFor('expense_claims')[0].eqs).not.toHaveProperty('lead_id');
    expect(__mock.chainsFor('expense_claims')[0].eqs).not.toHaveProperty('deal_id');
  });

  it('listMyClaims answers nothing (not a 500) on a database without the columns', async () => {
    arrange();
    __mock.queue('expense_claims', { error: missingColumn('lead_id') });
    expect(await svc.listMyClaims(asSpark, undefined, { lead_id: LEAD })).toEqual([]);
    __mock.reset(); arrange();
    __mock.queue('expense_claims', { error: { message: 'boom', code: 'XX000' } });
    await expect(svc.listMyClaims(asSpark, undefined, { lead_id: LEAD })).rejects.toMatchObject({ statusCode: 500 });
  });

  it('the admin list, the summary and the CSV all apply the same filters', async () => {
    arrange();
    await reports.listAllClaims(asAdmin, { lead_id: LEAD, deal_id: DEAL });
    await reports.claimsCsv(asAdmin, { lead_id: LEAD, deal_id: DEAL });
    await reports.claimsSummary(asAdmin, { lead_id: LEAD, deal_id: DEAL });
    const claimChains = __mock.chainsFor('expense_claims');
    expect(claimChains).toHaveLength(3);
    for (const c of claimChains) expect(c.eqs).toMatchObject({ lead_id: LEAD, deal_id: DEAL });
  });

  it('ignores an invalid id instead of failing', async () => {
    arrange();
    await reports.listAllClaims(asAdmin, { lead_id: 'x\');drop', deal_id: 'nope' });
    const c = __mock.chainsFor('expense_claims')[0];
    expect(c.eqs).not.toHaveProperty('lead_id');
    expect(c.eqs).not.toHaveProperty('deal_id');
  });

  it('empty list on a database without the columns', async () => {
    arrange();
    __mock.queue('expense_claims', { error: missingColumn('deal_id') });
    expect(await reports.listAllClaims(asAdmin, { deal_id: DEAL })).toMatchObject({ rows: [], total: 0 });
  });

  it('the CSV gains Lead and Deal columns after the existing ones', async () => {
    arrange({ claim: draft({ status: 'submitted', lead_id: LEAD, deal_id: DEAL }) });
    __mock.setDefault('expense_claim_items', { data: [{ claim_id: CLAIM, category: 'food', amount: 100 }] });
    const csv = await reports.claimsCsv(asAdmin, { lead_id: LEAD });
    const [head, row] = csv.split('\n');
    expect(head.endsWith('Clarification,Account,Form,Form ref,Form date,Lead,Deal')).toBe(true);
    expect(row.endsWith('Asha Rao,Tower B steel')).toBe(true);
  });

  it('a CSV with no link at all keeps exactly the columns it always had', async () => {
    arrange({ claim: draft({ status: 'submitted' }) });
    const csv = await reports.claimsCsv(asAdmin, {});
    expect(csv.split('\n')[0]).not.toMatch(/Lead|Deal|Clarification/);
  });
});

describe('the expense routes', () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = asSpark; next(); });
  app.use('/expenses', expensesRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message, code: err.code }));

  it('POST /claims keeps lead_id / deal_id (the schema must not strip them)', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD, account_id: null } });
    const res = await request(app).post('/expenses/claims').send({ deal_id: DEAL, items: [line] });
    expect(res.status).toBe(200);
    expect(storedLinks()).toMatchObject({ deal_id: DEAL, lead_id: LEAD });
    expect(res.body.data).toHaveProperty('deal_name');
  });

  it('POST /claims turns a mismatched deal into a 400', async () => {
    arrange({ deal: { id: DEAL, lead_id: LEAD2, account_id: null }, lead: { id: LEAD, account_id: null } });
    const res = await request(app).post('/expenses/claims').send({ lead_id: LEAD, deal_id: DEAL, items: [line] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'That deal belongs to another lead', code: 'VALIDATION' });
  });

  it('PATCH /claims/:id with "" clears the deal', async () => {
    arrange({ claim: draft({ lead_id: LEAD, deal_id: DEAL }) });
    const res = await request(app).patch(`/expenses/claims/${CLAIM}`).send({ deal_id: '', items: [line] });
    expect(res.status).toBe(200);
    expect(updatesOf('expense_claims').find((x) => 'deal_id' in x)!.deal_id).toBeNull();
  });

  it('GET /claims?lead_id=&deal_id= filters; an invalid id is ignored', async () => {
    arrange();
    await request(app).get(`/expenses/claims?lead_id=${LEAD}&deal_id=${DEAL}`);
    expect(__mock.chainsFor('expense_claims')[0].eqs).toMatchObject({ lead_id: LEAD, deal_id: DEAL });
    __mock.reset(); arrange();
    const res = await request(app).get('/expenses/claims?lead_id=zzz');
    expect(res.status).toBe(200);
    expect(__mock.chainsFor('expense_claims')[0].eqs).not.toHaveProperty('lead_id');
  });

  it('GET /claims/all and /claims/export take the same filters', async () => {
    const adminApp = express();
    adminApp.use((req: any, _res, next) => { req.user = asAdmin; next(); });
    adminApp.use('/expenses', expensesRouter);
    arrange();
    const all = await request(adminApp).get(`/expenses/claims/all?lead_id=${LEAD}&deal_id=${DEAL}`);
    expect(all.status).toBe(200);
    const exp = await request(adminApp).get(`/expenses/claims/export?lead_id=${LEAD}&deal_id=${DEAL}`);
    expect(exp.status).toBe(200);
    const chains = __mock.chainsFor('expense_claims');
    expect(chains).toHaveLength(2);
    for (const c of chains) expect(c.eqs).toMatchObject({ lead_id: LEAD, deal_id: DEAL });
  });
});

// ── the roll-up ─────────────────────────────────────────────────────────────
const claim = (id: string, status: string, total: number, over: any = {}) =>
  ({ id, org_id: ORG, user_id: REP, claim_no: `EXP-${id}`, title: `claim ${id}`, status, total_amount: total, currency: 'INR', created_at: '2026-10-01T00:00:00Z', lead_id: LEAD, deal_id: DEAL, ...over });

interface RollArrange {
  claims?: any[]; lead?: any | null; deal?: any | null; deals?: any[]; activities?: any[] | Error;
}
function arrangeRollup(o: RollArrange = {}) {
  __mock.setDefault('expense_claims', { data: o.claims ?? [] });
  __mock.setDefault('crm_leads', (c) => ({ data: selectOf(c).startsWith('id, first_name') ? [{ id: LEAD, first_name: 'Asha', last_name: 'Rao' }] : (o.lead === null ? [] : [o.lead ?? { id: LEAD, client_id: null }]) }));
  __mock.setDefault('crm_deals', (c) => {
    const s = selectOf(c);
    if (s === 'id, name') return { data: [{ id: DEAL, name: 'Tower B steel' }] };
    if (s === 'amount, currency') return { data: o.deals ?? [] };
    return { data: o.deal === null ? [] : [o.deal ?? { id: DEAL, client_id: null, lead_id: LEAD, amount: 10000, currency: 'INR' }] };
  });
  __mock.setDefault('crm_activities', () => (o.activities instanceof Error ? { error: { message: 'boom' } } : { data: o.activities ?? [] }));
  __mock.setDefault('users', { data: [{ id: REP, name: 'Asha' }, { id: OTHER_REP, name: 'Dev' }] });
}
const MIX = [
  claim('1', 'draft', 100), claim('2', 'submitted', 200), claim('3', 'approved', 300, { approved_amount: 250 }),
  claim('4', 'reimbursed', 400), claim('5', 'rejected', 50), claim('6', 'cancelled', 999),
];

describe('totalsOf / spentPct', () => {
  it('maps statuses to buckets and ignores cancelled', () => {
    expect(rollup.totalsOf(MIX)).toEqual({ claim_count: 5, spent_amount: 850, pending_amount: 200, draft_amount: 100, rejected_amount: 50 });
  });
  it('counts an approved claim at its approved amount, else the claimed total', () => {
    expect(rollup.totalsOf([claim('a', 'approved', 300, { approved_amount: 120.5 }), claim('b', 'approved', 80, { approved_amount: null })]).spent_amount).toBe(200.5);
  });
  it('percentage is rounded to one decimal, null without a value', () => {
    expect(rollup.spentPct(3000, 10000)).toBe(30);
    expect(rollup.spentPct(1000, 3000)).toBe(33.3);
    expect(rollup.spentPct(500, null)).toBeNull();
    expect(rollup.spentPct(500, 0)).toBeNull();
  });
  it('no claims is all zeros', () => {
    expect(rollup.totalsOf([])).toEqual({ claim_count: 0, spent_amount: 0, pending_amount: 0, draft_amount: 0, rejected_amount: 0 });
  });
});

describe('deal roll-up', () => {
  it('3,000 spent on a 10,000 deal is 30%', async () => {
    arrangeRollup({ claims: [claim('1', 'approved', 2000), claim('2', 'submitted', 1000)] });
    const r = await rollup.dealExpenseRollup(asAdmin, DEAL);
    expect(r).toMatchObject({
      currency: 'INR', opportunity_value: 10000, spent_pct_of_value: 30,
      totals: { claim_count: 2, spent_amount: 3000, pending_amount: 1000, draft_amount: 0, rejected_amount: 0 },
    });
  });

  it('shapes each claim row exactly as the contract says', async () => {
    arrangeRollup({ claims: [claim('1', 'submitted', 1000, { user_id: REP })] });
    const r = await rollup.dealExpenseRollup(asAdmin, DEAL);
    expect(r.claims).toEqual([{
      id: '1', claim_no: 'EXP-1', title: 'claim 1', status: 'submitted', total_amount: 1000, currency: 'INR',
      created_at: '2026-10-01T00:00:00Z', user_id: REP, user_name: 'Asha', lead_id: LEAD, deal_id: DEAL, deal_name: 'Tower B steel',
    }]);
    expect(Object.keys(r).sort()).toEqual(['claims', 'currency', 'opportunity_value', 'spent_pct_of_value', 'totals', 'visit_count']);
  });

  it('queries the deal\'s claims in the actor\'s org and client scope, skipping cancelled', async () => {
    arrangeRollup({ claims: MIX });
    const r = await rollup.dealExpenseRollup({ ...asAdmin, client_id: SPARK_CLIENT_ID }, DEAL);
    const c = __mock.chainsFor('expense_claims')[0];
    expect(c.eqs).toMatchObject({ org_id: ORG, deal_id: DEAL, client_id: SPARK_CLIENT_ID });
    expect(c.ops).toContainEqual({ method: 'neq', args: ['status', 'cancelled'] });
    expect(r.claims.find((x) => x.status === 'cancelled')).toBeUndefined();
  });

  it('a deal with no amount has no percentage; no claims is zeros', async () => {
    arrangeRollup({ claims: [], deal: { id: DEAL, client_id: null, lead_id: LEAD, amount: null, currency: 'USD' } });
    const r = await rollup.dealExpenseRollup(asAdmin, DEAL);
    expect(r).toMatchObject({ currency: 'USD', opportunity_value: null, spent_pct_of_value: null, visit_count: 0, claims: [],
      totals: { claim_count: 0, spent_amount: 0, pending_amount: 0, draft_amount: 0, rejected_amount: 0 } });
  });

  it('counts completed site visits and meetings on the deal and its lead (carrier types included)', async () => {
    arrangeRollup({
      claims: [],
      activities: [
        { type: 'site_visit' }, { type: 'meeting' }, { type: 'call' }, { type: 'task' },
        { type: 'note', metadata: { activity_type: 'site_visit' } }, { type: 'note', metadata: null },
      ],
    });
    const r = await rollup.dealExpenseRollup(asAdmin, DEAL);
    expect(r.visit_count).toBe(3);
    const c = __mock.chainsFor('crm_activities')[0];
    expect(c.eqs.org_id).toBe(ORG);
    expect(c.ors[0]).toBe(`deal_id.eq.${DEAL},lead_id.eq.${LEAD}`);
    expect(c.ops).toContainEqual({ method: 'in', args: ['status', ['completed', 'done']] });
    expect(c.ops).toContainEqual({ method: 'is', args: ['deleted_at', null] });
  });

  it('a deal with no lead counts only its own activities', async () => {
    arrangeRollup({ deal: { id: DEAL, client_id: null, lead_id: null, amount: 100, currency: 'INR' }, activities: [{ type: 'meeting' }] });
    const r = await rollup.dealExpenseRollup(asAdmin, DEAL);
    expect(r.visit_count).toBe(1);
    expect(__mock.chainsFor('crm_activities')[0].eqs.deal_id).toBe(DEAL);
  });

  it('a failing visit lookup is 0, not an error', async () => {
    arrangeRollup({ claims: [claim('1', 'approved', 500)], activities: new Error('x') });
    const r = await rollup.dealExpenseRollup(asAdmin, DEAL);
    expect(r.visit_count).toBe(0);
    expect(r.totals.spent_amount).toBe(500);
  });

  it('404 for a deal that is not there, a bad id, or another client\'s deal', async () => {
    arrangeRollup({ deal: null });
    await expect(rollup.dealExpenseRollup(asAdmin, DEAL)).rejects.toMatchObject({ statusCode: 404 });
    await expect(rollup.dealExpenseRollup(asAdmin, 'not-a-uuid')).rejects.toMatchObject({ statusCode: 404 });
    arrangeRollup({ deal: { id: DEAL, client_id: 'other-client', lead_id: LEAD, amount: 1, currency: 'INR' } });
    await expect(rollup.dealExpenseRollup({ ...asAdmin, client_id: SPARK_CLIENT_ID }, DEAL)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('lead roll-up', () => {
  it('sums the lead\'s deals for the opportunity value and buckets every claim status', async () => {
    arrangeRollup({ claims: MIX, deals: [{ amount: 4000, currency: 'INR' }, { amount: '6000.00', currency: 'INR' }, { amount: null, currency: 'INR' }] });
    const r = await rollup.leadExpenseRollup(asAdmin, LEAD);
    expect(r.opportunity_value).toBe(10000);
    expect(r.totals).toEqual({ claim_count: 5, spent_amount: 850, pending_amount: 200, draft_amount: 100, rejected_amount: 50 });
    expect(r.spent_pct_of_value).toBe(8.5);
    expect(r.claims.map((c) => c.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(__mock.chainsFor('expense_claims')[0].eqs).toMatchObject({ org_id: ORG, lead_id: LEAD });
    const dealsQ = __mock.chainsFor('crm_deals').find((c) => selectOf(c) === 'amount, currency')!;
    expect(dealsQ.eqs).toMatchObject({ org_id: ORG, lead_id: LEAD });
    expect(dealsQ.ops).toContainEqual({ method: 'is', args: ['deleted_at', null] });
  });

  it('no deals (or zero-value deals) means no value and no percentage', async () => {
    arrangeRollup({ claims: [claim('1', 'approved', 700)], deals: [] });
    const r = await rollup.leadExpenseRollup(asAdmin, LEAD);
    expect(r).toMatchObject({ opportunity_value: null, spent_pct_of_value: null });
    expect(r.totals.spent_amount).toBe(700);
    __mock.reset();
    arrangeRollup({ claims: [], deals: [{ amount: 0, currency: 'INR' }] });
    expect((await rollup.leadExpenseRollup(asAdmin, LEAD)).opportunity_value).toBeNull();
  });

  it('counts the lead\'s own completed visits only', async () => {
    arrangeRollup({ activities: [{ type: 'site_visit' }, { type: 'site_visit' }, { type: 'email' }] });
    const r = await rollup.leadExpenseRollup(asAdmin, LEAD);
    expect(r.visit_count).toBe(2);
    expect(__mock.chainsFor('crm_activities')[0].eqs.lead_id).toBe(LEAD);
  });

  it('works for a client that is not connected-B2B', async () => {
    arrangeRollup({ claims: [] });
    const r = await rollup.leadExpenseRollup(asOther, LEAD);
    expect(r.totals.claim_count).toBe(0);
    expect(r.claims).toEqual([]);
  });

  it('404 for a lead that is not visible', async () => {
    arrangeRollup({ lead: null });
    await expect(rollup.leadExpenseRollup(asAdmin, LEAD)).rejects.toMatchObject({ statusCode: 404, message: 'Lead not found' });
    arrangeRollup({ lead: { id: LEAD, client_id: 'other-client' } });
    await expect(rollup.leadExpenseRollup({ ...asAdmin, client_id: SPARK_CLIENT_ID }, LEAD)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('who sees the per-claim rows', () => {
  const mixed = [claim('1', 'submitted', 100, { user_id: REP }), claim('2', 'approved', 400, { user_id: OTHER_REP })];

  it('an admin sees every claim', async () => {
    arrangeRollup({ claims: mixed });
    const r = await rollup.dealExpenseRollup(asAdmin, DEAL);
    expect(r.claims.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('a rep sees only their own rows but the full totals', async () => {
    arrangeRollup({ claims: mixed });
    const r = await rollup.dealExpenseRollup(asSpark, DEAL);
    expect(r.claims.map((c) => c.id)).toEqual(['1']);
    expect(r.totals).toMatchObject({ claim_count: 2, spent_amount: 500, pending_amount: 100 });
  });

  it('an own-scope sub-admin (a field rep with an admin-ish role) is not an approver here either', async () => {
    arrangeRollup({ claims: mixed });
    const r = await rollup.leadExpenseRollup({ ...asSpark, role: 'sub_admin', data_scope: 'own' }, LEAD);
    expect(r.claims.map((c) => c.user_id)).toEqual([REP]);
    expect(r.totals.claim_count).toBe(2);
  });

  it('a team-scope admin role sees them all', async () => {
    arrangeRollup({ claims: mixed });
    const r = await rollup.leadExpenseRollup({ ...asSpark, role: 'sub_admin', data_scope: 'team' }, LEAD);
    expect(r.claims).toHaveLength(2);
  });
});

describe('a database without the lead_id / deal_id columns', () => {
  it('answers zeros and an empty list, never a 500', async () => {
    arrangeRollup({ claims: [], deals: [{ amount: 1000, currency: 'INR' }] });
    __mock.queue('expense_claims', { error: missingColumn('lead_id') });
    const r = await rollup.leadExpenseRollup(asAdmin, LEAD);
    expect(r).toMatchObject({ claims: [], opportunity_value: 1000, spent_pct_of_value: 0, totals: { claim_count: 0, spent_amount: 0 } });
    __mock.queue('expense_claims', { error: { code: '42703', message: 'column expense_claims.deal_id does not exist' } });
    const d = await rollup.dealExpenseRollup(asAdmin, DEAL);
    expect(d.claims).toEqual([]);
    expect(d.totals.claim_count).toBe(0);
  });

  it('any other database error is still an error', async () => {
    arrangeRollup();
    __mock.queue('expense_claims', { error: { code: 'XX000', message: 'disk on fire' } });
    await expect(rollup.dealExpenseRollup(asAdmin, DEAL)).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe('the CRM routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/crm', crmRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message }));

  it('GET /crm/leads/:id/expenses wraps the roll-up as { success, data }', async () => {
    arrangeRollup({ claims: [claim('1', 'approved', 250)], deals: [{ amount: 1000, currency: 'INR' }] });
    const res = await request(app).get(`/crm/leads/${LEAD}/expenses`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ currency: 'INR', opportunity_value: 1000, spent_pct_of_value: 25, totals: { claim_count: 1, spent_amount: 250 } });
    expect(res.body.data.claims).toHaveLength(1);
  });

  it('GET /crm/deals/:id/expenses wraps the roll-up and 404s an unknown deal', async () => {
    arrangeRollup({ claims: [claim('1', 'submitted', 3000)] });
    const ok = await request(app).get(`/crm/deals/${DEAL}/expenses`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ opportunity_value: 10000, spent_pct_of_value: 30, totals: { pending_amount: 3000 } });
    arrangeRollup({ deal: null });
    const missing = await request(app).get(`/crm/deals/${DEAL}/expenses`);
    expect(missing.status).toBe(404);
  });
});
