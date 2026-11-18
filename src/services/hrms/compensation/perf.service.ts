import { db, fail, fetchAll, HrmsScope, isForeignKeyViolation, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { notFound, now } from '../payroll/common';

// The module's own performance band per person, and the employee's reply to the rating (rewards/store.ts setPerf +
// setPerfReply). One row per employee (unique org + employee); band and reply are set independently, so each setter does
// a per-field upsert — load the row, update the one field, or insert it — rather than a whole-row upsert that would wipe
// the other field. A missing employee (FK 23503) answers with the dashboard's "That employee no longer exists."

const T = 'hrms_comp_perf';

export async function loadPerf(s: HrmsScope): Promise<Row[]> {
  return fetchAll<Row>((from, to) => scoped(db().from(T).select('*'), s).order('employee_id', { ascending: true }).range(from, to));
}

const findByEmployee = async (s: HrmsScope, employeeId: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('employee_id', employeeId).maybeSingle()) as Row | null;

async function upsertField(s: HrmsScope, employeeId: string, patch: Row): Promise<Row> {
  const existing = await findByEmployee(s, employeeId);
  if (existing) {
    const res = await scoped(db().from(T).update({ ...patch, updated_at: now() }), s).eq('employee_id', employeeId).select('*').single();
    if (res.error) throw fail(res.error);
    return res.data as Row;
  }
  const res = await db().from(T).insert({ ...scopeCols(s), employee_id: employeeId, ...patch }).select('*').single();
  if (res.error) {
    if (isForeignKeyViolation(res.error)) throw notFound('That employee no longer exists.');
    throw fail(res.error);
  }
  return res.data as Row;
}

const out = (r: Row): Row => ({ employee_id: r.employee_id, band: r.band ?? null, evidence: r.evidence ?? null, reply: r.reply ?? null });

export async function setPerf(s: HrmsScope, employeeId: string, band: string): Promise<Row> {
  return out(await upsertField(s, employeeId, { band }));
}

export async function setPerfReply(s: HrmsScope, employeeId: string, reply: string): Promise<Row> {
  const trimmed = String(reply ?? '').trim();
  return out(await upsertField(s, employeeId, { reply: trimmed || null }));
}
