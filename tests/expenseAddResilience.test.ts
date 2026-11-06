/**
 * "API error" when adding an expense — the server side of the fix.
 *
 *   - input the apps / people really send is read, not refused: "1,250.50", "99,50", "₹ 300", ISO timestamps,
 *     day-first dates, empty ids, "Other" as a category;
 *   - input that is wrong is refused with a sentence naming the line and the field — never a bare zod message,
 *     never a 500 (a date like 2026-02-31 used to pass the YYYY-MM-DD regex and die in Postgres);
 *   - a tenant database that never ran an OPTIONAL migration (the connected-B2B link columns, the GST columns)
 *     no longer fails every create that mentions those columns: the write is retried once without them;
 *   - Postgres errors that are about the caller's input come back as 4xx with a reason;
 *   - the receipt photo reader can no longer hold an upload open until the app gives up.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as svc from '../src/services/expenses/expenses.service';
import * as input from '../src/services/expenses/expenseInput';
import * as dbe from '../src/services/expenses/dbErrors';
import { sniff, withTimeout } from '../src/services/expenses/receipts.service';
import { usableAmount } from '../src/services/expenses/receiptScan.service';
import { SPARK_CLIENT_ID } from '../src/lib/b2bClients';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const expensesRouter = require('../src/routes/expenses.routes').default as express.Router;

const ORG = '00000000-0000-0000-0000-0000000000aa';
const REP = '11111111-1111-1111-1111-111111111111';
const CLAIM = '44444444-4444-4444-4444-444444444444';
const FORM_ENTRY = '66666666-6666-6666-6666-666666666666';
const asSpark = { id: REP, org_id: ORG, client_id: SPARK_CLIENT_ID, role: 'executive', data_scope: 'own' } as any;
const asOther = { id: REP, org_id: ORG, client_id: null, role: 'executive', data_scope: 'own' } as any;

const draft = (over: any = {}) => ({ id: CLAIM, org_id: ORG, user_id: REP, status: 'draft', claim_no: 'EXP-1', currency: 'INR', total_amount: 0, submit_count: 0, ...over });
const insertsOf = (table: string) =>
  __mock.chainsFor(table).flatMap((c) => c.ops.filter((o) => o.method === 'insert').map((o) => o.args[0] as any));
const updatesOf = (table: string) =>
  __mock.chainsFor(table).flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any));

function arrange(claim: any = draft(), items: any[] = []) {
  __mock.setDefault('expense_policies', { data: [] });
  __mock.setDefault('expense_claims', { data: [claim] });
  __mock.setDefault('expense_claim_items', { data: items });
  __mock.setDefault('expense_approvals', { data: [] });
  __mock.setDefault('form_submissions', { data: [{ id: FORM_ENTRY }] });
  __mock.setDefault('users', { data: [{ id: REP, supervisor_id: null, role: 'executive', org_role_id: null, name: 'Asha' }] });
  __mock.setDefault('notifications', { data: [] });
}

const missingColumn = (col: string, table = 'expense_claims') =>
  ({ code: 'PGRST204', message: `Could not find the '${col}' column of '${table}' in the schema cache` });

beforeEach(() => __mock.reset());

// ── reading numbers and dates the way people write them ─────────────────────
describe('looseNumber', () => {
  it.each([
    ['1,250.50', 1250.5], ['99,50', 99.5], ['1,250', 1250], ['12,34,567', 1234567], ['1.250,75', 1250.75],
    ['₹ 300', 300], ['Rs. 45.5', 45.5], ['INR 1,000', 1000], ['  72 ', 72], ['٣٠٠', 300], ['1.250.000', 1250000], ['0', 0],
  ])('%s -> %s', (raw, want) => expect(input.looseNumber(raw)).toBe(want));

  it('treats a blank as "not given" and leaves real numbers and nonsense alone', () => {
    expect(input.looseNumber('')).toBeNull();
    expect(input.looseNumber('  ')).toBeNull();
    expect(input.looseNumber(12.5)).toBe(12.5);
    expect(input.looseNumber(null)).toBeNull();
    expect(input.looseNumber('abc')).toBe('abc');
    expect(input.looseNumber('1e5x')).toBe('1e5x');
  });
});

describe('dates', () => {
  it('accepts only real calendar days in a sane year', () => {
    expect(input.isRealYmd('2026-10-31')).toBe(true);
    expect(input.isRealYmd('2028-02-29')).toBe(true);
    expect(input.isRealYmd('2026-02-31')).toBe(false);
    expect(input.isRealYmd('2027-02-29')).toBe(false);
    expect(input.isRealYmd('2026-13-01')).toBe(false);
    expect(input.isRealYmd('0026-10-05')).toBe(false);
    expect(input.isRealYmd('2569-10-05')).toBe(false);     // a Buddhist-calendar year
  });

  it('reads timestamps and day-first dates', () => {
    expect(input.normalizeYmd('2026-10-05T18:30:00.000Z')).toBe('2026-10-05');
    expect(input.normalizeYmd('2026-1-5')).toBe('2026-01-05');
    expect(input.normalizeYmd('05/10/2026')).toBe('2026-10-05');
    expect(input.normalizeYmd('5-10-2026')).toBe('2026-10-05');
    expect(input.normalizeYmd('')).toBeNull();
    expect(input.normalizeYmd('yesterday')).toBe('yesterday');
  });

  it('keeps a scanned receipt date only when it is usable', () => {
    expect(input.usableScanDate('2026-10-05')).toBe('2026-10-05');
    expect(input.usableScanDate('05/10/2026')).toBe('2026-10-05');
    expect(input.usableScanDate('2026-02-30')).toBeNull();
    expect(input.usableScanDate('Oct 5')).toBeNull();
    expect(input.usableScanDate(null)).toBeNull();
  });
});

// ── the claim body schema ───────────────────────────────────────────────────
describe('createSchema', () => {
  const line = (o: any = {}) => ({ category: 'food', amount: 120, item_date: '2026-10-05', ...o });
  const ok = (body: any) => { const r = input.createSchema.safeParse(body); if (!r.success) throw new Error(input.firstProblem(r.error)); return r.data as any; };
  const bad = (body: any) => { const r = input.createSchema.safeParse(body); return r.success ? 'OK' : input.firstProblem(r.error); };

  it('reads what the apps send', () => {
    const d = ok({
      title: 'Pune trip', account_id: '', form_id: '', form_submission_id: '',
      items: [line({ id: '', amount: '1,250.50', item_date: '2026-10-05T10:00:00Z', category: ' Food ', receipt_url: '', description: 'tea\u0000 and snacks' }),
        line({ category: 'Other', amount: '₹ 99', distance_km: '', merchant: null })],
    });
    expect(d.account_id).toBeNull();
    expect(d.form_submission_id).toBeNull();
    expect(d.items[0]).toMatchObject({ amount: 1250.5, item_date: '2026-10-05', category: 'food', receipt_url: '', description: 'tea and snacks' });
    expect(d.items[0].id).toBeUndefined();
    expect(d.items[1]).toMatchObject({ category: 'misc', amount: 99, distance_km: null });
  });

  it('names the line and the field for every kind of mistake', () => {
    expect(bad({ items: [line(), line({ item_date: '2026-02-31' })] })).toBe('Expense 2: date must be a real day written as YYYY-MM-DD');
    expect(bad({ items: [line({ category: 'snacks' })] })).toMatch(/^Expense 1: category must be one of: mileage, travel, food/);
    expect(bad({ items: [line({ amount: 'lots' })] })).toBe('Expense 1: amount must be a number');
    expect(bad({ items: [line({ amount: -5 })] })).toBe("Expense 1: amount can't be negative");
    expect(bad({ items: [line({ amount: 99999999 })] })).toBe('Expense 1: amount can be at most 10000000');
    expect(bad({ items: [line({ description: 'x'.repeat(501) })] })).toBe('Expense 1: description is too long (500 characters at most)');
    expect(bad({ items: [line({ receipt_url: 'javascript:alert(1)' })] })).toBe('Expense 1: The receipt must be a web link');
    expect(bad({ items: [line({ id: 'not-a-uuid' })] })).toBe('Expense 1: id is not a valid id');
    expect(bad({ items: [line({ supplier_gstin: '123' })] })).toBe('Expense 1: supplier GSTIN is not valid');
    expect(bad({ items: [{ amount: 5 }] })).toMatch(/^Expense 1: category/);
    expect(bad({ title: 't'.repeat(201) })).toBe('title is too long (200 characters at most)');
    expect(bad({ account_id: 'abc' })).toBe('linked account is not a valid id');
  });

  it('still accepts the plain shape an unchanged client sends', () => {
    expect(bad({ title: null, items: [line({ distance_km: null, odometer_start: null, vehicle_type: null })] })).toBe('OK');
    expect(bad({})).toBe('OK');
  });
});

// ── the router: bad input is a 400 with a sentence, never a 500 ─────────────
describe('POST /expenses/claims', () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = asOther; next(); });
  app.use('/expenses', expensesRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message, code: err.code }));

  it('refuses an impossible date with the line and the field', async () => {
    arrange();
    const res = await request(app).post('/expenses/claims').send({ items: [{ category: 'food', amount: 10, item_date: '2026-02-31' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Expense 1: date must be a real day written as YYYY-MM-DD');
    expect(insertsOf('expense_claims')).toHaveLength(0);
  });

  it('saves a claim whose amount arrives as a localized string', async () => {
    arrange();
    const res = await request(app).post('/expenses/claims').send({ items: [{ category: 'food', amount: '99,50', item_date: '2026-10-05' }] });
    expect(res.status).toBe(200);
    expect(insertsOf('expense_claims')[0]).toMatchObject({ total_amount: 99.5, status: 'draft' });
    expect(insertsOf('expense_claim_items')[0][0]).toMatchObject({ amount: 99.5, item_date: '2026-10-05' });
  });

  it('turns a Postgres date error into a 400, not a 500', async () => {
    arrange();
    __mock.queue('expense_claims', { error: { code: '22008', message: 'date/time field value out of range: "2026-02-31"' } });
    const res = await request(app).post('/expenses/claims').send({ items: [{ category: 'food', amount: 10 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a valid day/);
  });
});

// ── optional columns that a tenant database may not have ────────────────────
describe('createClaim on a database without the optional link columns', () => {
  it('retries a connected-B2B create once without the link columns', async () => {
    arrange();
    __mock.queue('expense_claims', { error: missingColumn('form_submission_id') });
    const c: any = await svc.createClaim(asSpark, {
      title: 'Visit', clarification: 'Client visit', account_id: null, form_submission_id: null,
      items: [{ category: 'food', amount: 100, item_date: '2026-10-05' }],
    });
    expect(c.id).toBe(CLAIM);
    const inserts = insertsOf('expense_claims');
    expect(inserts).toHaveLength(2);
    expect(Object.keys(inserts[0])).toEqual(expect.arrayContaining(['clarification', 'account_id', 'form_submission_id']));
    for (const k of svc.CLAIM_LINK_KEYS) expect(inserts[1]).not.toHaveProperty(k);
    expect(inserts[1]).toMatchObject({ title: 'Visit', status: 'draft', total_amount: 100, user_id: REP });
    expect(insertsOf('expense_claim_items')).toHaveLength(1);       // the lines are still saved
  });

  it('also recognises the raw Postgres wording (42703)', async () => {
    arrange();
    __mock.queue('expense_claims', { error: { code: '42703', message: 'column "clarification" of relation "expense_claims" does not exist' } });
    await svc.createClaim(asSpark, { clarification: 'x', items: [{ category: 'food', amount: 1 }] });
    expect(insertsOf('expense_claims')).toHaveLength(2);
  });

  it('retries only once, and only when the missing column is an optional one', async () => {
    arrange();
    __mock.queue('expense_claims', { error: missingColumn('distance_km') });
    await expect(svc.createClaim(asSpark, { clarification: 'x', items: [{ category: 'food', amount: 1 }] }))
      .rejects.toMatchObject({ statusCode: 500, code: 'DB' });
    expect(insertsOf('expense_claims')).toHaveLength(1);

    __mock.reset(); arrange();
    __mock.queue('expense_claims', { error: missingColumn('clarification') });
    __mock.queue('expense_claims', { error: missingColumn('title') });
    await expect(svc.createClaim(asSpark, { clarification: 'x', items: [{ category: 'food', amount: 1 }] })).rejects.toMatchObject({ statusCode: 500 });
    expect(insertsOf('expense_claims')).toHaveLength(2);
  });

  it('does not retry (or even write the link columns) for a client outside the B2B flow', async () => {
    arrange();
    await svc.createClaim(asOther, { clarification: 'x', account_id: null, items: [{ category: 'food', amount: 1 }] });
    const inserts = insertsOf('expense_claims');
    expect(inserts).toHaveLength(1);
    for (const k of svc.CLAIM_LINK_KEYS) expect(inserts[0]).not.toHaveProperty(k);
  });

  it('writes the link columns when the database has them', async () => {
    arrange();
    await svc.createClaim(asSpark, { clarification: ' Client visit ', form_submission_id: FORM_ENTRY, items: [{ category: 'food', amount: 1 }] });
    expect(insertsOf('expense_claims')).toHaveLength(1);
    expect(insertsOf('expense_claims')[0]).toMatchObject({ clarification: 'Client visit', form_submission_id: FORM_ENTRY });
  });

  it('retries the lines without the GST columns when this database has none', async () => {
    arrange();
    __mock.queue('expense_claim_items', { error: missingColumn('supplier_gstin', 'expense_claim_items') });
    await svc.createClaim(asOther, { items: [{ category: 'food', amount: 100, gst_rate: 5, supplier_gstin: null, itc_eligible: true } as any] });
    const rows = insertsOf('expense_claim_items');
    expect(rows).toHaveLength(2);
    expect(rows[0][0]).toHaveProperty('gst_rate', 5);
    expect(rows[1][0]).not.toHaveProperty('gst_rate');
    expect(rows[1][0]).not.toHaveProperty('itc_eligible');
    expect(rows[1][0]).toMatchObject({ category: 'food', amount: 100 });
  });

  it('removes the empty draft when its lines cannot be saved, so a retry does not leave two claims', async () => {
    arrange();
    __mock.queue('expense_claim_items', { error: { code: '22003', message: 'numeric field overflow' } });
    await expect(svc.createClaim(asOther, { items: [{ category: 'food', amount: 100 }] })).rejects.toMatchObject({ statusCode: 400 });
    const deletes = __mock.chainsFor('expense_claims').filter((c) => c.ops.some((o) => o.method === 'delete'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].eqs).toMatchObject({ id: CLAIM });
  });
});

describe('updateClaim and submitClaim on a database without the optional columns', () => {
  it('updates a claim without the link columns when they are missing', async () => {
    arrange(draft(), [{ id: 'l1', claim_id: CLAIM, category: 'food', amount: 10 }]);
    __mock.queue('expense_claims', { data: [draft()] });                                     // loadOwnClaim
    __mock.queue('expense_claims', { error: missingColumn('clarification') });               // the update (the next expense_claims query)
    await svc.updateClaim(asSpark, CLAIM, { clarification: 'Visit', items: [{ id: 'l1', category: 'food', amount: 12 } as any] });
    const updates = updatesOf('expense_claims');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0]).toHaveProperty('clarification', 'Visit');
    expect(updates[1]).not.toHaveProperty('clarification');
    expect(updates[1]).toHaveProperty('total_amount');
  });

  it('does not demand a clarification that this database has nowhere to keep', async () => {
    // a claim row read from a database without the clarification column has no such key at all
    arrange(draft(), [{ id: 'l1', claim_id: CLAIM, category: 'food', amount: 10, item_date: '2026-10-05' }]);
    await expect(svc.submitClaim(asSpark, CLAIM)).resolves.toBeDefined();
    expect(updatesOf('expense_claims').some((u) => u.status === 'submitted')).toBe(true);
  });

  it('still demands it where the column exists but is empty', async () => {
    arrange(draft({ clarification: null }), [{ id: 'l1', claim_id: CLAIM, category: 'food', amount: 10 }]);
    await expect(svc.submitClaim(asSpark, CLAIM)).rejects.toMatchObject({ statusCode: 400, code: 'CLARIFICATION_REQUIRED' });
  });

  it('submits for a claimant with no manager (the claim waits for the admins)', async () => {
    arrange(draft(), [{ id: 'l1', claim_id: CLAIM, category: 'food', amount: 10, item_date: '2026-10-05' }]);
    await expect(svc.submitClaim(asOther, CLAIM)).resolves.toBeDefined();
    expect(updatesOf('expense_claims').find((u) => u.status === 'submitted')).toMatchObject({ approver_id: null });
  });
});

// ── database error classification ───────────────────────────────────────────
describe('dbErrors', () => {
  it('spots an undefined column however it is worded', () => {
    expect(dbe.isUndefinedColumn({ code: 'PGRST204', message: 'x' })).toBe(true);
    expect(dbe.isUndefinedColumn({ code: '42703', message: 'x' })).toBe(true);
    expect(dbe.isUndefinedColumn({ message: 'column "account_id" does not exist' })).toBe(true);
    expect(dbe.isUndefinedColumn({ code: '23505', message: 'duplicate key' })).toBe(false);
    expect(dbe.isUndefinedColumn(null)).toBe(false);
  });

  it('names the missing column', () => {
    expect(dbe.missingColumn(missingColumn('form_id'))).toBe('form_id');
    expect(dbe.missingColumn({ message: 'column expense_claims.account_id does not exist' })).toBeNull();
    expect(dbe.missingColumn({ message: 'column "account_id" of relation "expense_claims" does not exist' })).toBe('account_id');
  });

  it('maps input-caused errors to 4xx with a reason, and leaves the rest a 500', () => {
    const status = (code: string, message = 'x') => dbe.dbFailure({ code, message }, 'save the claim').statusCode;
    expect(status('22008')).toBe(400);
    expect(status('22007')).toBe(400);
    expect(status('22003')).toBe(400);
    expect(status('22P02')).toBe(400);
    expect(status('22P05')).toBe(400);
    expect(status('23502', 'null value in column "user_id" violates not-null constraint')).toBe(400);
    expect(status('23503')).toBe(400);
    expect(status('23514')).toBe(400);
    expect(status('23505')).toBe(409);
    expect(status('57014')).toBe(500);
    expect(dbe.dbFailure({ code: '23502', message: 'null value in column "client_id" of relation "x"' }, 'save the claim').message).toContain('client id');
    expect(dbe.dbFailure({ code: '22003', message: 'x' }, 'save an expense line').message).toMatch(/^Couldn't save an expense line/);
  });
});

// ── receipts ────────────────────────────────────────────────────────────────
describe('receipt upload helpers', () => {
  it('gives up on a reader that never answers', async () => {
    jest.useFakeTimers();
    const never = new Promise<string>(() => undefined);
    const p = withTimeout(never, 50, 'receipt OCR');
    const assertion = expect(p).rejects.toThrow(/timed out after 50 ms/);
    jest.advanceTimersByTime(60);
    await assertion;
    jest.useRealTimers();
    await expect(withTimeout(Promise.resolve('ok'), 50, 'x')).resolves.toBe('ok');
  });

  it('recognises every HEIC brand an iPhone or Android camera writes', () => {
    const heif = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(12)]);
    for (const b of ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']) expect(sniff(heif(b))).toBe('image/heic');
    expect(sniff(heif('isom'))).toBeNull();
    expect(sniff(Buffer.from('plain text file here'))).toBeNull();
  });

  it('only keeps a scanned total that can be saved', () => {
    expect(usableAmount(250.456)).toBe(250.46);
    expect(usableAmount(0)).toBeNull();
    expect(usableAmount(-3)).toBeNull();
    expect(usableAmount(1e12)).toBeNull();
    expect(usableAmount(null)).toBeNull();
  });
});
