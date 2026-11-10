// PORT of kinematic-dashboard src/lib/hrms/engine.ts (the payroll oracle). Exact parity is the requirement: do NOT "improve" the maths here.
// Change the dashboard file first, regenerate tests/fixtures/hrms-payroll-golden.json, and port the change; tests/hrmsPayrollParity.test.ts
// reproduces every golden case. Only imports (and the masking helper's location) differ from the original.

// Payroll and statutory engine. Pure functions only: no React, no storage, no network. That keeps it testable
// (e2e/hrms-engine.spec.ts) and lets the backend reuse the same logic when payroll moves server-side.
//
// Scope of this preview engine, stated plainly so nobody mistakes it for a filing-grade one:
//   - PF, ESI, PT, LWF, TDS (both regimes, no surcharge), overtime, loss of pay, arrears, loans, F&F, gratuity.
//   - ESIC contribution-period continuity (once over the ceiling, stay till period end) is NOT modelled.
//   - TDS assumes a full financial year of the same pay (mid-year joiners are over-projected).
//   - All parameters come from rules.ts and carry a confidence tag; none are gazette-verified.

import type {
  Adjustment, AttendanceSummary, Employee, FnfCase, HrmsDb, Loan, Location, OvertimeRule, PayRun, Payslip, PayslipLine,
  SalaryComponent, SalaryStructure, Month, ISODate,
} from './types';
import { uid } from './types';
import { looksMaskedAccount } from './masking';
import {
  ESI, LABOUR_CODES, PF, TDS, isMetroCity, lwfFor, minWageFor, monthEnd, monthStart, professionalTax, slabTax, valueOn,
} from './rules';
import { addDays, daysInMonth, fullName, tenure } from './format';

const r0 = (n: number) => Math.round(n);

// ───────────────────────────── salary breakup from CTC ─────────────────────────
export interface BreakupLine {
  componentId: string; code: string; name: string; kind: SalaryComponent['kind'];
  monthly: number;
  isWage: boolean; taxable: boolean; pfApplicable: boolean; esiApplicable: boolean; prorate: boolean; showInPayslip: boolean;
}
export interface WageTest {
  remuneration: number;     // total monthly remuneration (the CTC, monthly)
  wages: number;            // components flagged as wages
  wagePct: number;
  passes: boolean;
  addBack: number;          // amount added to wages so that wages reach 50% of remuneration
  codeWages: number;        // wages after the add-back: the base for PF, gratuity, bonus
}
export interface Breakup {
  lines: BreakupLine[];
  monthlyCtc: number;
  monthlyGross: number;     // earnings only
  basic: number;
  wageTest: WageTest;
  pfWage: number;           // PF wage at full attendance (ceiling applied unless pfOnActual)
  esiApplicable: boolean;
  warnings: string[];
}

export interface BreakupOptions {
  asOn: ISODate;
  pfMember?: boolean;
  pfOnActual?: boolean;
  overrides?: Record<string, number>;
}

export function buildBreakup(structure: SalaryStructure, annualCtc: number, opts: BreakupOptions): Breakup {
  const warnings: string[] = [];
  const monthlyCtc = annualCtc / 12;
  const pfCeiling = valueOn(PF.ceiling, opts.asOn);
  const esiCeiling = valueOn(ESI.ceiling, opts.asOn);
  const pfMember = opts.pfMember ?? true;
  const comps = structure.components;
  const amount: Record<string, number> = {};

  const basicComp = comps.find((c) => c.code === 'BASIC') ?? comps.find((c) => c.kind === 'earning' && c.isWage);
  const fixedFirst = comps.filter((c) => c.kind !== 'deduction' && (c.calc.type === 'fixed' || c.calc.type === 'pct_ctc'));
  for (const c of fixedFirst) {
    const o = opts.overrides?.[c.id];
    amount[c.id] = r0(o != null ? o : c.calc.type === 'fixed' ? c.calc.value : (monthlyCtc * c.calc.value) / 100);
  }
  const basic = basicComp ? amount[basicComp.id] ?? 0 : 0;
  for (const c of comps.filter((x) => x.kind !== 'deduction' && x.calc.type === 'pct_basic')) {
    const o = opts.overrides?.[c.id];
    amount[c.id] = r0(o != null ? o : (basic * c.calc.value) / 100);
  }

  const wageSum = () => comps.filter((c) => c.kind === 'earning' && c.isWage).reduce((s, c) => s + (amount[c.id] ?? 0), 0);
  // 50% rule: wages (basic, DA, retaining allowance) must be at least half of the total remuneration.
  const wages = wageSum();
  const half = (monthlyCtc * LABOUR_CODES.minWagePercent) / 100;
  const addBack = wages < half ? half - wages : 0;
  const codeWages = wages + addBack;
  const pfWage = pfMember ? (opts.pfOnActual ? codeWages : Math.min(codeWages, pfCeiling)) : 0;

  for (const c of comps.filter((x) => x.calc.type === 'pf_employer')) amount[c.id] = r0((pfWage * PF.employerRate) / 100);
  for (const c of comps.filter((x) => x.calc.type === 'gratuity_provision')) amount[c.id] = r0((basic * c.calc.value) / 100);

  const balanceComp = comps.find((c) => c.calc.type === 'balance');
  const esiComp = comps.find((c) => c.calc.type === 'esi_employer');
  const sumOf = (kinds: SalaryComponent['kind'][], skip?: string) =>
    comps.filter((c) => kinds.includes(c.kind) && c.id !== skip).reduce((s, c) => s + (amount[c.id] ?? 0), 0);

  let esiApplicable = false;
  // Employer ESI depends on gross, and the balancing allowance depends on employer ESI: two passes settle it.
  amount[esiComp?.id ?? ''] = 0;
  for (let pass = 0; pass < 2; pass++) {
    const others = sumOf(['earning', 'employer', 'reimbursement'], balanceComp?.id);
    const bal = Math.max(0, r0(monthlyCtc - others));
    if (balanceComp) amount[balanceComp.id] = bal;
    const gross = sumOf(['earning']);
    esiApplicable = gross <= esiCeiling && gross > 0;
    if (esiComp) {
      const esiWage = comps.filter((c) => c.kind === 'earning' && c.esiApplicable).reduce((s, c) => s + (amount[c.id] ?? 0), 0);
      amount[esiComp.id] = esiApplicable ? Math.ceil((esiWage * ESI.employerRate) / 100) : 0;
    }
  }
  if (balanceComp && monthlyCtc - sumOf(['earning', 'employer', 'reimbursement'], balanceComp.id) < 0) {
    warnings.push('The fixed components and employer contributions are more than the CTC, so the balancing allowance was set to zero.');
  }
  if (!balanceComp) {
    const diff = Math.abs(monthlyCtc - sumOf(['earning', 'employer', 'reimbursement']));
    if (diff > 5) warnings.push(`The components add up to ${r0(sumOf(['earning', 'employer', 'reimbursement']))} a month, not the CTC of ${r0(monthlyCtc)}. Add a balancing component.`);
  }
  if (addBack > 0) warnings.push(`Wages are ${((wages / monthlyCtc) * 100).toFixed(1)}% of remuneration. Under the Labour Codes ${r0(addBack)} a month is added back to wages, which raises PF, gratuity and bonus.`);

  const lines: BreakupLine[] = comps.filter((c) => c.kind !== 'deduction').map((c) => ({
    componentId: c.id, code: c.code, name: c.name, kind: c.kind, monthly: amount[c.id] ?? 0,
    isWage: c.isWage, taxable: c.taxable, pfApplicable: c.pfApplicable, esiApplicable: c.esiApplicable, prorate: c.prorate, showInPayslip: c.showInPayslip,
  }));
  const monthlyGross = lines.filter((l) => l.kind === 'earning').reduce((s, l) => s + l.monthly, 0);
  return {
    lines, monthlyCtc, monthlyGross, basic,
    wageTest: { remuneration: monthlyCtc, wages, wagePct: monthlyCtc ? (wages / monthlyCtc) * 100 : 0, passes: addBack === 0, addBack, codeWages },
    pfWage, esiApplicable, warnings,
  };
}

// ────────────────────────────────── income tax ───────────────────────────────
export interface TaxInput {
  regime: Employee['taxRegime'];
  annualGross: number;          // taxable salary for the year
  basicAnnual: number;
  hraAnnual: number;
  metro: boolean;
  employeePfAnnual: number;
  ptAnnual: number;
  declaration: Employee['declaration'];
}
export function annualTax(i: TaxInput): { taxable: number; tax: number; cess: number; total: number; exemptions: number } {
  if (i.regime === 'new') {
    const taxable = Math.max(0, i.annualGross - TDS.newRegime.standardDeduction);
    let tax = slabTax(taxable, TDS.newRegime.slabs);
    if (taxable <= TDS.newRegime.rebateLimit) tax = Math.max(0, tax - TDS.newRegime.rebateMax);
    else tax = Math.min(tax, taxable - TDS.newRegime.rebateLimit); // marginal relief
    const cess = (tax * TDS.cess) / 100;
    return { taxable, tax, cess, total: r0(tax + cess), exemptions: TDS.newRegime.standardDeduction };
  }
  const d = i.declaration;
  const hraExempt = Math.max(0, Math.min(i.hraAnnual, d.rentPaidAnnual - 0.1 * i.basicAnnual, (i.metro ? 0.5 : 0.4) * i.basicAnnual));
  const c80 = Math.min(TDS.oldRegime.limits.sec80C, d.sec80C + i.employeePfAnnual);
  const exemptions = TDS.oldRegime.standardDeduction + hraExempt + c80 + d.sec80D + Math.min(TDS.oldRegime.limits.nps80CCD1B, d.nps80CCD1B)
    + Math.min(TDS.oldRegime.limits.homeLoanInterest, d.homeLoanInterest) + d.other + i.ptAnnual;
  const taxable = Math.max(0, i.annualGross - exemptions);
  let tax = slabTax(taxable, TDS.oldRegime.slabs);
  if (taxable <= TDS.oldRegime.rebateLimit) tax = Math.max(0, tax - TDS.oldRegime.rebateMax);
  const cess = (tax * TDS.cess) / 100;
  return { taxable, tax, cess, total: r0(tax + cess), exemptions };
}

// ──────────────────────────────── payslip for a month ────────────────────────
export interface PayslipInput {
  employee: Employee;
  structure: SalaryStructure;
  location: Location;
  attendance?: AttendanceSummary;
  adjustments: Adjustment[];
  loans: Loan[];
  overtimeRule?: OvertimeRule;
  shiftHours: number;
  month: Month;
  runId: string;
}

export function computePayslip(inp: PayslipInput): Payslip {
  const { employee: e, structure, location, month } = inp;
  const asOn = monthEnd(month);
  const days = daysInMonth(month);
  const lop = inp.attendance?.lopDays ?? 0;
  const paidDays = Math.max(0, days - lop);
  const factor = days ? paidDays / days : 1;
  const warnings: string[] = [];

  const breakup = buildBreakup(structure, e.annualCtc ?? 0, { asOn, pfMember: e.pfMember, pfOnActual: e.pfOnActualWage, overrides: e.structureOverrides });
  warnings.push(...breakup.warnings.filter((w) => !w.startsWith('Wages are')));

  const earnings: PayslipLine[] = [];
  for (const l of breakup.lines.filter((x) => x.kind === 'earning')) {
    const amt = r0(l.prorate ? l.monthly * factor : l.monthly);
    if (amt) earnings.push({ code: l.code, name: l.name, amount: amt, taxable: l.taxable });
  }
  const reimbursements: PayslipLine[] = breakup.lines.filter((x) => x.kind === 'reimbursement' && x.monthly)
    .map((l) => ({ code: l.code, name: l.name, amount: r0(l.prorate ? l.monthly * factor : l.monthly) }));

  // Overtime (Labour Codes: not less than 2x the ordinary rate).
  const otHours = inp.attendance?.overtimeHours ?? 0;
  const rule = inp.overtimeRule;
  const otEligible = !!rule && rule.appliesTo.includes(e.employmentType) && otHours * 60 >= rule.minMinutes;
  if (otHours > 0 && otEligible && rule) {
    const divisor = rule.rateDivisor === 'calendar' ? days : rule.rateDivisor;
    const ordinaryHourly = breakup.wageTest.codeWages / (divisor * inp.shiftHours);
    const otPay = r0(otHours * ordinaryHourly * rule.rateMultiplier);
    earnings.push({ code: 'OT', name: `Overtime (${otHours}h at ${rule.rateMultiplier}x)`, amount: otPay, taxable: true });
    if (otHours > 48) warnings.push(`${otHours} overtime hours this month. The quarterly cap is ${rule.quarterlyCapHours} hours.`);
  } else if (otHours > 0 && !otEligible) {
    warnings.push(`${otHours} overtime hours were logged but no overtime rule applies to this employee.`);
  }

  // One-time adjustments.
  const oneTimeTaxable: number[] = [];
  for (const a of inp.adjustments.filter((x) => x.employeeId === e.id && x.month === month)) {
    const label = a.note ? `${labelOf(a.kind)} (${a.note})` : labelOf(a.kind);
    if (a.kind === 'arrear' || a.kind === 'bonus' || a.kind === 'incentive') {
      earnings.push({ code: a.kind.toUpperCase(), name: label, amount: r0(a.amount), taxable: a.taxable });
      if (a.taxable) oneTimeTaxable.push(a.amount);
    } else if (a.kind === 'reimbursement') {
      reimbursements.push({ code: 'REIMB', name: label, amount: r0(a.amount) });
    }
  }

  const gross = earnings.reduce((s, l) => s + l.amount, 0);

  // PF
  const codeWagesPaid = breakup.wageTest.codeWages * factor;
  const pfCeiling = valueOn(PF.ceiling, asOn);
  const pfWage = e.pfMember ? r0(e.pfOnActualWage ? codeWagesPaid : Math.min(codeWagesPaid, pfCeiling)) : 0;
  const pfCapped = Math.min(pfWage, pfCeiling);
  const employeePf = r0((pfWage * PF.employeeRate) / 100);
  const eps = r0((pfCapped * PF.epsRate) / 100);
  const employerPfTotal = r0((pfWage * PF.employerRate) / 100);
  const epf = employerPfTotal - eps;
  const edli = r0((pfCapped * PF.edliRate) / 100);
  const pfAdmin = r0((pfCapped * PF.adminRate) / 100);
  if (e.pfMember && (!e.uan || e.uanStatus !== 'aadhaar_seeded')) warnings.push('UAN is missing or not Aadhaar-seeded: the ECR row will be blocked.');

  // ESI
  const esiCeiling = valueOn(ESI.ceiling, asOn);
  const grossForEsi = earnings.filter((l) => l.code !== 'OT').reduce((s, l) => s + l.amount, 0);
  const esiWage = breakup.lines.filter((l) => l.kind === 'earning' && l.esiApplicable).reduce((s, l) => s + (l.prorate ? l.monthly * factor : l.monthly), 0);
  const esiOn = grossForEsi > 0 && grossForEsi <= esiCeiling;
  const employeeEsi = esiOn ? Math.ceil((esiWage * ESI.employeeRate) / 100) : 0;
  const employerEsi = esiOn ? Math.ceil((esiWage * ESI.employerRate) / 100) : 0;
  if (esiOn && !e.esicIp) warnings.push('ESI applies at this gross but the employee has no ESIC number.');

  // PT + LWF
  const pt = e.ptApplicable ? professionalTax(location.state, gross, e.gender, month) : 0;
  const lwf = e.lwfApplicable ? lwfFor(location.state, month) : { employee: 0, employer: 0 };

  // TDS: annualise the regular taxable pay, then add the marginal tax on one-time taxable pay.
  const regularTaxableMonthly = earnings.filter((l) => l.taxable && !['ARREAR', 'BONUS', 'INCENTIVE', 'OT'].includes(l.code)).reduce((s, l) => s + l.amount, 0);
  const metro = e.employmentType === 'daily_wage' ? false : location.metro || isMetroCity(location.city, asOn);
  const hraLine = earnings.find((l) => l.code === 'HRA');
  const baseTax = (annualGross: number) => annualTax({
    regime: e.taxRegime, annualGross, basicAnnual: breakup.basic * 12, hraAnnual: (hraLine?.amount ?? 0) * 12, metro,
    employeePfAnnual: employeePf * 12, ptAnnual: pt * 12, declaration: e.declaration,
  }).total;
  const regularAnnual = regularTaxableMonthly * 12;
  const oneTime = oneTimeTaxable.reduce((s, n) => s + n, 0) + (earnings.find((l) => l.code === 'OT')?.amount ?? 0);
  const tdsRegular = baseTax(regularAnnual) / 12;
  const tdsOneTime = oneTime > 0 ? baseTax(regularAnnual + oneTime) - baseTax(regularAnnual) : 0;
  const tds = Math.max(0, r0(tdsRegular + tdsOneTime));
  if (!e.pan) warnings.push('No PAN on file: TDS must be deducted at the higher rate (section 206AA equivalent).');

  // Loans and one-time deductions
  const deductions: PayslipLine[] = [];
  if (employeePf) deductions.push({ code: 'PF', name: 'Provident Fund (employee)', amount: employeePf });
  if (employeeEsi) deductions.push({ code: 'ESI', name: 'ESI (employee)', amount: employeeEsi });
  if (pt) deductions.push({ code: 'PT', name: `Professional Tax (${location.state})`, amount: pt });
  if (lwf.employee) deductions.push({ code: 'LWF', name: 'Labour Welfare Fund (employee)', amount: lwf.employee });
  if (tds) deductions.push({ code: 'TDS', name: 'Income tax (TDS)', amount: tds });
  for (const l of inp.loans.filter((x) => x.employeeId === e.id && x.startMonth <= month && x.recovered < x.principal)) {
    const emi = Math.min(l.emi, l.principal - l.recovered);
    if (emi > 0) deductions.push({ code: 'LOAN', name: l.kind === 'advance' ? 'Advance recovery' : 'Loan EMI', amount: r0(emi) });
  }
  for (const a of inp.adjustments.filter((x) => x.employeeId === e.id && x.month === month && (x.kind === 'one_time_deduction' || x.kind === 'loan_emi' || x.kind === 'advance_recovery'))) {
    deductions.push({ code: 'DED', name: a.note ? `${labelOf(a.kind)} (${a.note})` : labelOf(a.kind), amount: r0(a.amount) });
  }

  const employer: PayslipLine[] = [];
  if (epf) employer.push({ code: 'EPF_ER', name: 'EPF (employer)', amount: epf });
  if (eps) employer.push({ code: 'EPS_ER', name: 'EPS (employer)', amount: eps });
  if (edli) employer.push({ code: 'EDLI', name: 'EDLI (employer)', amount: edli });
  if (pfAdmin) employer.push({ code: 'PF_ADM', name: 'PF admin charges', amount: pfAdmin });
  if (employerEsi) employer.push({ code: 'ESI_ER', name: 'ESI (employer)', amount: employerEsi });
  if (lwf.employer) employer.push({ code: 'LWF_ER', name: 'LWF (employer)', amount: lwf.employer });
  const gratuityLine = breakup.lines.find((l) => l.code === 'GRATUITY');
  if (gratuityLine?.monthly) employer.push({ code: 'GRAT', name: 'Gratuity provision', amount: r0(gratuityLine.monthly * factor) });

  const totalDeductions = deductions.reduce((s, l) => s + l.amount, 0);
  const reimbTotal = reimbursements.reduce((s, l) => s + l.amount, 0);
  const net = gross + reimbTotal - totalDeductions;
  if (net < 0) warnings.push(`Net pay is negative (${r0(net)}). Deductions exceed earnings.`);
  if (e.payMode === 'bank' && !e.bank) warnings.push('No bank account on file: this payslip cannot be paid by bank transfer.');

  const mw = minWageFor(location.state);
  if (mw && e.employmentType !== 'intern' && breakup.wageTest.codeWages < mw * 0.5 && gross < mw) warnings.push(`Gross is below the sample minimum wage of ${mw} for ${location.state}.`);

  return {
    id: uid('slip'), runId: inp.runId, employeeId: e.id, month, daysInMonth: days, paidDays, lopDays: lop, overtimeHours: otHours,
    earnings, deductions, employer, reimbursements,
    gross, totalDeductions, net, employerCost: gross + reimbTotal + employer.reduce((s, l) => s + l.amount, 0),
    wages: { codeWages: r0(codeWagesPaid), pfWage, esiWage: r0(esiWage), ptBase: gross, taxableMonthly: r0(regularTaxableMonthly) },
    warnings,
  };
}

function labelOf(k: Adjustment['kind']): string {
  return ({ arrear: 'Arrears', bonus: 'Bonus', incentive: 'Incentive', reimbursement: 'Reimbursement', one_time_deduction: 'Deduction', loan_emi: 'Loan EMI', advance_recovery: 'Advance recovery' } as const)[k];
}

// ──────────────────────────────── pay run + checks ───────────────────────────
export function employeesForRun(db: HrmsDb, month: Month, entityId: string): Employee[] {
  const start = monthStart(month);
  const end = monthEnd(month);
  return db.employees.filter((e) =>
    e.entityId === entityId && e.status !== 'onboarding' && e.joinDate <= end && (!e.lastWorkingDate || e.lastWorkingDate >= start));
}

export function attendanceFor(db: HrmsDb, employeeId: string, month: Month): AttendanceSummary | undefined {
  return db.attendance.find((a) => a.employeeId === employeeId && a.month === month);
}

export function computePayRunPayslips(db: HrmsDb, month: Month, entityId: string, runId: string): Payslip[] {
  const out: Payslip[] = [];
  for (const e of employeesForRun(db, month, entityId)) {
    const structure = db.structures.find((s) => s.id === e.structureId);
    const location = db.locations.find((l) => l.id === e.locationId);
    if (!structure || !e.annualCtc || !location) continue;
    const shift = db.shifts.find((s) => s.id === e.shiftId);
    out.push(computePayslip({
      employee: e, structure, location, attendance: attendanceFor(db, e.id, month),
      adjustments: db.adjustments, loans: db.loans,
      overtimeRule: db.overtimeRules[0], shiftHours: shift?.fullDayHours ?? 8, month, runId,
    }));
  }
  return out;
}

export type CheckSeverity = 'blocker' | 'warning' | 'info';
export interface PreRunCheck { id: string; severity: CheckSeverity; title: string; detail: string; employeeId?: string; fixHref?: string }

export function preRunChecks(db: HrmsDb, month: Month, entityId: string): PreRunCheck[] {
  const checks: PreRunCheck[] = [];
  const emps = employeesForRun(db, month, entityId);
  const entity = db.entities.find((x) => x.id === entityId);
  const add = (c: Omit<PreRunCheck, 'id'>) => checks.push({ ...c, id: `${c.title}:${c.employeeId ?? 'all'}` });

  for (const e of emps) {
    const name = fullName(e);
    if (!e.structureId || !e.annualCtc) add({ severity: 'blocker', title: 'No salary structure', detail: `${name} has no structure or CTC, so no payslip is generated.`, employeeId: e.id, fixHref: `/dashboard/hrms/employees/${e.id}?tab=salary` });
    if (e.payMode === 'bank' && !e.bank) add({ severity: 'blocker', title: 'No bank account', detail: `${name} is paid by bank transfer but has no account on file.`, employeeId: e.id, fixHref: `/dashboard/hrms/employees/${e.id}?tab=statutory` });
    if (!e.pan) add({ severity: 'warning', title: 'No PAN', detail: `${name}: TDS goes at the higher rate without a PAN.`, employeeId: e.id, fixHref: `/dashboard/hrms/employees/${e.id}?tab=statutory` });
    if (e.pfMember && e.uanStatus !== 'aadhaar_seeded') add({ severity: 'warning', title: 'UAN not Aadhaar-seeded', detail: `${name}: the ECR row is blocked until the UAN is seeded.`, employeeId: e.id, fixHref: `/dashboard/hrms/employees/${e.id}?tab=statutory` });
    const att = attendanceFor(db, e.id, month);
    if (!att) add({ severity: 'warning', title: 'No attendance summary', detail: `${name}: no attendance for ${month}; the run assumes a full month.`, employeeId: e.id });
    else if (!att.locked) add({ severity: 'warning', title: 'Attendance not locked', detail: `${name}: attendance for ${month} is still open for regularisation.`, employeeId: e.id });
    const structure = db.structures.find((s) => s.id === e.structureId);
    if (structure && e.annualCtc) {
      const b = buildBreakup(structure, e.annualCtc, { asOn: monthEnd(month), pfMember: e.pfMember, pfOnActual: e.pfOnActualWage, overrides: e.structureOverrides });
      if (!b.wageTest.passes) add({ severity: 'info', title: '50% wage rule add-back', detail: `${name}: ${r0(b.wageTest.addBack)} a month is added back to wages (PF, gratuity and bonus rise).`, employeeId: e.id });
    }
  }
  if (!entity?.registrations.some((r) => r.type === 'pf')) add({ severity: 'warning', title: 'No PF registration', detail: `${entity?.name ?? 'The entity'} has no PF establishment code, so the ECR cannot be generated.`, fixHref: '/dashboard/hrms/organization' });
  const unpaidOld = db.payRuns.filter((r) => r.entityId === entityId && r.month < month && r.status !== 'paid' && r.type === 'regular');
  for (const r of unpaidOld) add({ severity: 'warning', title: 'Earlier run not closed', detail: `The ${r.month} run is still ${r.status}.` });
  return checks;
}

// ───────────────────────────────── full and final ─────────────────────────────
export interface FnfResult {
  lines: { label: string; amount: number; kind: 'payment' | 'recovery'; note?: string }[];
  payable: number;
  recoverable: number;
  net: number;
  tds: number;
  gratuity: { eligible: boolean; years: number; amount: number; reason: string };
  dueBy: ISODate;
}

/** Counts working days (Mon-Sat) after a date; used for the two-working-day settlement clock. */
export function addWorkingDays(from: ISODate, n: number): ISODate {
  let d = from;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) left -= 1; // Sundays do not count
  }
  return d;
}

export function computeFnf(db: HrmsDb, c: FnfCase): FnfResult | null {
  const e = db.employees.find((x) => x.id === c.employeeId);
  const structure = db.structures.find((s) => s.id === e?.structureId);
  const location = db.locations.find((l) => l.id === e?.locationId);
  if (!e || !structure || !location || !e.annualCtc) return null;
  const lwd = c.lastWorkingDate;
  const month = lwd.slice(0, 7);
  const asOn = lwd;
  const breakup = buildBreakup(structure, e.annualCtc, { asOn, pfMember: e.pfMember, pfOnActual: e.pfOnActualWage, overrides: e.structureOverrides });
  const days = daysInMonth(month);
  const worked = Number(lwd.slice(8, 10));
  const lines: FnfResult['lines'] = [];

  const pending = r0((breakup.monthlyGross * worked) / days);
  lines.push({ label: `Salary for ${worked} days of ${month}`, amount: pending, kind: 'payment' });

  const wagesDaily = breakup.wageTest.codeWages / 30;
  if (c.leaveEncashDays > 0) lines.push({ label: `Leave encashment (${c.leaveEncashDays} days)`, amount: r0(wagesDaily * c.leaveEncashDays), kind: 'payment', note: 'Wages divided by 30' });

  const t = tenure(e.joinDate, lwd);
  const needYears = e.employmentType === 'fixed_term' ? LABOUR_CODES.gratuity.fixedTermYears : LABOUR_CODES.gratuity.permanentYears;
  const eligible = (e.employmentType === 'permanent' || e.employmentType === 'fixed_term') && t.totalMonths >= needYears * 12;
  const gYears = t.years + (t.months >= 6 ? 1 : 0);
  const gAmount = eligible ? Math.min(LABOUR_CODES.gratuity.cap, r0((15 / 26) * breakup.wageTest.codeWages * gYears)) : 0;
  const reason = eligible ? `${t.years}y ${t.months}m of service, rounded to ${gYears} years` : `Needs ${needYears} years of service (has ${t.years}y ${t.months}m) or a permanent or fixed-term contract`;
  if (gAmount) lines.push({ label: 'Gratuity', amount: gAmount, kind: 'payment', note: '15/26 × wages × years, exempt up to the cap' });

  if (c.otherPayments) lines.push({ label: 'Other payments', amount: c.otherPayments, kind: 'payment' });

  const shortfall = Math.max(0, e.noticeDays - c.noticeDaysServed);
  if (shortfall > 0) lines.push({ label: `Notice shortfall recovery (${shortfall} days)`, amount: r0((breakup.monthlyGross / 30) * shortfall), kind: 'recovery' });
  for (const l of db.loans.filter((x) => x.employeeId === e.id && x.recovered < x.principal)) lines.push({ label: l.kind === 'advance' ? 'Advance outstanding' : 'Loan outstanding', amount: l.principal - l.recovered, kind: 'recovery' });
  if (c.otherRecoveries) lines.push({ label: 'Other recoveries', amount: c.otherRecoveries, kind: 'recovery' });

  const payable = lines.filter((l) => l.kind === 'payment').reduce((s, l) => s + l.amount, 0);
  const recoverable = lines.filter((l) => l.kind === 'recovery').reduce((s, l) => s + l.amount, 0);

  // TDS on the taxable part (salary and leave encashment; gratuity is exempt up to the cap).
  const taxablePart = pending + (lines.find((l) => l.label.startsWith('Leave encashment'))?.amount ?? 0);
  const regularAnnual = breakup.lines.filter((l) => l.kind === 'earning' && l.taxable).reduce((s, l) => s + l.monthly, 0) * 12;
  const base = (g: number) => annualTax({ regime: e.taxRegime, annualGross: g, basicAnnual: breakup.basic * 12, hraAnnual: (breakup.lines.find((l) => l.code === 'HRA')?.monthly ?? 0) * 12, metro: location.metro, employeePfAnnual: 0, ptAnnual: 0, declaration: e.declaration }).total;
  const tds = Math.max(0, r0(base(regularAnnual + taxablePart) - base(regularAnnual)));
  if (tds) lines.push({ label: 'Income tax (TDS)', amount: tds, kind: 'recovery' });

  return {
    lines, payable, recoverable: recoverable + tds, net: payable - recoverable - tds, tds,
    gratuity: { eligible, years: gYears, amount: gAmount, reason },
    dueBy: addWorkingDays(lwd, LABOUR_CODES.settlementWorkingDays),
  };
}

// ───────────────────────────── statutory file builders ────────────────────────
/** EPFO ECR text file (version 2 layout, "#~#" separated). Rows with a missing or unseeded UAN are returned separately. */
export function buildEcr(db: HrmsDb, run: PayRun): { text: string; rows: number; blocked: { employeeId: string; reason: string }[] } {
  const lines: string[] = [];
  const blocked: { employeeId: string; reason: string }[] = [];
  const ceiling = valueOn(PF.ceiling, monthEnd(run.month));
  for (const s of run.payslips) {
    const e = db.employees.find((x) => x.id === s.employeeId);
    if (!e || !e.pfMember) continue;
    if (!e.uan) { blocked.push({ employeeId: e.id, reason: 'No UAN' }); continue; }
    if (e.uanStatus !== 'aadhaar_seeded') { blocked.push({ employeeId: e.id, reason: 'UAN not Aadhaar-seeded' }); continue; }
    const pf = s.deductions.find((d) => d.code === 'PF')?.amount ?? 0;
    const eps = s.employer.find((d) => d.code === 'EPS_ER')?.amount ?? 0;
    const epfDiff = s.employer.find((d) => d.code === 'EPF_ER')?.amount ?? 0;
    const epfWage = s.wages.pfWage;
    const epsWage = Math.min(epfWage, ceiling);
    lines.push([e.uan, fullName(e).toUpperCase(), s.gross, epfWage, epsWage, epsWage, pf, eps, epfDiff, s.lopDays, 0].join('#~#'));
  }
  return { text: lines.join('\n'), rows: lines.length, blocked };
}

/** NEFT-style bank advice CSV for a frozen run. */
/** `masked` lists the people left out only because their account number is masked (live data), so a screen can refuse the whole file. */
export function buildBankFile(db: HrmsDb, run: PayRun): { header: string[]; rows: string[][]; skipped: { employeeId: string; reason: string }[]; masked: string[] } {
  const header = ['Employee code', 'Name', 'Account number', 'IFSC', 'Bank', 'Amount', 'Narration'];
  const rows: string[][] = [];
  const skipped: { employeeId: string; reason: string }[] = [];
  const masked: string[] = [];
  for (const s of run.payslips) {
    const e = db.employees.find((x) => x.id === s.employeeId);
    if (!e) continue;
    if (e.payMode !== 'bank') { skipped.push({ employeeId: e.id, reason: `Paid by ${e.payMode}` }); continue; }
    if (!e.bank) { skipped.push({ employeeId: e.id, reason: 'No bank account' }); continue; }
    if (s.net <= 0) { skipped.push({ employeeId: e.id, reason: 'Net pay is zero or negative' }); continue; }
    // Live data keeps account numbers masked in the browser; a bank file with a mask in it would pay no one.
    if (looksMaskedAccount(e.bank.accountNumber)) { skipped.push({ employeeId: e.id, reason: 'Account number is masked (live data): the full number is not held in this browser' }); masked.push(e.id); continue; }
    rows.push([e.code, e.bank.accountHolder, e.bank.accountNumber, e.bank.ifsc, e.bank.bankName, String(r0(s.net)), `Salary ${run.month}`]);
  }
  return { header, rows, skipped, masked };
}

export function runTotals(run: PayRun) {
  const sum = (f: (s: Payslip) => number) => run.payslips.reduce((t, s) => t + f(s), 0);
  const code = (lines: PayslipLine[], c: string) => lines.find((l) => l.code === c)?.amount ?? 0;
  return {
    headcount: run.payslips.length,
    gross: sum((s) => s.gross),
    net: sum((s) => s.net),
    deductions: sum((s) => s.totalDeductions),
    employerCost: sum((s) => s.employerCost),
    pfEmployee: sum((s) => code(s.deductions, 'PF')),
    pfEmployer: sum((s) => s.employer.filter((l) => ['EPF_ER', 'EPS_ER'].includes(l.code)).reduce((t, l) => t + l.amount, 0)),
    esi: sum((s) => code(s.deductions, 'ESI') + code(s.employer, 'ESI_ER')),
    pt: sum((s) => code(s.deductions, 'PT')),
    tds: sum((s) => code(s.deductions, 'TDS')),
    warnings: sum((s) => s.warnings.length),
  };
}
