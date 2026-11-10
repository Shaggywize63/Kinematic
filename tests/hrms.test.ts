/**
 * HRMS phase 1 API rules, driven over HTTP through the real router and services against an in-memory PostgREST double.
 *
 * The double applies filters, ordering, paging, soft delete, the unique employee code and primary keys, cascades, the
 * hrms_next_code counter, and records every query, so the tests can assert both WHAT came back and WHAT was asked
 * (every query scoped to the caller's org with client_id null, no PAN or bank value ever written in the clear).
 */
import express from 'express';
import request from 'supertest';
import { logger } from '../src/lib/logger';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
interface Filter { t: 'eq' | 'neq' | 'is' | 'in' | 'not'; col: string; val: any }
interface Query {
  table: string; op: 'select' | 'insert' | 'update' | 'delete' | 'upsert'; filters: Filter[]; orders: Array<{ col: string; asc: boolean }>;
  rows?: Row[]; patch?: Row; returning: boolean; cols: string; count?: string; head?: boolean; range?: [number, number]; limit?: number;
  single?: boolean; maybe?: boolean; onConflict?: string;
}

// A function declaration, so it is hoisted above the jest.mock factory that builds the module's client from it.
function mockCreateFakeDb() {
  const tables: Record<string, Row[]> = {};
  const log: Query[] = [];
  const rpcLog: Array<{ name: string; args: any }> = [];
  const counters = new Map<string, number>();
  const missing = new Set<string>();
  const fails: Array<{ table: string; op: string; error: any; times: number }> = [];
  const crypto = require('crypto');

  const DEFAULTS: Record<string, () => Row> = {
    hrms_employees: () => ({
      last_name: '', status: 'onboarding', probation_months: 0, notice_days: 0, aadhaar_verified: false, uan_status: 'none', pf_member: false,
      pf_on_actual_wage: false, pt_applicable: false, lwf_applicable: false, tax_regime: 'new', pay_mode: 'bank', address: {},
      declaration: { status: 'not_submitted' }, deleted_at: null, father_name: null, marital_status: null, blood_group: null, emergency_contact: null,
      reporting_to_id: null, confirmation_date: null, last_working_date: null, shift_id: null, cost_centre: null, contract_end_date: null,
      pan_enc: null, aadhaar_last4: null, uan: null, pf_join_date: null, esic_ip: null, bank_enc: null, structure_id: null, annual_ctc: null,
      structure_overrides: null,
    }),
    hrms_entities: () => ({ address: {}, registrations: [], pan: null, tan: null, cin: null, gstin: null, signatory: null }),
    hrms_locations: () => ({ address: null, metro: false, holiday_list_id: null }),
    hrms_departments: () => ({ head_id: null }),
    hrms_designations: () => ({ grade: null }),
    hrms_employee_documents: () => ({ status: 'pending', mandatory: false, file_name: null }),
  };

  const matches = (r: Row, filters: Filter[]) => filters.every((f) => {
    const v = r[f.col] === undefined ? null : r[f.col];
    if (f.t === 'eq') return v === f.val;
    if (f.t === 'neq') return v !== f.val;
    if (f.t === 'is') return v === f.val;
    if (f.t === 'in') return (f.val as any[]).includes(v);
    return v !== null; // not(col, 'is', null)
  });
  const project = (r: Row, cols: string) => (cols === '*' ? { ...r } : Object.fromEntries(cols.split(',').map((c) => [c.trim(), r[c.trim()] ?? null])));

  const violates = (table: string, row: Row, existing: Row[]): any => {
    if (existing.some((r) => r.id === row.id)) return { code: '23505', message: `duplicate key value violates unique constraint "${table}_pkey"` };
    if (table === 'hrms_employees' && !row.deleted_at && existing.some((r) => !r.deleted_at && r.org_id === row.org_id && r.code === row.code)) {
      return { code: '23505', message: 'duplicate key value violates unique constraint "hrms_employees_org_code_uq"' };
    }
    return null;
  };

  const cascade = (table: string, gone: Row[]) => {
    if (table !== 'hrms_employees' || !gone.length) return;
    const ids = new Set(gone.map((g) => g.id));
    for (const t of ['hrms_employee_documents', 'hrms_employee_history']) tables[t] = (tables[t] ?? []).filter((r) => !ids.has(r.employee_id));
    for (const r of tables.hrms_employees ?? []) if (ids.has(r.reporting_to_id)) r.reporting_to_id = null;
    for (const r of tables.hrms_departments ?? []) if (ids.has(r.head_id)) r.head_id = null;
  };

  const exec = (q: Query): { data: any; error: any; count?: number | null } => {
    if (missing.has(q.table)) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${q.table}' in the schema cache` } };
    const fi = fails.findIndex((f) => f.table === q.table && f.op === q.op && f.times > 0);
    if (fi >= 0) { fails[fi]!.times -= 1; return { data: null, error: fails[fi]!.error }; }
    const rows = (tables[q.table] ??= []);
    let result: Row[] = [];
    let count: number | null = null;

    if (q.op === 'select') {
      let out = rows.filter((r) => matches(r, q.filters));
      count = out.length;
      for (const o of [...q.orders].reverse()) out = out.slice().sort((a, b) => (a[o.col] < b[o.col] ? (o.asc ? -1 : 1) : a[o.col] > b[o.col] ? (o.asc ? 1 : -1) : 0));
      if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
      if (q.limit !== undefined) out = out.slice(0, q.limit);
      if (q.head) return { data: null, error: null, count };
      result = out.map((r) => project(r, q.cols));
    } else if (q.op === 'insert' || q.op === 'upsert') {
      const fresh: Row[] = [];
      for (const input of q.rows ?? []) {
        const now = new Date().toISOString();
        let row: Row = { id: crypto.randomUUID(), ...(DEFAULTS[q.table]?.() ?? {}), created_at: now, updated_at: now, ...input };
        if (q.op === 'upsert') {
          const cols = (q.onConflict ?? 'id').split(',');
          const hit = rows.find((r) => cols.every((c) => r[c] === row[c]));
          if (hit) { Object.assign(hit, input); result.push(project(hit, q.cols)); continue; }
        }
        const bad = violates(q.table, row, rows.concat(fresh));
        if (bad) return { data: null, error: bad };
        fresh.push(row);
      }
      rows.push(...fresh);
      result = result.concat(fresh.map((r) => project(r, q.cols)));
    } else if (q.op === 'update') {
      const hit = rows.filter((r) => matches(r, q.filters));
      for (const r of hit) Object.assign(r, q.patch);
      result = hit.map((r) => project(r, q.cols));
    } else {
      const gone = rows.filter((r) => matches(r, q.filters));
      tables[q.table] = rows.filter((r) => !gone.includes(r));
      cascade(q.table, gone);
      result = gone.map((r) => project(r, q.cols));
    }

    if (!q.returning) return { data: null, error: null, count };
    if (q.single || q.maybe) {
      if (result.length === 1 || (q.maybe && result.length <= 1)) return { data: result[0] ?? null, error: null, count };
      return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
    }
    return { data: result, error: null, count };
  };

  const from = (table: string) => {
    const q: Query = { table, op: 'select', filters: [], orders: [], returning: false, cols: '*' };
    log.push(q);
    const b: any = {
      select(cols = '*', opts: any = {}) { q.cols = cols; q.returning = true; q.count = opts.count; q.head = opts.head; return b; },
      insert(rows: Row | Row[]) { q.op = 'insert'; q.rows = Array.isArray(rows) ? rows : [rows]; return b; },
      upsert(row: Row, opts: any = {}) { q.op = 'upsert'; q.rows = [row]; q.onConflict = opts.onConflict; q.returning = true; return b; },
      update(patch: Row) { q.op = 'update'; q.patch = patch; return b; },
      delete() { q.op = 'delete'; return b; },
      eq(col: string, val: any) { q.filters.push({ t: 'eq', col, val }); return b; },
      neq(col: string, val: any) { q.filters.push({ t: 'neq', col, val }); return b; },
      is(col: string, val: any) { q.filters.push({ t: 'is', col, val }); return b; },
      in(col: string, val: any[]) { q.filters.push({ t: 'in', col, val }); return b; },
      not(col: string, _op: string, _val: any) { q.filters.push({ t: 'not', col, val: null }); return b; },
      order(col: string, o: any = {}) { q.orders.push({ col, asc: o.ascending !== false }); return b; },
      range(a: number, z: number) { q.range = [a, z]; return b; },
      limit(n: number) { q.limit = n; return b; },
      single() { q.single = true; q.returning = true; return b; },
      maybeSingle() { q.maybe = true; q.returning = true; return b; },
      then(res: any, rej: any) { return Promise.resolve(exec(q)).then(res, rej); },
    };
    return b;
  };

  const rpc = (name: string, args: any) => {
    rpcLog.push({ name, args });
    if (missing.has(`rpc:${name}`)) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } });
    const key = `${args.p_org}:${args.p_name}`;
    const n = args.p_count ?? 1;
    const cur = counters.get(key) ?? 1;
    counters.set(key, cur + n);
    return Promise.resolve({ data: cur + n - 1, error: null });
  };

  return {
    client: { from, rpc, auth: { getUser: async () => ({ data: { user: null }, error: { message: 'mock' } }) } },
    tables, log, rpcLog, counters, missing, fails,
    reset() { for (const k of Object.keys(tables)) delete tables[k]; log.length = 0; rpcLog.length = 0; counters.clear(); missing.clear(); fails.length = 0; },
  };
}

jest.mock('../src/lib/supabase', () => {
  const db = mockCreateFakeDb();
  return { __db: db, supabaseAdmin: db.client, supabase: db.client, getUserClient: () => db.client };
});

import hrmsRouter from '../src/routes/hrms.routes';
import { decryptField } from '../src/lib/hrmsCrypto';

const fake = (require('../src/lib/supabase') as { __db: ReturnType<typeof mockCreateFakeDb> }).__db;

// ── fixtures ────────────────────────────────────────────────────────────────
const uid = (n: number, org = 'a') => `${org.repeat(8)}-${org.repeat(4)}-4${org.repeat(3)}-8${org.repeat(3)}-${String(n).padStart(12, '0')}`;
const ORG = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000bb';
const MASTER = { id: '33333333-3333-4333-8333-333333333333', org_id: ORG, email: 's@kinematicapp.com', name: 'Sagar B', role: 'super_admin' };
const ENT = uid(1); const LOC = uid(2); const DEP = uid(3); const DSG = uid(4);
const PAN = 'ABCPM1234F';
const ACCOUNT = '501001234567';
const BANK = { accountHolder: 'Aarav Mehta', accountNumber: ACCOUNT, ifsc: 'HDFC0001234', bankName: 'HDFC Bank', accountType: 'savings' };

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);

const person = (over: Row = {}): Row => ({
  first_name: 'Aarav', last_name: 'Mehta', email: 'aarav@example.com', mobile: '9876543210', gender: 'male', dob: '1996-04-18',
  entity_id: ENT, location_id: LOC, department_id: DEP, designation_id: DSG, employment_type: 'permanent', join_date: '2026-04-01', ...over,
});

function seedStructure(org = ORG, ids = { ENT, LOC, DEP, DSG }) {
  const stamp = { org_id: org, client_id: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  (fake.tables.hrms_entities ??= []).push({ id: ids.ENT, name: 'Acme Pvt Ltd', pan: null, address: {}, registrations: [], ...stamp });
  (fake.tables.hrms_locations ??= []).push({ id: ids.LOC, entity_id: ids.ENT, name: 'Pune HQ', state: 'Maharashtra', city: 'Pune', metro: false, ...stamp });
  (fake.tables.hrms_departments ??= []).push({ id: ids.DEP, name: 'Sales', head_id: null, ...stamp });
  (fake.tables.hrms_designations ??= []).push({ id: ids.DSG, name: 'Executive', grade: null, ...stamp });
}

async function create(over: Row = {}, expected = 201) {
  const res = await api().post('/hrms/employees').send(person(over));
  expect(res.status).toBe(expected);
  return res.body.data;
}
const history = (employeeId: string) => (fake.tables.hrms_employee_history ?? []).filter((h) => h.employee_id === employeeId);
const stored = (id: string) => (fake.tables.hrms_employees ?? []).find((e) => e.id === id)!;

beforeAll(() => { process.env.HRMS_DATA_KEY = 'api-test-hrms-data-key-0123456789abcdef'; });
beforeEach(() => {
  fake.reset(); user = MASTER; seedStructure();
  // the router logs the 4xx/5xx it answers; keep the test output quiet (the "logs" test below captures them itself)
  for (const level of ['error', 'warn'] as const) jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
});
afterEach(() => { jest.restoreAllMocks(); });


/** Every query on an hrms_ table filters org_id = the caller's org AND client_id IS NULL; every insert stamps both. */
function assertEveryQueryScoped(atLeast: number) {
  const queries = fake.log.filter((q) => q.table.startsWith('hrms_'));
  expect(queries.length).toBeGreaterThanOrEqual(atLeast);
  for (const q of queries) {
    if (q.op === 'insert' || q.op === 'upsert') {
      for (const r of q.rows!) expect(r).toMatchObject({ org_id: ORG, client_id: null });
    } else {
      const eqOrg = q.filters.find((f) => f.t === 'eq' && f.col === 'org_id');
      const nullClient = q.filters.find((f) => f.t === 'is' && f.col === 'client_id' && f.val === null);
      expect({ table: q.table, op: q.op, org: eqOrg?.val, clientNull: !!nullClient }).toEqual({ table: q.table, op: q.op, org: ORG, clientNull: true });
    }
  }
  expect(fake.rpcLog.every((c) => c.args.p_org === ORG)).toBe(true);
}

// ═══════════════════════════════════════════════════════════════════════════
describe('scope: the caller\'s org, client_id NULL, every query', () => {
  it('filters every select / update / delete on org_id and client_id IS NULL, and stamps every insert', async () => {
    const e = await create({ pan: PAN, bank: BANK, documents: [{ type: 'pan_card', name: 'PAN card', mandatory: true }] });
    await api().put(`/hrms/employees/${e.id}`).send({ designation_id: DSG, status: 'active', pan: 'ZZZPM9999Z' });
    await api().post(`/hrms/employees/${e.id}/documents`).send({ type: 'other', name: 'Letter' });
    await api().post(`/hrms/employees/${e.id}/reveal`).send({ field: 'pan', reason: 'checking the card' });
    await api().get('/hrms/bootstrap');
    await api().get(`/hrms/access-log?employee_id=${e.id}`);
    await api().post('/hrms/departments').send({ name: 'Ops' });
    await api().put('/hrms/settings/employee_code_prefix').send({ value: 'KIN-' });
    await api().delete(`/hrms/employees/${e.id}`); // status is still onboarding here: a soft delete, still a scoped lookup

    assertEveryQueryScoped(20);
  });

  it('also scopes the import, structure deletes (and the draft purge), document changes and every follow-up lookup', async () => {
    fake.tables.hrms_departments!.push({ id: uid(31), org_id: ORG, client_id: null, name: 'Temp', head_id: null });
    const d = await create({ email: 'tmp@example.com', department_id: uid(31) });
    await api().delete(`/hrms/employees/${d.id}`);                         // soft delete (also clears reportees + department head)
    await api().delete(`/hrms/departments/${uid(31)}`);                    // purges the soft-deleted draft, then deletes
    await api().post('/hrms/employees/import').send({ rows: [person({ email: 'i@example.com', department_id: undefined, department: 'sales', location_id: undefined, entity_id: undefined, location: 'pune hq' }), person({ email: 'bad' })] });
    const e = await create({ email: 'e@example.com' });
    const doc = (await api().post(`/hrms/employees/${e.id}/documents`).send({ type: 'other', name: 'Letter' })).body.data;
    await api().put(`/hrms/employees/${e.id}/documents/${doc.id}`).send({ status: 'verified' });
    await api().delete(`/hrms/employees/${e.id}/documents/${doc.id}`);
    await api().put(`/hrms/employees/${e.id}`).send({ department_id: DEP, reporting_to_id: null, bank: BANK });
    await api().delete(`/hrms/locations/${LOC}`);                          // 409: counts, scoped
    await api().get('/hrms/access-log');
    assertEveryQueryScoped(25);
    expect(fake.log.some((q) => q.op === 'delete' && q.table === 'hrms_employees')).toBe(true); // the purge really ran
  });

  it('ignores X-Client-Id entirely', async () => {
    const CLIENT = '99999999-9999-4999-8999-999999999999';
    const res = await api().post('/hrms/employees').set('X-Client-Id', CLIENT).send(person());
    expect(res.status).toBe(201);
    await api().get('/hrms/bootstrap').set('X-Client-Id', CLIENT);
    expect(stored(res.body.data.id).client_id).toBeNull();
    for (const q of fake.log) {
      expect(JSON.stringify(q.filters)).not.toContain(CLIENT);
      expect(JSON.stringify(q.rows ?? [])).not.toContain(CLIENT);
    }
  });

  it('does not see, update, delete or reveal another org\'s rows', async () => {
    const OTHER = { ENT: uid(11, 'b'), LOC: uid(12, 'b'), DEP: uid(13, 'b'), DSG: uid(14, 'b') };
    seedStructure(OTHER_ORG, OTHER);
    const theirs = uid(99, 'b');
    (fake.tables.hrms_employees ??= []).push({ id: theirs, org_id: OTHER_ORG, client_id: null, code: 'EMP-0001', first_name: 'Zed', last_name: 'Other', status: 'onboarding', deleted_at: null, pan_enc: null, bank_enc: null });

    const boot = await api().get('/hrms/bootstrap');
    expect(boot.body.data.entities.map((x: Row) => x.id)).toEqual([ENT]);
    expect(boot.body.data.employees).toEqual([]);
    expect((await api().put(`/hrms/employees/${theirs}`).send({ first_name: 'Hacked' })).status).toBe(404);
    expect((await api().delete(`/hrms/employees/${theirs}`)).status).toBe(404);
    expect((await api().post(`/hrms/employees/${theirs}/reveal`).send({ field: 'pan', reason: 'curious about it' })).status).toBe(404);
    expect((await api().put(`/hrms/departments/${OTHER.DEP}`).send({ name: 'Hacked' })).status).toBe(404);
    expect((await api().delete(`/hrms/entities/${OTHER.ENT}`)).status).toBe(404);
    // a new employee cannot be attached to another org's department or manager
    expect((await api().post('/hrms/employees').send(person({ department_id: OTHER.DEP }))).body.error).toMatch(/Unknown department/);
    expect((await api().post('/hrms/employees').send(person({ reporting_to_id: theirs }))).body.error).toMatch(/Unknown employee/);
    expect(stored(theirs).first_name).toBe('Zed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('masking and write-only sensitive fields', () => {
  it('stores PAN and bank encrypted, never in the clear, and returns them masked', async () => {
    const e = await create({ pan: PAN, bank: BANK });
    expect(e.pan).toBe('XXXXXX234F');
    expect(e.bank).toEqual({ ...BANK, accountNumber: '••••••••4567' });
    expect(e).not.toHaveProperty('pan_enc');
    expect(e).not.toHaveProperty('bank_enc');
    expect(e).not.toHaveProperty('org_id');

    const row = stored(e.id);
    expect(JSON.stringify(row)).not.toContain(PAN);
    expect(JSON.stringify(row)).not.toContain(ACCOUNT);
    expect(decryptField(row.pan_enc, `${e.id}:pan`)).toBe(PAN);
    expect(JSON.parse(decryptField(row.bank_enc, `${e.id}:bank`)!)).toEqual(BANK);
    // and no query ever carried the clear value
    expect(JSON.stringify(fake.log.map((q) => [q.rows, q.patch]))).not.toContain(PAN);
    expect(JSON.stringify(fake.log.map((q) => [q.rows, q.patch]))).not.toContain(ACCOUNT);
  });

  it('masks everywhere an employee is returned: bootstrap, update, import', async () => {
    const e = await create({ pan: PAN, bank: BANK });
    const boot = await api().get('/hrms/bootstrap');
    const upd = await api().put(`/hrms/employees/${e.id}`).send({ cost_centre: 'CC1' });
    const imp = await api().post('/hrms/employees/import').send({ rows: [person({ email: 'b@example.com', pan: 'BCDPE2345G', bank: { ...BANK, accountNumber: '999900001111' } })] });
    const all = JSON.stringify([boot.body, upd.body, imp.body]);
    for (const secret of [PAN, ACCOUNT, 'BCDPE2345G', '999900001111']) expect(all).not.toContain(secret);
    expect(boot.body.data.employees[0].pan).toBe('XXXXXX234F');
    expect(upd.body.data.bank.accountNumber).toBe('••••••••4567');
    expect(imp.body.data.employees[0].pan).toBe('XXXXXX234F'.replace('234F', '345G'));
  });

  it('ignores a masked PAN or bank sent back: nothing stored, nothing logged', async () => {
    const e = await create({ pan: PAN, bank: BANK });
    const before = { pan_enc: stored(e.id).pan_enc, bank_enc: stored(e.id).bank_enc, updated_at: stored(e.id).updated_at };
    const hist = history(e.id).length;
    const res = await api().put(`/hrms/employees/${e.id}`).send({ pan: e.pan, bank: e.bank });
    expect(res.status).toBe(200);
    expect(stored(e.id).pan_enc).toBe(before.pan_enc);
    expect(stored(e.id).bank_enc).toBe(before.bank_enc);
    expect(stored(e.id).updated_at).toBe(before.updated_at);
    expect(history(e.id)).toHaveLength(hist);
    // the same echo variants a client might produce
    for (const echo of ['XXXXXXXXXX', 'AB•••••34F', 'ABC***234F']) {
      expect((await api().put(`/hrms/employees/${e.id}`).send({ pan: echo })).status).toBe(200);
      expect(decryptField(stored(e.id).pan_enc, `${e.id}:pan`)).toBe(PAN);
    }
  });

  it('treats a masked echo as "no PAN" on create: nothing is stored', async () => {
    const e = await create({ pan: 'XXXXXX234F', bank: { ...BANK, accountNumber: '••••••••4567' } });
    expect(e.pan).toBeNull();
    expect(e.bank).toBeNull();
    expect(stored(e.id).pan_enc).toBeNull();
    expect(stored(e.id).bank_enc).toBeNull();
  });

  it('does not mistake a real PAN that contains X for a mask', async () => {
    const e = await create({ pan: 'AXXPX1234F' });
    expect(decryptField(stored(e.id).pan_enc, `${e.id}:pan`)).toBe('AXXPX1234F');
  });

  it('stores a new full PAN / bank number, replacing the old', async () => {
    const e = await create({ pan: PAN, bank: BANK });
    const res = await api().put(`/hrms/employees/${e.id}`).send({ pan: 'bcdpe 2345g', bank: { ...BANK, accountNumber: '222233334444' } });
    expect(res.status).toBe(200);
    expect(decryptField(stored(e.id).pan_enc, `${e.id}:pan`)).toBe('BCDPE2345G');
    expect(JSON.parse(decryptField(stored(e.id).bank_enc, `${e.id}:bank`)!).accountNumber).toBe('222233334444');
    expect(res.body.data.pan).toBe('XXXXXX345G');
  });

  it('lets other bank fields be edited while the account number stays masked (the number on file is kept)', async () => {
    const e = await create({ pan: PAN, bank: BANK });
    const res = await api().put(`/hrms/employees/${e.id}`).send({ bank: { ...e.bank, ifsc: 'ICIC0004321', bankName: 'ICICI Bank' } });
    expect(res.status).toBe(200);
    const bank = JSON.parse(decryptField(stored(e.id).bank_enc, `${e.id}:bank`)!);
    expect(bank).toMatchObject({ accountNumber: ACCOUNT, ifsc: 'ICIC0004321', bankName: 'ICICI Bank' });
  });

  it('clears PAN and bank with null', async () => {
    const e = await create({ pan: PAN, bank: BANK });
    const res = await api().put(`/hrms/employees/${e.id}`).send({ pan: null, bank: null });
    expect(res.body.data.pan).toBeNull();
    expect(res.body.data.bank).toBeNull();
    expect(stored(e.id).pan_enc).toBeNull();
  });

  it('accepts the snake_case spelling of the nested bank keys', async () => {
    const e = await create({ bank: { account_holder: 'Aarav Mehta', account_number: ACCOUNT, ifsc: 'HDFC0001234', bank_name: 'HDFC Bank', account_type: 'current' } });
    expect(e.bank).toMatchObject({ accountHolder: 'Aarav Mehta', accountNumber: '••••••••4567', bankName: 'HDFC Bank', accountType: 'current' });
  });

  it('rejects malformed PAN, IFSC, account number and a full Aadhaar with a 400 that names the field', async () => {
    const cases: Array<[Row, RegExp]> = [
      [{ pan: 'ABC123' }, /pan/i],
      [{ bank: { ...BANK, ifsc: 'NOPE' } }, /ifsc/i],
      [{ bank: { ...BANK, accountNumber: '12ab' } }, /account number/i],
      [{ bank: { ...BANK, accountNumber: '' } }, /account number is required/i],
      [{ aadhaar_last4: '234567890123' }, /last four digits/i],
      [{ uan: '123' }, /UAN is 12 digits/],
    ];
    for (const [over, msg] of cases) {
      const res = await api().post('/hrms/employees').send(person(over));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'VALIDATION' });
      expect(res.body.error).toMatch(msg);
    }
    expect(fake.tables.hrms_employees ?? []).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('reveal and the access log', () => {
  it('returns the full PAN and writes who / when / employee / field / reason to the access log', async () => {
    const e = await create({ pan: PAN, bank: BANK });
    const res = await api().post(`/hrms/employees/${e.id}/reveal`).send({ field: 'pan', reason: '  Checking against the PAN card  ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ field: 'pan', value: PAN });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(fake.tables.hrms_access_log).toHaveLength(1);
    expect(fake.tables.hrms_access_log![0]).toMatchObject({
      org_id: ORG, client_id: null, by_user_id: MASTER.id, by_name: 'Sagar B', employee_id: e.id, field: 'pan', reason: 'Checking against the PAN card',
    });
    expect(Date.now() - new Date(fake.tables.hrms_access_log![0].at).getTime()).toBeLessThan(5000);
  });

  it('returns the full bank details, and the Aadhaar last four, each logged', async () => {
    const e = await create({ pan: PAN, bank: BANK, aadhaar_last4: '9012' });
    const bank = await api().post(`/hrms/employees/${e.id}/reveal`).send({ field: 'bank', reason: 'salary bank file check' });
    expect(bank.body.data).toEqual({ field: 'bank', value: BANK });
    const aadhaar = await api().post(`/hrms/employees/${e.id}/reveal`).send({ field: 'aadhaar', reason: 'KYC cross-check' });
    expect(aadhaar.body.data).toEqual({ field: 'aadhaar', value: '9012' });
    expect(fake.tables.hrms_access_log!.map((r) => r.field)).toEqual(['bank', 'aadhaar']);
  });

  it('refuses without a reason, or with fewer than 5 characters, and logs nothing and reveals nothing', async () => {
    const e = await create({ pan: PAN });
    for (const body of [{ field: 'pan' }, { field: 'pan', reason: '' }, { field: 'pan', reason: 'abcd' }, { field: 'pan', reason: '    ab ' }, { field: 'pan', reason: 'x'.repeat(501) }]) {
      const res = await api().post(`/hrms/employees/${e.id}/reveal`).send(body);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(PAN);
    }
    expect((await api().post(`/hrms/employees/${e.id}/reveal`).send({ field: 'password', reason: 'long enough' })).status).toBe(400);
    expect(fake.tables.hrms_access_log ?? []).toHaveLength(0);
  });

  it('logs nothing when there is nothing to reveal (404)', async () => {
    const e = await create();
    expect((await api().post(`/hrms/employees/${e.id}/reveal`).send({ field: 'pan', reason: 'nothing on file' })).status).toBe(404);
    expect((await api().post(`/hrms/employees/${e.id}/reveal`).send({ field: 'bank', reason: 'nothing on file' })).status).toBe(404);
    expect(fake.tables.hrms_access_log ?? []).toHaveLength(0);
  });

  it('fails closed: if the access-log row cannot be written, the value is not returned', async () => {
    const e = await create({ pan: PAN });
    fake.fails.push({ table: 'hrms_access_log', op: 'insert', error: { message: 'disk full' }, times: 1 });
    const res = await api().post(`/hrms/employees/${e.id}/reveal`).send({ field: 'pan', reason: 'checking the card' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(PAN);
  });

  it('answers 500 DECRYPT_FAILED, not a wrong value, when the key has changed', async () => {
    const e = await create({ pan: PAN });
    const saved = process.env.HRMS_DATA_KEY;
    process.env.HRMS_DATA_KEY = 'a-different-hrms-data-key-0123456789abcdef';
    try {
      const res = await api().post(`/hrms/employees/${e.id}/reveal`).send({ field: 'pan', reason: 'checking the card' });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('DECRYPT_FAILED');
      expect(fake.tables.hrms_access_log ?? []).toHaveLength(0);
      // the list still loads, with the PAN shown as unreadable instead of failing the whole page
      const boot = await api().get('/hrms/bootstrap');
      expect(boot.status).toBe(200);
      expect(boot.body.data.employees[0].pan).toBe('XXXXXXXXXX');
    } finally { process.env.HRMS_DATA_KEY = saved; }
  });

  it('reads the access log newest first, capped at 200, optionally for one employee', async () => {
    const a = await create({ pan: PAN, email: 'a@example.com' });
    const b = await create({ pan: PAN, email: 'b@example.com' });
    const log = (fake.tables.hrms_access_log ??= []);
    for (let i = 0; i < 230; i++) {
      log.push({ id: `l${i}`, org_id: ORG, client_id: null, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), by_name: 'X', employee_id: i % 2 ? a.id : b.id, field: 'pan', reason: `reason ${i}` });
    }
    log.push({ id: 'foreign', org_id: OTHER_ORG, client_id: null, at: '2030-01-01T00:00:00Z', by_name: 'Y', employee_id: a.id, field: 'pan', reason: 'not ours' });

    const all = await api().get('/hrms/access-log');
    expect(all.body.data).toHaveLength(200);
    expect(all.body.data[0].reason).toBe('reason 229');
    expect(all.body.data[0].at > all.body.data[1].at).toBe(true);
    expect(all.body.data.some((r: Row) => r.reason === 'not ours')).toBe(false);
    expect(all.body.data[0]).not.toHaveProperty('org_id');

    const one = await api().get(`/hrms/access-log?employee_id=${a.id}`);
    expect(one.body.data.every((r: Row) => r.employee_id === a.id)).toBe(true);
    expect(one.body.data).toHaveLength(115);
    expect((await api().get('/hrms/access-log?employee_id=not-an-id')).status).toBe(400);
    expect((await api().get('/hrms/access-log?limit=5')).body.data).toHaveLength(5);
  });

  it('the access log outlives a deleted draft (no cascade)', async () => {
    const e = await create({ pan: PAN });
    await api().post(`/hrms/employees/${e.id}/reveal`).send({ field: 'pan', reason: 'checking the card' });
    expect((await api().delete(`/hrms/employees/${e.id}`)).status).toBe(200);
    expect((await api().get(`/hrms/access-log?employee_id=${e.id}`)).body.data).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('change log (history)', () => {
  it('writes "Employee: Created" with the actor on create', async () => {
    const e = await create();
    expect(e.history).toHaveLength(1);
    expect(e.history[0]).toMatchObject({ field: 'Employee', from_value: null, to_value: 'Created', by_name: 'Sagar B', by_user_id: MASTER.id, employee_id: e.id });
    expect(e.history[0]).not.toHaveProperty('org_id');
  });

  it('logs one row per labelled field that really changed, with from/to, and nothing for unchanged or unlabelled fields', async () => {
    const e = await create({ cost_centre: 'CC1' });
    const res = await api().put(`/hrms/employees/${e.id}`).send({
      first_name: 'Aarav', // unchanged: not logged
      last_name: 'Shah', mobile: '9000000001', status: 'active', annual_ctc: 1200000, pf_member: true, dob: '1996-04-19',
      pf_join_date: '2026-04-01', // changed but unlabelled: stored, not logged
      aadhaar_verified: true,
    });
    expect(res.status).toBe(200);
    const rows = history(e.id).filter((h) => h.field !== 'Employee');
    const byField = Object.fromEntries(rows.map((r) => [r.field, [r.from_value, r.to_value]]));
    expect(byField).toEqual({
      'Last name': ['Mehta', 'Shah'], Mobile: ['9876543210', '9000000001'], Status: ['onboarding', 'active'], 'Annual CTC': [null, '1200000'],
      'PF member': ['No', 'Yes'], 'Date of birth': ['1996-04-18', '1996-04-19'],
    });
    expect(stored(e.id)).toMatchObject({ pf_join_date: '2026-04-01', aadhaar_verified: true });
    expect(new Set(rows.map((r) => r.at)).size).toBe(1);
    expect(rows.every((r) => r.by_name === 'Sagar B' && r.org_id === ORG && r.client_id === null)).toBe(true);
    // newest first in the response
    expect(res.body.data.history.length).toBe(rows.length + 1);
  });

  it('names the department / location / manager instead of printing ids', async () => {
    const boss = await create({ email: 'boss@example.com', first_name: 'Boss', last_name: 'Person' });
    const e = await create({ email: 'e@example.com' });
    const DEP2 = uid(30);
    fake.tables.hrms_departments!.push({ id: DEP2, org_id: ORG, client_id: null, name: 'Operations', head_id: null });
    await api().put(`/hrms/employees/${e.id}`).send({ department_id: DEP2, reporting_to_id: boss.id });
    const rows = history(e.id);
    expect(rows.find((r) => r.field === 'Department')).toMatchObject({ from_value: 'Sales', to_value: 'Operations' });
    expect(rows.find((r) => r.field === 'Reports to')).toMatchObject({ from_value: null, to_value: `Boss Person (${boss.code})` });
  });

  it('never writes a PAN, bank value, or Aadhaar digits to the log: "Updated" only', async () => {
    const e = await create({ pan: PAN, bank: BANK, aadhaar_last4: '9012' });
    await api().put(`/hrms/employees/${e.id}`).send({ pan: 'BCDPE2345G', bank: { ...BANK, accountNumber: '222233334444' }, aadhaar_last4: '3456' });
    await api().put(`/hrms/employees/${e.id}`).send({ pan: null });
    const rows = history(e.id);
    expect(rows.find((r) => r.field === 'PAN' && r.to_value === 'Updated')).toMatchObject({ from_value: 'On file' });
    expect(rows.find((r) => r.field === 'PAN' && r.to_value === 'Removed')).toMatchObject({ from_value: 'On file' });
    expect(rows.find((r) => r.field === 'Bank account')).toMatchObject({ from_value: 'On file', to_value: 'Updated' });
    expect(rows.find((r) => r.field === 'Aadhaar')).toMatchObject({ from_value: 'On file', to_value: 'Updated (last four digits only)' });
    const everything = JSON.stringify([fake.tables.hrms_employee_history, fake.log.filter((q) => q.table === 'hrms_employee_history').map((q) => q.rows)]);
    for (const secret of [PAN, 'BCDPE2345G', ACCOUNT, '222233334444', '9012', '3456', 'HDFC0001234']) expect(everything).not.toContain(secret);
  });

  it('shows object-valued fields (address, declaration) as "Updated", not their content', async () => {
    const e = await create();
    await api().put(`/hrms/employees/${e.id}`).send({ address: { line1: '12 Hill Road', city: 'Pune' }, declaration: { sec80C: 150000, status: 'submitted' } });
    const rows = history(e.id);
    expect(rows.find((r) => r.field === 'Address')).toMatchObject({ to_value: 'Updated' });
    expect(rows.find((r) => r.field === 'Tax declaration (Form 124)')).toMatchObject({ to_value: 'Updated' });
    expect(JSON.stringify(rows)).not.toContain('Hill Road');
  });

  it('writes nothing, not even updated_at, when an update changes nothing', async () => {
    const e = await create();
    const stamp = stored(e.id).updated_at;
    const writesBefore = fake.log.filter((q) => q.op === 'update' || q.op === 'insert').length;
    const res = await api().put(`/hrms/employees/${e.id}`).send({ first_name: 'Aarav', email: 'aarav@example.com', status: 'onboarding', documents: [], history: [] });
    expect(res.status).toBe(200);
    expect(stored(e.id).updated_at).toBe(stamp);
    expect(fake.log.filter((q) => q.op === 'update' || q.op === 'insert')).toHaveLength(writesBefore);
  });

  it('only the keys sent change; the rest of the row is untouched', async () => {
    const e = await create({ cost_centre: 'CC1', father_name: 'Ravi Mehta' });
    await api().put(`/hrms/employees/${e.id}`).send({ cost_centre: 'CC2' });
    expect(stored(e.id)).toMatchObject({ cost_centre: 'CC2', father_name: 'Ravi Mehta', first_name: 'Aarav', email: 'aarav@example.com' });
  });

  it('applies no change when its change-log rows cannot be written, and removes the log rows when the change itself fails', async () => {
    const e = await create();
    fake.fails.push({ table: 'hrms_employee_history', op: 'insert', error: { message: 'boom' }, times: 1 });
    expect((await api().put(`/hrms/employees/${e.id}`).send({ last_name: 'Shah' })).status).toBe(500);
    expect(stored(e.id).last_name).toBe('Mehta');

    fake.fails.push({ table: 'hrms_employees', op: 'update', error: { message: 'boom' }, times: 1 });
    expect((await api().put(`/hrms/employees/${e.id}`).send({ last_name: 'Shah' })).status).toBe(500);
    expect(stored(e.id).last_name).toBe('Mehta');
    expect(history(e.id).filter((h) => h.field === 'Last name')).toHaveLength(0);
  });

  it('caps history at 200 per employee in bootstrap, newest first', async () => {
    const e = await create();
    const rows = (fake.tables.hrms_employee_history ??= []);
    for (let i = 0; i < 250; i++) rows.push({ id: `h${i}`, org_id: ORG, client_id: null, employee_id: e.id, at: new Date(Date.UTC(2027, 0, 1, 0, 0, i)).toISOString(), by_name: 'X', field: 'Mobile', from_value: String(i), to_value: String(i + 1) });
    const boot = await api().get('/hrms/bootstrap');
    const h = boot.body.data.employees[0].history;
    expect(h).toHaveLength(200);
    expect(h[0].from_value).toBe('249');
    expect(h[0].at > h[199].at).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('employee code and idempotent create', () => {
  it('assigns EMP-0001, EMP-0002 ... from the counter, and a new prefix applies to the next one', async () => {
    expect((await create({ email: '1@example.com' })).code).toBe('EMP-0001');
    expect((await create({ email: '2@example.com' })).code).toBe('EMP-0002');
    const set = await api().put('/hrms/settings/employee_code_prefix').send({ value: 'KIN-' });
    expect(set.status).toBe(200);
    expect(set.body.data.employee_code_prefix).toBe('KIN-');
    expect((await create({ email: '3@example.com' })).code).toBe('KIN-0003');
  });

  it('uses a supplied code when it is free, and answers 409 CODE_TAKEN when it is not', async () => {
    expect((await create({ code: 'MER-1001' })).code).toBe('MER-1001');
    expect(fake.rpcLog).toHaveLength(0);
    const dup = await api().post('/hrms/employees').send(person({ code: 'MER-1001', email: 'x@example.com' }));
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ success: false, code: 'CODE_TAKEN' });
    expect(fake.tables.hrms_employees).toHaveLength(1);
  });

  it('skips a code that a hand-typed one already took and takes the next number', async () => {
    await create({ code: 'EMP-0001' });
    const e = await create({ email: 'n@example.com' });
    expect(e.code).toBe('EMP-0002');
    expect(fake.rpcLog.length).toBe(2);
  });

  it('is idempotent on a client id: the second call returns the existing row with 200 and writes nothing', async () => {
    const id = uid(50);
    const first = await create({ id, pan: PAN });
    const writes = fake.log.filter((q) => q.op === 'insert').length;
    const again = await api().post('/hrms/employees').send(person({ id, first_name: 'Changed' }));
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(first.id);
    expect(again.body.data.first_name).toBe('Aarav');
    expect(again.body.data.pan).toBe('XXXXXX234F');
    expect(fake.log.filter((q) => q.op === 'insert')).toHaveLength(writes);
    expect(fake.tables.hrms_employees).toHaveLength(1);
    expect(history(id)).toHaveLength(1);
  });

  it('refuses a client id that belongs to a deleted draft or another org', async () => {
    const id = uid(51);
    await create({ id });
    await api().delete(`/hrms/employees/${id}`);
    expect((await api().post('/hrms/employees').send(person({ id }))).status).toBe(409);
    const theirs = uid(52, 'b');
    fake.tables.hrms_employees!.push({ id: theirs, org_id: OTHER_ORG, client_id: null, code: 'EMP-9999', deleted_at: null });
    const res = await api().post('/hrms/employees').send(person({ id: theirs, email: 'o@example.com' }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ID_IN_USE');
  });

  it('creates the documents sent with the employee, and rolls the employee back if they fail', async () => {
    const e = await create({ documents: [{ type: 'pan_card', name: 'PAN card', mandatory: true }, { type: 'bank_proof', name: 'Cancelled cheque' }] });
    expect(e.documents.map((d: Row) => [d.name, d.status, d.mandatory])).toEqual([['PAN card', 'pending', true], ['Cancelled cheque', 'pending', false]]);

    fake.fails.push({ table: 'hrms_employee_documents', op: 'insert', error: { message: 'boom' }, times: 1 });
    const bad = await api().post('/hrms/employees').send(person({ email: 'd@example.com', documents: [{ type: 'other', name: 'X' }] }));
    expect(bad.status).toBe(500);
    expect(fake.tables.hrms_employees).toHaveLength(1);
    expect(fake.tables.hrms_employee_history!.every((h) => h.employee_id === e.id)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('validation', () => {
  const cases: Array<[string, Row, RegExp]> = [
    ['missing first name', { first_name: '' }, /first_name: First name is required/],
    ['name over 100 characters', { first_name: 'a'.repeat(101) }, /first_name/],
    ['bad email', { email: 'not-an-email' }, /email/],
    ['bad date', { join_date: '2026-13-45' }, /join_date/],
    ['date not YYYY-MM-DD', { join_date: '01/04/2026' }, /YYYY-MM-DD/],
    ['future date of birth', { dob: '2999-01-01' }, /dob/],
    ['negative CTC', { annual_ctc: -1 }, /Annual CTC cannot be negative/],
    ['unknown employment type', { employment_type: 'freelancer' }, /employment_type/],
    ['unknown status', { status: 'retired' }, /status/],
    ['unknown department', { department_id: uid(77) }, /Unknown department/],
    ['unknown location', { location_id: uid(78) }, /Unknown location/],
    ['department id that is not an id', { department_id: 'sales' }, /department_id/],
    ['probation out of range', { probation_months: 99 }, /probation_months/],
    ['a code with spaces', { code: 'EMP 1' }, /code/],
  ];
  it.each(cases)('rejects %s with a 400 that names the problem', async (_name, over, message) => {
    const res = await api().post('/hrms/employees').send(person(over));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'VALIDATION' });
    expect(res.body.error).toMatch(message);
    expect(fake.tables.hrms_employees ?? []).toHaveLength(0);
  });

  it('rejects a null on a required field in an update, and a bad id in the URL', async () => {
    const e = await create();
    expect((await api().put(`/hrms/employees/${e.id}`).send({ email: null })).status).toBe(400);
    expect((await api().put('/hrms/employees/not-a-uuid').send({})).status).toBe(400);
    expect((await api().put(`/hrms/employees/${uid(60)}`).send({ first_name: 'X' })).status).toBe(404);
  });

  it('accepts a single-name person (empty last name)', async () => {
    expect((await create({ last_name: '' })).last_name).toBe('');
  });

  it('refuses a body over 1 MB with 413 before touching the database', async () => {
    const res = await api().post('/hrms/employees').send(person({ declaration: { status: 'submitted', note: 'x'.repeat(1_200_000) } }));
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ success: false, code: 'PAYLOAD_TOO_LARGE' });
    expect(fake.log).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('code is immutable', () => {
  it('rejects a code change and accepts the same code', async () => {
    const e = await create();
    const bad = await api().put(`/hrms/employees/${e.id}`).send({ code: 'EMP-9999' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('CODE_IMMUTABLE');
    expect(stored(e.id).code).toBe(e.code);
    expect((await api().put(`/hrms/employees/${e.id}`).send({ code: e.code, mobile: '9000000002' })).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('reporting line', () => {
  let a: Row; let b: Row; let c: Row;
  beforeEach(async () => {
    a = await create({ email: 'a@example.com', first_name: 'A' });
    b = await create({ email: 'b@example.com', first_name: 'B', reporting_to_id: a.id });
    c = await create({ email: 'c@example.com', first_name: 'C', reporting_to_id: b.id });
  });

  it('rejects reporting to oneself', async () => {
    const res = await api().put(`/hrms/employees/${a.id}`).send({ reporting_to_id: a.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/themselves/);
  });

  it('rejects a direct loop (A reports to B who reports to A) and an indirect one (A -> C -> B -> A)', async () => {
    const direct = await api().put(`/hrms/employees/${a.id}`).send({ reporting_to_id: b.id });
    expect(direct.status).toBe(400);
    expect(direct.body.error).toMatch(/reporting loop/);
    const indirect = await api().put(`/hrms/employees/${a.id}`).send({ reporting_to_id: c.id });
    expect(indirect.status).toBe(400);
    expect(stored(a.id).reporting_to_id).toBeNull();
    expect(history(a.id).filter((h) => h.field === 'Reports to')).toHaveLength(0);
  });

  it('accepts a legal move and clears with null', async () => {
    expect((await api().put(`/hrms/employees/${c.id}`).send({ reporting_to_id: a.id })).status).toBe(200);
    expect(stored(c.id).reporting_to_id).toBe(a.id);
    expect((await api().put(`/hrms/employees/${c.id}`).send({ reporting_to_id: null })).status).toBe(200);
    expect(stored(c.id).reporting_to_id).toBeNull();
  });

  it('rejects an unknown manager and a deleted one', async () => {
    expect((await api().put(`/hrms/employees/${c.id}`).send({ reporting_to_id: uid(70) })).status).toBe(400);
    const draft = await create({ email: 'd@example.com' });
    await api().delete(`/hrms/employees/${draft.id}`);
    expect((await api().put(`/hrms/employees/${c.id}`).send({ reporting_to_id: draft.id })).body.error).toMatch(/Unknown employee/);
  });

  it('is robust to a loop already in the data (no endless walk)', async () => {
    stored(a.id).reporting_to_id = c.id; // corrupt: A -> C -> B -> A
    const d = await create({ email: 'e@example.com' });
    expect((await api().put(`/hrms/employees/${d.id}`).send({ reporting_to_id: a.id })).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('deleting an employee', () => {
  it('soft-deletes a draft, logs it, frees the code, drops it from bootstrap, and un-points reportees and a department head', async () => {
    const draft = await create({ email: 'd@example.com', code: 'EMP-0100' });
    const rep = await create({ email: 'r@example.com', reporting_to_id: draft.id });
    fake.tables.hrms_departments![0]!.head_id = draft.id;

    const res = await api().delete(`/hrms/employees/${draft.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: draft.id });
    expect(stored(draft.id).deleted_at).toBeTruthy();
    expect(history(draft.id).map((h) => [h.field, h.to_value])).toContainEqual(['Employee', 'Deleted']);
    expect(stored(rep.id).reporting_to_id).toBeNull();
    expect(history(rep.id).find((h) => h.field === 'Reports to')).toMatchObject({ from_value: expect.stringContaining('EMP-0100'), to_value: null });
    expect(fake.tables.hrms_departments![0]!.head_id).toBeNull();

    const boot = await api().get('/hrms/bootstrap');
    expect(boot.body.data.employees.map((x: Row) => x.id)).toEqual([rep.id]);
    // the code is free again
    expect((await create({ email: 'again@example.com', code: 'EMP-0100' })).code).toBe('EMP-0100');
    // and it cannot be deleted twice
    expect((await api().delete(`/hrms/employees/${draft.id}`)).status).toBe(404);
  });

  it('treats a deleted draft as gone everywhere: update, reveal, documents and the manager picker all 404 / 400', async () => {
    const draft = await create({ email: 'gone@example.com', pan: PAN });
    const other = await create({ email: 'other@example.com' });
    await api().delete(`/hrms/employees/${draft.id}`);
    expect((await api().put(`/hrms/employees/${draft.id}`).send({ last_name: 'X' })).status).toBe(404);
    expect((await api().post(`/hrms/employees/${draft.id}/reveal`).send({ field: 'pan', reason: 'still checking' })).status).toBe(404);
    expect((await api().post(`/hrms/employees/${draft.id}/documents`).send({ type: 'other', name: 'Letter' })).status).toBe(404);
    expect((await api().put(`/hrms/employees/${other.id}`).send({ reporting_to_id: draft.id })).status).toBe(400);
    expect(fake.tables.hrms_access_log ?? []).toHaveLength(0);
  });

  it.each(['active', 'on_notice', 'exited'])('refuses a %s employee with 409 and the reason, and changes nothing', async (status) => {
    const e = await create({ status });
    const res = await api().delete(`/hrms/employees/${e.id}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'NOT_A_DRAFT' });
    expect(res.body.error).toMatch(/Mark the person as exited instead/);
    expect(stored(e.id).deleted_at).toBeNull();
    expect(history(e.id).filter((h) => h.to_value === 'Deleted')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('organisation structure: create, idempotent ids, update', () => {
  it('creates each kind (201) and returns the row without tenant columns', async () => {
    const ent = await api().post('/hrms/entities').send({ name: 'Beta LLP', pan: 'AAACB1234C', gstin: '27AAACB1234C1Z5', registrations: [{ id: 'r1', type: 'pf', number: 'PF/1' }], signatory: { name: 'A B', designation: 'Director' } });
    expect(ent.status).toBe(201);
    expect(ent.body.data).toMatchObject({ name: 'Beta LLP', pan: 'AAACB1234C', signatory: { name: 'A B', designation: 'Director' } });
    expect(ent.body.data).not.toHaveProperty('org_id');
    const loc = await api().post('/hrms/locations').send({ entity_id: ent.body.data.id, name: 'Mumbai', state: 'Maharashtra', city: 'Mumbai', metro: true });
    expect(loc.status).toBe(201);
    expect(loc.body.data.metro).toBe(true);
    expect((await api().post('/hrms/designations').send({ name: 'Manager', grade: 'M1' })).status).toBe(201);
    const emp = await create();
    const dep = await api().post('/hrms/departments').send({ name: 'Ops', head_id: emp.id });
    expect(dep.status).toBe(201);
    expect(dep.body.data.head_id).toBe(emp.id);
  });

  it('is idempotent on a client id for all four kinds: 200 and the existing row, no second insert', async () => {
    const calls: Array<[string, Row]> = [
      ['entities', { name: 'Gamma Ltd' }], ['locations', { entity_id: ENT, name: 'Delhi', state: 'Delhi', city: 'Delhi' }],
      ['departments', { name: 'HR' }], ['designations', { name: 'Analyst' }],
    ];
    let n = 200;
    for (const [path, body] of calls) {
      const id = uid(n++);
      const first = await api().post(`/hrms/${path}`).send({ id, ...body });
      expect(first.status).toBe(201);
      const inserts = fake.log.filter((q) => q.op === 'insert').length;
      const again = await api().post(`/hrms/${path}`).send({ id, ...body, name: 'Renamed' });
      expect(again.status).toBe(200);
      expect(again.body.data.id).toBe(id);
      expect(again.body.data.name).toBe(first.body.data.name);
      expect(fake.log.filter((q) => q.op === 'insert')).toHaveLength(inserts);
    }
  });

  it('rejects a location on an unknown entity, a department head who is not an employee, and bad registration data', async () => {
    expect((await api().post('/hrms/locations').send({ entity_id: uid(90), name: 'X', state: 'S', city: 'C' })).body.error).toMatch(/Unknown legal entity/);
    expect((await api().post('/hrms/departments').send({ name: 'X', head_id: uid(91) })).body.error).toMatch(/Unknown employee/);
    expect((await api().post('/hrms/entities').send({ name: 'X', pan: 'bad' })).status).toBe(400);
    expect((await api().post('/hrms/entities').send({ name: 'X', registrations: [{ type: 'nope', number: '1' }] })).status).toBe(400);
    expect((await api().post('/hrms/locations').send({ entity_id: ENT, name: 'X' })).status).toBe(400);
  });

  it('updates only the keys sent and 404s for a missing row', async () => {
    const res = await api().put(`/hrms/locations/${LOC}`).send({ metro: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ metro: true, name: 'Pune HQ', city: 'Pune' });
    expect((await api().put(`/hrms/departments/${uid(95)}`).send({ name: 'X' })).status).toBe(404);
    expect((await api().put(`/hrms/designations/${DSG}`).send({})).body.data.name).toBe('Executive');
  });
});

describe('organisation structure: deletes are refused while something uses the row', () => {
  it('refuses an entity that still has locations, then employees, with a plain reason', async () => {
    const withLoc = await api().delete(`/hrms/entities/${ENT}`);
    expect(withLoc.status).toBe(409);
    expect(withLoc.body).toMatchObject({ success: false, code: 'IN_USE' });
    expect(withLoc.body.error).toBe('This legal entity still has 1 location. Move or delete them first.');

    const ent2 = (await api().post('/hrms/entities').send({ name: 'Second' })).body.data;
    const loc2 = (await api().post('/hrms/locations').send({ entity_id: ent2.id, name: 'L2', state: 'S', city: 'C' })).body.data;
    await create({ entity_id: ent2.id, location_id: loc2.id });
    expect((await api().delete(`/hrms/locations/${loc2.id}`)).body.error).toBe('This location still has 1 employee. Move them to another location first.');
    expect(fake.tables.hrms_locations).toHaveLength(2);
  });

  it.each([['departments', 'department_id', 'department'], ['designations', 'designation_id', 'designation'], ['locations', 'location_id', 'location']])(
    'refuses a %s row with employees, counting them',
    async (path, col, noun) => {
      await create({ email: 'a@example.com' });
      await create({ email: 'b@example.com' });
      const id = { departments: DEP, designations: DSG, locations: LOC }[path as 'departments']!;
      const res = await api().delete(`/hrms/${path}/${id}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(`This ${noun} still has 2 employees. Move them to another ${noun} first.`);
      expect(col).toBeTruthy();
    },
  );

  it('deletes an unused row, and a row only soft-deleted drafts still point at', async () => {
    const extra = (await api().post('/hrms/departments').send({ name: 'Temp' })).body.data;
    const draft = await create({ department_id: extra.id });
    expect((await api().delete(`/hrms/departments/${extra.id}`)).status).toBe(409);
    await api().delete(`/hrms/employees/${draft.id}`); // soft delete: the row still holds the foreign key
    const res = await api().delete(`/hrms/departments/${extra.id}`);
    expect(res.status).toBe(200);
    expect(fake.tables.hrms_departments!.map((d) => d.id)).toEqual([DEP]);
    expect(fake.tables.hrms_employees!.find((e) => e.id === draft.id)).toBeUndefined();
  });

  it.each(['23001', '23503'])('answers 409, not 500, if the database foreign key (SQLSTATE %s) catches a row added after the check', async (code) => {
    // Postgres raises 23001 (restrict_violation) for ON DELETE RESTRICT; 23503 is the NO ACTION / missing-reference flavour. Both must map.
    fake.fails.push({ table: 'hrms_designations', op: 'delete', error: { code, message: 'violates foreign key constraint' }, times: 1 });
    const res = await api().delete(`/hrms/designations/${DSG}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IN_USE');
  });

  it('404s for a row that is not there (or is another org\'s)', async () => {
    for (const path of ['entities', 'locations', 'departments', 'designations']) expect((await api().delete(`/hrms/${path}/${uid(96)}`)).status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('documents', () => {
  it('adds (idempotent on id), updates, and removes, logging status changes, files and removals on the employee', async () => {
    const e = await create();
    const docId = uid(300);
    const add = await api().post(`/hrms/employees/${e.id}/documents`).send({ id: docId, type: 'pan_card', name: 'PAN card', mandatory: true });
    expect(add.status).toBe(201);
    expect(add.body.data).toMatchObject({ id: docId, employee_id: e.id, status: 'pending', mandatory: true });
    expect(add.body.data).not.toHaveProperty('org_id');
    expect((await api().post(`/hrms/employees/${e.id}/documents`).send({ id: docId, type: 'pan_card', name: 'PAN card' })).status).toBe(200);
    expect(fake.tables.hrms_employee_documents).toHaveLength(1);

    const up = await api().put(`/hrms/employees/${e.id}/documents/${docId}`).send({ status: 'uploaded', fileName: 'pan.pdf', uploadedOn: '2026-05-01' });
    expect(up.status).toBe(200);
    expect(up.body.data).toMatchObject({ status: 'uploaded', file_name: 'pan.pdf', uploaded_on: '2026-05-01' });
    expect((await api().put(`/hrms/employees/${e.id}/documents/${docId}`).send({ status: 'uploaded' })).status).toBe(200);

    expect((await api().delete(`/hrms/employees/${e.id}/documents/${docId}`)).body.data).toEqual({ id: docId });
    expect(fake.tables.hrms_employee_documents).toHaveLength(0);
    expect(history(e.id).filter((h) => h.field === 'Document: PAN card').map((h) => [h.from_value, h.to_value])).toEqual([
      [null, 'Added (pending)'], ['pending', 'uploaded'], ['uploaded', 'Removed'],
    ]);
  });

  it('scopes documents to the employee and the org: a document of another employee is a 404', async () => {
    const e1 = await create({ email: 'a@example.com' });
    const e2 = await create({ email: 'b@example.com' });
    const docId = (await api().post(`/hrms/employees/${e1.id}/documents`).send({ type: 'other', name: 'Letter' })).body.data.id;
    expect((await api().put(`/hrms/employees/${e2.id}/documents/${docId}`).send({ status: 'verified' })).status).toBe(404);
    expect((await api().delete(`/hrms/employees/${e2.id}/documents/${docId}`)).status).toBe(404);
    expect((await api().post(`/hrms/employees/${uid(61)}/documents`).send({ type: 'other', name: 'Letter' })).status).toBe(404);
    expect((await api().post(`/hrms/employees/${e1.id}/documents`).send({ type: 'passport', name: 'Letter' })).status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('settings', () => {
  it('stores a valid prefix, defaults to EMP-, and refuses bad prefixes and unknown keys', async () => {
    expect((await api().get('/hrms/bootstrap')).body.data.settings).toEqual({ employee_code_prefix: 'EMP-' });
    for (const value of ['', 'A', 'TOOLONG123', 'EM P', 'EMP_', 'ÉMP-']) {
      expect((await api().put('/hrms/settings/employee_code_prefix').send({ value })).status).toBe(400);
    }
    expect((await api().put('/hrms/settings/employee_code_prefix').send({})).status).toBe(400);
    expect((await api().put('/hrms/settings/other_key').send({ value: 'KIN-' })).status).toBe(404);
    expect((await api().put('/hrms/settings/employee_code_prefix').send({ value: 'KIN-' })).status).toBe(200);
    expect((await api().put('/hrms/settings/employee_code_prefix').send({ value: 'MER-' })).body.data.employee_code_prefix).toBe('MER-');
    expect(fake.tables.hrms_settings).toHaveLength(1);
    expect((await api().get('/hrms/bootstrap')).body.data.settings.employee_code_prefix).toBe('MER-');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('bootstrap', () => {
  it('returns everything for the org in one call, with documents and history, and the server time', async () => {
    const e = await create({ pan: PAN, documents: [{ type: 'pan_card', name: 'PAN card' }] });
    const res = await api().get('/hrms/bootstrap');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(Object.keys(d).sort()).toEqual(['departments', 'designations', 'employees', 'entities', 'locations', 'server_time', 'settings']);
    expect(d.entities).toHaveLength(1);
    expect(d.locations[0]).toMatchObject({ id: LOC, entity_id: ENT, name: 'Pune HQ' });
    expect(d.employees[0]).toMatchObject({ id: e.id, code: 'EMP-0001', pan: 'XXXXXX234F' });
    expect(d.employees[0].documents).toHaveLength(1);
    expect(d.employees[0].history).toHaveLength(1);
    expect(new Date(d.server_time).getTime()).not.toBeNaN();
    for (const row of [...d.entities, ...d.locations, ...d.departments, ...d.designations, d.employees[0]]) expect(row).not.toHaveProperty('org_id');
  });

  it('reads past the 1000-row PostgREST page (pages through employees)', async () => {
    const rows = (fake.tables.hrms_employees ??= []);
    for (let i = 0; i < 1203; i++) {
      rows.push({ id: `e${String(i).padStart(5, '0')}`, org_id: ORG, client_id: null, code: `EMP-${String(i).padStart(5, '0')}`, first_name: 'P', last_name: String(i), deleted_at: null, pan_enc: null, bank_enc: null });
    }
    const res = await api().get('/hrms/bootstrap');
    expect(res.body.data.employees).toHaveLength(1203);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('bulk import', () => {
  const row = (n: number, over: Row = {}) => person({ email: `p${n}@example.com`, first_name: `P${n}`, ...over });

  it('creates valid rows and reports each bad row on its own ({ row, error }), without failing the rest', async () => {
    const res = await api().post('/hrms/employees/import').send({
      rows: [row(1), row(2, { email: 'broken' }), row(3, { pan: 'XYZ' }), row(4, { department_id: uid(77) }), row(5), 'not an object', row(6, { dob: '2999-01-01' })],
    });
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d).toMatchObject({ dry_run: false, total: 7, valid: 2, created: 2, existing: 0, failed: 5 });
    expect(d.errors.map((e: Row) => e.row)).toEqual([2, 3, 4, 6, 7]);
    expect(d.errors.find((e: Row) => e.row === 2).error).toMatch(/email/);
    expect(d.errors.find((e: Row) => e.row === 3).error).toMatch(/pan/i);
    expect(d.errors.find((e: Row) => e.row === 4).error).toMatch(/Unknown department/);
    expect(d.errors.find((e: Row) => e.row === 6).error).toMatch(/Each row must be an object/);
    expect(d.errors.find((e: Row) => e.row === 7).error).toMatch(/dob/);
    expect(d.employees.map((e: Row) => e.first_name)).toEqual(['P1', 'P5']);
    expect(d.employees.map((e: Row) => e.code)).toEqual(['EMP-0001', 'EMP-0002']);
    expect(fake.tables.hrms_employees).toHaveLength(2);
    expect(d.employees[0].history[0]).toMatchObject({ field: 'Employee', to_value: 'Created', by_name: 'Sagar B' });
    expect(history(d.employees[0].id)).toHaveLength(1);
  });

  it('a dry run validates everything and writes nothing, not even a code', async () => {
    const res = await api().post('/hrms/employees/import').send({ dry_run: true, rows: [row(1), row(2, { email: 'broken' })] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ dry_run: true, total: 2, valid: 1, created: 0, failed: 1, employees: [] });
    expect(res.body.data.errors).toEqual([{ row: 2, error: expect.stringMatching(/email/) }]);
    expect(fake.log.filter((q) => q.op === 'insert')).toHaveLength(0);
    expect(fake.rpcLog).toHaveLength(0);
  });

  it('reserves all codes in one round trip, in order, skipping rows that bring their own', async () => {
    const res = await api().post('/hrms/employees/import').send({ rows: [row(1), row(2, { code: 'MER-7' }), row(3), row(4)] });
    expect(res.body.data.employees.map((e: Row) => e.code)).toEqual(['EMP-0001', 'MER-7', 'EMP-0002', 'EMP-0003']);
    expect(fake.rpcLog).toHaveLength(1);
    expect(fake.rpcLog[0]!.args).toMatchObject({ p_org: ORG, p_count: 3 });
  });

  it('rejects a code already taken, or repeated in the file, or an id repeated in the file', async () => {
    await create({ code: 'MER-1', email: 'x@example.com' });
    const res = await api().post('/hrms/employees/import').send({ rows: [row(1, { code: 'MER-1' }), row(2, { code: 'MER-2' }), row(3, { code: 'mer-2' }), row(4, { id: uid(400) }), row(5, { id: uid(400) })] });
    expect(res.body.data.errors.map((e: Row) => [e.row, e.error])).toEqual([
      [1, expect.stringMatching(/MER-1 is already in use/)], [3, expect.stringMatching(/repeated in this file/)], [5, expect.stringMatching(/Repeated in this file/)],
    ]);
    expect(res.body.data.created).toBe(2);
  });

  it('resolves department, designation and location by name, and takes the entity from the location', async () => {
    const res = await api().post('/hrms/employees/import').send({
      rows: [
        { ...row(1), department_id: undefined, designation_id: undefined, location_id: undefined, entity_id: undefined, department: ' sales ', designation: 'EXECUTIVE', location: 'pune hq' },
        { ...row(2), department_id: undefined, department: 'Underwater Basket Weaving' },
      ],
    });
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.employees[0]).toMatchObject({ department_id: DEP, designation_id: DSG, location_id: LOC, entity_id: ENT });
    expect(res.body.data.errors).toEqual([{ row: 2, error: 'Unknown department "Underwater Basket Weaving"' }]);
  });

  it('is idempotent when rows carry ids: a re-run leaves existing people alone', async () => {
    const rows = [row(1, { id: uid(401) }), row(2, { id: uid(402) })];
    expect((await api().post('/hrms/employees/import').send({ rows })).body.data.created).toBe(2);
    const again = await api().post('/hrms/employees/import').send({ rows });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ created: 0, existing: 2, failed: 0 });
    expect(fake.tables.hrms_employees).toHaveLength(2);
  });

  it('keeps going row by row when a bulk write fails, so the error lands on the right row', async () => {
    // The bulk insert is refused; the fallback inserts row by row and one of them collides on its code.
    fake.fails.push({ table: 'hrms_employees', op: 'insert', error: { code: '23505', message: 'duplicate key value violates unique constraint "hrms_employees_org_code_uq"' }, times: 1 });
    const res = await api().post('/hrms/employees/import').send({ rows: [row(1), row(2), row(3)] });
    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(3);
    expect(res.body.data.failed).toBe(0);
    expect(fake.tables.hrms_employees).toHaveLength(3);
  });

  it('rows that set optional fields next to rows that do not still get their defaults (uniform bulk rows)', async () => {
    const res = await api().post('/hrms/employees/import').send({ rows: [row(1, { status: 'active', pan: PAN, notice_days: 30 }), row(2), row(3, { employment_type: 'intern' })] });
    expect(res.body.data.created).toBe(3);
    const rows = fake.log.filter((q) => q.table === 'hrms_employees' && q.op === 'insert')[0]!.rows!;
    expect(rows.map((r) => [r.status, r.notice_days, r.last_name === 'Mehta', r.pan_enc === null])).toEqual([['active', 30, true, false], ['onboarding', 0, true, true], ['onboarding', 0, true, true]]);
    for (const r of rows) expect(r).toMatchObject({ probation_months: 0, uan_status: 'none', tax_regime: 'new', pay_mode: 'bank', pf_member: false, address: {} });
  });

  it('stores PAN / bank encrypted and never echoes them', async () => {
    const res = await api().post('/hrms/employees/import').send({ rows: [row(1, { pan: PAN, bank: BANK })] });
    const id = res.body.data.employees[0].id;
    expect(JSON.stringify(stored(id))).not.toContain(PAN);
    expect(decryptField(stored(id).pan_enc, `${id}:pan`)).toBe(PAN);
    expect(JSON.stringify(res.body)).not.toContain(ACCOUNT);
  });

  it('accepts at most 500 rows and at least one', async () => {
    expect((await api().post('/hrms/employees/import').send({ rows: [] })).status).toBe(400);
    const big = await api().post('/hrms/employees/import').send({ rows: Array.from({ length: 501 }, (_, i) => ({ first_name: `P${i}` })) });
    expect(big.status).toBe(400);
    expect(big.body.error).toMatch(/at most 500/);
    const ok = await api().post('/hrms/employees/import').send({ dry_run: true, rows: Array.from({ length: 500 }, (_, i) => row(i)) });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ total: 500, valid: 500, failed: 0 });
  });

  it('writes in chunks of 100, not one query per row', async () => {
    const res = await api().post('/hrms/employees/import').send({ rows: Array.from({ length: 250 }, (_, i) => row(i)) });
    expect(res.body.data.created).toBe(250);
    const inserts = fake.log.filter((q) => q.table === 'hrms_employees' && q.op === 'insert');
    expect(inserts.map((q) => q.rows!.length)).toEqual([100, 100, 50]);
    // supabase-js fills a key missing from some rows of a bulk insert with NULL (not the column default), so every row must carry every column
    for (const q of inserts) expect(new Set(q.rows!.map((r) => Object.keys(r).sort().join(','))).size).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('when the HRMS tables do not exist yet', () => {
  const NOT_READY = { success: false, error: 'HRMS storage is not set up yet', code: 'HRMS_NOT_READY' };

  it('answers 503 HRMS_NOT_READY, never a 500, on reads and writes', async () => {
    for (const t of ['hrms_entities', 'hrms_employees', 'hrms_settings', 'hrms_access_log']) fake.missing.add(t);
    const boot = await api().get('/hrms/bootstrap');
    expect(boot.status).toBe(503);
    expect(boot.body).toMatchObject(NOT_READY);
    expect(JSON.stringify(boot.body)).not.toMatch(/stack|PGRST|schema cache/);
    expect((await api().post('/hrms/entities').send({ name: 'X' })).body).toMatchObject(NOT_READY);
    expect((await api().post('/hrms/employees').send(person())).status).toBe(503);
    expect((await api().put('/hrms/settings/employee_code_prefix').send({ value: 'KIN-' })).status).toBe(503);
    expect((await api().get('/hrms/access-log')).status).toBe(503);
    expect((await api().post('/hrms/employees/import').send({ rows: [person()] })).status).toBe(503);
  });

  it('maps a missing counter function and a Postgres undefined-table error the same way', async () => {
    fake.missing.add('rpc:hrms_next_code');
    expect((await api().post('/hrms/employees').send(person())).body).toMatchObject(NOT_READY);
    fake.reset(); seedStructure();
    fake.fails.push({ table: 'hrms_departments', op: 'select', error: { code: '42P01', message: 'relation "public.hrms_departments" does not exist' }, times: 1 });
    expect((await api().get('/hrms/bootstrap')).body).toMatchObject(NOT_READY);
  });

  it('keeps a real database failure as a generic 500 with no internals', async () => {
    fake.fails.push({ table: 'hrms_entities', op: 'select', error: { code: 'XX000', message: 'connection to server at 10.0.3.4 lost' }, times: 1 });
    const res = await api().get('/hrms/bootstrap');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toContain('10.0.3.4');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('personal data stays out of the logs', () => {
  it('does not log request bodies when a request fails (400 or 500)', async () => {
    const lines: string[] = [];
    for (const level of ['error', 'warn', 'info', 'http', 'debug'] as const) {
      jest.spyOn(logger, level).mockImplementation(((...a: unknown[]) => { lines.push(JSON.stringify(a)); }) as never);
    }
    // 400: valid sensitive fields next to an invalid field
    await api().post('/hrms/employees').send(person({ email: 'bad', pan: PAN, bank: BANK }));
    // 400 from the sensitive field itself
    await api().post('/hrms/employees').send(person({ pan: 'ZZ123', bank: { ...BANK, ifsc: 'bad' } }));
    // 500 from the database
    fake.fails.push({ table: 'hrms_employees', op: 'insert', error: { message: 'boom' }, times: 1 });
    await api().post('/hrms/employees').send(person({ email: 'ok@example.com', pan: PAN, bank: BANK }));
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    for (const secret of [PAN, ACCOUNT, 'ZZ123', 'HDFC0001234', 'Aarav', '9876543210']) expect(all).not.toContain(secret);
    expect(all).toMatch(/\[hrms\] POST \/hrms\/employees -> 400/);
    expect(all).toMatch(/\[hrms\] POST \/hrms\/employees -> 500/);
  });
});

describe('rate limit on reveal', () => {
  it('allows 30 reveals a minute, then answers 429', async () => {
    const e = await create({ pan: PAN });
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      let last = 0;
      for (let i = 0; i < 31; i++) last = (await api().post(`/hrms/employees/${e.id}/reveal`).send({ field: 'pan', reason: 'checking the card' })).status;
      expect(last).toBe(429);
      expect(fake.tables.hrms_access_log).toHaveLength(30);
    } finally { process.env.NODE_ENV = prev; }
  });
});
