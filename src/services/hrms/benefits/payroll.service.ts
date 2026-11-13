import { AppError } from '../../../utils';
import { db, fail, fetchAll, HrmsScope, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, refuse } from '../payroll/common';
import { EMPLOYEE_COLUMNS, toEngineEmployee, toEngineStructure } from '../payroll/mapping';
import { benefitsTag, deductionPreview, planOf } from './engine';
import type { BenefitsDb, Enrolment, Plan } from './engine';
import { toEngineEnrolment, toEnginePlan } from './mapping';
import { ensureConfig } from './config.service';

// Send to payroll: the dashboard rewards/store.ts sendToPayroll. It computes the monthly deduction preview with the
// ported engine (so the amounts match the dashboard exactly), then replaces any earlier `[benefits <month>]` one-time
// deductions for the org + month -- atomically, through hrms_benefit_send_to_payroll, which refuses while that month's
// pay run is frozen or paid. The payroll maths and endpoints are untouched; only the adjustment rows the payroll engine
// already understands are created / deleted.
//   Refusals (the dashboard's exact words): "No health plan is set up." (400 VALIDATION),
//   "The payroll run for <month> is frozen or paid, so its adjustments are locked." (409 RUN_LOCKED).

const today = (): string => new Date().toISOString().slice(0, 10);

/** The frozen or paid run covering this month in the org (any entity), as the dashboard's sendToPayroll checks. */
async function frozenOrPaidRun(s: HrmsScope, month: string): Promise<Row | null> {
  const rows = must(await scoped(db().from('hrms_pay_runs').select('id,month,status'), s)
    .eq('month', month).in('status', ['frozen', 'paid']).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(1)) as Row[] | null;
  return rows?.[0] ?? null;
}

async function loadPlans(s: HrmsScope): Promise<Plan[]> {
  const rows = await fetchAll<Row>((from, to) => scoped(db().from('hrms_benefit_plans').select('*'), s).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to));
  return rows.map(toEnginePlan);
}
async function loadEnrolments(s: HrmsScope): Promise<Enrolment[]> {
  const rows = await fetchAll<Row>((from, to) => scoped(db().from('hrms_benefit_enrolments').select('*'), s).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to));
  return rows.map(toEngineEnrolment);
}
async function loadEngineDb(s: HrmsScope): Promise<BenefitsDb> {
  const [employees, structures] = await Promise.all([
    fetchAll<Row>((from, to) => scoped(db().from('hrms_employees').select(EMPLOYEE_COLUMNS), s).is('deleted_at', null).order('code', { ascending: true }).order('id', { ascending: true }).range(from, to)),
    fetchAll<Row>((from, to) => scoped(db().from('hrms_structures').select('*'), s).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to)),
  ]);
  return { employees: employees.map(toEngineEmployee), structures: structures.map(toEngineStructure) };
}

export interface SendResult { removed: number; added: number; total: number }

export async function sendToPayroll(s: HrmsScope, month: string): Promise<SendResult> {
  const plans = await loadPlans(s);
  const health = planOf(plans, 'health');
  if (!health) throw invalid('No health plan is set up.');

  const locked = await frozenOrPaidRun(s, month);
  if (locked) throw refuse(409, `The payroll run for ${month} is frozen or paid, so its adjustments are locked.`, 'RUN_LOCKED');

  const [engineDb, enrolments] = await Promise.all([loadEngineDb(s), loadEnrolments(s)]);
  const tag = benefitsTag(month);
  const rows = deductionPreview(engineDb, plans, enrolments, today(), health.coverStart).filter((r) => r.total > 0);
  const total = rows.reduce((t, r) => t + r.total, 0);
  const payloadRows = rows.map((r) => ({ employee_id: r.employeeId, amount: r.total, note: `${tag} ${r.note}` }));
  const sentEntry = { on: today(), rows: rows.length, total, by: s.actor };

  await ensureConfig(s);
  const { data, error } = await db().rpc('hrms_benefit_send_to_payroll', {
    p_org: s.org_id, p_month: month, p_tag: tag, p_rows: payloadRows, p_sent: sentEntry, p_by: s.actor,
  });
  if (error) throw sendError(month, error);
  return { removed: Number(data) || 0, added: rows.length, total };
}

function sendError(month: string, error: { code?: string; message?: string }): AppError {
  if ((error.message ?? '').trim() === 'RUN_LOCKED') return refuse(409, `The payroll run for ${month} is frozen or paid, so its adjustments are locked.`, 'RUN_LOCKED');
  return fail(error);
}
