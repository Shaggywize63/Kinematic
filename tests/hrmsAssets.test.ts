/**
 * HRMS phase 6 (the Asset register on the server), driven over HTTP through the real router and services against the
 * in-memory PostgREST double (tests/helpers/hrmsFakeDb.ts, which also stands in for the two plpgsql functions
 * hrms_asset_create / hrms_asset_apply_event). Covers the service layer: the gate, scoping, the bootstrap shape, the
 * addAsset validation and every command's guard with the dashboard's exact words, tag assignment by type, serial/tag
 * uniqueness, idempotent create, the full state machine, and 503 HRMS_NOT_READY. The SQL itself (constraints, the fks,
 * the functions end to end, concurrency) is proven by the PGlite harness named in the final report.
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
import type { HrmsFakeDb, Row } from './helpers/hrmsFakeDb';
import { MASTER, ORG, OTHER_ORG, seedCompany, seedPeople, uid } from './helpers/hrmsPayrollScenario';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fake = (require('../src/lib/supabase') as { __db: HrmsFakeDb }).__db;

let user: any = MASTER;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req: any, _res, next) => { req.user = user; next(); });
app.use('/hrms', hrmsRouter);
const api = () => request(app);
const P = '/hrms/assets';

let people: Record<string, Row>;
beforeAll(() => { process.env.HRMS_DATA_KEY = 'api-test-hrms-data-key-0123456789abcdef'; });
beforeEach(() => {
  fake.reset(); user = MASTER; seedCompany(fake); people = seedPeople(fake);
  for (const level of ['error', 'warn'] as const) jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
});
afterEach(() => { jest.restoreAllMocks(); });

const t = (name: string): Row[] => (fake.tables[name] ??= []);
const stamp = { org_id: ORG, client_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
const ok = (res: request.Response, status = 200) => { expect({ status: res.status, body: res.status === status ? undefined : res.body }).toEqual({ status, body: undefined }); return res.body.data; };
const refused = (res: request.Response, status: number, code: string, error?: string | RegExp) => {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ success: false, code });
  if (typeof error === 'string') expect(res.body.error).toBe(error);
  else if (error) expect(res.body.error).toMatch(error);
};

const GOOD_ASSET = { type: 'laptop', make: 'Dell', model: 'Latitude 5440', serial: 'SN-TEST-0001', purchase_date: '2025-06-01', cost: 80000, warranty_months: 24, condition: 'new' };
const mkAsset = async (over: Row = {}) => ok(await api().post(P).send({ ...GOOD_ASSET, ...over }), 201);
const issue = async (id: string, over: Row = {}) => api().post(`${P}/${id}/issue`).send({ person_id: people.aarav!.id, condition: 'good', ack: true, ...over });

// ═══════════════════════════════════════════════════════════════════════════
describe('who may use the Asset register, and which rows it reaches', () => {
  const routes: Array<[string, string, any?]> = [
    ['get', '/bootstrap'],
    ['post', '', {}],
    ['post', `/${uid(1)}/issue`, {}], ['post', `/${uid(1)}/return`, {}], ['post', `/${uid(1)}/transfer`, {}],
    ['post', `/${uid(1)}/repair-out`, {}], ['post', `/${uid(1)}/repair-back`, {}], ['post', `/${uid(1)}/lost`, {}], ['post', `/${uid(1)}/retire`, {}],
  ];
  const callEach = async () => {
    const out: number[] = [];
    for (const [m, p, body] of routes) out.push((await (api() as any)[m](`${P}${p}`).send(body)).status);
    return out;
  };

  it('answers 403 to anyone but the master admin as themselves, on every route, and never reaches the database', async () => {
    for (const who of [
      { ...MASTER, email: 'someone@example.com' },
      { ...MASTER, impersonated_by: { id: 'x' } },
      { ...MASTER, acting_as_org: OTHER_ORG },
      { id: 'c', org_id: ORG, email: 'ops@client.com', role: 'admin', client_id: 'c1', enabled_modules: ['finance', 'hrms'] },
    ]) {
      fake.log.length = 0; fake.rpcLog.length = 0; user = who;
      expect(await callEach()).toEqual(routes.map(() => 403));
      expect(fake.log).toHaveLength(0);
      expect(fake.rpcLog).toHaveLength(0);
    }
  });

  it('answers 401 with no user', async () => {
    user = undefined;
    expect((await api().get(`${P}/bootstrap`)).status).toBe(401);
  });

  it('scopes every select on org_id and client_id IS NULL, and the atomic functions carry the org', async () => {
    const { asset } = await mkAsset();
    await issue(asset.id);
    await api().get(`${P}/bootstrap`);
    const queries = fake.log.filter((q) => ['hrms_assets', 'hrms_asset_events'].includes(q.table));
    expect(queries.length).toBeGreaterThanOrEqual(4);
    for (const q of queries) {
      const eqOrg = q.filters.find((f) => f.t === 'eq' && f.col === 'org_id');
      const nullClient = q.filters.find((f) => f.t === 'is' && f.col === 'client_id' && f.val === null);
      expect({ table: q.table, org: eqOrg?.val, clientNull: !!nullClient }).toEqual({ table: q.table, org: ORG, clientNull: true });
    }
    for (const call of fake.rpcLog.filter((c) => c.name.startsWith('hrms_asset_'))) expect(call.args.p_org).toBe(ORG);
  });

  it('ignores X-Client-Id entirely', async () => {
    const CLIENT = '99999999-9999-4999-8999-999999999999';
    await api().post(P).send(GOOD_ASSET).set('X-Client-Id', CLIENT);
    await api().get(`${P}/bootstrap`).set('X-Client-Id', CLIENT);
    for (const q of fake.log) expect(JSON.stringify(q.filters)).not.toContain(CLIENT);
    for (const r of t('hrms_assets')) expect(r.client_id).toBeNull();
    for (const r of t('hrms_asset_events')) expect(r.client_id).toBeNull();
  });

  it("never sees another org's assets or events, and bootstrap shows none of them", async () => {
    const other = { org_id: OTHER_ORG, client_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
    t('hrms_assets').push({ id: uid(41, 'b'), tag: 'AST-LAP-001', type: 'laptop', make: 'Acme', model: 'X', serial: 'THEIRS-1', purchase_date: '2025-01-01', cost: 1000, warranty_end: null, condition: 'good', status: 'in_stock', holder_id: null, ...other });
    t('hrms_asset_events').push({ id: uid(42, 'b'), asset_id: uid(41, 'b'), on_date: '2025-01-01', kind: 'purchased', from_id: null, to_id: null, condition: 'good', status: 'in_stock', ack: null, note: null, by_name: 'Them', ...other });
    const mine = await mkAsset();
    const b = ok(await api().get(`${P}/bootstrap`));
    expect(b.assets).toHaveLength(1);
    expect(b.assets[0].id).toBe(mine.asset.id);
    expect(b.events.every((e: Row) => e.asset_id === mine.asset.id)).toBe(true);
    // a command on another org's asset is a 404, never a cross-tenant write
    refused(await issue(uid(41, 'b')), 404, 'NOT_FOUND', 'That asset is not in the register.');
    expect(t('hrms_assets').find((r) => r.id === uid(41, 'b'))!.status).toBe('in_stock');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('bootstrap', () => {
  it('returns { assets, events, server_time }; empty for a new org', async () => {
    const b = ok(await api().get(`${P}/bootstrap`));
    expect(Object.keys(b).sort()).toEqual(['assets', 'events', 'server_time']);
    expect([b.assets.length, b.events.length]).toEqual([0, 0]);
    expect(typeof b.server_time).toBe('string');
  });

  it('returns every asset and all of its events, oldest-first, for replay', async () => {
    const { asset } = await mkAsset();
    await issue(asset.id);
    await api().post(`${P}/${asset.id}/return`).send({ condition: 'fair', next: 'in_stock' });
    const b = ok(await api().get(`${P}/bootstrap`));
    expect(b.assets).toHaveLength(1);
    const mine = b.events.filter((e: Row) => e.asset_id === asset.id);
    expect(mine.map((e: Row) => e.kind)).toEqual(['purchased', 'issued', 'returned']);
    expect(mine[mine.length - 1].status).toBe('in_stock'); // replay lands on the current status
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('addAsset (POST /assets)', () => {
  it('creates an in-stock asset and its purchased event; the wire shapes are exact', async () => {
    const { asset, event } = await mkAsset();
    expect(Object.keys(asset).sort()).toEqual(['condition', 'cost', 'created_at', 'holder_id', 'id', 'make', 'model', 'purchase_date', 'serial', 'status', 'tag', 'type', 'updated_at', 'warranty_end']);
    expect(asset).toMatchObject({ type: 'laptop', make: 'Dell', model: 'Latitude 5440', serial: 'SN-TEST-0001', purchase_date: '2025-06-01', cost: 80000, condition: 'new', status: 'in_stock', holder_id: null, tag: 'AST-LAP-001' });
    expect(asset.warranty_end).toBe('2027-06-01'); // 24 months from purchase
    expect(Object.keys(event).sort()).toEqual(['ack', 'asset_id', 'by', 'condition', 'created_at', 'id', 'kind', 'note', 'on', 'status', 'to_id', 'from_id', 'updated_at'].sort());
    expect(event).toMatchObject({ asset_id: asset.id, on: '2025-06-01', kind: 'purchased', status: 'in_stock', condition: 'new', from_id: null, to_id: null, ack: null, note: 'Added to the register.', by: MASTER.name });
  });

  it('assigns the tag per type (AST-<PREFIX>-NNN), counting up within a type', async () => {
    expect((await mkAsset({ serial: 'L1' })).asset.tag).toBe('AST-LAP-001');
    expect((await mkAsset({ serial: 'L2' })).asset.tag).toBe('AST-LAP-002');
    expect((await mkAsset({ type: 'phone', serial: 'P1' })).asset.tag).toBe('AST-PHN-001');
    expect((await mkAsset({ type: 'vehicle', serial: 'V1' })).asset.tag).toBe('AST-VEH-001');
  });

  it('uses a supplied free tag, but falls back to the next free one when it is taken', async () => {
    expect((await mkAsset({ serial: 'A', tag: 'AST-LAP-050' })).asset.tag).toBe('AST-LAP-050');
    // supplying the now-taken tag falls back to the computed next (max 50 -> 051)
    expect((await mkAsset({ serial: 'B', tag: 'AST-LAP-050' })).asset.tag).toBe('AST-LAP-051');
  });

  it('is idempotent on a client-supplied id (returns the same asset with 200)', async () => {
    const CID = 'aaaa0000-0000-4000-8000-000000000001';
    const a = ok(await api().post(P).send({ ...GOOD_ASSET, id: CID }), 201);
    const again = ok(await api().post(P).send({ ...GOOD_ASSET, id: CID, make: 'Changed' }), 200);
    expect([again.asset.id, again.asset.make, again.event.kind]).toEqual([a.asset.id, 'Dell', 'purchased']);
    expect(t('hrms_assets')).toHaveLength(1);
  });

  it('refuses the addAsset problems with the dashboard words', async () => {
    refused(await api().post(P).send({ ...GOOD_ASSET, make: '  ' }), 400, 'VALIDATION', 'Enter the make and the model.');
    refused(await api().post(P).send({ ...GOOD_ASSET, model: '' }), 400, 'VALIDATION', 'Enter the make and the model.');
    refused(await api().post(P).send({ ...GOOD_ASSET, serial: '   ' }), 400, 'VALIDATION', 'Enter the serial number.');
    refused(await api().post(P).send({ ...GOOD_ASSET, cost: 0 }), 400, 'VALIDATION', 'Enter the purchase cost.');
    refused(await api().post(P).send({ ...GOOD_ASSET, cost: -5 }), 400, 'VALIDATION', 'Enter the purchase cost.');
    refused(await api().post(P).send({ ...GOOD_ASSET, purchase_date: '2099-01-01' }), 400, 'VALIDATION', 'The purchase date cannot be in the future.');
    refused(await api().post(P).send({ ...GOOD_ASSET, type: 'spaceship' }), 400, 'VALIDATION');
  });

  it('refuses a duplicate serial (case-insensitive) with the dashboard words', async () => {
    await mkAsset({ serial: 'SN-DUP-1' });
    refused(await api().post(P).send({ ...GOOD_ASSET, serial: 'SN-DUP-1' }), 400, 'VALIDATION', 'This serial number is already in the register.');
    refused(await api().post(P).send({ ...GOOD_ASSET, serial: 'sn-dup-1' }), 400, 'VALIDATION', 'This serial number is already in the register.');
  });

  it('rounds the cost and stores no warranty when none is given', async () => {
    const { asset } = await mkAsset({ serial: 'R1', cost: 1234.67, warranty_months: 0 });
    expect(asset.cost).toBe(1235);
    expect(asset.warranty_end).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the state machine (issue / return / transfer / repair / lost / retire)', () => {
  it('runs the full happy path and returns { asset, event } at each step', async () => {
    const { asset } = await mkAsset();

    let r = ok(await issue(asset.id, { condition: 'good', note: 'Handed over' }));
    expect(r.asset).toMatchObject({ status: 'issued', holder_id: people.aarav!.id, condition: 'good' });
    expect(r.event).toMatchObject({ kind: 'issued', status: 'issued', to_id: people.aarav!.id, from_id: null, condition: 'good', ack: true, note: 'Handed over' });

    r = ok(await api().post(`${P}/${asset.id}/transfer`).send({ to_id: people.bela!.id, condition: 'good', ack: true }));
    expect(r.asset).toMatchObject({ status: 'issued', holder_id: people.bela!.id });
    expect(r.event).toMatchObject({ kind: 'transferred', status: 'issued', from_id: people.aarav!.id, to_id: people.bela!.id, ack: true });

    r = ok(await api().post(`${P}/${asset.id}/return`).send({ condition: 'fair', next: 'in_stock', note: 'Back' }));
    expect(r.asset).toMatchObject({ status: 'in_stock', holder_id: null, condition: 'fair' });
    expect(r.event).toMatchObject({ kind: 'returned', status: 'in_stock', from_id: people.bela!.id, to_id: null, condition: 'fair', ack: null });

    r = ok(await api().post(`${P}/${asset.id}/repair-out`).send({ note: 'Screen' }));
    expect(r.asset).toMatchObject({ status: 'in_repair', holder_id: null });
    expect(r.event).toMatchObject({ kind: 'repair_out', status: 'in_repair', condition: null });

    r = ok(await api().post(`${P}/${asset.id}/repair-back`).send({ condition: 'good' }));
    expect(r.asset).toMatchObject({ status: 'in_stock', condition: 'good' });
    expect(r.event).toMatchObject({ kind: 'repair_back', status: 'in_stock', condition: 'good' });

    r = ok(await api().post(`${P}/${asset.id}/retire`).send({ note: 'Old' }));
    expect(r.asset).toMatchObject({ status: 'retired' });
    expect(r.event).toMatchObject({ kind: 'retired', status: 'retired' });
  });

  it('return can send an asset straight to repair or to retired', async () => {
    const a = (await mkAsset({ serial: 'RET-1' })).asset;
    await issue(a.id);
    expect(ok(await api().post(`${P}/${a.id}/return`).send({ condition: 'damaged', next: 'in_repair' })).asset.status).toBe('in_repair');
    const b = (await mkAsset({ serial: 'RET-2' })).asset;
    await issue(b.id);
    expect(ok(await api().post(`${P}/${b.id}/return`).send({ condition: 'poor', next: 'retired' })).asset.status).toBe('retired');
  });

  it('marks an issued or in-stock asset lost', async () => {
    const a = (await mkAsset({ serial: 'LOST-1' })).asset;
    await issue(a.id);
    const r = ok(await api().post(`${P}/${a.id}/lost`).send({ note: 'Gone' }));
    expect(r.asset).toMatchObject({ status: 'lost', holder_id: null });
    expect(r.event).toMatchObject({ kind: 'lost', status: 'lost', from_id: people.aarav!.id });
  });

  it('issue: refuses with the dashboard words at each guard', async () => {
    refused(await issue(uid(999)), 404, 'NOT_FOUND', 'That asset is not in the register.');
    const a = (await mkAsset({ serial: 'ISS-1' })).asset;
    refused(await issue(a.id, { person_id: uid(888) }), 400, 'VALIDATION', 'Choose who it is for.');
    refused(await issue(a.id, { ack: false }), 400, 'VALIDATION', 'The receiver has to acknowledge receipt before it is issued.');
    await issue(a.id); // now issued
    refused(await issue(a.id), 409, 'ASSET_STATE', 'AST-LAP-001 is issued, so it cannot be issued.');
  });

  it('issue: the state refusal names the readable current status', async () => {
    const a = (await mkAsset({ serial: 'ISS-2' })).asset;
    await api().post(`${P}/${a.id}/repair-out`).send({});
    refused(await issue(a.id), 409, 'ASSET_STATE', `${a.tag} is in repair, so it cannot be issued.`);
  });

  it('return / transfer: only an issued asset, with the right people', async () => {
    const a = (await mkAsset({ serial: 'RT-1' })).asset; // in_stock
    refused(await api().post(`${P}/${a.id}/return`).send({ condition: 'good', next: 'in_stock' }), 409, 'ASSET_STATE', 'Only an issued asset can be returned.');
    refused(await api().post(`${P}/${a.id}/transfer`).send({ to_id: people.bela!.id, condition: 'good', ack: true }), 409, 'ASSET_STATE', 'Only an issued asset can be transferred.');
    await issue(a.id); // -> issued, held by aarav
    refused(await api().post(`${P}/${a.id}/transfer`).send({ to_id: people.aarav!.id, condition: 'good', ack: true }), 409, 'ASSET_STATE', 'It is already with this person.');
    refused(await api().post(`${P}/${a.id}/transfer`).send({ to_id: uid(777), condition: 'good', ack: true }), 400, 'VALIDATION', 'Choose who receives it.');
    refused(await api().post(`${P}/${a.id}/transfer`).send({ to_id: people.bela!.id, condition: 'good', ack: false }), 400, 'VALIDATION', 'The new holder has to acknowledge receipt before it is transferred.');
  });

  it('repair / lost / retire: the status guards with the dashboard words', async () => {
    const a = (await mkAsset({ serial: 'G-1' })).asset; // in_stock
    refused(await api().post(`${P}/${a.id}/repair-back`).send({ condition: 'good' }), 409, 'ASSET_STATE', 'Only an asset in repair can come back from repair.');
    await api().post(`${P}/${a.id}/retire`).send({}); // in_stock -> retired
    refused(await api().post(`${P}/${a.id}/repair-out`).send({}), 409, 'ASSET_STATE', 'Only an asset in stock or issued can go for repair.');
    refused(await api().post(`${P}/${a.id}/lost`).send({}), 409, 'ASSET_STATE', 'Only an asset in stock or issued can be marked lost.');
    refused(await api().post(`${P}/${a.id}/retire`).send({}), 409, 'ASSET_STATE', 'Only an asset in stock or in repair can be retired.');
  });

  it('two issues of one asset: one wins, the second is refused (the row is locked and re-checked)', async () => {
    const a = (await mkAsset({ serial: 'RACE-1' })).asset;
    const first = await issue(a.id);
    const second = await issue(a.id);
    expect(first.status).toBe(200);
    refused(second, 409, 'ASSET_STATE', 'AST-LAP-001 is issued, so it cannot be issued.');
    expect(t('hrms_asset_events').filter((e) => e.asset_id === a.id && e.kind === 'issued')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('503 when the asset tables are not there yet', () => {
  it('answers HRMS_NOT_READY on bootstrap, create and commands', async () => {
    const a = (await mkAsset()).asset;
    fake.missing.add('hrms_assets');
    refused(await api().get(`${P}/bootstrap`), 503, 'HRMS_NOT_READY', 'HRMS storage is not set up yet');
    refused(await api().post(P).send({ ...GOOD_ASSET, serial: 'NEW-1' }), 503, 'HRMS_NOT_READY');
    refused(await issue(a.id), 503, 'HRMS_NOT_READY');
  });
});
