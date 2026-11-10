import { AppError } from '../../../utils';
import { db, fail, fetchAll, HrmsScope, isUniqueViolation, must, scopeCols, scoped } from '../scope';
import type { Row } from './common';
import { buildEcr, computePayRunPayslips, LAW_VERSION, preRunChecks } from './engine';
import type { PayRun, PreRunCheck } from './engine';
import { inputFingerprint } from './fingerprint';
import { loadPayrollDb } from './inputs.service';
import { EMPLOYEE_COLUMNS, payslipOut, payslipRow, runOut, toEngineEmployee, emptyDb } from './mapping';
import type { RunView } from './mapping';
import { invalid, newId, notFound, now, refuse } from './common';

// Pay runs and payslips. The rules are actions.ts createPayRun / computeRun / markRunPaid and payrollActions.ts freezeRunSafe /
// unfreezeRunSafe / runIsStale, with their words. The server is the authority: it is the one that refuses, and the UI shows its reason.
//
//   draft --compute--> computed --freeze--> frozen --mark paid--> paid
//                         ^----- unfreeze (with a reason) ----'
//
// Compute, freeze, unfreeze and mark-paid are plpgsql functions (migration_hrms_payroll.sql) so each is one transaction: a compute never
// leaves a half-replaced set of payslips, a freeze never recovers a loan without locking the attendance, and so on.

const T = 'hrms_pay_runs';
const AUDIT = 'hrms_pay_run_audit';
const SLIPS = 'hrms_payslips';
const CHUNK = 100;

// ── the plain reasons ───────────────────────────────────────────────────────
export const REASON = {
  notFound: 'Run not found',
  notComputed: 'Only a computed run can be frozen.',
  stale: 'Inputs changed after the last compute. Compute again before freezing, so the payslips match the inputs.',
  unfreezeReason: 'Give a reason of at least a few words. It goes into the audit trail.',
  notFrozenUnfreeze: 'Only a frozen run can be unfrozen. A paid run is closed.',
  notFrozenPay: 'Only a frozen run can be marked paid. Freeze it first.',
  frozen: 'This run is frozen. Unfreeze it before computing again.',
  paid: 'This run is paid and closed, so it cannot be computed again.',
} as const;

const runClosed = (run: Row) => refuse(409, run.status === 'paid' ? REASON.paid : REASON.frozen, 'RUN_FROZEN');

/** Map a failure of one of the plpgsql functions (SQLSTATE P0001, token as the message) to a plain refusal; anything else keeps the HRMS mapping. */
function rpcError(error: { code?: string; message?: string }, run: Row | null, op: 'compute' | 'freeze' | 'unfreeze' | 'pay'): AppError {
  switch ((error.message ?? '').trim()) {
    case 'RUN_NOT_FOUND': return notFound(REASON.notFound);
    case 'RUN_FROZEN': return run ? runClosed(run) : refuse(409, REASON.frozen, 'RUN_FROZEN');
    case 'RUN_NOT_COMPUTED': return refuse(409, REASON.notComputed, 'RUN_NOT_COMPUTED');
    case 'RUN_STALE': return refuse(409, REASON.stale, 'RUN_STALE');
    case 'RUN_NOT_FROZEN': return refuse(409, op === 'pay' ? REASON.notFrozenPay : REASON.notFrozenUnfreeze, 'RUN_NOT_FROZEN');
    case 'UNFREEZE_REASON': return invalidWith(REASON.unfreezeReason, 'UNFREEZE_REASON');
    default: return fail(error);
  }
}
const invalidWith = (message: string, code: string) => new AppError(400, message, code);

// ── reading ─────────────────────────────────────────────────────────────────
async function findRun(s: HrmsScope, id: string): Promise<Row | null> {
  return must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;
}
export async function requireRun(s: HrmsScope, id: string): Promise<Row> {
  const run = await findRun(s, id);
  if (!run) throw notFound(REASON.notFound);
  return run;
}

const chunks = <T>(a: T[], n = CHUNK): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function auditOf(s: HrmsScope, runIds: string[]): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>();
  for (const part of chunks(runIds)) {
    const rows = await fetchAll<Row>((from, to) => scoped(db().from(AUDIT).select('*'), s).in('run_id', part).order('run_id', { ascending: true }).order('seq', { ascending: true }).range(from, to));
    for (const r of rows) (out.get(String(r.run_id)) ?? out.set(String(r.run_id), []).get(String(r.run_id))!).push(r);
  }
  return out;
}

/** Payslips grouped by run, in the engine's order. `byMonthFrom` reads every payslip of that month on (bootstrap); otherwise the given runs. */
async function payslipsOf(s: HrmsScope, runIds: string[], byMonthFrom?: string): Promise<Map<string, ReturnType<typeof payslipOut>[]>> {
  const out = new Map<string, ReturnType<typeof payslipOut>[]>();
  const add = (rows: Row[]) => { for (const r of rows) (out.get(String(r.run_id)) ?? out.set(String(r.run_id), []).get(String(r.run_id))!).push(payslipOut(r)); };
  // up to 500 pages of 1000: a year of payslips for a very large org must never be cut off silently
  const page = (refine: (q: any) => any) => fetchAll<Row>((from, to) => // eslint-disable-line @typescript-eslint/no-explicit-any
    refine(scoped(db().from(SLIPS).select('*'), s)).order('run_id', { ascending: true }).order('position', { ascending: true }).order('id', { ascending: true }).range(from, to), 1000, 500);
  if (byMonthFrom) add(await page((q) => q.gte('month', byMonthFrom)));
  else for (const part of chunks(runIds)) add(await page((q) => q.in('run_id', part)));
  return out;
}

/** Which of these runs are stale: computed, and the inputs a compute would read now hash differently from the ones it read. */
export async function staleRuns(s: HrmsScope, runs: Row[]): Promise<Set<string>> {
  const computed = runs.filter((r) => r.status === 'computed');
  const stale = new Set<string>();
  if (!computed.length) return stale;
  const model = await loadPayrollDb(s, { months: computed.map((r) => String(r.month)) });
  for (const r of computed) {
    if (!r.input_fingerprint || inputFingerprint(model, String(r.month), String(r.entity_id)) !== r.input_fingerprint) stale.add(String(r.id));
  }
  return stale;
}

export async function getRun(s: HrmsScope, id: string): Promise<RunView> {
  const run = await requireRun(s, id);
  const [audit, slips, stale] = await Promise.all([auditOf(s, [id]), payslipsOf(s, [id]), staleRuns(s, [run])]);
  return runOut(run, audit.get(id) ?? [], slips.get(id) ?? [], stale.has(id));
}

export interface RunFilter { entity_id?: string; month?: string; status?: string; type?: string }

/** Runs without their payslips (`payslips: []`, plus `payslip_count`), newest month first. */
export async function listRuns(s: HrmsScope, f: RunFilter = {}, limit = 200): Promise<RunView[]> {
  let q = scoped(db().from(T).select('*'), s);
  for (const k of ['entity_id', 'month', 'status', 'type'] as const) if (f[k]) q = q.eq(k, f[k]!);
  const runs = (must(await q.order('month', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: true }).limit(Math.min(500, Math.max(1, limit)))) as Row[] | null) ?? [];
  const ids = runs.map((r) => String(r.id));
  const [audit, stale, counts] = await Promise.all([
    auditOf(s, ids), staleRuns(s, runs),
    Promise.all(runs.map(async (r) => {
      const { count, error } = await scoped(db().from(SLIPS).select('id', { count: 'exact', head: true }), s).eq('run_id', String(r.id));
      if (error) throw fail(error);
      return [String(r.id), count ?? 0] as const;
    })),
  ]);
  const countOf = new Map(counts);
  return runs.map((r) => ({ ...runOut(r, audit.get(String(r.id)) ?? [], [], stale.has(String(r.id))), payslip_count: countOf.get(String(r.id)) ?? 0 }));
}

/** Every run from `fromMonth` on WITH its payslips (bootstrap). */
export async function runsWithPayslips(s: HrmsScope, fromMonth: string): Promise<RunView[]> {
  const runs = await fetchAll<Row>((from, to) => scoped(db().from(T).select('*'), s).gte('month', fromMonth).order('month', { ascending: true }).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to));
  const ids = runs.map((r) => String(r.id));
  const [audit, slips, stale] = await Promise.all([auditOf(s, ids), payslipsOf(s, ids, fromMonth), staleRuns(s, runs)]);
  return runs.map((r) => runOut(r, audit.get(String(r.id)) ?? [], slips.get(String(r.id)) ?? [], stale.has(String(r.id))));
}

// ── create ──────────────────────────────────────────────────────────────────
export interface CreatedRun { run: RunView; created: boolean }

/** actions.ts createPayRun: one run per entity, month and type; asking again returns the existing one. */
export async function createRun(s: HrmsScope, input: { id?: string; entity_id: string; month: string; type?: PayRun['type'] }): Promise<CreatedRun> {
  const type = input.type ?? 'regular';
  const again = async (row: Row): Promise<CreatedRun> => ({ run: await getRun(s, String(row.id)), created: false });
  if (input.id) {
    const existing = await findRun(s, input.id);
    if (existing) return again(existing);
  }
  const entity = must(await scoped(db().from('hrms_entities').select('id'), s).eq('id', input.entity_id).maybeSingle()) as Row | null;
  if (!entity) throw invalid('entity_id: Unknown legal entity');
  const same = (must(await scoped(db().from(T).select('*'), s).eq('entity_id', input.entity_id).eq('month', input.month).eq('type', type)
    .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(1)) as Row[] | null)?.[0];
  if (same) return again(same);

  const id = input.id ?? newId();
  const res = await db().from(T).insert({
    ...scopeCols(s), id, entity_id: input.entity_id, month: input.month, type, status: 'draft', law_version: LAW_VERSION, created_by: s.actor,
  }).select('*').single();
  if (res.error) {
    if (isUniqueViolation(res.error, 'hrms_pay_runs_regular_uq') || (input.id && isUniqueViolation(res.error, 'pkey'))) {
      const mine = input.id ? await findRun(s, id) : (must(await scoped(db().from(T).select('*'), s).eq('entity_id', input.entity_id).eq('month', input.month).eq('type', type).limit(1)) as Row[] | null)?.[0];
      if (mine) return again(mine);
      throw refuse(409, 'This id is already in use', 'ID_IN_USE');
    }
    throw fail(res.error);
  }
  const audit = await db().from(AUDIT).insert({ ...scopeCols(s), run_id: id, at: now(), by_user_id: s.user_id, by_name: s.actor, action: 'Created' });
  if (audit.error) {
    await scoped(db().from(T).delete(), s).eq('id', id); // no run without its first audit line
    throw fail(audit.error);
  }
  return { run: await getRun(s, id), created: true };
}

// ── the four commands ───────────────────────────────────────────────────────
/** actions.ts computeRun: recompute every payslip from the current inputs and replace the run's payslips in one go. */
export async function computeRun(s: HrmsScope, id: string): Promise<RunView> {
  const run = await requireRun(s, id);
  if (run.status === 'frozen' || run.status === 'paid') throw runClosed(run);
  const model = await loadPayrollDb(s, { months: [String(run.month)] });
  const month = String(run.month);
  const entityId = String(run.entity_id);
  const payslips = computePayRunPayslips(model, month, entityId, id);
  const { error } = await db().rpc('hrms_store_computed_run', {
    p_org: s.org_id, p_run: id, p_payslips: payslips.map((p, i) => payslipRow(p, i)), p_fingerprint: inputFingerprint(model, month, entityId),
    p_law_version: LAW_VERSION, p_by_user: s.user_id, p_by_name: s.actor,
  });
  if (error) throw rpcError(error, run, 'compute');
  return getRun(s, id);
}

/** payrollActions.ts freezeRunSafe: only a computed run, and only while its inputs still match what was computed. */
export async function freezeRun(s: HrmsScope, id: string): Promise<RunView> {
  const run = await requireRun(s, id);
  if (run.status !== 'computed') throw refuse(409, REASON.notComputed, 'RUN_NOT_COMPUTED');
  const stored = run.input_fingerprint ? String(run.input_fingerprint) : null;
  const model = await loadPayrollDb(s, { months: [String(run.month)] });
  if (!stored || inputFingerprint(model, String(run.month), String(run.entity_id)) !== stored) throw refuse(409, REASON.stale, 'RUN_STALE');
  // The function checks the status and the fingerprint again under the row lock: a compute that slipped in after the read above wins, and the freeze says stale.
  const { error } = await db().rpc('hrms_freeze_run', { p_org: s.org_id, p_run: id, p_by_user: s.user_id, p_by_name: s.actor, p_fingerprint: stored });
  if (error) throw rpcError(error, run, 'freeze');
  return getRun(s, id);
}

/** payrollActions.ts unfreezeRunSafe: a reason of at least 5 characters, and only a frozen run. Undoes exactly what the freeze did. */
export async function unfreezeRun(s: HrmsScope, id: string, reason: string): Promise<RunView> {
  const why = reason.trim();
  if (why.length < 5) throw invalidWith(REASON.unfreezeReason, 'UNFREEZE_REASON');
  const run = await requireRun(s, id);
  if (run.status !== 'frozen') throw refuse(409, REASON.notFrozenUnfreeze, 'RUN_NOT_FROZEN');
  const { error } = await db().rpc('hrms_unfreeze_run', { p_org: s.org_id, p_run: id, p_by_user: s.user_id, p_by_name: s.actor, p_reason: why });
  if (error) throw rpcError(error, run, 'unfreeze');
  return getRun(s, id);
}

/** actions.ts markRunPaid: only a frozen run. */
export async function markRunPaid(s: HrmsScope, id: string): Promise<RunView> {
  const run = await requireRun(s, id);
  if (run.status !== 'frozen') throw refuse(409, REASON.notFrozenPay, 'RUN_NOT_FROZEN');
  const { error } = await db().rpc('hrms_mark_run_paid', { p_org: s.org_id, p_run: id, p_by_user: s.user_id, p_by_name: s.actor });
  if (error) throw rpcError(error, run, 'pay');
  return getRun(s, id);
}

// ── checks and the ECR ──────────────────────────────────────────────────────
/** The pre-run checks, exactly what the engine's preRunChecks says for this run's entity and month today. */
export async function runChecks(s: HrmsScope, id: string): Promise<{ checks: PreRunCheck[] }> {
  const run = await requireRun(s, id);
  const model = await loadPayrollDb(s, { months: [String(run.month)], withRuns: true });
  return { checks: preRunChecks(model, String(run.month), String(run.entity_id)) };
}

/** The people on a run's payslips as the engine sees them (no PAN or bank value). */
export async function employeesOnRun(s: HrmsScope, employeeIds: string[]) {
  const rows: Row[] = [];
  for (const part of chunks(employeeIds)) rows.push(...((must(await scoped(db().from('hrms_employees').select(EMPLOYEE_COLUMNS), s).in('id', part)) as Row[] | null) ?? []));
  return rows;
}

/** The EPFO ECR text and the rows it had to leave out, from the run's stored payslips (buildEcr's result as is). */
export async function runEcr(s: HrmsScope, id: string) {
  const run = await requireRun(s, id);
  const slips = (await payslipsOf(s, [id])).get(id) ?? [];
  const model = emptyDb();
  model.employees = (await employeesOnRun(s, slips.map((p) => p.employeeId))).map(toEngineEmployee);
  return buildEcr(model, { month: String(run.month), payslips: slips } as unknown as PayRun);
}

