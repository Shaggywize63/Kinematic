// PORT of kinematic-dashboard src/lib/hrms/rules.ts (the payroll oracle). Exact parity is the requirement: do NOT "improve" the maths here.
// Change the dashboard file first, regenerate tests/fixtures/hrms-payroll-golden.json, and port the change; tests/hrmsPayrollParity.test.ts
// reproduces every golden case. Only imports (and the masking helper's location) differ from the original.

// India statutory parameters, effective-dated. Every figure carries a confidence tag because the research behind
// this module (docs: "Kinematic HRMS Blueprint", 5 Nov 2026) relied on law-firm and press summaries, not the gazette.
//   'verified'   — stable for years (e.g. EPF 12%)
//   'reported'   — reported by official or press summaries in 2025-26, to be checked against the notification
//   'indicative' — sample value for the preview; state tables especially change often
// A real payroll run must not go live until every 'reported' and 'indicative' row has been confirmed.

import type { Gender, ISODate, Month } from './types';

export const LAW_VERSION = 'IN-2026.11 (preview)';
export type Confidence = 'verified' | 'reported' | 'indicative';

export interface Dated<T> { from: ISODate; value: T; source: string; confidence: Confidence }

/** The value in force on a date: the last row whose `from` is on or before it. */
export function valueOn<T>(table: Dated<T>[], on: ISODate): T {
  let hit = table[0]!;
  for (const row of table) if (row.from <= on) hit = row;
  return hit.value;
}
export function rowOn<T>(table: Dated<T>[], on: ISODate): Dated<T> {
  let hit = table[0]!;
  for (const row of table) if (row.from <= on) hit = row;
  return hit;
}
/** Last day of a month as ISO date: "2026-11" → "2026-11-30". */
export const monthEnd = (m: Month): ISODate => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y!, mo!, 0)).toISOString().slice(0, 10);
};
export const monthStart = (m: Month): ISODate => `${m}-01`;

// ───────────────────────────────────── PF ─────────────────────────────────────
export const PF = {
  ceiling: [
    { from: '2014-09-01', value: 15000, source: 'EPFO', confidence: 'verified' },
    { from: '2026-09-17', value: 25000, source: 'PIB, S.O. 5109(E) (as reported)', confidence: 'reported' },
  ] as Dated<number>[],
  employeeRate: 12,         // % of PF wage
  employerRate: 12,         // % of PF wage, split below
  epsRate: 8.33,            // % of min(PF wage, ceiling) — carved out of the employer's 12%
  edliRate: 0.5,            // % of min(PF wage, ceiling), employer only
  adminRate: 0.5,           // % of min(PF wage, ceiling), employer only
};

// ───────────────────────────────────── ESI ────────────────────────────────────
export const ESI = {
  ceiling: [
    { from: '2017-01-01', value: 21000, source: 'ESIC (a rise to 30,000 was discussed in Aug 2026, not notified)', confidence: 'reported' },
  ] as Dated<number>[],
  employeeRate: 0.75,
  employerRate: 3.25,
};

// ─────────────────────────────── Labour Codes ──────────────────────────────────
export const LABOUR_CODES = {
  inForceFrom: '2025-11-21',
  minWagePercent: 50,       // wages must be at least this % of total remuneration (the "50% rule")
  overtimeMultiplier: 2,
  overtimeQuarterlyCapHours: 144,
  settlementWorkingDays: 2, // full and final within two working days of the last working day
  gratuity: {
    rate: '15/26',
    cap: 2000000,
    permanentYears: 5,
    fixedTermYears: 1,      // fixed-term employees from 21 Nov 2025 (as reported)
  },
  bonus: {
    eligibilityCeiling: 21000,   // S.O. 4711(E), 25 Aug 2026 (as reported)
    calcCeilingFloor: 7000,
    minPercent: 8.33,
    maxPercent: 20,
  },
};

// ───────────────────────────── professional tax ───────────────────────────────
interface PtSlab { upTo: number; amount: number }
interface PtRule {
  state: string;
  slabs: PtSlab[];                 // by monthly gross; last slab upTo = Infinity
  februaryAmount?: number;         // some states collect the annual balance in February
  womenExemptUpTo?: number;        // Maharashtra: women below this gross pay nothing
  womenSlabs?: PtSlab[];
  confidence: Confidence;
  note?: string;
}
export const PT_RULES: PtRule[] = [
  { state: 'Karnataka', slabs: [{ upTo: 24999, amount: 0 }, { upTo: Infinity, amount: 200 }], februaryAmount: 300, confidence: 'indicative', note: 'Rs 200 a month from Rs 25,000, Rs 300 in February' },
  { state: 'Maharashtra', slabs: [{ upTo: 7500, amount: 0 }, { upTo: 10000, amount: 175 }, { upTo: Infinity, amount: 200 }], februaryAmount: 300, womenSlabs: [{ upTo: 25000, amount: 0 }, { upTo: Infinity, amount: 200 }], confidence: 'indicative', note: 'Women are exempt up to Rs 25,000' },
  { state: 'Telangana', slabs: [{ upTo: 15000, amount: 0 }, { upTo: 20000, amount: 150 }, { upTo: Infinity, amount: 200 }], confidence: 'indicative' },
  { state: 'Andhra Pradesh', slabs: [{ upTo: 15000, amount: 0 }, { upTo: 20000, amount: 150 }, { upTo: Infinity, amount: 200 }], confidence: 'indicative' },
  { state: 'West Bengal', slabs: [{ upTo: 10000, amount: 0 }, { upTo: 15000, amount: 110 }, { upTo: 25000, amount: 130 }, { upTo: 40000, amount: 150 }, { upTo: Infinity, amount: 200 }], confidence: 'indicative' },
  { state: 'Gujarat', slabs: [{ upTo: 12000, amount: 0 }, { upTo: Infinity, amount: 200 }], confidence: 'indicative' },
];
/** States with no professional tax (or not modelled) pay zero; the UI lists them as "No PT". */
export const PT_NONE_STATES = ['Delhi', 'Haryana', 'Uttar Pradesh', 'Rajasthan', 'Punjab', 'Uttarakhand', 'Himachal Pradesh', 'Goa'];

export function professionalTax(state: string, monthlyGross: number, gender: Gender, month: Month): number {
  const rule = PT_RULES.find((r) => r.state === state);
  if (!rule) return 0;
  const slabs = gender === 'female' && rule.womenSlabs ? rule.womenSlabs : rule.slabs;
  const slab = slabs.find((s) => monthlyGross <= s.upTo) ?? slabs[slabs.length - 1]!;
  if (slab.amount === 0) return 0;
  if (rule.februaryAmount && month.endsWith('-02')) return rule.februaryAmount;
  return slab.amount;
}

// ─────────────────────────────── labour welfare fund ──────────────────────────
export interface LwfRule { state: string; employee: number; employer: number; months: number[]; confidence: Confidence }
export const LWF_RULES: LwfRule[] = [
  { state: 'Maharashtra', employee: 12, employer: 36, months: [6, 12], confidence: 'indicative' },
  { state: 'Karnataka', employee: 50, employer: 100, months: [12], confidence: 'indicative' },
  { state: 'Tamil Nadu', employee: 10, employer: 20, months: [12], confidence: 'indicative' },
];
export function lwfFor(state: string, month: Month): { employee: number; employer: number } {
  const r = LWF_RULES.find((x) => x.state === state);
  const mo = Number(month.slice(5, 7));
  return r && r.months.includes(mo) ? { employee: r.employee, employer: r.employer } : { employee: 0, employer: 0 };
}

// ────────────────────────────────── income tax ─────────────────────────────────
export interface TaxSlab { upTo: number; rate: number }
export const TDS = {
  // Income-tax Act 2025 (from 1 Apr 2026): salary TDS is under section 392. Form 16 → 130, 24Q → 138, 12BB → 124 (as reported).
  newRegime: {
    slabs: [
      { upTo: 400000, rate: 0 }, { upTo: 800000, rate: 5 }, { upTo: 1200000, rate: 10 }, { upTo: 1600000, rate: 15 },
      { upTo: 2000000, rate: 20 }, { upTo: 2400000, rate: 25 }, { upTo: Infinity, rate: 30 },
    ] as TaxSlab[],
    standardDeduction: 75000,
    rebateLimit: 1200000,    // no tax up to this taxable income, with marginal relief just above it
    rebateMax: 60000,
    confidence: 'reported' as Confidence,
  },
  oldRegime: {
    slabs: [{ upTo: 250000, rate: 0 }, { upTo: 500000, rate: 5 }, { upTo: 1000000, rate: 20 }, { upTo: Infinity, rate: 30 }] as TaxSlab[],
    standardDeduction: 50000,
    rebateLimit: 500000,
    rebateMax: 12500,
    limits: { sec80C: 150000, nps80CCD1B: 50000, homeLoanInterest: 200000 },
    confidence: 'reported' as Confidence,
  },
  cess: 4,
  // Surcharge on income above Rs 50 lakh is not modelled in the preview.
};

export function slabTax(income: number, slabs: TaxSlab[]): number {
  let tax = 0;
  let prev = 0;
  for (const s of slabs) {
    if (income > prev) tax += (Math.min(income, s.upTo) - prev) * (s.rate / 100);
    prev = s.upTo;
    if (income <= s.upTo) break;
  }
  return tax;
}

// HRA metro list (dated). From 1 Apr 2026 four more cities join the 50% rate (as reported).
export const HRA_METROS: Dated<string[]>[] = [
  { from: '2000-01-01', value: ['Delhi', 'Mumbai', 'Kolkata', 'Chennai'], source: 'Income-tax Rules 1962', confidence: 'verified' },
  { from: '2026-04-01', value: ['Delhi', 'Mumbai', 'Kolkata', 'Chennai', 'Bengaluru', 'Hyderabad', 'Pune', 'Ahmedabad'], source: 'Income-tax Rules 2026 (as reported)', confidence: 'reported' },
];
export const isMetroCity = (city: string, on: ISODate): boolean =>
  valueOn(HRA_METROS, on).some((c) => c.toLowerCase() === city.toLowerCase() || (c === 'Bengaluru' && city.toLowerCase() === 'bangalore'));

// ──────────────────────────────── minimum wages ───────────────────────────────
// Sample values only. Each state revises on its own cycle and the central VDA changed twice in 2026.
export interface MinWage { state: string; zone: string; skill: 'unskilled' | 'semi_skilled' | 'skilled'; monthly: number; asOn: ISODate; confidence: Confidence }
export const MIN_WAGES: MinWage[] = [
  { state: 'Delhi', zone: 'All', skill: 'unskilled', monthly: 18500, asOn: '2026-04-01', confidence: 'indicative' },
  { state: 'Delhi', zone: 'All', skill: 'semi_skilled', monthly: 20400, asOn: '2026-04-01', confidence: 'indicative' },
  { state: 'Delhi', zone: 'All', skill: 'skilled', monthly: 22300, asOn: '2026-04-01', confidence: 'indicative' },
  { state: 'Karnataka', zone: 'Zone A', skill: 'unskilled', monthly: 14500, asOn: '2026-04-01', confidence: 'indicative' },
  { state: 'Karnataka', zone: 'Zone A', skill: 'skilled', monthly: 17500, asOn: '2026-04-01', confidence: 'indicative' },
  { state: 'Maharashtra', zone: 'Zone I', skill: 'unskilled', monthly: 15500, asOn: '2026-04-01', confidence: 'indicative' },
  { state: 'Maharashtra', zone: 'Zone I', skill: 'skilled', monthly: 18500, asOn: '2026-04-01', confidence: 'indicative' },
];
export const minWageFor = (state: string, skill: MinWage['skill'] = 'unskilled'): number | null =>
  MIN_WAGES.find((m) => m.state === state && m.skill === skill)?.monthly ?? null;

// ─────────────────────────────── compliance calendar ──────────────────────────
export interface CalendarRule { law: 'PF' | 'ESI' | 'PT' | 'LWF' | 'TDS'; name: string; dayOfMonth: number; frequency: 'monthly' | 'quarterly'; note: string }
export const CALENDAR_RULES: CalendarRule[] = [
  { law: 'TDS', name: 'TDS deposit (salary, section 392)', dayOfMonth: 7, frequency: 'monthly', note: 'Challan for the previous month' },
  { law: 'PF', name: 'PF contribution and ECR', dayOfMonth: 15, frequency: 'monthly', note: 'ECR blocks rows with an unseeded UAN' },
  { law: 'ESI', name: 'ESI contribution', dayOfMonth: 15, frequency: 'monthly', note: 'Return filed half-yearly' },
  { law: 'PT', name: 'Professional tax payment', dayOfMonth: 20, frequency: 'monthly', note: 'Due date differs by state' },
];
