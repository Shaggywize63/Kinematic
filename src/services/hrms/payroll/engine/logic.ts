// PORT of the payroll rules that live in kinematic-dashboard src/components/hrms/payroll/logic.ts: isLocked, the adjustment kinds and limits,
// the adjustment / salary structure / loan / full-and-final validators. The words of every message are the dashboard's: the server enforces
// the same rules and the UI shows the server's reason. This is not engine maths, but it is kept in step with the dashboard the same way.
//
// Differences from the original are adaptations, not changes of rule:
//   - imports point at this folder; the UI-only helpers (labels, previews, comparisons, schedules, lookups) are not ported;
//   - validateLoan returns the blocking errors only: its two WARNINGS never block a save, and one of them needs the UI's preview month;
//   - validateFnf skips the earned-leave balance check, because leave balances are not on the server yet.

import type {
  AdjustmentKind, CalcType, ComponentKind, HrmsDb, Id, Loan, Month, PayRun, SalaryComponent, SalaryStructure,
} from './types';
import { employeesForRun } from './engine';
import { fmtMonth, fullName } from './format';
import { ESI, PF } from './rules';

export const isLocked = (r: Pick<PayRun, 'status'>): boolean => r.status === 'frozen' || r.status === 'paid';

// ───────────────────────────────── adjustments ─────────────────────────────────
export interface AdjustmentKindInfo { value: AdjustmentKind; label: string; effect: 'earning' | 'reimbursement' | 'deduction'; taxable: boolean }
export const ADJUSTMENT_KINDS: AdjustmentKindInfo[] = [
  { value: 'arrear', label: 'Arrears', effect: 'earning', taxable: true },
  { value: 'bonus', label: 'Bonus', effect: 'earning', taxable: true },
  { value: 'incentive', label: 'Incentive', effect: 'earning', taxable: true },
  { value: 'reimbursement', label: 'Reimbursement', effect: 'reimbursement', taxable: false },
  { value: 'one_time_deduction', label: 'One-time deduction', effect: 'deduction', taxable: false },
  { value: 'loan_emi', label: 'Loan EMI (manual)', effect: 'deduction', taxable: false },
  { value: 'advance_recovery', label: 'Advance recovery (manual)', effect: 'deduction', taxable: false },
];
export const adjustmentInfo = (k: AdjustmentKind): AdjustmentKindInfo => ADJUSTMENT_KINDS.find((x) => x.value === k) ?? ADJUSTMENT_KINDS[0]!;
export const MAX_ADJUSTMENT = 10_000_000; // sanity cap: one crore

/** The frozen or paid run that covers this employee's entity in that month, if any. Adjustments are locked once it exists. */
export function adjustmentLock(db: HrmsDb, a: { employeeId: Id; month: Month }): PayRun | undefined {
  const emp = db.employees.find((e) => e.id === a.employeeId);
  if (!emp) return undefined;
  return db.payRuns.find((r) => r.month === a.month && r.entityId === emp.entityId && isLocked(r));
}

export interface AdjustmentDraft { employeeId: string; month: string; kind: AdjustmentKind; amount: string; taxable: boolean; note: string }
export function validateAdjustment(db: HrmsDb, d: AdjustmentDraft, editingId?: Id, originalLockedBy?: PayRun): Record<string, string> {
  const err: Record<string, string> = {};
  if (!d.employeeId || !db.employees.some((e) => e.id === d.employeeId)) err.employeeId = 'Choose an employee';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(d.month)) err.month = 'Choose a month';
  const amt = Number(d.amount);
  if (d.amount.trim() === '' || Number.isNaN(amt)) err.amount = 'Enter an amount';
  else if (amt <= 0) err.amount = 'Amount must be more than zero';
  else if (amt > MAX_ADJUSTMENT) err.amount = 'That is more than ₹1 crore; check the amount';
  else if (Math.abs(amt - Math.round(amt)) > 1e-9) err.amount = 'Whole rupees only';
  if (d.note.length > 80) err.note = 'Keep the note under 80 characters';
  const emp = db.employees.find((e) => e.id === d.employeeId);
  if (emp && !err.month && !employeesForRun(db, d.month, emp.entityId).some((e) => e.id === emp.id)) {
    err.employeeId = `${fullName(emp)} is not on the ${fmtMonth(d.month)} payroll, so this would never be paid. Choose a month they are employed.`;
  }
  if (!err.employeeId && !err.month) {
    const lock = adjustmentLock(db, d);
    if (lock) err.month = `The ${fmtMonth(lock.month)} run is ${lock.status}. Adjustments for it are closed; use the next open month.`;
    else if (editingId && originalLockedBy) err.month = 'This adjustment sits in a closed run and cannot be changed.';
  }
  return err;
}

// ─────────────────────────────────── salary structures ───────────────────────────────────
export const CALC_TYPES_BY_KIND: Record<ComponentKind, CalcType[]> = {
  earning: ['fixed', 'pct_basic', 'pct_ctc', 'balance'],
  employer: ['pf_employer', 'esi_employer', 'gratuity_provision', 'fixed', 'pct_basic', 'pct_ctc'],
  reimbursement: ['fixed'],
  deduction: ['fixed'],
};
export interface ComponentDraft {
  code: string; name: string; kind: ComponentKind; calcType: CalcType; value: string;
  isWage: boolean; taxable: boolean; pfApplicable: boolean; esiApplicable: boolean; prorate: boolean; showInPayslip: boolean;
}
export const MAX_FIXED_COMPONENT = 1_000_000;

export function draftFromComponent(c: SalaryComponent): ComponentDraft {
  return { code: c.code, name: c.name, kind: c.kind, calcType: c.calc.type, value: String(c.calc.value), isWage: c.isWage, taxable: c.taxable, pfApplicable: c.pfApplicable, esiApplicable: c.esiApplicable, prorate: c.prorate, showInPayslip: c.showInPayslip };
}
export function componentFromDraft(d: ComponentDraft, id: string): SalaryComponent {
  const value = d.calcType === 'balance' ? 0 : d.calcType === 'pf_employer' ? PF.employerRate : d.calcType === 'esi_employer' ? ESI.employerRate : Number(d.value);
  return {
    id, code: d.code.trim().toUpperCase(), name: d.name.trim(), kind: d.kind, calc: { type: d.calcType, value },
    isWage: d.kind === 'earning' ? d.isWage : false, taxable: d.taxable, pfApplicable: d.pfApplicable, esiApplicable: d.esiApplicable, prorate: d.prorate, showInPayslip: d.showInPayslip,
  };
}
/** Sensible flag defaults when the kind changes, mirroring how the seed structures are set up. */
export function flagDefaults(kind: ComponentKind): Pick<ComponentDraft, 'taxable' | 'esiApplicable' | 'prorate' | 'isWage' | 'pfApplicable'> {
  return kind === 'earning'
    ? { taxable: true, esiApplicable: true, prorate: true, isWage: false, pfApplicable: false }
    : { taxable: false, esiApplicable: false, prorate: false, isWage: false, pfApplicable: false };
}

export function validateComponent(d: ComponentDraft, siblings: SalaryComponent[]): Record<string, string> {
  const err: Record<string, string> = {};
  const code = d.code.trim().toUpperCase();
  if (!code) err.code = 'Enter a code';
  else if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(code)) err.code = 'Use 2 to 20 capital letters, digits or underscores, starting with a letter';
  else if (siblings.some((s) => s.code === code)) err.code = 'Another component already uses this code';
  if (!d.name.trim()) err.name = 'Enter a name';
  else if (d.name.trim().length > 50) err.name = 'Keep the name under 50 characters';
  if (!CALC_TYPES_BY_KIND[d.kind].includes(d.calcType)) err.calcType = 'This calculation is not available for this kind';
  const v = Number(d.value);
  const needsValue = !['balance', 'pf_employer', 'esi_employer'].includes(d.calcType);
  if (needsValue) {
    if (d.value.trim() === '' || Number.isNaN(v)) err.value = 'Enter a value';
    else if (v < 0) err.value = 'Cannot be negative';
    else if (d.calcType === 'fixed' && v > MAX_FIXED_COMPONENT) err.value = 'More than ₹10,00,000 a month; check the amount';
    else if (d.calcType === 'pct_ctc' && (v <= 0 || v > 100)) err.value = 'Percent of CTC must be above 0 and at most 100';
    else if (d.calcType === 'pct_basic' && (v <= 0 || v > 200)) err.value = 'Percent of basic must be above 0 and at most 200';
    else if (d.calcType === 'gratuity_provision' && (v <= 0 || v > 10)) err.value = 'Gratuity provision is above 0 and at most 10 percent of basic';
  }
  if (code === 'BASIC' && d.kind !== 'earning') err.kind = 'BASIC must be an earning';
  if (code === 'BASIC' && !d.isWage) err.isWage = 'BASIC must count as a wage';
  if (code === 'BASIC' && d.calcType === 'balance') err.calcType = 'BASIC cannot be the balancing component';
  if (d.calcType === 'balance' && d.kind !== 'earning') err.calcType = 'Only an earning can be the balancing component';
  return err;
}

export function validateStructure(s: SalaryStructure): { errors: string[]; warnings: string[] } {
  const errors: string[] = []; const warnings: string[] = [];
  if (!s.name.trim()) errors.push('Give the structure a name.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.effectiveFrom)) errors.push('Choose an effective-from date.');
  const comps = s.components;
  if (!comps.length) errors.push('Add at least one component.');
  const basic = comps.find((c) => c.code === 'BASIC');
  if (!basic) errors.push('A component with the code BASIC is required.');
  else {
    if (basic.kind !== 'earning') errors.push('BASIC must be an earning.');
    if (!basic.isWage) errors.push('BASIC must be flagged as a wage.');
    if (basic.calc.type === 'balance') errors.push('BASIC cannot be the balancing component.');
  }
  const balances = comps.filter((c) => c.calc.type === 'balance');
  if (balances.length > 1) errors.push(`Only one balancing component is allowed (found ${balances.map((c) => c.code).join(', ')}).`);
  if (comps.filter((c) => c.calc.type === 'esi_employer').length > 1) errors.push('Only one employer ESI component is allowed.');
  const dup = comps.filter((c, i) => comps.findIndex((x) => x.code === c.code) !== i).map((c) => c.code);
  if (dup.length) errors.push(`Component codes must be unique (repeated: ${Array.from(new Set(dup)).join(', ')}).`);
  const pctCtc = comps.filter((c) => c.kind !== 'deduction' && c.calc.type === 'pct_ctc').reduce((t, c) => t + c.calc.value, 0);
  if (pctCtc > 100) errors.push(`Components that take a percent of CTC add up to ${pctCtc}%, which is more than 100%.`);
  for (const c of comps) {
    const e = validateComponent(draftFromComponent(c), comps.filter((x) => x !== c));
    for (const m of Object.values(e)) errors.push(`${c.code || 'Component'}: ${m}`);
  }
  if (!balances.length) warnings.push('There is no balancing component, so the breakup only reaches the CTC if the components add up exactly.');
  if (comps.some((c) => c.kind === 'deduction')) warnings.push('Deduction components are not applied by the preview payroll engine. Statutory deductions come from the rules, and loans from the Loans tab.');
  if (!comps.some((c) => c.calc.type === 'pf_employer')) warnings.push('No employer PF component: the employer PF will not be counted in the CTC.');
  return { errors: Array.from(new Set(errors)), warnings };
}


// ─────────────────────────────────────── loans ───────────────────────────────────────
export interface LoanDraft { employeeId: string; kind: Loan['kind']; principal: string; emi: string; startMonth: string; note: string }
export function validateLoan(db: HrmsDb, d: LoanDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const e = db.employees.find((x) => x.id === d.employeeId);
  if (!e) errors.employeeId = 'Choose an employee';
  const p = Number(d.principal); const m = Number(d.emi);
  if (d.principal.trim() === '' || Number.isNaN(p) || p <= 0) errors.principal = 'Enter the amount lent';
  else if (p > 5_000_000) errors.principal = 'More than ₹50 lakh; check the amount';
  if (d.emi.trim() === '' || Number.isNaN(m) || m <= 0) errors.emi = 'Enter the monthly EMI';
  else if (!errors.principal && m > p) errors.emi = 'The EMI cannot be more than the amount lent';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(d.startMonth)) errors.startMonth = 'Choose the first month of recovery';
  if (d.note.length > 80) errors.note = 'Keep the note under 80 characters';
  return errors;
}

// ─────────────────────────────── full and final ───────────────────────────────
export interface FnfDraft {
  employeeId: string; lastWorkingDate: string; resignationDate: string; noticeDaysServed: string; leaveEncashDays: string; otherRecoveries: string; otherPayments: string;
}
export function validateFnf(db: HrmsDb, d: FnfDraft): Record<string, string> {
  const err: Record<string, string> = {};
  const e = db.employees.find((x) => x.id === d.employeeId);
  if (!e) err.employeeId = 'Choose an employee';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.lastWorkingDate)) err.lastWorkingDate = 'Enter the last working day';
  else if (e && e.joinDate > d.lastWorkingDate) err.lastWorkingDate = 'The last working day is before the joining date';
  if (d.resignationDate && !/^\d{4}-\d{2}-\d{2}$/.test(d.resignationDate)) err.resignationDate = 'Enter a valid date';
  else if (d.resignationDate && d.lastWorkingDate && d.resignationDate > d.lastWorkingDate) err.resignationDate = 'Resignation is after the last working day';
  const num = (v: string, key: string, label: string, max: number) => {
    const n = Number(v);
    if (v.trim() === '' || Number.isNaN(n)) err[key] = `Enter ${label}`;
    else if (n < 0) err[key] = 'Cannot be negative';
    else if (n > max) err[key] = `That is more than ${max}; check it`;
  };
  num(d.noticeDaysServed, 'noticeDaysServed', 'the notice days served', 365);
  num(d.leaveEncashDays, 'leaveEncashDays', 'the leave days to encash', 365);
  num(d.otherRecoveries, 'otherRecoveries', 'the other recoveries (0 if none)', MAX_ADJUSTMENT);
  num(d.otherPayments, 'otherPayments', 'the other payments (0 if none)', MAX_ADJUSTMENT);
  return err;
}
