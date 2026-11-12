/**
 * An in-memory PostgREST + Postgres double for the HRMS tests (phase 1 and payroll).
 *
 * It applies the filters services use (eq, neq, is, in, gt, gte, lt, lte, not-null), ordering, paging, head counts, upsert, the unique
 * indexes the code relies on (employee code, one attendance row per person and month, one regular run per entity and month, one payslip per
 * person per run, one open settlement per person, primary keys), the cascades, and what jsonb does to an object (it sorts its keys by
 * length). Every query is recorded so a test can assert both WHAT came back and WHAT was asked (org scope, no plaintext secrets).
 *
 * It also stands in for the plpgsql functions: hrms_next_code, hrms_store_computed_run, hrms_freeze_run, hrms_unfreeze_run and
 * hrms_mark_run_paid. They are written here in TypeScript to do exactly what migration_hrms_payroll.sql does (the SQL itself is proven in
 * PGlite: see the scratch harness named in the final report), so the service layer's use of them can be tested without a database.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from 'crypto';

export type Row = Record<string, any>;
export interface Filter { t: 'eq' | 'neq' | 'is' | 'in' | 'not' | 'gt' | 'gte' | 'lt' | 'lte'; col: string; val: any }
export interface Query {
  table: string; op: 'select' | 'insert' | 'update' | 'delete' | 'upsert'; filters: Filter[]; orders: Array<{ col: string; asc: boolean }>;
  rows?: Row[]; patch?: Row; returning: boolean; cols: string; count?: string; head?: boolean; range?: [number, number]; limit?: number;
  single?: boolean; maybe?: boolean; onConflict?: string;
}
interface Unique { table: string; cols: string[]; name: string; where?: (r: Row) => boolean }

const UNIQUES: Unique[] = [
  { table: 'hrms_employees', cols: ['org_id', 'code'], name: 'hrms_employees_org_code_uq', where: (r) => !r.deleted_at },
  { table: 'hrms_attendance', cols: ['org_id', 'employee_id', 'month'], name: 'hrms_attendance_org_emp_month_uq' },
  { table: 'hrms_pay_runs', cols: ['org_id', 'entity_id', 'month'], name: 'hrms_pay_runs_regular_uq', where: (r) => r.type === 'regular' },
  { table: 'hrms_payslips', cols: ['run_id', 'employee_id'], name: 'hrms_payslips_run_employee_uq' },
  { table: 'hrms_fnf_cases', cols: ['org_id', 'employee_id'], name: 'hrms_fnf_cases_open_uq', where: (r) => r.status !== 'paid' },
  { table: 'hrms_shifts', cols: ['org_id', 'name'], name: 'hrms_shifts_org_name_uq' },
  { table: 'hrms_roster', cols: ['org_id', 'employee_id', 'week_start'], name: 'hrms_roster_org_emp_week_uq' },
  { table: 'hrms_leave_types', cols: ['org_id', 'code'], name: 'hrms_leave_types_org_code_uq' },
  { table: 'hrms_leave_balances', cols: ['org_id', 'employee_id', 'leave_type_id'], name: 'hrms_leave_balances_org_emp_lt_uq' },
];

/** The database defaults of the columns the services leave out of an insert. */
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
  hrms_access_log: () => ({ employee_id: null, run_id: null }),
  hrms_structures: () => ({ description: null, components: [] }),
  hrms_attendance: () => ({ present_days: 0, paid_leave_days: 0, weekly_offs: 0, holidays: 0, lop_days: 0, overtime_hours: 0, locked: false }),
  hrms_adjustments: () => ({ taxable: false, note: null, source: null, created_by: null }),
  hrms_loans: () => ({ recovered: 0, note: null }),
  hrms_pay_runs: () => ({
    type: 'regular', status: 'draft', law_version: null, computed_at: null, frozen_at: null, frozen_by_user_id: null, frozen_by: null, paid_at: null,
    loan_recoveries: {}, attendance_locked_for: [], input_fingerprint: null, created_by: null,
  }),
  hrms_fnf_cases: () => ({ resignation_date: null, notice_days_served: 0, leave_encash_days: 0, other_recoveries: 0, other_payments: 0, status: 'draft' }),
  hrms_shifts: () => ({ break_minutes: 0, grace_minutes: 0, full_day_hours: 8, half_day_hours: 4, is_night: false, color: '#3E9EFF' }),
  hrms_roster: () => ({ days: [] }),
  hrms_leave_types: () => ({
    paid: true, audience: 'all', accrual: {}, carry_forward: {}, encashment: {}, max_consecutive_days: null, document_after_days: null,
    probation_eligible: true, include_weekly_offs: false, description: null,
  }),
  hrms_holiday_lists: () => ({ holidays: [] }),
  hrms_leave_balances: () => ({ opening: 0, accrued: 0, taken: 0, encashed: 0, lapsed: 0 }),
  hrms_assets: () => ({ warranty_end: null, status: 'in_stock', holder_id: null }),
  hrms_asset_events: () => ({ from_id: null, to_id: null, condition: null, ack: null, note: null }),
};

/** jsonb stores an object's keys sorted by length, then bytewise; arrays keep their order. */
export function jsonb(v: any): any {
  if (Array.isArray(v)) return v.map(jsonb);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, jsonb(v[k])]));
  }
  return v;
}
const normalise = (row: Row): Row => { for (const k of Object.keys(row)) if (row[k] && typeof row[k] === 'object') row[k] = jsonb(row[k]); return row; };

export function createHrmsFakeDb() {
  const tables: Record<string, Row[]> = {};
  const log: Query[] = [];
  const rpcLog: Array<{ name: string; args: any }> = [];
  const counters = new Map<string, number>();
  const missing = new Set<string>();
  const fails: Array<{ table: string; op: string; error: any; times: number; fire?: () => void }> = [];
  const rpcFails: Array<{ name: string; error: any; times: number }> = [];
  let auditSeq = 0;
  // A strictly-increasing clock for asset rows and events, so bootstrap's (created_at, id) order is insertion order even
  // when many operations land in the same millisecond (the real DB uses clock_timestamp(), which is microsecond-distinct).
  let assetClock = Date.now();
  const assetTick = () => new Date(assetClock++).toISOString();
  /** Runs before an rpc body, to simulate another request getting in between a service's read and its call. */
  const hooks: { beforeRpc?: (name: string, args: any) => void } = {};

  const matches = (r: Row, filters: Filter[]) => filters.every((f) => {
    const v = r[f.col] === undefined ? null : r[f.col];
    switch (f.t) {
      case 'eq': return v === f.val;
      case 'neq': return v !== f.val;
      case 'is': return v === f.val;
      case 'in': return (f.val as any[]).includes(v);
      case 'gt': return v !== null && v > f.val;
      case 'gte': return v !== null && v >= f.val;
      case 'lt': return v !== null && v < f.val;
      case 'lte': return v !== null && v <= f.val;
      default: return v !== null; // not(col, 'is', null)
    }
  });
  const project = (r: Row, cols: string) => (cols === '*' ? { ...r } : Object.fromEntries(cols.split(',').map((c) => [c.trim(), r[c.trim()] ?? null])));

  const violates = (table: string, row: Row, existing: Row[]): any => {
    if (existing.some((r) => r.id === row.id)) return { code: '23505', message: `duplicate key value violates unique constraint "${table}_pkey"` };
    for (const u of UNIQUES.filter((x) => x.table === table)) {
      if (u.where && !u.where(row)) continue;
      if (existing.some((r) => (!u.where || u.where(r)) && u.cols.every((c) => r[c] === row[c]))) {
        return { code: '23505', message: `duplicate key value violates unique constraint "${u.name}"` };
      }
    }
    return null;
  };

  const cascade = (table: string, gone: Row[]) => {
    if (!gone.length) return;
    const ids = new Set(gone.map((g) => g.id));
    if (table === 'hrms_employees') {
      for (const t of ['hrms_employee_documents', 'hrms_employee_history', 'hrms_attendance', 'hrms_adjustments', 'hrms_roster', 'hrms_leave_balances']) tables[t] = (tables[t] ?? []).filter((r) => !ids.has(r.employee_id));
      for (const r of tables.hrms_employees ?? []) if (ids.has(r.reporting_to_id)) r.reporting_to_id = null;
      for (const r of tables.hrms_departments ?? []) if (ids.has(r.head_id)) r.head_id = null;
      for (const r of tables.hrms_assets ?? []) if (ids.has(r.holder_id)) r.holder_id = null;                 // holder_id ON DELETE SET NULL
      for (const r of tables.hrms_asset_events ?? []) { if (ids.has(r.from_id)) r.from_id = null; if (ids.has(r.to_id)) r.to_id = null; } // from_id/to_id ON DELETE SET NULL
    }
    if (table === 'hrms_pay_runs') for (const t of ['hrms_payslips', 'hrms_pay_run_audit']) tables[t] = (tables[t] ?? []).filter((r) => !ids.has(r.run_id));
    if (table === 'hrms_assets') tables.hrms_asset_events = (tables.hrms_asset_events ?? []).filter((r) => !ids.has(r.asset_id)); // asset_id ON DELETE CASCADE
  };

  const exec = (q: Query): { data: any; error: any; count?: number | null } => {
    if (missing.has(q.table)) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${q.table}' in the schema cache` } };
    const fi = fails.findIndex((f) => f.table === q.table && f.op === q.op && f.times > 0);
    if (fi >= 0) { fails[fi]!.times -= 1; fails[fi]!.fire?.(); return { data: null, error: fails[fi]!.error }; }
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
        const row: Row = normalise({ id: crypto.randomUUID(), ...(DEFAULTS[q.table]?.() ?? {}), created_at: now, updated_at: now, ...input });
        if (q.table === 'hrms_pay_run_audit') row.seq = ++auditSeq;
        if (q.op === 'upsert') {
          const cols = (q.onConflict ?? 'id').split(',');
          const hit = rows.find((r) => cols.every((c) => r[c] === row[c]));
          if (hit) { Object.assign(hit, normalise({ ...input })); result.push(project(hit, q.cols)); continue; }
        }
        const bad = violates(q.table, row, rows.concat(fresh));
        if (bad) return { data: null, error: bad };
        fresh.push(row);
      }
      rows.push(...fresh);
      result = result.concat(fresh.map((r) => project(r, q.cols)));
    } else if (q.op === 'update') {
      const hit = rows.filter((r) => matches(r, q.filters));
      for (const r of hit) Object.assign(r, normalise({ ...q.patch }));
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
    const f = (t: Filter['t']) => (col: string, val?: any) => { q.filters.push({ t, col, val }); return b; };
    const b: any = {
      select(cols = '*', opts: any = {}) { q.cols = cols; q.returning = true; q.count = opts.count; q.head = opts.head; return b; },
      insert(rows: Row | Row[]) { q.op = 'insert'; q.rows = Array.isArray(rows) ? rows : [rows]; return b; },
      upsert(row: Row, opts: any = {}) { q.op = 'upsert'; q.rows = [row]; q.onConflict = opts.onConflict; q.returning = true; return b; },
      update(patch: Row) { q.op = 'update'; q.patch = patch; return b; },
      delete() { q.op = 'delete'; return b; },
      eq: f('eq'), neq: f('neq'), is: f('is'), in: f('in'), gt: f('gt'), gte: f('gte'), lt: f('lt'), lte: f('lte'),
      not(col: string) { q.filters.push({ t: 'not', col, val: null }); return b; },
      order(col: string, o: any = {}) { q.orders.push({ col, asc: o.ascending !== false }); return b; },
      range(a: number, z: number) { q.range = [a, z]; return b; },
      limit(n: number) { q.limit = n; return b; },
      single() { q.single = true; q.returning = true; return b; },
      maybeSingle() { q.maybe = true; q.returning = true; return b; },
      then(res: any, rej: any) { return Promise.resolve(exec(q)).then(res, rej); },
    };
    return b;
  };

  // ── the plpgsql functions ─────────────────────────────────────────────────
  const T = (name: string) => (tables[name] ??= []);
  const token = (message: string) => ({ error: { code: 'P0001', message }, data: null });
  const audit = (org: string, run: string, by: string | null, name: string, action: string) =>
    T('hrms_pay_run_audit').push(normalise({ id: crypto.randomUUID(), org_id: org, client_id: null, run_id: run, at: new Date().toISOString(), by_user_id: by, by_name: name || 'Unknown', action, seq: ++auditSeq, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
  const runOf = (org: string, id: string) => T('hrms_pay_runs').find((r) => r.id === id && r.org_id === org && r.client_id === null);

  const functions: Record<string, (a: any) => { data: any; error: any }> = {
    hrms_next_code: (a) => {
      const key = `${a.p_org}:${a.p_name}`;
      const n = a.p_count ?? 1;
      const cur = counters.get(key) ?? 1;
      counters.set(key, cur + n);
      return { data: cur + n - 1, error: null };
    },
    hrms_store_computed_run: (a) => {
      const run = runOf(a.p_org, a.p_run);
      if (!run) return token('RUN_NOT_FOUND');
      if (!['draft', 'computed'].includes(run.status)) return token('RUN_FROZEN');
      const slips: Row[] = a.p_payslips;
      const people = new Set(T('hrms_employees').filter((e) => e.org_id === a.p_org).map((e) => e.id));
      if (slips.some((s) => !people.has(s.employee_id))) return token('PAYSLIP_EMPLOYEE');
      const now = new Date().toISOString();
      tables.hrms_payslips = T('hrms_payslips').filter((s) => s.run_id !== run.id);
      for (const s of slips) {
        tables.hrms_payslips.push(normalise({ id: crypto.randomUUID(), org_id: a.p_org, client_id: null, run_id: run.id, month: run.month, ...JSON.parse(JSON.stringify(s)), created_at: now, updated_at: now }));
      }
      Object.assign(run, { status: 'computed', computed_at: now, law_version: a.p_law_version, input_fingerprint: a.p_fingerprint, updated_at: now });
      audit(a.p_org, run.id, a.p_by_user, a.p_by_name, `Computed ${slips.length} payslips`);
      return { data: slips.length, error: null };
    },
    hrms_freeze_run: (a) => {
      const run = runOf(a.p_org, a.p_run);
      if (!run) return token('RUN_NOT_FOUND');
      if (run.status !== 'computed') return token('RUN_NOT_COMPUTED');
      if (!a.p_fingerprint || !run.input_fingerprint || a.p_fingerprint !== run.input_fingerprint) return token('RUN_STALE');
      const now = new Date().toISOString();
      const slips = T('hrms_payslips').filter((s) => s.run_id === run.id).sort((x, y) => x.position - y.position);
      const recov: Record<string, number> = {};
      for (const s of slips) {
        for (const l of T('hrms_loans').filter((x) => x.org_id === a.p_org && x.client_id === null && x.employee_id === s.employee_id && x.start_month <= run.month && x.recovered < x.principal)) {
          const emi = Math.min(l.emi, l.principal - l.recovered);
          if (emi <= 0) continue;
          l.recovered = Math.round((l.recovered + emi) * 100) / 100; l.updated_at = now;
          recov[l.id] = (recov[l.id] ?? 0) + emi;
        }
      }
      const ids = new Set(slips.map((s) => s.employee_id));
      const locked: string[] = [];
      for (const at of T('hrms_attendance')) {
        if (at.org_id === a.p_org && at.client_id === null && at.month === run.month && !at.locked && ids.has(at.employee_id)) { at.locked = true; at.updated_at = now; locked.push(at.employee_id); }
      }
      Object.assign(run, { status: 'frozen', frozen_at: now, frozen_by_user_id: a.p_by_user, frozen_by: a.p_by_name || 'Unknown', loan_recoveries: jsonb(recov), attendance_locked_for: locked.sort(), updated_at: now });
      audit(a.p_org, run.id, a.p_by_user, a.p_by_name, 'Frozen. Payslips are locked.');
      return { data: { loan_recoveries: recov, attendance_locked_for: locked }, error: null };
    },
    hrms_unfreeze_run: (a) => {
      const why = String(a.p_reason ?? '').trim();
      if (why.length < 5) return token('UNFREEZE_REASON');
      const run = runOf(a.p_org, a.p_run);
      if (!run) return token('RUN_NOT_FOUND');
      if (run.status !== 'frozen') return token('RUN_NOT_FROZEN');
      const now = new Date().toISOString();
      for (const [loanId, amt] of Object.entries(run.loan_recoveries as Record<string, number>)) {
        const l = T('hrms_loans').find((x) => x.id === loanId && x.org_id === a.p_org);
        if (l) { l.recovered = Math.max(0, Math.round((l.recovered - amt) * 100) / 100); l.updated_at = now; }
      }
      for (const at of T('hrms_attendance')) if (at.org_id === a.p_org && at.month === run.month && (run.attendance_locked_for as string[]).includes(at.employee_id)) { at.locked = false; at.updated_at = now; }
      Object.assign(run, { status: 'computed', frozen_at: null, frozen_by_user_id: null, frozen_by: null, loan_recoveries: {}, attendance_locked_for: [], updated_at: now });
      audit(a.p_org, run.id, a.p_by_user, a.p_by_name, `Unfrozen: ${why}`);
      return { data: { status: 'computed' }, error: null };
    },
    hrms_mark_run_paid: (a) => {
      const run = runOf(a.p_org, a.p_run);
      if (!run) return token('RUN_NOT_FOUND');
      if (run.status !== 'frozen') return token('RUN_NOT_FROZEN');
      const now = new Date().toISOString();
      Object.assign(run, { status: 'paid', paid_at: now, updated_at: now });
      audit(a.p_org, run.id, a.p_by_user, a.p_by_name, 'Marked paid');
      return { data: { status: 'paid' }, error: null };
    },
    // ── asset register (migration_hrms_assets.sql) ───────────────────────────
    // The asset + its 'purchased' event, atomically. Enforces the two unique indexes (tag per org; serial per org,
    // case-insensitive) and the primary key, exactly as the SQL does; returns the new 'purchased' event's id.
    hrms_asset_create: (a) => {
      const assets = T('hrms_assets');
      const uniq = (name: string) => ({ data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${name}"` } });
      if (assets.some((x) => x.id === a.p_asset)) return uniq('hrms_assets_pkey');
      if (assets.some((x) => x.org_id === a.p_org && x.client_id === null && x.tag === a.p_tag)) return uniq('hrms_assets_org_tag_uq');
      const ser = String(a.p_serial).toLowerCase();
      if (assets.some((x) => x.org_id === a.p_org && x.client_id === null && String(x.serial).toLowerCase() === ser)) return uniq('hrms_assets_org_serial_uq');
      const ts = assetTick();
      assets.push(normalise({
        id: a.p_asset, org_id: a.p_org, client_id: null, tag: a.p_tag, type: a.p_type, make: a.p_make, model: a.p_model, serial: a.p_serial,
        purchase_date: a.p_purchase_date, cost: a.p_cost, warranty_end: a.p_warranty_end ?? null, condition: a.p_condition, status: 'in_stock', holder_id: null, created_at: ts, updated_at: ts,
      }));
      const evId = crypto.randomUUID();
      T('hrms_asset_events').push(normalise({
        id: evId, org_id: a.p_org, client_id: null, asset_id: a.p_asset, on_date: a.p_on, kind: 'purchased', from_id: null, to_id: null,
        condition: a.p_condition, status: 'in_stock', ack: null, note: 'Added to the register.', by_name: a.p_by || 'Unknown', created_at: ts, updated_at: ts,
      }));
      return { data: evId, error: null };
    },
    // One state transition, atomically: check against the CURRENT status, append the event, move status/holder/condition.
    // The transition rules mirror store.ts; a wrong status is ASSET_STATE, a transfer to the current holder is ASSET_SAME_HOLDER.
    hrms_asset_apply_event: (a) => {
      const asset = T('hrms_assets').find((x) => x.id === a.p_asset && x.org_id === a.p_org && x.client_id === null);
      if (!asset) return token('ASSET_NOT_FOUND');
      const from = asset.holder_id ?? null;
      let newStatus = asset.status; let newHolder: string | null = asset.holder_id ?? null; let newCond = asset.condition;
      let evFrom: string | null = null; let evTo: string | null = null; let evCond: string | null = null; let evAck: boolean | null = null;
      const bad = () => token('ASSET_STATE');
      switch (a.p_kind) {
        case 'issued':
          if (asset.status !== 'in_stock') return bad();
          newStatus = 'issued'; newHolder = a.p_to_id; newCond = a.p_condition ?? asset.condition; evTo = a.p_to_id; evCond = a.p_condition ?? null; evAck = true; break;
        case 'returned':
          if (asset.status !== 'issued') return bad();
          if (!['in_stock', 'in_repair', 'retired'].includes(a.p_next_status)) return bad();
          newStatus = a.p_next_status; newHolder = null; newCond = a.p_condition ?? asset.condition; evFrom = from; evCond = a.p_condition ?? null; break;
        case 'transferred':
          if (asset.status !== 'issued') return bad();
          if (from === (a.p_to_id ?? null)) return token('ASSET_SAME_HOLDER');
          newStatus = 'issued'; newHolder = a.p_to_id; newCond = a.p_condition ?? asset.condition; evFrom = from; evTo = a.p_to_id; evCond = a.p_condition ?? null; evAck = true; break;
        case 'repair_out':
          if (!['in_stock', 'issued'].includes(asset.status)) return bad();
          newStatus = 'in_repair'; newHolder = null; evFrom = from; break;
        case 'repair_back':
          if (asset.status !== 'in_repair') return bad();
          newStatus = 'in_stock'; newHolder = null; newCond = a.p_condition ?? asset.condition; evCond = a.p_condition ?? null; break;
        case 'lost':
          if (!['in_stock', 'issued'].includes(asset.status)) return bad();
          newStatus = 'lost'; newHolder = null; evFrom = from; break;
        case 'retired':
          if (!['in_stock', 'in_repair'].includes(asset.status)) return bad();
          newStatus = 'retired'; newHolder = null; break;
        default: return token('ASSET_BAD_KIND');
      }
      const ts = assetTick();
      const evId = crypto.randomUUID();
      T('hrms_asset_events').push(normalise({
        id: evId, org_id: a.p_org, client_id: null, asset_id: a.p_asset, on_date: a.p_on, kind: a.p_kind, from_id: evFrom, to_id: evTo,
        condition: evCond, status: newStatus, ack: evAck, note: a.p_note ?? null, by_name: a.p_by || 'Unknown', created_at: ts, updated_at: ts,
      }));
      Object.assign(asset, { status: newStatus, holder_id: newHolder, condition: newCond, updated_at: ts });
      return { data: evId, error: null };
    },
  };

  const rpc = (name: string, args: any) => {
    rpcLog.push({ name, args });
    if (missing.has(`rpc:${name}`)) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } });
    const fi = rpcFails.findIndex((f) => f.name === name && f.times > 0);
    if (fi >= 0) { rpcFails[fi]!.times -= 1; return Promise.resolve({ data: null, error: rpcFails[fi]!.error }); }
    hooks.beforeRpc?.(name, args);
    const fn = functions[name];
    if (!fn) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } });
    return Promise.resolve(fn(JSON.parse(JSON.stringify(args))));
  };

  return {
    client: { from, rpc, auth: { getUser: async () => ({ data: { user: null }, error: { message: 'mock' } }) } },
    tables, log, rpcLog, counters, missing, fails, rpcFails, hooks,
    reset() {
      for (const k of Object.keys(tables)) delete tables[k];
      log.length = 0; rpcLog.length = 0; counters.clear(); missing.clear(); fails.length = 0; rpcFails.length = 0; auditSeq = 0; assetClock = Date.now(); hooks.beforeRpc = undefined;
    },
  };
}

export type HrmsFakeDb = ReturnType<typeof createHrmsFakeDb>;
