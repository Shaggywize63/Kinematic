import { db, fail, HrmsScope, isNotReady, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { insertIdempotent, newId, notFound, now, refuse } from '../payroll/common';
import { exitOut } from './mapping';
import { closeBlockers } from './validation';

// Exit cases. The rules are the dashboard's (lifecycleActions.ts startExit / closeExit / exitChecks), with its words. The one hard
// server rule is the CLOSE BLOCKER: moving stage to 'closed' is refused (409 EXIT_BLOCKED) while any clearance item is not done, or the
// employee's full-and-final case is not paid. The F&F case is read from hrms_fnf_cases (phase 2); its maths and endpoints are untouched.

const T = 'hrms_exit_cases';

const find = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

const liveEmployee = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from('hrms_employees').select('id'), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;

/** The employee's latest full-and-final case (most recent last working date), exactly like lifecycleActions.ts fnfFor. Null if none —
 *  or if the F&F table is not there yet, which the close blocker then reports as "no F&F case" (it is not an error for this phase). */
async function latestFnf(s: HrmsScope, employeeId: string): Promise<{ status: string } | null> {
  const res = await scoped(db().from('hrms_fnf_cases').select('status,last_working_date'), s)
    .eq('employee_id', employeeId).order('last_working_date', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (res.error) {
    if (isNotReady(res.error)) return null;
    throw fail(res.error);
  }
  const rows = (res.data as Row[] | null) ?? [];
  return rows[0] ? { status: String(rows[0].status) } : null;
}

function normClearance(v: unknown): Row[] {
  if (!Array.isArray(v)) return [];
  return v.map((c) => {
    const r = (c && typeof c === 'object' ? c : {}) as Row;
    const item: Row = { id: r.id ? String(r.id) : newId(), department: String(r.department ?? '').trim(), owner: String(r.owner ?? ''), done: !!r.done };
    if (r.remarks !== null && r.remarks !== undefined && r.remarks !== '') item.remarks = String(r.remarks);
    return item;
  });
}
function normAssets(v: unknown): Row[] {
  if (!Array.isArray(v)) return [];
  return v.map((a) => {
    const r = (a && typeof a === 'object' ? a : {}) as Row;
    return { id: r.id ? String(r.id) : newId(), name: String(r.name ?? '').trim(), returned: !!r.returned };
  });
}

/** The effective exit columns from a source object (create: the request; update: current merged with the patch). */
function columnsOf(src: Row): Row {
  return {
    employee_id: src.employee_id,
    reason: src.reason,
    resignation_date: src.resignation_date,
    last_working_date: src.last_working_date,
    notice_waived: src.notice_waived === undefined ? false : !!src.notice_waived,
    stage: src.stage ?? 'notice',
    clearance: normClearance(src.clearance),
    assets: normAssets(src.assets),
    interview_done: src.interview_done === undefined ? false : !!src.interview_done,
  };
}

/** Refuse (409 EXIT_BLOCKED) with the dashboard's joined reasons if this case cannot be closed yet. */
async function assertCanClose(s: HrmsScope, employeeId: string, clearance: Row[]): Promise<void> {
  const fnf = await latestFnf(s, employeeId);
  const blockers = closeBlockers(clearance.map((c) => ({ department: String(c.department ?? ''), done: !!c.done })), fnf);
  if (blockers.length) throw refuse(409, blockers.join(' '), 'EXIT_BLOCKED');
}

export async function createExit(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: exitOut(existing), created: false };
  }
  if (!(await liveEmployee(s, String(input.employee_id)))) throw notFound('Employee not found');
  const columns = columnsOf(input);
  if (columns.stage === 'closed') await assertCanClose(s, String(columns.employee_id), columns.clearance as Row[]);
  const r = await insertIdempotent(s, T, { id, ...columns }, !!input.id, () => find(s, id));
  return { row: exitOut(r.row), created: r.created };
}

export async function updateExit(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Exit case not found');
  const merged: Row = { ...current };
  for (const k of ['reason', 'resignation_date', 'last_working_date', 'notice_waived', 'stage', 'clearance', 'assets', 'interview_done'] as const) {
    if (patch[k] !== undefined) merged[k] = patch[k];
  }
  const columns = columnsOf(merged);
  // The close blocker fires only on the transition INTO 'closed' (reopen, and any other edit, are free).
  if (columns.stage === 'closed' && current.stage !== 'closed') {
    await assertCanClose(s, String(current.employee_id), columns.clearance as Row[]);
  }
  const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return exitOut(res.data as Row);
}

export async function deleteExit(s: HrmsScope, id: string): Promise<{ id: string }> {
  const current = await find(s, id);
  if (!current) throw notFound('Exit case not found');
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}
