import { db, fail, HrmsScope, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { insertIdempotent, newId, notFound, now } from '../payroll/common';
import { onboardingOut } from './mapping';

// Onboarding cases. A case tracks a new joiner's checklist; the dashboard creates the draft Employee separately through the phase-1
// endpoint (status 'onboarding') and then this case, so this endpoint NEVER creates an employee. employee_id is optional (a pre-hire
// has none); when given it must be a live employee of the org. Stage and task shape are validated by the schema; there is no other rule.

const T = 'hrms_onboarding_cases';

const find = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

/** A live (not soft-deleted) employee of the org, or null. */
const liveEmployee = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from('hrms_employees').select('id'), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;

/** Checklist tasks in the dashboard's camelCase shape; a task without an id gets one, done defaults to false. */
function normTasks(v: unknown): Row[] {
  if (!Array.isArray(v)) return [];
  return v.map((t) => {
    const r = (t && typeof t === 'object' ? t : {}) as Row;
    const task: Row = { id: r.id ? String(r.id) : newId(), label: String(r.label ?? '').trim(), owner: String(r.owner ?? ''), done: !!r.done };
    if (r.dueOn !== null && r.dueOn !== undefined && r.dueOn !== '') task.dueOn = String(r.dueOn);
    return task;
  });
}

/** The effective onboarding columns from a source object (create: the request; update: current merged with the patch). */
function columnsOf(src: Row): Row {
  return {
    employee_id: src.employee_id ?? null,
    name: String(src.name ?? '').trim(),
    role: String(src.role ?? '').trim(),
    join_date: src.join_date,
    stage: src.stage ?? 'offer',
    tasks: normTasks(src.tasks),
  };
}

export async function createOnboarding(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: onboardingOut(existing), created: false };
  }
  if (input.employee_id && !(await liveEmployee(s, String(input.employee_id)))) throw notFound('Employee not found');
  const columns = columnsOf(input);
  const r = await insertIdempotent(s, T, { id, ...columns }, !!input.id, () => find(s, id));
  return { row: onboardingOut(r.row), created: r.created };
}

export async function updateOnboarding(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Onboarding case not found');
  if (patch.employee_id && !(await liveEmployee(s, String(patch.employee_id)))) throw notFound('Employee not found');
  const merged: Row = { ...current };
  for (const k of ['employee_id', 'name', 'role', 'join_date', 'stage', 'tasks'] as const) {
    if (patch[k] !== undefined) merged[k] = patch[k];
  }
  const columns = columnsOf(merged);
  const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return onboardingOut(res.data as Row);
}

export async function deleteOnboarding(s: HrmsScope, id: string): Promise<{ id: string }> {
  const current = await find(s, id);
  if (!current) throw notFound('Onboarding case not found');
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}
