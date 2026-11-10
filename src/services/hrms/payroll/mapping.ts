import type {
  Adjustment, AttendanceSummary, Employee, FnfCase, HrmsDb, Loan, Location, OvertimeRule, PayRun, Payslip, SalaryStructure, TaxDeclaration,
} from './engine';
import type { Row } from './common';

// Rows <-> the engine's model <-> the wire. Pure functions, no database access.
//
// Numeric columns: PostgREST sends numeric as a JSON number, but a driver or double may hand back a string ("1500.00"), so every number
// that reaches the engine or leaves on the wire goes through num(). Nothing here rounds: the engine rounds, the database stores.

export const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ── the engine's view of the people ─────────────────────────────────────────
/** The employee columns payroll reads. No PAN or bank number is selected in the clear: only whether a ciphertext exists. */
export const EMPLOYEE_COLUMNS = [
  'id', 'code', 'first_name', 'last_name', 'gender', 'entity_id', 'location_id', 'employment_type', 'status', 'join_date', 'last_working_date',
  'shift_id', 'notice_days', 'tax_regime', 'declaration', 'pf_member', 'pf_on_actual_wage', 'uan', 'uan_status', 'esic_ip', 'pt_applicable',
  'lwf_applicable', 'pay_mode', 'structure_id', 'annual_ctc', 'structure_overrides', 'pan_enc', 'bank_enc',
].join(',');

/**
 * Payroll never needs a PAN or an account number, only whether one is on file (the engine warns "No PAN on file" and refuses a bank
 * payment with no account). These stand-ins say "there is one" without decrypting anything; the bank file reads the real bank separately.
 */
const PAN_ON_FILE = 'ON-FILE';
const BANK_ON_FILE = { accountHolder: '', accountNumber: '', ifsc: '', bankName: '', accountType: 'savings' } as const;

const EMPTY_DECLARATION: TaxDeclaration = { sec80C: 0, sec80D: 0, nps80CCD1B: 0, homeLoanInterest: 0, rentPaidAnnual: 0, other: 0, status: 'not_submitted' };

/**
 * A stored declaration may lack keys (a partial update replaces the whole jsonb). The old-regime maths would turn a missing number into NaN,
 * so absent amounts are read as 0 here, exactly what the dashboard's always-complete declaration holds.
 */
export function declarationOf(raw: unknown): TaxDeclaration {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...EMPTY_DECLARATION, ...d };
  for (const k of ['sec80C', 'sec80D', 'nps80CCD1B', 'homeLoanInterest', 'rentPaidAnnual', 'other'] as const) out[k] = Number.isFinite(Number(out[k])) ? Number(out[k]) : 0;
  return out as unknown as TaxDeclaration;
}

export function toEngineEmployee(r: Row): Employee {
  const opt = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : (v as string));
  return {
    id: String(r.id), code: String(r.code ?? ''), firstName: String(r.first_name ?? ''), lastName: String(r.last_name ?? ''),
    email: '', mobile: '', gender: r.gender, dob: '', address: {},
    entityId: String(r.entity_id), locationId: String(r.location_id), departmentId: '', designationId: '',
    employmentType: r.employment_type, status: r.status, joinDate: String(r.join_date),
    probationMonths: 0, noticeDays: num(r.notice_days),
    lastWorkingDate: opt(r.last_working_date), shiftId: opt(r.shift_id),
    pan: r.pan_enc ? PAN_ON_FILE : undefined,
    uan: opt(r.uan), uanStatus: r.uan_status ?? 'none', pfMember: !!r.pf_member, pfOnActualWage: !!r.pf_on_actual_wage, esicIp: opt(r.esic_ip),
    ptApplicable: !!r.pt_applicable, lwfApplicable: !!r.lwf_applicable, taxRegime: r.tax_regime ?? 'new', declaration: declarationOf(r.declaration),
    bank: r.bank_enc ? { ...BANK_ON_FILE } : undefined, payMode: r.pay_mode ?? 'bank',
    structureId: opt(r.structure_id), annualCtc: r.annual_ctc === null || r.annual_ctc === undefined ? undefined : Number(r.annual_ctc),
    structureOverrides: r.structure_overrides && typeof r.structure_overrides === 'object' ? (r.structure_overrides as Record<string, number>) : undefined,
    documents: [], history: [],
  } as Employee;
}

export const toEngineLocation = (r: Row): Location => ({
  id: String(r.id), name: String(r.name ?? ''), entityId: String(r.entity_id), state: String(r.state ?? ''), city: String(r.city ?? ''), metro: !!r.metro,
});

export const toEngineStructure = (r: Row): SalaryStructure => ({
  id: String(r.id), name: String(r.name ?? ''), description: r.description ?? undefined, effectiveFrom: String(r.effective_from),
  components: Array.isArray(r.components) ? (r.components as SalaryStructure['components']) : [],
});

export const toEngineAttendance = (r: Row): AttendanceSummary => ({
  employeeId: String(r.employee_id), month: String(r.month), daysInMonth: num(r.days_in_month), presentDays: num(r.present_days),
  paidLeaveDays: num(r.paid_leave_days), weeklyOffs: num(r.weekly_offs), holidays: num(r.holidays), lopDays: num(r.lop_days),
  overtimeHours: num(r.overtime_hours), locked: !!r.locked,
});

export const toEngineAdjustment = (r: Row): Adjustment => ({
  id: String(r.id), employeeId: String(r.employee_id), month: String(r.month), kind: r.kind, amount: num(r.amount), taxable: !!r.taxable,
  note: r.note ?? undefined,
});

export const toEngineLoan = (r: Row): Loan => ({
  id: String(r.id), employeeId: String(r.employee_id), kind: r.kind, principal: num(r.principal), emi: num(r.emi), startMonth: String(r.start_month),
  recovered: num(r.recovered), note: r.note ?? undefined,
});

export const toEngineFnf = (r: Row): FnfCase => ({
  id: String(r.id), employeeId: String(r.employee_id), lastWorkingDate: String(r.last_working_date), resignationDate: iso(r.resignation_date) ?? undefined,
  noticeDaysServed: num(r.notice_days_served), leaveEncashDays: num(r.leave_encash_days), otherRecoveries: num(r.other_recoveries),
  otherPayments: num(r.other_payments), status: r.status, dueBy: String(r.due_by),
});

/** The dashboard's seed overtime rule (ot_std): what an org gets until it saves its own. */
export const DEFAULT_OVERTIME_RULE: OvertimeRule = {
  id: 'ot_std', name: 'Standard overtime', rateMultiplier: 2, quarterlyCapHours: 144, requiresConsent: true, minMinutes: 30, rateDivisor: 26,
  womenNightConsent: true, appliesTo: ['permanent', 'contract', 'daily_wage', 'fixed_term'],
};

/** An HrmsDb with every collection empty: payroll fills only what the engine reads (and no shifts: the server uses 8 hour days). */
export function emptyDb(): HrmsDb {
  return {
    version: 1, company: { name: '', currency: 'INR', fyStartMonth: 4 },
    entities: [], locations: [], departments: [], designations: [], employees: [], shifts: [], roster: [], overtimeRules: [], leaveTypes: [],
    holidayLists: [], leaveBalances: [], attendance: [], structures: [], adjustments: [], loans: [], payRuns: [], fnfCases: [], onboarding: [],
    exits: [], letterTemplates: [], letters: [], compliance: [], consents: [], accessLog: [], retention: [],
  };
}

// ── the wire ────────────────────────────────────────────────────────────────
// Every row has id, created_at, updated_at; tenant columns never leave. Numbers are JSON numbers.

export const structureOut = (r: Row): Row => ({
  id: r.id, name: r.name, description: r.description ?? null, effective_from: iso(r.effective_from),
  components: Array.isArray(r.components) ? r.components : [], created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

export const attendanceOut = (r: Row): Row => ({
  id: r.id, employee_id: r.employee_id, month: r.month, days_in_month: num(r.days_in_month), present_days: num(r.present_days),
  paid_leave_days: num(r.paid_leave_days), weekly_offs: num(r.weekly_offs), holidays: num(r.holidays), lop_days: num(r.lop_days),
  overtime_hours: num(r.overtime_hours), locked: !!r.locked, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

export const adjustmentOut = (r: Row): Row => ({
  id: r.id, employee_id: r.employee_id, month: r.month, kind: r.kind, amount: num(r.amount), taxable: !!r.taxable, note: r.note ?? null,
  source: r.source ?? null, created_by: r.created_by ?? null, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

export const loanOut = (r: Row): Row => ({
  id: r.id, employee_id: r.employee_id, kind: r.kind, principal: num(r.principal), emi: num(r.emi), start_month: r.start_month,
  recovered: num(r.recovered), note: r.note ?? null, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

export const fnfOut = (r: Row): Row => ({
  id: r.id, employee_id: r.employee_id, last_working_date: iso(r.last_working_date), resignation_date: iso(r.resignation_date),
  notice_days_served: num(r.notice_days_served), leave_encash_days: num(r.leave_encash_days), other_recoveries: num(r.other_recoveries),
  other_payments: num(r.other_payments), status: r.status, due_by: iso(r.due_by), created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

// jsonb does not keep an object's key order (it sorts keys by length), so the lines and the wages are rebuilt in the order the dashboard's
// engine writes them: the response is then identical, key for key, to what the engine returned when the payslip was computed.
const line = (l: Row) => ({ code: String(l.code), name: String(l.name), amount: num(l.amount), ...(l.taxable === undefined ? {} : { taxable: !!l.taxable }) });
const lines = (v: unknown) => (Array.isArray(v) ? v.map(line) : []);
const WAGE_KEYS = ['codeWages', 'pfWage', 'esiWage', 'ptBase', 'taxableMonthly'] as const;
const wagesOf = (v: unknown): Payslip['wages'] => {
  const w = (v && typeof v === 'object' ? v : {}) as Row;
  return Object.fromEntries(WAGE_KEYS.map((k) => [k, num(w[k])])) as Payslip['wages'];
};

/** A payslip exactly as the dashboard's Payslip type has it (camelCase), so the UI uses it unchanged. */
export const payslipOut = (r: Row): Payslip => ({
  id: String(r.id), runId: String(r.run_id), employeeId: String(r.employee_id), month: String(r.month), daysInMonth: num(r.days_in_month),
  paidDays: num(r.paid_days), lopDays: num(r.lop_days), overtimeHours: num(r.overtime_hours),
  earnings: lines(r.earnings), deductions: lines(r.deductions), employer: lines(r.employer), reimbursements: lines(r.reimbursements),
  gross: num(r.gross), totalDeductions: num(r.total_deductions), net: num(r.net), employerCost: num(r.employer_cost),
  wages: wagesOf(r.wages), warnings: Array.isArray(r.warnings) ? r.warnings.map(String) : [],
});

/** The columns of hrms_payslips the compute stores, from the engine's payslip (snake_case; the database fills id and the stamps). */
export function payslipRow(p: Payslip, position: number): Row {
  return {
    employee_id: p.employeeId, position, days_in_month: p.daysInMonth, paid_days: p.paidDays, lop_days: p.lopDays, overtime_hours: p.overtimeHours,
    earnings: p.earnings, deductions: p.deductions, employer: p.employer, reimbursements: p.reimbursements,
    gross: p.gross, total_deductions: p.totalDeductions, net: p.net, employer_cost: p.employerCost, wages: p.wages, warnings: p.warnings,
  };
}

export interface AuditRow { at: string; by: string; action: string }

export interface RunView {
  id: string; entity_id: string; month: string; type: PayRun['type']; status: PayRun['status']; law_version: string | null;
  created_at: string | null; computed_at: string | null; frozen_at: string | null; frozen_by: string | null; paid_at: string | null;
  loan_recoveries: Record<string, number>; attendance_locked_for: string[]; audit: AuditRow[]; stale: boolean; payslips: Payslip[];
  updated_at: string | null; payslip_count?: number;
}

const recoveries = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, amt] of Object.entries(v as Record<string, unknown>)) out[k] = num(amt);
  return out;
};

/** A run as the wire has it. `payslips` is [] for a list; `payslip_count` is added by the caller when it knows it. */
export function runOut(r: Row, audit: Row[], payslips: Payslip[], stale: boolean): RunView {
  return {
    id: String(r.id), entity_id: String(r.entity_id), month: String(r.month), type: r.type, status: r.status, law_version: r.law_version ?? null,
    created_at: iso(r.created_at), computed_at: iso(r.computed_at), frozen_at: iso(r.frozen_at), frozen_by: r.frozen_by ?? null, paid_at: iso(r.paid_at),
    loan_recoveries: recoveries(r.loan_recoveries), attendance_locked_for: Array.isArray(r.attendance_locked_for) ? r.attendance_locked_for.map(String) : [],
    audit: audit.map((a) => ({ at: String(iso(a.at)), by: String(a.by_name), action: String(a.action) })), stale, payslips, updated_at: iso(r.updated_at),
  };
}
