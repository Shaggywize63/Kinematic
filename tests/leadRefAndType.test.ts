/**
 * Lead numbers (SR/LD/2627-12) and lead type (requirement | discussion), against an in-memory PostgREST fake:
 *
 *   - pure rules: format / prefix / default prefix / financial-year series / subject helper / export columns;
 *   - allocation: connected-B2B only, one series per financial year, never throws;
 *   - createLead: assigns once, never overwrites, ref_no unwritable by clients, lead_type validated, degrades on an
 *     unmigrated database;
 *   - reads: q search, lead_type / ref_no filters, CSV columns, detail JSON;
 *   - e-mail subject stamping;
 *   - POST /leads/ref-numbers/backfill (dry run, per-own-FY series, limit/remaining, admin-only, non-B2B, NOT_MIGRATED).
 */
import express from 'express';
import request from 'supertest';

type Row = Record<string, any>;

interface FakeDb {
  tables: Record<string, Row[]>;
  missingTables: Set<string>;
  missingCols: Record<string, Set<string>>;
  failTables: Record<string, string>;
  counters: Record<string, number>;
  rpcCalls: Array<{ fn: string; args: Row }>;
  rpcMode: 'ok' | 'missing' | 'error' | 'throw';
  inserts: Array<{ table: string; row: Row }>;
  updates: Array<{ table: string; row: Row }>;
  seq: number;
}

jest.mock('../src/lib/supabase', () => {
  const db: FakeDb = {
    tables: {}, missingTables: new Set(), missingCols: {}, failTables: {}, counters: {}, rpcCalls: [],
    rpcMode: 'ok', inserts: [], updates: [], seq: 0,
  };

  const splitOr = (expr: string) => expr.split(/,(?![^()]*\))/);
  const likeToRegex = (pat: string): RegExp => {
    let out = '';
    for (const c of pat) out += c === '%' || c === '*' ? '.*' : c === '_' ? '.' : c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return new RegExp(`^${out}$`, 'is');
  };
  const ilike = (v: unknown, pat: string) => v !== null && v !== undefined && likeToRegex(pat).test(String(v));
  const orParts = (expr: string) => splitOr(expr).map((p) => {
    const m = /^([a-z_>-]+)\.(is|eq|ilike|in)\.(.*)$/.exec(p)!;
    const [, col, op, val] = m;
    const test = op === 'is' ? (r: Row) => r[col] === null || r[col] === undefined
      : op === 'eq' ? (r: Row) => String(r[col]) === val.replace(/^"|"$/g, '')
      : op === 'ilike' ? (r: Row) => ilike(r[col], val)
      : (() => { const set = new Set(val.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''))); return (r: Row) => set.has(String(r[col])); })();
    return { col, test };
  });

  class Q {
    private op: 'select' | 'insert' | 'update' = 'select';
    private payload: any;
    private preds: Array<(r: Row) => boolean> = [];
    private cols: string[] = [];
    private orders: Array<{ c: string; asc: boolean }> = [];
    private head = false;
    private wantCount = false;
    private returning = false;
    private from = 0;
    private to = Infinity;
    private mode: 'many' | 'single' | 'maybe' = 'many';
    constructor(private t: string) {}
    select(c?: string, o?: { count?: string; head?: boolean }) {
      if (this.op === 'select' && c && c !== '*') this.cols.push(...c.split(',').map((x) => x.trim()).filter((x) => /^[a-z_]+$/.test(x)));
      if (this.op !== 'select') this.returning = true;
      this.wantCount = o?.count === 'exact'; this.head = !!o?.head; return this;
    }
    insert(p: any) { this.op = 'insert'; this.payload = p; return this; }
    update(p: Row) { this.op = 'update'; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.cols.push(c); this.preds.push((r) => String(r[c]) === String(v)); return this; }
    neq(c: string, v: unknown) { this.cols.push(c); this.preds.push((r) => String(r[c]) !== String(v)); return this; }
    in(c: string, vs: unknown[]) { this.cols.push(c); const s = new Set(vs.map(String)); this.preds.push((r) => s.has(String(r[c]))); return this; }
    is(c: string, v: null) { this.cols.push(c); this.preds.push((r) => (r[c] ?? null) === v); return this; }
    not() { return this; }
    gte(c: string, v: any) { this.cols.push(c); this.preds.push((r) => String(r[c]) >= String(v)); return this; }
    lte(c: string, v: any) { this.cols.push(c); this.preds.push((r) => String(r[c]) <= String(v)); return this; }
    ilike(c: string, pat: string) { this.cols.push(c); this.preds.push((r) => ilike(r[c], pat)); return this; }
    or(expr: string) {
      const parts = orParts(expr);
      parts.forEach((p) => this.cols.push(p.col));
      this.preds.push((r) => parts.some((p) => p.test(r)));
      return this;
    }
    order(c: string, o?: { ascending?: boolean }) { this.orders.push({ c, asc: o?.ascending !== false }); return this; }
    limit(n: number) { this.to = this.from + n - 1; return this; }
    range(a: number, b: number) { this.from = a; this.to = b; return this; }
    single() { this.mode = 'single'; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }

    private finish(rows: Row[], count?: number): any {
      const data = rows.map((r) => ({ ...r }));
      if (this.mode === 'single') return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      if (this.mode === 'maybe') return { data: data[0] ?? null, error: null };
      return { data, error: null, ...(this.wantCount ? { count: count ?? rows.length } : {}) };
    }

    private run(): any {
      const t = this.t;
      if (db.failTables[t]) return { data: null, error: { code: 'XX000', message: db.failTables[t] } };
      if (db.missingTables.has(t)) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${t}' in the schema cache` } };
      const gone = db.missingCols[t];
      if (this.op === 'insert') for (const p of (Array.isArray(this.payload) ? this.payload : [this.payload])) db.inserts.push({ table: t, row: { ...p } });
      const payloadRows: Row[] = this.op === 'insert' ? (Array.isArray(this.payload) ? this.payload : [this.payload]) : this.op === 'update' ? [this.payload] : [];
      const touched = [...this.cols, ...payloadRows.flatMap((r) => Object.keys(r))];
      const bad = gone ? touched.find((c) => gone.has(c)) : undefined;
      if (bad) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${bad}' column of '${t}' in the schema cache` } };
      const rows = (db.tables[t] ??= []);

      if (this.op === 'insert') {
        const made: Row[] = [];
        for (const p of payloadRows) {
          if (t === 'crm_leads' && p.ref_no) {
            const clash = rows.some((r) => !r.deleted_at && r.org_id === p.org_id && (r.client_id ?? '') === (p.client_id ?? '') && r.ref_no === p.ref_no);
            if (clash) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "crm_leads_org_client_ref_no_uidx"' } };
          }
          made.push({ id: `00000000-0000-4000-8000-${String(++db.seq + 100000).padStart(12, '0')}`, deleted_at: null, created_at: '2026-06-01T00:00:00Z', ...p });
        }
        rows.push(...made);
        return this.returning ? this.finish(made) : { data: null, error: null };
      }

      const hit = rows.filter((r) => this.preds.every((p) => p(r)));
      if (this.op === 'update') {
        db.updates.push({ table: t, row: { ...this.payload } });
        hit.forEach((r) => Object.assign(r, this.payload));
        return this.returning ? this.finish(hit) : { data: null, error: null };
      }

      let sorted = hit.slice();
      for (const { c, asc } of [...this.orders].reverse()) {
        sorted = sorted.sort((a, b) => {
          const x = a[c] ?? ''; const y = b[c] ?? '';
          const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
          return asc ? cmp : -cmp;
        });
      }
      if (this.head) return { data: null, error: null, count: sorted.length };
      return this.finish(sorted.slice(this.from, this.to + 1), sorted.length);
    }
    then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve().then(() => this.run()).then(res, rej); }
  }

  const rpc = async (fn: string, args: Row) => {
    db.rpcCalls.push({ fn, args });
    if (db.rpcMode === 'throw') throw new Error('network down');
    if (db.rpcMode === 'missing') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.next_lead_ref(p_client, p_series) in the schema cache' } };
    if (db.rpcMode === 'error') return { data: null, error: { code: 'XX000', message: 'boom' } };
    const key = `${args.p_client}|${args.p_series}`;
    db.counters[key] = (db.counters[key] ?? 0) + 1;
    return { data: db.counters[key], error: null };
  };

  const client = { from: (t: string) => new Q(t), rpc, auth: { getUser: async () => ({ data: { user: null }, error: { message: 'mock' } }) } };
  return { __db: db, supabaseAdmin: client, supabase: client, getUserClient: () => client };
});

// The create path's other collaborators are not under test here.
jest.mock('../src/services/crm/dedup.service', () => ({
  findLeadByEmail: jest.fn(async () => null), findLeadByPhone: jest.fn(async () => null),
}));
jest.mock('../src/services/crm/assignment.service', () => ({ assignOwner: jest.fn(async () => null) }));
jest.mock('../src/services/crm/ai/leadScoring.service', () => ({
  computeUnifiedScore: jest.fn(async () => ({ score: 10, breakdown: {} })),
  rerankLeadAsync: jest.fn(async () => undefined),
}));
jest.mock('../src/services/crm/automations.service', () => ({ fireForTrigger: jest.fn(async () => undefined) }));
jest.mock('../src/services/notify', () => ({ notify: jest.fn(), notifyUsers: jest.fn(), resolveManagers: jest.fn(async () => []) }));
jest.mock('../src/services/crm/customFields.service', () => ({
  ...jest.requireActual('../src/services/crm/customFields.service'),
  validateAndStampCustomFields: jest.fn(async (_o: string, _c: string | null, _e: string, cf: unknown) => cf ?? {}),
}));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn(async () => undefined) }));

let mockUser: Row = {};
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => { req.user = { ...mockUser }; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requireModule: () => (_req: any, _res: any, next: any) => next(),
  requireModuleAccess: () => (_req: any, _res: any, next: any) => next(),
  requireAnyModuleAccess: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/utils/demoCrm', () => ({ demoCrmMiddleware: (_req: any, _res: any, next: any) => next() }));
jest.mock('../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../src/services/ai.service', () => ({ AIService: { callKiniAI: jest.fn().mockRejectedValue(new Error('no model in tests')) } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __db: db } = require('../src/lib/supabase') as { __db: FakeDb };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

import {
  formatLeadRef, normalizeLeadPrefix, normalizeLeadRef, leadRefPrefixFromSettings, DEFAULT_LEAD_REF_PREFIX,
  allocateLeadRef, tryAllocateLeadRef, withLeadRefInSubject, subjectHasLeadRef, getLeadRefNo,
} from '../src/lib/leadRef';
import { financialYearCode } from '../src/lib/formRef';
import { clearClientFlagCache } from '../src/lib/clientFlags';
import { createLead } from '../src/services/crm/leads.service';
import { listLeadsWithCount } from '../src/services/crm/leads.service';
import { withLeadNumberColumns, discoverExportColumns } from '../src/services/crm/exportColumns.helper';
import { leadCreateSchema, leadUpdateSchema } from '../src/validators/crm.validators';
import { sendEmail } from '../src/services/crm/emails.service';
import { stubProvider } from '../src/services/crm/providers/stub.provider';
import { logger } from '../src/lib/logger';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const SPARK = 'c0218852-0a19-4dd0-b9fa-72f9e32ed0d8'; // a connected-B2B client
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';  // any other tenant
const ADMIN = { id: '33333333-3333-3333-3333-333333333333', org_id: ORG, role: 'admin', client_id: null, org_role_data_scope: 'all' };
const REP = { id: '44444444-4444-4444-4444-444444444444', org_id: ORG, role: 'executive', client_id: null, org_role_data_scope: 'all' };
const NOT_MIGRATED = 'Lead numbers are not set up in this database yet. Apply migration_lead_ref_and_type.sql.';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/crm', crmRouter);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? err.statusCode ?? 500).json({ success: false, error: { code: err.code ?? 'UNHANDLED', message: err.message } }));
const get = (url: string, client?: string) => { const r = request(app).get(url); return client ? r.set('X-Client-Id', client) : r; };
const post = (url: string, body: unknown, client?: string) => { const r = request(app).post(url).send(body as object); return client ? r.set('X-Client-Id', client) : r; };
const patch = (url: string, body: unknown, client?: string) => { const r = request(app).patch(url).send(body as object); return client ? r.set('X-Client-Id', client) : r; };

let n = 0;
const uid = () => `20000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const lead = (extra: Row = {}): Row => {
  const row = {
    id: uid(), org_id: ORG, client_id: SPARK, first_name: 'Asha', last_name: 'Rao', email: null, phone: null, company: null,
    status: 'new', score: 0, deleted_at: null, created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z',
    ref_no: null, lead_type: null, ...extra,
  };
  db.tables.crm_leads.push(row);
  return row;
};
const leads = () => db.tables.crm_leads;
const counter = (series: string, client = SPARK) => db.counters[`${client}|${series}`];

beforeEach(() => {
  db.tables = { crm_leads: [], clients: [{ id: SPARK, org_id: ORG, is_active: true, settings: {} }, { id: OTHER, org_id: ORG, is_active: true, settings: {} }], crm_settings: [] };
  db.missingTables = new Set(); db.missingCols = {}; db.failTables = {}; db.counters = {}; db.rpcCalls = []; db.rpcMode = 'ok';
  db.inserts = []; db.updates = []; db.seq = 0;
  mockUser = { ...ADMIN };
  clearClientFlagCache();
  (logger.warn as jest.Mock).mockClear();
});

// ── pure rules ──────────────────────────────────────────────────────────────
describe('formatLeadRef / normalizeLeadPrefix / default prefix', () => {
  it('formats prefix/FY-n with no zero padding', () => {
    expect(formatLeadRef('SR/LD', '2627', 1)).toBe('SR/LD/2627-1');
    expect(formatLeadRef('SR/LD', '2627', 12)).toBe('SR/LD/2627-12');
    expect(formatLeadRef('SR/LD', '2627', 1234)).toBe('SR/LD/2627-1234');
  });
  it('accepts upper/lower letters, digits and "/" groups up to 16 chars (stored upper-case)', () => {
    expect(normalizeLeadPrefix(' sr/ld ')).toBe('SR/LD');
    expect(normalizeLeadPrefix('LD')).toBe('LD');
    expect(normalizeLeadPrefix('A/B/C1')).toBe('A/B/C1');
    expect(normalizeLeadPrefix('A'.repeat(16))).toBe('A'.repeat(16));
  });
  it('rejects anything else', () => {
    for (const bad of [undefined, null, 5, '', '   ', 'A'.repeat(17), '/LD', 'SR/', 'SR//LD', 'SR-LD', 'SR LD', 'SR/L D', 'SR.LD']) {
      expect(normalizeLeadPrefix(bad)).toBeNull();
    }
  });
  it('defaults to SR/LD when the client has no lead_ref_prefix, honours a valid one, and falls back (with a warning) on junk', () => {
    expect(DEFAULT_LEAD_REF_PREFIX).toBe('SR/LD');
    expect(leadRefPrefixFromSettings({})).toBe('SR/LD');
    expect(leadRefPrefixFromSettings(null)).toBe('SR/LD');
    expect(leadRefPrefixFromSettings({ lead_ref_prefix: '  ' })).toBe('SR/LD');
    expect(leadRefPrefixFromSettings({ lead_ref_prefix: 'sp/lead' })).toBe('SP/LEAD');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(leadRefPrefixFromSettings({ lead_ref_prefix: 'no good!' })).toBe('SR/LD');
    expect(logger.warn).toHaveBeenCalled();
  });
  it('normalizeLeadRef cleans what a person types and rejects non-numbers', () => {
    expect(normalizeLeadRef(' sr/ld/2627–12 ')).toBe('SR/LD/2627-12');
    expect(normalizeLeadRef('SR/LD/2627-1')).toBe('SR/LD/2627-1');
    for (const bad of [undefined, 7, '', 'SR/LD', 'SR/LD/26-1', 'SR/LD/2627', "x'; drop", 'SR/LD/2627-12,owner_id.eq.1']) {
      expect(normalizeLeadRef(bad)).toBeNull();
    }
  });
});

// ── allocation ──────────────────────────────────────────────────────────────
describe('allocateLeadRef', () => {
  it('gives nothing without a client or for a client that is not connected-B2B (no database call at all)', async () => {
    await expect(allocateLeadRef(null)).resolves.toBeNull();
    await expect(allocateLeadRef(undefined)).resolves.toBeNull();
    await expect(allocateLeadRef(OTHER)).resolves.toBeNull();
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('numbers a B2B client with the default prefix, counting up in one financial-year series', async () => {
    const at = new Date('2026-11-12T10:00:00Z');
    expect(await allocateLeadRef(SPARK, at)).toBe('SR/LD/2627-1');
    expect(await allocateLeadRef(SPARK, at)).toBe('SR/LD/2627-2');
    expect(db.rpcCalls[0]).toEqual({ fn: 'next_lead_ref', args: { p_client: SPARK, p_series: 'SR/LD/2627' } });
    expect(counter('SR/LD/2627')).toBe(2);
  });

  it('restarts at 1 in a new financial year, and each year keeps its own counter', async () => {
    expect(await allocateLeadRef(SPARK, new Date('2027-03-31T10:00:00+05:30'))).toBe('SR/LD/2627-1');
    expect(await allocateLeadRef(SPARK, new Date('2027-04-01T00:00:00+05:30'))).toBe('SR/LD/2728-1');
    expect(await allocateLeadRef(SPARK, new Date('2026-03-31T10:00:00+05:30'))).toBe('SR/LD/2526-1');
    expect(await allocateLeadRef(SPARK, new Date('2027-05-01T00:00:00Z'))).toBe('SR/LD/2728-2');
    expect(financialYearCode(new Date('2026-04-01T00:00:00+05:30'))).toBe('2627');
  });

  it('uses the client\'s lead_ref_prefix setting', async () => {
    db.tables.clients[0].settings = { lead_ref_prefix: 'sp/ld' };
    expect(await allocateLeadRef(SPARK, new Date('2026-06-01T00:00:00Z'))).toBe('SP/LD/2627-1');
    expect(db.rpcCalls[0].args.p_series).toBe('SP/LD/2627');
  });

  it('never throws: an RPC error, a thrown RPC, a missing function or a bad value leave the lead without a number (and log)', async () => {
    for (const mode of ['error', 'throw', 'missing'] as const) {
      db.rpcMode = mode;
      await expect(allocateLeadRef(SPARK)).resolves.toBeNull();
    }
    expect((logger.warn as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('tryAllocateLeadRef tells "not migrated" apart from other failures', async () => {
    db.rpcMode = 'missing';
    expect(await tryAllocateLeadRef(SPARK)).toEqual({ ref: null, notMigrated: true });
    db.rpcMode = 'error';
    expect(await tryAllocateLeadRef(SPARK)).toEqual({ ref: null, notMigrated: false });
    db.rpcMode = 'ok';
    expect(await tryAllocateLeadRef(SPARK, new Date('2026-06-01T00:00:00Z'))).toEqual({ ref: 'SR/LD/2627-1', notMigrated: false });
  });
});

// ── e-mail subject ──────────────────────────────────────────────────────────
describe('withLeadRefInSubject', () => {
  const REF = 'SR/LD/2627-12';
  it('prefixes the subject with the number in brackets', () => {
    expect(withLeadRefInSubject('Quote for pumps', REF)).toBe('[SR/LD/2627-12] Quote for pumps');
  });
  it('turns an empty / missing subject into just the bracketed number', () => {
    expect(withLeadRefInSubject('', REF)).toBe('[SR/LD/2627-12]');
    expect(withLeadRefInSubject('   ', REF)).toBe('[SR/LD/2627-12]');
    expect(withLeadRefInSubject(undefined, REF)).toBe('[SR/LD/2627-12]');
    expect(withLeadRefInSubject(null, REF)).toBe('[SR/LD/2627-12]');
  });
  it('leaves a subject that already contains the number alone (case-insensitive, any position)', () => {
    expect(withLeadRefInSubject('[SR/LD/2627-12] Quote', REF)).toBe('[SR/LD/2627-12] Quote');
    expect(withLeadRefInSubject('Re: [sr/ld/2627-12] Quote', REF)).toBe('Re: [sr/ld/2627-12] Quote');
    expect(withLeadRefInSubject('Quote SR/LD/2627-12', REF)).toBe('Quote SR/LD/2627-12');
  });
  it('does not mistake another number for this one (…-1 vs …-12, …-123)', () => {
    expect(subjectHasLeadRef('About SR/LD/2627-123', REF)).toBe(false);
    expect(withLeadRefInSubject('About SR/LD/2627-123', REF)).toBe('[SR/LD/2627-12] About SR/LD/2627-123');
    expect(withLeadRefInSubject('About SR/LD/2627-12', 'SR/LD/2627-1')).toBe('[SR/LD/2627-1] About SR/LD/2627-12');
    expect(withLeadRefInSubject('XSR/LD/2627-12', REF)).toBe('[SR/LD/2627-12] XSR/LD/2627-12');
  });
  it('leaves the subject unchanged when there is no number', () => {
    expect(withLeadRefInSubject('Quote', null)).toBe('Quote');
    expect(withLeadRefInSubject('Quote', undefined)).toBe('Quote');
    expect(withLeadRefInSubject('Quote', '  ')).toBe('Quote');
    expect(withLeadRefInSubject('', null)).toBe('');
  });
});

describe('sendEmail stamps the lead number', () => {
  let sent: Row[];
  beforeEach(() => {
    db.tables.crm_email_logs = []; sent = [];
    jest.spyOn(stubProvider, 'send').mockImplementation(async (i: any) => { sent.push(i); return { message_id: 'm1' }; });
  });
  afterEach(() => jest.restoreAllMocks());
  const base = { org_id: ORG, to: 'x@y.com', body_html: '<p>Hi</p>', bypass_suppression: true };

  it('sends and logs "[ref] subject" for a numbered lead', async () => {
    const l = lead({ ref_no: 'SR/LD/2627-12' });
    await sendEmail({ ...base, subject: 'Quote for pumps', lead_id: l.id });
    expect(sent[0].subject).toBe('[SR/LD/2627-12] Quote for pumps');
    expect(db.tables.crm_email_logs[0].subject).toBe('[SR/LD/2627-12] Quote for pumps');
  });
  it('does not double-stamp a subject that already has it (a reply)', async () => {
    const l = lead({ ref_no: 'SR/LD/2627-12' });
    await sendEmail({ ...base, subject: 'Re: [SR/LD/2627-12] Quote', lead_id: l.id });
    expect(sent[0].subject).toBe('Re: [SR/LD/2627-12] Quote');
  });
  it('leaves the subject alone for an un-numbered lead, no lead, or another org\'s lead', async () => {
    const plain = lead();
    const foreign = lead({ org_id: '00000000-0000-0000-0000-0000000000bb', ref_no: 'SR/LD/2627-3' });
    await sendEmail({ ...base, subject: 'A', lead_id: plain.id });
    await sendEmail({ ...base, subject: 'B' });
    await sendEmail({ ...base, subject: 'C', lead_id: foreign.id });
    expect(sent.map((s) => s.subject)).toEqual(['A', 'B', 'C']);
  });
  it('still sends when the lead lookup fails (unmigrated column, DB error)', async () => {
    const l = lead({ ref_no: 'SR/LD/2627-12' });
    db.missingCols.crm_leads = new Set(['ref_no']);
    await sendEmail({ ...base, subject: 'Quote', lead_id: l.id });
    expect(sent[0].subject).toBe('Quote');
    db.missingCols = {}; db.failTables.crm_leads = 'db down';
    await expect(sendEmail({ ...base, subject: 'Quote2', lead_id: l.id })).resolves.toBeTruthy();
    expect(sent[1].subject).toBe('Quote2');
    expect(await getLeadRefNo(ORG, l.id)).toBeNull();
  });
  it('stamps the log of a suppressed (not sent) mail too', async () => {
    const l = lead({ ref_no: 'SR/LD/2627-12' });
    db.tables.crm_email_unsubscribes = [{ id: 'u1', org_id: ORG, email: 'x@y.com' }];
    await sendEmail({ ...base, bypass_suppression: false, subject: 'Offer', lead_id: l.id });
    expect(sent).toHaveLength(0);
    expect(db.tables.crm_email_logs[0].subject).toBe('[SR/LD/2627-12] Offer');
  });
});

// ── validators ──────────────────────────────────────────────────────────────
describe('lead_type validation', () => {
  const ok = { first_name: 'A' };
  it('accepts requirement, discussion, null, and omitted (create and patch)', () => {
    for (const t of ['requirement', 'discussion', null, undefined]) {
      expect(leadCreateSchema.safeParse({ ...ok, lead_type: t }).success).toBe(true);
      expect(leadUpdateSchema.safeParse({ lead_type: t }).success).toBe(true);
    }
    expect(leadUpdateSchema.safeParse({}).success).toBe(true);
  });
  it('reads an empty string as null and rejects any other value', () => {
    expect(leadCreateSchema.parse({ ...ok, lead_type: '' }).lead_type).toBeNull();
    for (const bad of ['Requirement', 'hot', 'both', 1, true, {}]) {
      expect(leadCreateSchema.safeParse({ ...ok, lead_type: bad }).success).toBe(false);
      expect(leadUpdateSchema.safeParse({ lead_type: bad }).success).toBe(false);
    }
  });
  it('drops ref_no from client bodies (read-only)', () => {
    expect(leadCreateSchema.parse({ ...ok, ref_no: 'SR/LD/2627-99' })).not.toHaveProperty('ref_no');
    expect(leadUpdateSchema.parse({ ref_no: 'SR/LD/2627-99' })).not.toHaveProperty('ref_no');
  });
});

// ── createLead ──────────────────────────────────────────────────────────────
describe('createLead', () => {
  const make = (extra: Row = {}, client: string | null = SPARK) =>
    createLead({ org_id: ORG, payload: { first_name: 'Asha', client_id: client, ...extra } as any, skipDedup: true });

  it('numbers a connected-B2B lead and stores the lead type', async () => {
    const l = await make({ lead_type: 'requirement' });
    expect(l.ref_no).toMatch(/^SR\/LD\/\d{4}-1$/);
    expect(l.lead_type).toBe('requirement');
    expect(leads()[0]).toMatchObject({ ref_no: l.ref_no, lead_type: 'requirement' });
  });

  it('gives each new lead the next number, once', async () => {
    const a = await make(); const b = await make({ first_name: 'Bo' });
    const num = (x: any) => Number(String(x.ref_no).split('-')[1]);
    expect(num(b)).toBe(num(a) + 1);
    expect(db.rpcCalls).toHaveLength(2);
  });

  it('ignores a ref_no sent in the payload (read-only) and allocates its own', async () => {
    const l = await make({ ref_no: 'SR/LD/2627-999' });
    expect(l.ref_no).not.toBe('SR/LD/2627-999');
    expect(l.ref_no).toMatch(/-1$/);
    // a non-numbered tenant cannot smuggle one in either
    const o = await make({ ref_no: 'SR/LD/2627-5' }, OTHER);
    expect(o.ref_no ?? null).toBeNull();
    expect(db.inserts.filter((i) => i.table === 'crm_leads').every((i) => i.row.ref_no !== 'SR/LD/2627-999' && i.row.ref_no !== 'SR/LD/2627-5')).toBe(true);
  });

  it('writes the exact row it always did for a client without numbers and no lead type (no new keys)', async () => {
    await make({}, OTHER);
    const row = db.inserts.find((i) => i.table === 'crm_leads')!.row;
    expect('ref_no' in row).toBe(false);
    expect('lead_type' in row).toBe(false);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('accepts a lead type on a client without numbers', async () => {
    const l = await make({ lead_type: 'discussion' }, OTHER);
    expect(l.lead_type).toBe('discussion');
    expect(l.ref_no ?? null).toBeNull();
  });

  it('ignores an invalid lead_type value instead of writing it', async () => {
    await make({ lead_type: 'hot' }, OTHER);
    expect('lead_type' in db.inserts.find((i) => i.table === 'crm_leads')!.row).toBe(false);
  });

  it('saves the lead un-numbered when the counter is unavailable', async () => {
    db.rpcMode = 'missing';
    const l = await make();
    expect(l.id).toBeTruthy();
    expect(l.ref_no ?? null).toBeNull();
  });

  it('degrades on a database without the columns: retries once without ref_no / lead_type and still creates the lead', async () => {
    db.missingCols.crm_leads = new Set(['ref_no', 'lead_type']);
    const l = await make({ lead_type: 'requirement' });
    expect(l.id).toBeTruthy();
    const attempts = db.inserts.filter((i) => i.table === 'crm_leads');
    expect(attempts).toHaveLength(2);
    expect('ref_no' in attempts[0].row && 'lead_type' in attempts[0].row).toBe(true);
    expect('ref_no' in attempts[1].row || 'lead_type' in attempts[1].row).toBe(false);
    expect(leads()).toHaveLength(1);
  });

  it('degrades when only lead_type is missing too (a lead type on an un-numbered client)', async () => {
    db.missingCols.crm_leads = new Set(['lead_type']);
    const l = await make({ lead_type: 'discussion' }, OTHER);
    expect(l.id).toBeTruthy();
    expect(db.inserts.filter((i) => i.table === 'crm_leads')).toHaveLength(2);
  });

  it('does not swallow an unrelated missing column', async () => {
    db.missingCols.crm_leads = new Set(['industry']);
    await expect(make({ industry: 'Steel' })).rejects.toThrow(/industry/);
    expect(db.inserts.filter((i) => i.table === 'crm_leads')).toHaveLength(1);
  });

  it('saves the lead un-numbered if the unique index refuses the number', async () => {
    const day = new Date();
    const taken = await allocateLeadRef(SPARK, day); // consume 1
    lead({ ref_no: formatLeadRef('SR/LD', financialYearCode(day), 2) }); // someone already holds number 2
    expect(taken).toMatch(/-1$/);
    const l = await make();
    expect(l.id).toBeTruthy();
    expect(l.ref_no ?? null).toBeNull();
  });

  it('a lead keeps its number: updateLead cannot change or clear ref_no', async () => {
    const l = await make();
    const { updateLead } = await import('../src/services/crm/leads.service');
    await updateLead(ORG, l.id, { ref_no: 'SR/LD/2627-777', notes: 'hi' } as any);
    await updateLead(ORG, l.id, { ref_no: null, notes: 'again' } as any);
    expect(leads()[0].ref_no).toBe(l.ref_no);
    expect(db.updates.every((u) => !('ref_no' in u.row))).toBe(true);
    expect(db.rpcCalls).toHaveLength(1); // no new allocation on edit
  });
});

// ── lead routes ─────────────────────────────────────────────────────────────
describe('POST /leads and PATCH /leads/:id', () => {
  it('numbers the new lead, returns ref_no and lead_type, and ignores a client-sent ref_no', async () => {
    const res = await post('/crm/leads', { first_name: 'Asha', lead_type: 'requirement', ref_no: 'SR/LD/2627-500' }, SPARK);
    expect(res.status).toBe(201);
    expect(res.body.data.ref_no).toMatch(/^SR\/LD\/\d{4}-1$/);
    expect(res.body.data.ref_no).not.toBe('SR/LD/2627-500');
    expect(res.body.data.lead_type).toBe('requirement');
  });

  it('rejects an invalid lead_type with 400 (create and patch)', async () => {
    expect((await post('/crm/leads', { first_name: 'A', lead_type: 'hot' }, SPARK)).status).toBe(400);
    const l = lead();
    expect((await patch(`/crm/leads/${l.id}`, { lead_type: 'hot' }, SPARK)).status).toBe(400);
  });

  it('PATCH changes lead_type but never ref_no', async () => {
    const l = lead({ ref_no: 'SR/LD/2627-4', lead_type: 'discussion' });
    const res = await patch(`/crm/leads/${l.id}`, { lead_type: 'requirement', ref_no: 'SR/LD/2627-5' }, SPARK);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ lead_type: 'requirement', ref_no: 'SR/LD/2627-4' });
    expect(leads()[0].ref_no).toBe('SR/LD/2627-4');
    // clearing the type is allowed
    expect((await patch(`/crm/leads/${l.id}`, { lead_type: null }, SPARK)).body.data.lead_type).toBeNull();
  });

  it('PATCH lead_type on a database without the column still saves the rest of the edit', async () => {
    const l = lead();
    db.missingCols.crm_leads = new Set(['lead_type']);
    const res = await patch(`/crm/leads/${l.id}`, { lead_type: 'requirement', notes: 'kept' }, SPARK);
    expect(res.status).toBe(200);
    expect(leads()[0].notes).toBe('kept');
  });

  it('GET /leads/:id (detail) returns both fields', async () => {
    const l = lead({ ref_no: 'SR/LD/2627-8', lead_type: 'discussion' });
    const res = await get(`/crm/leads/${l.id}`, SPARK);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ref_no: 'SR/LD/2627-8', lead_type: 'discussion' });
  });
});

describe('lead_type works with the field-overrides settings like other built-in fields', () => {
  const overrides = (o: Row) => { db.tables.crm_settings = [{ org_id: ORG, client_id: SPARK, config: { field_overrides: o } }]; };

  it('required: a create without it is 400 "Lead type is required"; with it is fine', async () => {
    overrides({ 'lead.lead_type': { required: true } });
    const missing = await post('/crm/leads', { first_name: 'A' }, SPARK);
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toContain('Lead type is required');
    expect((await post('/crm/leads', { first_name: 'A', lead_type: 'requirement' }, SPARK)).status).toBe(201);
  });

  it('required on PATCH only bites when the caller clears it', async () => {
    overrides({ 'lead.lead_type': { required: true } });
    const l = lead({ lead_type: 'requirement' });
    expect((await patch(`/crm/leads/${l.id}`, { notes: 'x' }, SPARK)).status).toBe(200);
    expect((await patch(`/crm/leads/${l.id}`, { lead_type: null }, SPARK)).status).toBe(400);
  });

  it('hidden: the value is stripped before it is stored (create and patch)', async () => {
    overrides({ 'lead.lead_type': { hidden: true } });
    const res = await post('/crm/leads', { first_name: 'A', lead_type: 'requirement' }, SPARK);
    expect(res.status).toBe(201);
    expect(res.body.data.lead_type ?? null).toBeNull();
    const l = lead();
    await patch(`/crm/leads/${l.id}`, { lead_type: 'discussion' }, SPARK);
    expect(leads().find((r) => r.id === l.id)!.lead_type).toBeNull();
  });

  it('a scoped (@b2b) override applies to a B2B-form lead', async () => {
    overrides({ 'lead.lead_type@b2b': { hidden: true } });
    const res = await post('/crm/leads', { first_name: 'A', lead_type: 'requirement' }, SPARK);
    expect(res.body.data.lead_type ?? null).toBeNull();
  });
});

// ── reads ───────────────────────────────────────────────────────────────────
describe('lead list: search, filters', () => {
  beforeEach(() => {
    lead({ first_name: 'Anil', ref_no: 'SR/LD/2627-1', lead_type: 'requirement' });
    lead({ first_name: 'Beena', ref_no: 'SR/LD/2627-12', lead_type: 'discussion' });
    lead({ first_name: 'Chitra', ref_no: 'SR/LD/2526-12', lead_type: null });
    lead({ first_name: 'Dev', ref_no: null });
  });
  const names = (res: request.Response) => res.body.data.map((r: Row) => r.first_name).sort();

  it('q matches the lead number, case-insensitively, as a contains', async () => {
    expect(names(await get('/crm/leads?q=sr/ld/2627-12', SPARK))).toEqual(['Beena']);
    expect(names(await get('/crm/leads?q=2627-1', SPARK))).toEqual(['Anil', 'Beena']);
    expect(names(await get('/crm/leads?q=SR%2FLD', SPARK))).toEqual(['Anil', 'Beena', 'Chitra']);
  });

  it('q still matches names', async () => {
    expect(names(await get('/crm/leads?q=dev', SPARK))).toEqual(['Dev']);
  });

  it('filters by lead_type', async () => {
    expect(names(await get('/crm/leads?lead_type=requirement', SPARK))).toEqual(['Anil']);
    expect(names(await get('/crm/leads?lead_type=discussion', SPARK))).toEqual(['Beena']);
    const bad = await get('/crm/leads?lead_type=hot', SPARK);
    expect(bad.status).toBe(400);
  });

  it('filters by exact ref_no (case-insensitive input, not a contains)', async () => {
    expect(names(await get('/crm/leads?ref_no=SR/LD/2627-1', SPARK))).toEqual(['Anil']);
    expect(names(await get('/crm/leads?ref_no=sr%2Fld%2F2627-12', SPARK))).toEqual(['Beena']);
    expect(names(await get('/crm/leads?ref_no=SR/LD/2627-99', SPARK))).toEqual([]);
  });

  it('refuses a malformed ref_no (never interpolated)', async () => {
    const res = await get(`/crm/leads?ref_no=${encodeURIComponent('x,owner_id.eq.1')}`, SPARK);
    expect(res.status).toBe(400);
  });

  it('on a database without the columns: search still works, filters match nothing', async () => {
    db.missingCols.crm_leads = new Set(['ref_no', 'lead_type']);
    for (const l of leads()) { delete l.ref_no; delete l.lead_type; }
    expect(names(await get('/crm/leads?q=dev', SPARK))).toEqual(['Dev']);
    expect(names(await get('/crm/leads?q=SR%2FLD', SPARK))).toEqual([]);
    const f = await get('/crm/leads?lead_type=requirement', SPARK);
    expect(f.status).toBe(200);
    expect(f.body.data).toEqual([]);
    expect((await get('/crm/leads?ref_no=SR/LD/2627-1', SPARK)).body.data).toEqual([]);
  });

  it('a client without numbers searches exactly as before (no ref_no term in a plain search)', async () => {
    db.missingCols.crm_leads = new Set(['ref_no']); // would blow up if the term were added
    const rows = await listLeadsWithCount(ORG, { q: 'dev' }, OTHER, { strictClient: true });
    expect(rows.total).toBe(0);
    expect((logger.warn as jest.Mock)).not.toHaveBeenCalled();
  });
});

describe('lead CSV export', () => {
  it('has "Lead No" after Lead ID and "Lead Type" after Status', async () => {
    lead({ first_name: 'Anil', ref_no: 'SR/LD/2627-1', lead_type: 'requirement' });
    lead({ first_name: 'Beena', ref_no: 'SR/LD/2627-2', lead_type: null });
    const res = await get('/crm/leads/export', SPARK);
    expect(res.status).toBe(200);
    const [header, ...lines] = res.text.trim().split('\n');
    const cols = header.split(',');
    expect(cols[0]).toBe('Lead ID');
    expect(cols[1]).toBe('Lead No');
    expect(cols[cols.indexOf('Status') + 1]).toBe('Lead Type');
    expect(cols.filter((c) => c === 'Lead No' || c === 'Lead Type' || c === 'Ref No')).toEqual(['Lead No', 'Lead Type']);
    const byName = (name: string) => lines.find((l) => l.split(',')[cols.indexOf('First Name')] === name)!.split(',');
    expect(byName('Anil')[1]).toBe('SR/LD/2627-1');
    expect(byName('Anil')[cols.indexOf('Lead Type')]).toBe('requirement');
    expect(byName('Beena')[cols.indexOf('Lead Type')]).toBe('');
  });

  it('withLeadNumberColumns: Lead Type only on a migrated DB; Lead No only for a numbered client or when a lead has one', () => {
    const base = discoverExportColumns({ id: 'x', first_name: 'a', status: 'new', created_at: 'z', ref_no: null, lead_type: null });
    const lead0 = [{ id: 'x', first_name: 'a', status: 'new', ref_no: null, lead_type: null }];
    const keys = (c: Array<{ key: string }>) => c.map((x) => x.key);
    expect(keys(withLeadNumberColumns([{ key: 'id', label: 'Lead ID' }, ...base], lead0, false))).not.toContain('ref_no');
    expect(keys(withLeadNumberColumns([{ key: 'id', label: 'Lead ID' }, ...base], lead0, false))).toContain('lead_type');
    expect(keys(withLeadNumberColumns([{ key: 'id', label: 'Lead ID' }, ...base], lead0, true)).slice(0, 2)).toEqual(['id', 'ref_no']);
    expect(keys(withLeadNumberColumns([{ key: 'id', label: 'Lead ID' }, ...base], [{ ...lead0[0], ref_no: 'SR/LD/2627-1' }], false))).toContain('ref_no');
    // unmigrated rows (no such keys): nothing added
    const unmigrated = discoverExportColumns({ id: 'x', first_name: 'a', status: 'new' });
    expect(keys(withLeadNumberColumns([{ key: 'id', label: 'Lead ID' }, ...unmigrated], [{ id: 'x', first_name: 'a', status: 'new' }], true)))
      .not.toEqual(expect.arrayContaining(['ref_no']));
  });
});

// ── backfill ────────────────────────────────────────────────────────────────
describe('POST /leads/ref-numbers/backfill', () => {
  const URL = '/crm/leads/ref-numbers/backfill';
  const seedMissing = () => {
    // created out of order on purpose; one already numbered, one soft-deleted, one in another client
    lead({ id: 'a1', first_name: 'Mar26', created_at: '2026-03-10T10:00:00Z' });             // FY 2526
    lead({ id: 'a2', first_name: 'Apr26', created_at: '2026-04-05T10:00:00Z' });             // FY 2627
    lead({ id: 'a0', first_name: 'Feb26', created_at: '2026-02-10T10:00:00Z' });             // FY 2526
    lead({ id: 'a3', first_name: 'May26', created_at: '2026-05-05T10:00:00Z' });             // FY 2627
    lead({ id: 'n1', first_name: 'Done', created_at: '2026-01-01T10:00:00Z', ref_no: 'SR/LD/2526-7' });
    lead({ id: 'd1', first_name: 'Gone', created_at: '2026-01-02T10:00:00Z', deleted_at: '2026-02-01T00:00:00Z' });
    lead({ id: 'o1', first_name: 'Other', created_at: '2026-01-03T10:00:00Z', client_id: OTHER });
  };
  const ref = (id: string) => leads().find((l) => l.id === id)!.ref_no;

  it('is admin-only (403 for a rep) and writes nothing', async () => {
    seedMissing();
    mockUser = { ...REP };
    const res = await post(URL, { dry_run: false }, SPARK);
    expect(res.status).toBe(403);
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
  });

  it('answers 400 "Lead numbers are not used by this client" for a client that is not connected-B2B, or no client', async () => {
    seedMissing();
    for (const c of [OTHER, undefined]) {
      const res = await post(URL, { dry_run: false }, c);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Lead numbers are not used by this client');
    }
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('dry run (the default) only counts: allocates and writes nothing, sample refs are null', async () => {
    seedMissing();
    const res = await post(URL, {}, SPARK);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ dry_run: true, total_missing: 4, processed: 0, remaining: 4 });
    expect(res.body.data.sample.map((s: Row) => s.name)).toEqual(['Feb26 Rao', 'Mar26 Rao', 'Apr26 Rao', 'May26 Rao']); // oldest first
    expect(res.body.data.sample.every((s: Row) => s.ref_no === null)).toBe(true);
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
    expect(leads().filter((l) => l.ref_no).length).toBe(1);
  });

  it('real run numbers oldest first, each in the series of its OWN created_at, skipping numbered / deleted / other-client leads', async () => {
    seedMissing();
    const res = await post(URL, { dry_run: false }, SPARK);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ dry_run: false, total_missing: 4, processed: 4, remaining: 0 });
    expect(ref('a0')).toBe('SR/LD/2526-1');
    expect(ref('a1')).toBe('SR/LD/2526-2');
    expect(ref('a2')).toBe('SR/LD/2627-1');
    expect(ref('a3')).toBe('SR/LD/2627-2');
    expect(ref('n1')).toBe('SR/LD/2526-7');  // untouched
    expect(ref('d1')).toBeNull();            // soft-deleted
    expect(ref('o1')).toBeNull();            // other client
    expect(res.body.data.sample).toEqual([
      { id: 'a0', name: 'Feb26 Rao', ref_no: 'SR/LD/2526-1' },
      { id: 'a1', name: 'Mar26 Rao', ref_no: 'SR/LD/2526-2' },
      { id: 'a2', name: 'Apr26 Rao', ref_no: 'SR/LD/2627-1' },
      { id: 'a3', name: 'May26 Rao', ref_no: 'SR/LD/2627-2' },
    ]);
    expect(db.rpcCalls.map((c) => c.args.p_series)).toEqual(['SR/LD/2526', 'SR/LD/2526', 'SR/LD/2627', 'SR/LD/2627']);
  });

  it('is idempotent: a second run has nothing left and allocates nothing', async () => {
    seedMissing();
    await post(URL, { dry_run: false }, SPARK);
    const calls = db.rpcCalls.length;
    const again = await post(URL, { dry_run: false }, SPARK);
    expect(again.body.data).toMatchObject({ total_missing: 0, processed: 0, remaining: 0, sample: [] });
    expect(db.rpcCalls).toHaveLength(calls);
  });

  it('honours limit and is resumable: remaining counts what is left, the next call continues the numbering', async () => {
    seedMissing();
    const first = await post(URL, { dry_run: false, limit: 3 }, SPARK);
    expect(first.body.data).toMatchObject({ total_missing: 4, processed: 3, remaining: 1 });
    expect(ref('a3')).toBeNull();
    const rest = await post(URL, { dry_run: false, limit: 3 }, SPARK);
    expect(rest.body.data).toMatchObject({ total_missing: 1, processed: 1, remaining: 0 });
    expect(ref('a3')).toBe('SR/LD/2627-2'); // continues after a2's 2627-1
  });

  it('pages through more than one batch (limit above the 200-row page)', async () => {
    for (let i = 0; i < 450; i++) lead({ created_at: `2026-06-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z` });
    const res = await post(URL, { dry_run: false, limit: 450 }, SPARK);
    expect(res.body.data).toMatchObject({ total_missing: 450, processed: 450, remaining: 0 });
    expect(new Set(leads().map((l) => l.ref_no)).size).toBe(450);
    expect(counter('SR/LD/2627')).toBe(450);
  });

  it('a dry run reports the remaining count beyond limit; sample is at most 10', async () => {
    for (let i = 0; i < 25; i++) lead({ created_at: `2026-06-01T00:00:${String(i).padStart(2, '0')}Z` });
    const res = await post(URL, { limit: 20 }, SPARK);
    expect(res.body.data).toMatchObject({ dry_run: true, total_missing: 25, processed: 0, remaining: 25 });
    expect(res.body.data.sample).toHaveLength(10);
    const real = await post(URL, { dry_run: false, limit: 20 }, SPARK);
    expect(real.body.data).toMatchObject({ processed: 20, remaining: 5 });
    expect(real.body.data.sample).toHaveLength(10);
  });

  it('validates the body (limit 1..2000, dry_run boolean)', async () => {
    for (const body of [{ limit: 0 }, { limit: 2001 }, { limit: 'x' }, { dry_run: 'yes' }]) {
      expect((await post(URL, body, SPARK)).status).toBe(400);
    }
    expect((await post(URL, { limit: 2000 }, SPARK)).status).toBe(200);
  });

  it('503 NOT_MIGRATED when the columns are missing (dry run and real run)', async () => {
    seedMissing();
    db.missingCols.crm_leads = new Set(['ref_no']);
    for (const dry_run of [true, false]) {
      const res = await post(URL, { dry_run }, SPARK);
      expect(res.status).toBe(503);
      expect(res.body.error).toEqual({ code: 'NOT_MIGRATED', message: NOT_MIGRATED });
    }
  });

  it('503 NOT_MIGRATED when the counter function is missing (a real run only needs it)', async () => {
    seedMissing();
    db.rpcMode = 'missing';
    const res = await post(URL, { dry_run: false }, SPARK);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_MIGRATED');
    expect(leads().filter((l) => l.ref_no).length).toBe(1);
    expect((await post(URL, { dry_run: true }, SPARK)).status).toBe(200); // a count needs no counter
  });

  it('stops (200) when the counter starts failing mid-run, keeping what was numbered', async () => {
    seedMissing();
    // fail from the third allocation on
    const real = db.rpcMode;
    let calls = 0;
    const { supabaseAdmin } = require('../src/lib/supabase');
    const orig = supabaseAdmin.rpc;
    supabaseAdmin.rpc = async (fn: string, args: Row) => (++calls > 2 ? { data: null, error: { code: 'XX000', message: 'boom' } } : orig(fn, args));
    try {
      const res = await post(URL, { dry_run: false }, SPARK);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ total_missing: 4, processed: 2, remaining: 2 });
    } finally { supabaseAdmin.rpc = orig; db.rpcMode = real; }
  });

  it('does not overwrite a number a concurrent create stamped in between', async () => {
    seedMissing();
    const { supabaseAdmin } = require('../src/lib/supabase');
    const orig = supabaseAdmin.rpc;
    let first = true;
    supabaseAdmin.rpc = async (fn: string, args: Row) => {
      if (first) { first = false; ref('a0'); leads().find((l) => l.id === 'a0')!.ref_no = 'SR/LD/2526-50'; }
      return orig(fn, args);
    };
    try {
      const res = await post(URL, { dry_run: false }, SPARK);
      expect(res.status).toBe(200);
      expect(ref('a0')).toBe('SR/LD/2526-50');
      expect(res.body.data.processed).toBe(3);
    } finally { supabaseAdmin.rpc = orig; }
  });
});
