import { db, fail, HrmsScope, isUniqueViolation, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, newId, notFound, now } from '../payroll/common';
import { EMPLOYEE_COLUMNS, toEngineEmployee } from '../payroll/mapping';
import { enrolmentEligibility, planOf, tierOf, validateDependants, validateFlex, windowStatus } from './engine';
import type { Dependant } from './engine';
import { enrolmentOut, toEnginePlan } from './mapping';
import { clearReminder, loadBenefitsWindow } from './config.service';

// Per-employee enrolments. submitEnrolment UPSERTS one row per employee (unique org + employee), reproducing the
// dashboard rewards/store.ts submitEnrolment: its order of checks and its exact plain words
//   "Choose an employee." / the eligibility reason (or "This person cannot enrol.") / "The enrolment window is closed. HR
//    can extend it." / "Choose a health cover amount, or choose to opt out." / the dependant-rule messages / the flex
//    messages.
// submitEnrolment also clears any pending reminder for the person (as the dashboard does: delete reminders[employeeId]).

const T = 'hrms_benefit_enrolments';
const today = (): string => new Date().toISOString().slice(0, 10);

const findByEmployee = async (s: HrmsScope, employeeId: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('employee_id', employeeId).maybeSingle()) as Row | null;

/** The live (not soft-deleted) employee of the org as the engine sees it, or null. */
async function engineEmployee(s: HrmsScope, id: string) {
  const row = must(await scoped(db().from('hrms_employees').select(EMPLOYEE_COLUMNS), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;
  return row ? toEngineEmployee(row) : null;
}

async function loadPlans(s: HrmsScope) {
  const rows = must(await scoped(db().from('hrms_benefit_plans').select('*'), s).order('created_at', { ascending: true }).order('id', { ascending: true })) as Row[] | null;
  return (rows ?? []).map(toEnginePlan);
}

export interface EnrolInput {
  id?: string; employee_id: string; status: 'enrolled' | 'waived'; health_tier?: string | null;
  dependants?: Array<{ id?: string; name: string; relation: 'spouse' | 'child' | 'parent'; dob: string }>;
  meal_tier?: string | null; nps_tier?: string | null; flex?: Record<string, number>;
}

/** submitEnrolment: validate (eligibility, window, health cover, dependant rules, flex), then upsert by employee. */
export async function submitEnrolment(s: HrmsScope, i: EnrolInput): Promise<Row> {
  const emp = await engineEmployee(s, i.employee_id);
  const plans = await loadPlans(s);
  const health = planOf(plans, 'health');
  const flexPlan = planOf(plans, 'flex');
  if (!emp || !health) throw invalid('Choose an employee.');

  const elig = enrolmentEligibility(emp, health.coverStart);
  if (!elig.eligible) throw invalid(elig.reason ?? 'This person cannot enrol.');

  const window = await loadBenefitsWindow(s);
  if (windowStatus(window, today()).state !== 'open') throw invalid('The enrolment window is closed. HR can extend it.');

  const deps = (i.dependants ?? []) as Dependant[];
  const flex = i.flex ?? {};
  if (i.status === 'enrolled') {
    if (!tierOf(health, i.health_tier ?? undefined)) throw invalid('Choose a health cover amount, or choose to opt out.');
    const errs = health.dependants ? validateDependants(health.dependants, deps, health.coverStart) : [];
    if (errs.length) throw invalid(errs[0]!);
    if (flexPlan) { const fe = validateFlex(flexPlan, flex); if (fe.length) throw invalid(fe[0]!); }
  }

  const enrolled = i.status === 'enrolled';
  const columns: Row = {
    employee_id: i.employee_id,
    status: i.status,
    submitted_on: today(),
    by_name: s.actor,
    health_tier: enrolled ? (i.health_tier ?? null) : null,
    dependants: enrolled ? deps.map((x) => ({ id: x.id ? String(x.id) : newId(), name: String(x.name ?? '').trim(), relation: x.relation, dob: x.dob })) : [],
    meal_tier: enrolled ? (i.meal_tier ?? null) : null,
    nps_tier: enrolled ? (i.nps_tier ?? null) : null,
    flex: enrolled ? Object.fromEntries(Object.entries(flex).filter(([, v]) => v > 0)) : {},
  };

  const saved = await upsertByEmployee(s, i.employee_id, (i.id as string | undefined) ?? newId(), columns);
  await clearReminder(s, i.employee_id);
  return enrolmentOut(saved);
}

/** Replace the person's enrolment, or insert a new one (unique org + employee is the backstop on a race). */
async function upsertByEmployee(s: HrmsScope, employeeId: string, newRowId: string, columns: Row): Promise<Row> {
  const existing = await findByEmployee(s, employeeId);
  if (existing) {
    const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', existing.id).select('*').single();
    if (res.error) throw fail(res.error);
    return res.data as Row;
  }
  const ins = await db().from(T).insert({ ...scopeCols(s), id: newRowId, ...columns }).select('*').single();
  if (!ins.error) return ins.data as Row;
  if (isUniqueViolation(ins.error, 'hrms_benefit_enrolments_org_emp_uq')) {
    const now2 = await findByEmployee(s, employeeId);
    if (now2) {
      const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', now2.id).select('*').single();
      if (res.error) throw fail(res.error);
      return res.data as Row;
    }
  }
  throw fail(ins.error);
}

/** Clear one person's enrolment (DELETE /enrolments/:employeeId). */
export async function deleteEnrolment(s: HrmsScope, employeeId: string): Promise<{ employee_id: string }> {
  const existing = await findByEmployee(s, employeeId);
  if (!existing) throw notFound('That person has no enrolment.');
  const del = await scoped(db().from(T).delete(), s).eq('id', existing.id);
  if (del.error) throw fail(del.error);
  return { employee_id: employeeId };
}
