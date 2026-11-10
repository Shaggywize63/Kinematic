// PORT of kinematic-dashboard src/lib/hrms/types.ts (the payroll oracle). Exact parity is the requirement: do NOT "improve" the maths here.
// Change the dashboard file first, regenerate tests/fixtures/hrms-payroll-golden.json, and port the change; tests/hrmsPayrollParity.test.ts
// reproduces every golden case. Only imports (and the masking helper's location) differ from the original.

// HRMS data model (frontend-first preview).
// Everything here is the contract the pages are built against. When the backend lands, the same shapes become
// the REST payloads (snake_case mapping happens in one place, the api layer), so keep these free of UI concerns.

export type ISODate = string;   // YYYY-MM-DD
export type Month = string;     // YYYY-MM
export type Id = string;

// ─────────────────────────────── organisation ───────────────────────────────
export type RegistrationType = 'pf' | 'esi' | 'pt' | 'lwf' | 'shops' | 'clra' | 'tan' | 'gst';

export interface Registration {
  id: Id;
  type: RegistrationType;
  state?: string;            // state name from INDIAN_STATES (PT / LWF / Shops are per state)
  number: string;
  validFrom?: ISODate;
  validTo?: ISODate;
  notes?: string;
}

export interface LegalEntity {
  id: Id;
  name: string;
  pan: string;
  tan: string;
  cin?: string;
  gstin?: string;
  address: Address;
  registrations: Registration[];
  signatory?: { name: string; designation: string };
}

export interface Address { line1?: string; line2?: string; city?: string; state?: string; pincode?: string }

export interface Location {
  id: Id;
  name: string;
  entityId: Id;
  state: string;
  city: string;
  address?: string;
  metro: boolean;            // HRA metro rate (50%) — dated list in rules.ts decides the default
  holidayListId?: Id;
}

export interface Department { id: Id; name: string; headId?: Id }
export interface Designation { id: Id; name: string; grade?: string }

// ───────────────────────────────── employee ─────────────────────────────────
export type EmploymentType = 'permanent' | 'fixed_term' | 'contract' | 'intern' | 'daily_wage';
export type EmployeeStatus = 'onboarding' | 'active' | 'on_notice' | 'exited';
export type Gender = 'male' | 'female' | 'other';
export type UanStatus = 'none' | 'generated' | 'activated' | 'aadhaar_seeded';
export type TaxRegime = 'new' | 'old';
export type PayMode = 'bank' | 'cash' | 'cheque';

export interface BankDetails {
  accountHolder: string;
  accountNumber: string;
  ifsc: string;
  bankName: string;
  accountType: 'savings' | 'current';
}

export interface TaxDeclaration {
  // Old-regime inputs (annual, rupees). Form 124 in the Income-tax Act 2025 naming (12BB before).
  sec80C: number;
  sec80D: number;
  nps80CCD1B: number;
  homeLoanInterest: number;
  rentPaidAnnual: number;
  landlordPan?: string;
  other: number;
  submittedOn?: ISODate;
  status: 'not_submitted' | 'submitted' | 'verified';
}

export interface EmployeeDocument {
  id: Id;
  type: 'offer_letter' | 'appointment_letter' | 'id_proof' | 'address_proof' | 'pan_card' | 'aadhaar' | 'education' | 'experience' | 'bank_proof' | 'relieving_letter' | 'other';
  name: string;
  uploadedOn: ISODate;
  status: 'pending' | 'uploaded' | 'verified' | 'rejected';
  mandatory?: boolean;
  fileName?: string;
}

export interface ChangeLogEntry {
  id: Id;
  at: string;                // ISO datetime
  by: string;
  field: string;
  from?: string;
  to?: string;
}

export interface Employee {
  id: Id;
  code: string;              // employee ID shown to people, e.g. KIN-0042
  firstName: string;
  lastName: string;
  email: string;
  mobile: string;
  gender: Gender;
  dob: ISODate;
  fatherName?: string;
  maritalStatus?: 'single' | 'married' | 'other';
  bloodGroup?: string;
  address: Address;
  emergencyContact?: { name: string; relation: string; mobile: string };

  // employment
  entityId: Id;
  locationId: Id;
  departmentId: Id;
  designationId: Id;
  reportingToId?: Id;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  joinDate: ISODate;
  confirmationDate?: ISODate;
  probationMonths: number;
  noticeDays: number;
  lastWorkingDate?: ISODate;
  shiftId?: Id;
  costCentre?: string;
  contractEndDate?: ISODate; // fixed-term / contract

  // statutory + bank (DPDP: only the last four digits of Aadhaar are kept)
  pan?: string;
  aadhaarLast4?: string;
  aadhaarVerified?: boolean;
  uan?: string;
  uanStatus: UanStatus;
  pfMember: boolean;
  pfOnActualWage: boolean;   // contribute above the ceiling (higher-wage option)
  pfJoinDate?: ISODate;
  esicIp?: string;
  ptApplicable: boolean;
  lwfApplicable: boolean;
  taxRegime: TaxRegime;
  declaration: TaxDeclaration;
  bank?: BankDetails;
  payMode: PayMode;

  // pay
  structureId?: Id;
  annualCtc?: number;
  structureOverrides?: Record<string, number>; // componentId → monthly fixed override

  documents: EmployeeDocument[];
  history: ChangeLogEntry[];
}

// ─────────────────────────────── time and leave ──────────────────────────────
export interface Shift {
  id: Id;
  name: string;
  start: string;             // HH:mm
  end: string;
  breakMinutes: number;
  graceMinutes: number;
  fullDayHours: number;
  halfDayHours: number;
  isNight: boolean;
  color: string;
}

export type RosterCell = Id | 'off';             // shift id or weekly off
export interface RosterRow { employeeId: Id; weekStart: ISODate; days: RosterCell[] } // Mon..Sun

export interface OvertimeRule {
  id: Id;
  name: string;
  rateMultiplier: number;    // Labour Codes: not less than 2x
  quarterlyCapHours: number; // Labour Codes: 144
  requiresConsent: boolean;
  minMinutes: number;        // ignore overtime below this
  rateDivisor: 26 | 30 | 'calendar';
  womenNightConsent: boolean;
  appliesTo: EmploymentType[];
}

export interface LeaveType {
  id: Id;
  name: string;
  code: string;
  paid: boolean;
  audience: 'all' | 'female' | 'male';
  accrual: { mode: 'none' | 'monthly' | 'yearly' | 'on_joining'; days: number; afterMonths: number };
  carryForward: { allowed: boolean; maxDays: number; expiryMonths: number };
  encashment: { allowed: boolean; maxDays: number; onExit: boolean };
  maxConsecutiveDays?: number;
  documentAfterDays?: number;
  probationEligible: boolean;
  includeWeeklyOffs: boolean;
  description?: string;
}

export interface Holiday { date: ISODate; name: string; optional: boolean }
export interface HolidayList { id: Id; name: string; state: string; year: number; holidays: Holiday[] }

export interface LeaveBalance { employeeId: Id; leaveTypeId: Id; opening: number; accrued: number; taken: number; encashed: number; lapsed: number }

// Per employee per month attendance rollup that payroll consumes (the field attendance module will feed it).
export interface AttendanceSummary {
  employeeId: Id;
  month: Month;
  daysInMonth: number;
  presentDays: number;
  paidLeaveDays: number;
  weeklyOffs: number;
  holidays: number;
  lopDays: number;
  overtimeHours: number;
  locked: boolean;
}

// ──────────────────────────────── payroll ────────────────────────────────────
export type ComponentKind = 'earning' | 'deduction' | 'employer' | 'reimbursement';
export type CalcType = 'fixed' | 'pct_basic' | 'pct_ctc' | 'balance' | 'pf_employer' | 'esi_employer' | 'gratuity_provision';

export interface SalaryComponent {
  id: Id;
  code: string;              // BASIC, HRA, SPECIAL ...
  name: string;
  kind: ComponentKind;
  calc: { type: CalcType; value: number };   // fixed: monthly rupees; pct_*: percent
  isWage: boolean;           // counts as "wages" for the Labour Codes 50% rule (basic, DA, retaining allowance)
  taxable: boolean;
  pfApplicable: boolean;
  esiApplicable: boolean;
  prorate: boolean;          // reduced by loss-of-pay days
  showInPayslip: boolean;
}

export interface SalaryStructure {
  id: Id;
  name: string;
  description?: string;
  effectiveFrom: ISODate;
  components: SalaryComponent[];
}

export type AdjustmentKind = 'arrear' | 'bonus' | 'incentive' | 'reimbursement' | 'one_time_deduction' | 'loan_emi' | 'advance_recovery';
export interface Adjustment {
  id: Id;
  employeeId: Id;
  month: Month;
  kind: AdjustmentKind;
  amount: number;
  taxable: boolean;
  note?: string;
}

export interface Loan {
  id: Id;
  employeeId: Id;
  kind: 'loan' | 'advance';
  principal: number;
  emi: number;
  startMonth: Month;
  recovered: number;
  note?: string;
}

export interface PayslipLine { code: string; name: string; amount: number; taxable?: boolean }

export interface Payslip {
  id: Id;
  runId: Id;
  employeeId: Id;
  month: Month;
  daysInMonth: number;
  paidDays: number;
  lopDays: number;
  overtimeHours: number;
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  employer: PayslipLine[];   // employer contributions, not in net
  reimbursements: PayslipLine[];
  gross: number;
  totalDeductions: number;
  net: number;
  employerCost: number;
  wages: { codeWages: number; pfWage: number; esiWage: number; ptBase: number; taxableMonthly: number };
  warnings: string[];
}

export type PayRunStatus = 'draft' | 'computed' | 'frozen' | 'paid';
export interface PayRun {
  id: Id;
  month: Month;
  entityId: Id;
  type: 'regular' | 'offcycle';
  status: PayRunStatus;
  lawVersion: string;
  createdAt: string;
  computedAt?: string;
  frozenAt?: string;
  frozenBy?: string;
  paidAt?: string;
  payslips: Payslip[];
  audit: { at: string; by: string; action: string }[];
  /** Set when the run is frozen so an unfreeze can undo exactly what the freeze did. */
  loanRecoveries?: Record<string, number>;   // loanId → rupees recovered by this run
  attendanceLockedFor?: Id[];                // employees whose attendance this freeze locked
  /** Live data only: the server's answer to "have the inputs changed since the last compute?". Sample runs leave it unset and work it out in the browser. */
  stale?: boolean;
}

export interface FnfCase {
  id: Id;
  employeeId: Id;
  lastWorkingDate: ISODate;
  resignationDate?: ISODate;
  noticeDaysServed: number;
  leaveEncashDays: number;
  otherRecoveries: number;
  otherPayments: number;
  status: 'draft' | 'approved' | 'paid';
  dueBy: ISODate;           // Code on Wages: within two working days of the last working day
}

// ─────────────────────────────── lifecycle ───────────────────────────────────
export interface ChecklistTask { id: Id; label: string; owner: string; done: boolean; dueOn?: ISODate }
export interface OnboardingCase {
  id: Id;
  employeeId?: Id;
  name: string;
  role: string;
  joinDate: ISODate;
  stage: 'offer' | 'documents' | 'registration' | 'assets' | 'induction' | 'done';
  tasks: ChecklistTask[];
}
export interface ClearanceItem { id: Id; department: string; owner: string; done: boolean; remarks?: string }
export interface ExitCase {
  id: Id;
  employeeId: Id;
  reason: 'resignation' | 'termination' | 'end_of_contract' | 'retirement' | 'absconding';
  resignationDate: ISODate;
  lastWorkingDate: ISODate;
  noticeWaived: boolean;
  stage: 'notice' | 'clearance' | 'settlement' | 'closed';
  clearance: ClearanceItem[];
  assets: { id: Id; name: string; returned: boolean }[];
  interviewDone: boolean;
}
export type LetterType = 'offer' | 'appointment' | 'confirmation' | 'increment' | 'relieving' | 'experience' | 'warning';
export interface LetterTemplate { id: Id; type: LetterType; name: string; body: string }
export interface IssuedLetter { id: Id; employeeId: Id; templateId: Id; type: LetterType; issuedOn: ISODate; body: string; signed: boolean }

// ─────────────────────────────── compliance + DPDP ───────────────────────────
export interface ComplianceTask {
  id: Id;
  name: string;
  law: 'PF' | 'ESI' | 'PT' | 'LWF' | 'TDS' | 'Shops' | 'CLRA' | 'POSH' | 'Gratuity' | 'Bonus';
  dueOn: ISODate;
  entityId: Id;
  state?: string;
  status: 'upcoming' | 'due_soon' | 'filed' | 'overdue';
  filedOn?: ISODate;
  reference?: string;
}

export interface ConsentRecord { id: Id; employeeId: Id; purpose: string; noticeVersion: string; grantedAt: string; withdrawnAt?: string }
export interface AccessLogEntry { id: Id; at: string; byUser: string; employeeId: Id; field: string; reason: string }
export interface RetentionRule { id: Id; dataset: string; keepYears: number; basis: string; action: 'delete' | 'anonymise' }

// ───────────────────────────────── the database ──────────────────────────────
export interface HrmsDb {
  version: number;
  company: { name: string; currency: 'INR'; fyStartMonth: number };
  entities: LegalEntity[];
  locations: Location[];
  departments: Department[];
  designations: Designation[];
  employees: Employee[];
  shifts: Shift[];
  roster: RosterRow[];
  overtimeRules: OvertimeRule[];
  leaveTypes: LeaveType[];
  holidayLists: HolidayList[];
  leaveBalances: LeaveBalance[];
  attendance: AttendanceSummary[];
  structures: SalaryStructure[];
  adjustments: Adjustment[];
  loans: Loan[];
  payRuns: PayRun[];
  fnfCases: FnfCase[];
  onboarding: OnboardingCase[];
  exits: ExitCase[];
  letterTemplates: LetterTemplate[];
  letters: IssuedLetter[];
  compliance: ComplianceTask[];
  consents: ConsentRecord[];
  accessLog: AccessLogEntry[];
  retention: RetentionRule[];
}

export const uid = (prefix = 'id'): Id => `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
