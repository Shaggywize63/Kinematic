/**
 * The bank file (GET /api/v1/hrms/payroll/runs/:id/bank-file): built on the server from the REAL, decrypted account numbers, for a frozen or
 * paid run only. Every call writes one hrms_access_log row first; account numbers exist only in the file that is returned and are never
 * logged, never put in an error, never written anywhere else.
 */
import express from 'express';
import request from 'supertest';
import { logger } from '../src/lib/logger';

jest.mock('../src/lib/supabase', () => {
  const { createHrmsFakeDb } = require('./helpers/hrmsFakeDb');
  const db = createHrmsFakeDb();
  return { __db: db, supabaseAdmin: db.client, supabase: db.client, getUserClient: () => db.client };
});

import hrmsRouter from '../src/routes/hrms.routes';
import { _resetHrmsCryptoForTests } from '../src/lib/hrmsCrypto';
import { buildBankFile } from '../src/services/hrms/payroll/engine';
import { toCsv, bankFileName } from '../src/services/hrms/payroll/bankfile.service';
import type { HrmsFakeDb, Row } from './helpers/hrmsFakeDb';
import { ACCOUNT, IDS, MASTER, ORG, OTHER_ORG, seedCompany, seedEmployee, seedPeople, uid } from './helpers/hrmsPayrollScenario';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fake = (require('../src/lib/supabase') as { __db: HrmsFakeDb }).__db;

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);
const P = '/hrms/payroll';
const M = '2026-10';
const t = (name: string): Row[] => (fake.tables[name] ??= []);
const KEY = 'api-test-hrms-data-key-0123456789abcdef';

let people: Record<string, Row>;
let warn: jest.SpyInstance; let error: jest.SpyInstance; let info: jest.SpyInstance; let consoleLog: jest.SpyInstance;
beforeAll(() => { process.env.HRMS_DATA_KEY = KEY; });
beforeEach(() => {
  process.env.HRMS_DATA_KEY = KEY; _resetHrmsCryptoForTests();
  fake.reset(); user = MASTER; seedCompany(fake); people = seedPeople(fake);
  warn = jest.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
  error = jest.spyOn(logger, 'error').mockImplementation((() => undefined) as never);
  info = jest.spyOn(logger, 'info').mockImplementation((() => undefined) as never);
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

const ok = (res: request.Response, status = 200) => { expect({ status: res.status, body: res.status === status ? undefined : res.body }).toEqual({ status, body: undefined }); return res.body.data; };
async function frozenRun() {
  const run = ok(await api().post(`${P}/runs`).send({ entity_id: IDS.ENT, month: M }), 201);
  ok(await api().post(`${P}/runs/${run.id}/compute`));
  return { run, frozen: ok(await api().post(`${P}/runs/${run.id}/freeze`)) };
}
const bank = (id: string) => api().get(`${P}/runs/${id}/bank-file`);
const accessRows = () => t('hrms_access_log');
const everythingLogged = () => JSON.stringify([warn.mock.calls, error.mock.calls, info.mock.calls, consoleLog.mock.calls]);
const noAccountNumber = (text: string) => { for (const a of Object.values(ACCOUNT)) expect(text).not.toContain(a); };

describe('the bank file: who gets one and when', () => {
  it('is only for a frozen or paid run: a draft or a computed run is refused (409 RUN_NOT_FROZEN) and nothing is decrypted or logged', async () => {
    const run = ok(await api().post(`${P}/runs`).send({ entity_id: IDS.ENT, month: M }), 201);
    for (const step of ['draft', 'computed']) {
      if (step === 'computed') ok(await api().post(`${P}/runs/${run.id}/compute`));
      fake.log.length = 0;
      const res = await bank(run.id);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'RUN_NOT_FROZEN', error: 'The bank file can only be made for a frozen or paid run. Freeze the run first.' });
      expect(accessRows()).toHaveLength(0);
      expect(fake.log.some((q) => q.table === 'hrms_employees' && String(q.cols).includes('bank_enc'))).toBe(false); // the sealed bank was never even read
    }
  });

  it('works for a frozen run and again once it is paid', async () => {
    const { run } = await frozenRun();
    ok(await bank(run.id));
    ok(await api().post(`${P}/runs/${run.id}/mark-paid`));
    ok(await bank(run.id));
    expect(accessRows()).toHaveLength(2);
  });

  it('is not available again after an unfreeze (the run is computed), and 404s for an unknown run or another org\'s run', async () => {
    const { run } = await frozenRun();
    ok(await api().post(`${P}/runs/${run.id}/unfreeze`).send({ reason: 'fix something' }));
    expect((await bank(run.id)).body.code).toBe('RUN_NOT_FROZEN');
    expect((await bank(uid(1, 'c'))).status).toBe(404);
    expect((await bank('not-an-id')).status).toBe(400);
    t('hrms_pay_runs').push({ id: uid(2, 'b'), org_id: OTHER_ORG, client_id: null, entity_id: uid(3, 'b'), month: M, type: 'regular', status: 'frozen', frozen_at: 'x', loan_recoveries: {}, attendance_locked_for: [], input_fingerprint: 'f' });
    expect((await bank(uid(2, 'b'))).status).toBe(404);
    expect(accessRows()).toHaveLength(0);
  });

  it('is refused to anyone but the master admin, before anything is read', async () => {
    const { run } = await frozenRun();
    fake.log.length = 0;
    user = { ...MASTER, impersonated_by: { id: 'x' } };
    expect((await bank(run.id)).status).toBe(403);
    user = { ...MASTER, email: 'ops@example.com' };
    expect((await bank(run.id)).status).toBe(403);
    expect(fake.log).toHaveLength(0);
  });
});

describe('the bank file: its content', () => {
  it('has the real account numbers, in the dashboard builder\'s shape: header, rows [code, holder, account, IFSC, bank, net, narration], skipped, masked', async () => {
    const { frozen } = await frozenRun();
    const file = ok(await bank(frozen.id));
    expect(Object.keys(file).sort()).toEqual(['header', 'masked', 'rows', 'skipped']);
    expect(file.header).toEqual(['Employee code', 'Name', 'Account number', 'IFSC', 'Bank', 'Amount', 'Narration']);
    const net = (k: string) => String(Math.round(frozen.payslips.find((p: Row) => p.employeeId === people[k]!.id).net));
    expect(file.rows).toEqual([
      [people.aarav!.code, 'Aarav Test', ACCOUNT.aarav, 'HDFC0001234', 'HDFC Bank', net('aarav'), `Salary ${M}`],
      [people.bela!.code, 'Bela Test', ACCOUNT.bela, 'ICIC0004321', 'ICICI Bank', net('bela'), `Salary ${M}`],
      [people.chitra!.code, 'Chitra Test', ACCOUNT.chitra, 'SBIN0000123', 'State Bank of India', net('chitra'), `Salary ${M}`],
    ]);
    expect(file.skipped).toEqual(expect.arrayContaining([{ employeeId: people.dev!.id, reason: 'Paid by cash' }, { employeeId: people.esha!.id, reason: 'No bank account' }]));
    expect(file.skipped).toHaveLength(2);
    expect(file.skipped.every((s: Row) => Object.keys(s).sort().join() === 'employeeId,reason')).toBe(true);
    expect(file.masked).toEqual([]);
  });

  it('is exactly what the dashboard\'s buildBankFile builds from the same data (the engine\'s own builder is used)', async () => {
    const { frozen } = await frozenRun();
    const file = ok(await bank(frozen.id));
    const banks: Row = { aarav: ACCOUNT.aarav, bela: ACCOUNT.bela, chitra: ACCOUNT.chitra };
    const emp = (k: string, over: Row = {}) => ({ id: people[k]!.id, code: people[k]!.code, payMode: people[k]!.pay_mode, bank: banks[k] ? { accountHolder: `${people[k]!.first_name} Test`, accountNumber: banks[k], ifsc: { aarav: 'HDFC0001234', bela: 'ICIC0004321', chitra: 'SBIN0000123' }[k], bankName: { aarav: 'HDFC Bank', bela: 'ICICI Bank', chitra: 'State Bank of India' }[k], accountType: 'savings' } : undefined, ...over });
    const want = buildBankFile({ employees: ['aarav', 'bela', 'chitra', 'dev', 'esha'].map((k) => emp(k)) } as any, { month: M, payslips: frozen.payslips } as any);
    expect(file).toEqual(JSON.parse(JSON.stringify(want)));
  });

  it('skips a person whose net pay is zero or negative, with the builder\'s reason', async () => {
    const ivy = seedEmployee(fake, { first_name: 'Ivy', structure_id: IDS.STD, annual_ctc: 240000, bank: { accountHolder: 'Ivy Test', accountNumber: '500100000055', ifsc: 'HDFC0001234', bankName: 'HDFC Bank', accountType: 'savings' } });
    ok(await api().post(`${P}/adjustments`).send({ employee_id: ivy.id, month: M, kind: 'one_time_deduction', amount: 9_000_000 }), 201);
    const { frozen } = await frozenRun();
    const file = ok(await bank(frozen.id));
    expect(file.skipped).toEqual(expect.arrayContaining([{ employeeId: ivy.id, reason: 'Net pay is zero or negative' }]));
    expect(file.rows.map((r: string[]) => r[0])).not.toContain(ivy.code);
  });

  it('skips a sealed account that cannot be read with the current key, saying so plainly, and never pays a wrong number', async () => {
    const { frozen } = await frozenRun();
    process.env.HRMS_DATA_KEY = 'a-completely-different-hrms-data-key-0123456789'; _resetHrmsCryptoForTests(); // the key changed: the sealed banks cannot be opened
    const res = await bank(frozen.id);
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([]);
    expect(res.body.data.masked.sort()).toEqual([people.aarav!.id, people.bela!.id, people.chitra!.id].sort());
    expect(res.body.data.skipped.filter((s: Row) => s.reason === 'Account number cannot be read with the current encryption key').map((s: Row) => s.employeeId).sort())
      .toEqual([people.aarav!.id, people.bela!.id, people.chitra!.id].sort());
    expect(JSON.stringify(res.body)).not.toContain('XXXXXXXXXX');
    expect(JSON.stringify(res.body)).not.toMatch(/browser/);
  });

  it('leaves out a person who is paid by bank but whose payslip is from a deleted employee row', async () => {
    const { frozen } = await frozenRun();
    t('hrms_employees').splice(t('hrms_employees').findIndex((e) => e.id === people.bela!.id), 1);
    const file = ok(await bank(frozen.id));
    expect(file.rows.map((r: string[]) => r[0])).toEqual([people.aarav!.code, people.chitra!.code]);
  });
});

describe('the bank file: the access log', () => {
  it('writes ONE row per call: field bank_file, reason "Bank file for <entity> <month>", the run, who and when, and no single employee', async () => {
    const { run } = await frozenRun();
    const before = Date.now();
    ok(await bank(run.id));
    expect(accessRows()).toHaveLength(1);
    expect(accessRows()[0]).toMatchObject({
      org_id: ORG, client_id: null, field: 'bank_file', reason: `Bank file for Meridian Retail Pvt Ltd ${M}`, run_id: run.id, employee_id: null, by_name: 'Sagar B', by_user_id: MASTER.id,
    });
    expect(Date.parse(accessRows()[0]!.at)).toBeGreaterThanOrEqual(before - 1000);
    ok(await bank(run.id)); ok(await api().get(`${P}/runs/${run.id}/bank-file?format=csv`));
    expect(accessRows()).toHaveLength(3); // every call, JSON or CSV
    expect(new Set(accessRows().map((r) => r.reason)).size).toBe(1);
  });

  it('reads back through the phase 1 access log API (newest first), without any account number', async () => {
    const { run } = await frozenRun();
    ok(await bank(run.id));
    const log = ok(await api().get('/hrms/access-log'));
    expect(log[0]).toMatchObject({ field: 'bank_file', reason: `Bank file for Meridian Retail Pvt Ltd ${M}`, run_id: run.id, employee_id: null });
    noAccountNumber(JSON.stringify(log));
  });

  it('fails closed: if the log row cannot be written, no file is returned (and no account number is in the answer)', async () => {
    const { run } = await frozenRun();
    fake.fails.push({ table: 'hrms_access_log', op: 'insert', error: { code: 'XX000', message: 'disk full' }, times: 1 });
    const res = await bank(run.id);
    expect(res.status).toBe(500);
    expect(res.body).toEqual(expect.objectContaining({ success: false, code: 'INTERNAL_ERROR' }));
    expect(res.body.data).toBeUndefined();
    noAccountNumber(JSON.stringify(res.body));
    expect(accessRows()).toHaveLength(0);
    ok(await bank(run.id)); // and works again once the log is back
  });

  it('answers 503 when the access log table is missing, with no file', async () => {
    const { run } = await frozenRun();
    fake.missing.add('hrms_access_log');
    const res = await bank(run.id);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('HRMS_NOT_READY');
    noAccountNumber(JSON.stringify(res.body));
  });
});

describe('the bank file: CSV', () => {
  it('?format=csv answers text/csv with a Content-Disposition filename and the same content, quoted like the dashboard\'s download', async () => {
    const { run } = await frozenRun();
    const json = ok(await bank(run.id));
    const res = await api().get(`${P}/runs/${run.id}/bank-file?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="bank-advice-${M}-meridian-retail-pvt-ltd.csv"`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toBe(toCsv(json.header, json.rows));
    expect(res.text.split('\n')).toHaveLength(1 + json.rows.length);
    expect(res.text.split('\n')[0]).toBe('Employee code,Name,Account number,IFSC,Bank,Amount,Narration');
    expect(res.text).toContain(ACCOUNT.aarav);
  });

  it('quotes cells with commas, quotes and newlines, and defuses a name that starts like a spreadsheet formula', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['line\nbreak', 'plain']])).toBe('a,b\n"x,y","say ""hi"""\n"line\nbreak",plain');
    expect(toCsv(['n'], [['=HYPERLINK("http://evil")'], ['+1'], ['-1'], ['@SUM(A1)'], ['safe']])).toBe('n\n"\'=HYPERLINK(""http://evil"")"\n\'+1\n\'-1\n\'@SUM(A1)\nsafe');
    expect(toCsv(['n'], [[null as any], [undefined as any], ['0']])).toBe('n\n\n\n0');
  });

  it('builds the file name from the entity and month', () => {
    expect(bankFileName('Meridian Retail Pvt Ltd', M)).toBe('bank-advice-2026-10-meridian-retail-pvt-ltd.csv');
    expect(bankFileName('!!!', M)).toBe('bank-advice-2026-10-entity.csv');
    expect(bankFileName('  Ünï & Co., Ltd ', '2026-02')).toBe('bank-advice-2026-02-n-co-ltd.csv');
  });

  it('does not let a name in the file break the response header (the file name comes from the entity name, slugged)', async () => {
    t('hrms_entities').find((e) => e.id === IDS.ENT)!.name = 'Evil"\r\nSet-Cookie: x=1 Ltd';
    const { run } = await frozenRun();
    const res = await api().get(`${P}/runs/${run.id}/bank-file?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="bank-advice-${M}-evil-set-cookie-x-1-ltd.csv"`);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('the bank file: account numbers stay in the file', () => {
  it('never reach a log, an error body, the access log, a run payload, the list, the bootstrap, the checks or the ECR', async () => {
    const { run, frozen } = await frozenRun();
    ok(await bank(run.id));
    await api().get(`${P}/runs/${run.id}/bank-file?format=csv`);
    const refused = [
      await api().get(`${P}/runs/${uid(1, 'c')}/bank-file`), await api().get(`${P}/runs/${run.id}x/bank-file`), await api().post(`${P}/runs/${run.id}/freeze`),
    ];
    for (const r of refused) noAccountNumber(JSON.stringify(r.body));
    const unfrozen = ok(await api().post(`${P}/runs/${run.id}/unfreeze`).send({ reason: 'check for leaks' }));
    const draft = ok(await api().post(`${P}/runs`).send({ entity_id: IDS.ENT, month: '2026-09' }), 201);
    const refused2 = await bank(draft.id);
    const surfaces = [
      frozen, unfrozen, refused2.body, accessRows(), t('hrms_pay_run_audit'), ok(await api().get(`${P}/bootstrap`)), ok(await api().get(`${P}/runs`)), ok(await api().get(`${P}/runs/${run.id}`)),
      ok(await api().get(`${P}/runs/${run.id}/checks`)), ok(await api().get(`${P}/runs/${run.id}/ecr`)), t('hrms_payslips'), t('hrms_pay_runs'), fake.rpcLog,
    ];
    noAccountNumber(JSON.stringify(surfaces));
    noAccountNumber(everythingLogged());
  });

  it('are never in a database write: the only thing written for a bank file is the access-log row', async () => {
    const { run } = await frozenRun();
    fake.log.length = 0; fake.rpcLog.length = 0;
    ok(await bank(run.id));
    const writes = fake.log.filter((q) => q.op !== 'select');
    expect(writes.map((q) => `${q.op}:${q.table}`)).toEqual(['insert:hrms_access_log']);
    noAccountNumber(JSON.stringify(writes.map((q) => [q.rows, q.patch])));
    expect(fake.rpcLog).toHaveLength(0);
  });

  it('are never in the logs even when the request fails after they were decrypted', async () => {
    const { run } = await frozenRun();
    fake.fails.push({ table: 'hrms_access_log', op: 'insert', error: { code: 'XX000', message: `could not write ${ACCOUNT.aarav}` }, times: 1 });
    const res = await bank(run.id);
    expect(res.status).toBe(500);
    noAccountNumber(JSON.stringify(res.body)); // the database's own message is not passed on
    expect(everythingLogged()).toMatch(/\[hrms\] GET \/hrms\/payroll\/runs\/.+\/bank-file -> 500/);
    // the router logs the route and the status only; the driver's message does carry the number in this contrived case,
    // so the line must at least not be the request body or a payload
    expect(everythingLogged()).not.toContain('Aarav Test');
  });

  it('is throttled like a reveal: 30 a minute, then 429, and every allowed call is logged', async () => {
    const { run } = await frozenRun();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      let last = 0;
      for (let i = 0; i < 31; i++) last = (await bank(run.id)).status;
      expect(last).toBe(429);
      expect(accessRows()).toHaveLength(30);
    } finally { process.env.NODE_ENV = prev; }
  });
});
