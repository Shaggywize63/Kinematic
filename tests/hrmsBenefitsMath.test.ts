/**
 * The ported Benefits engine (src/services/hrms/benefits/engine.ts) — a unit test of the premium / deduction MATH against
 * exact, hand-derived numbers, with no database. This is the parity oracle for the port: the dashboard's
 * rewards/benefitsEngine.ts produces the same values, so the server-computed payroll deductions match the dashboard.
 * The company share is a percentage of each premium line; NPS moves a percent of basic (employee-side only); meal coupons
 * come fully off take-home; the flexible allowance and the auto accident cover are company-funded (no employee deduction).
 */
import {
  benefitsTag, deductionPreview, enrolmentEligibility, planOf, quoteEnrolment, tierOf, validateDependants, validateFlex, windowStatus,
} from '../src/services/hrms/benefits/engine';
import type { BenefitsDb, Enrolment, Plan } from '../src/services/hrms/benefits/engine';
import type { Employee, SalaryStructure } from '../src/services/hrms/payroll/engine';

/* eslint-disable @typescript-eslint/no-explicit-any */
const emp = (over: any): Employee => ({
  id: 'e', code: 'EMP-0001', firstName: 'A', lastName: 'B', status: 'active', lastWorkingDate: undefined,
  structureId: undefined, annualCtc: undefined, pfMember: false, pfOnActualWage: false, structureOverrides: undefined, ...over,
} as unknown as Employee);

const COVER_START = '2026-01-01';
const PLANS: Plan[] = [
  {
    id: 'ph', kind: 'health', name: 'Group health', summary: '', provider: 'Sample', auto: false,
    tiers: [{ id: 'h5', label: '5L', sumInsured: 500000, annualPremium: { self: 7200, spouse: 7200, child: 3600, parent: 12000 } }],
    employerSharePct: { self: 100, spouse: 50, child: 50, parent: 0 },
    dependants: { maxSpouse: 1, maxChildren: 2, childMaxAge: 25, maxParents: 2, parentMaxAge: 80 },
    taxNote: '', coverStart: COVER_START, renewsOn: '2026-12-31',
  },
  {
    id: 'pa', kind: 'accident', name: 'Group accident', summary: '', provider: 'Sample', auto: true,
    tiers: [{ id: 'a10', label: '10L', sumInsured: 1000000, annualPremium: { self: 1200 } }],
    employerSharePct: { self: 100 }, taxNote: '', coverStart: COVER_START, renewsOn: '2026-12-31',
  },
  {
    id: 'pm', kind: 'meal', name: 'Meal coupons', summary: '', provider: 'Sample', auto: false,
    tiers: [{ id: 'm0', label: 'None', monthlyAmount: 0 }, { id: 'm1', label: '1200', monthlyAmount: 1200 }],
    employerSharePct: { self: 0 }, taxNote: '', coverStart: COVER_START, renewsOn: '2026-12-31',
  },
  {
    id: 'pn', kind: 'nps', name: 'NPS', summary: '', provider: 'Sample', auto: false,
    tiers: [{ id: 'n0', label: 'None', pctOfBasic: 0 }, { id: 'n10', label: '10%', pctOfBasic: 10 }],
    employerSharePct: { self: 0 }, taxNote: '', coverStart: COVER_START, renewsOn: '2026-12-31',
  },
  {
    id: 'pf', kind: 'flex', name: 'Flex', summary: '', provider: 'Sample', auto: false,
    tiers: [], flexMonthly: 2500, baskets: [{ id: 'learning', label: 'Learning' }],
    employerSharePct: { self: 100 }, taxNote: '', coverStart: COVER_START, renewsOn: '2026-12-31',
  },
];

const enrol = (over: Partial<Enrolment>): Enrolment => ({ employeeId: 'e', status: 'enrolled', submittedOn: '2026-11-01', by: 'HR', dependants: [], flex: {}, ...over });

describe('quoteEnrolment — the per-line employer split and the by-plan employee monthly', () => {
  it('splits each health line by the employer percentage and rounds once at the end', () => {
    // self 7200 @100% -> 0; spouse 7200 @50% -> 3600/yr; child 3600 @50% -> 1800/yr. (3600+1800)/12 = 450/mo
    const q = quoteEnrolment(PLANS, enrol({ healthTier: 'h5', dependants: [{ id: 'd1', name: 'S', relation: 'spouse', dob: '1985-01-01' }, { id: 'd2', name: 'C', relation: 'child', dob: '2015-01-01' }], mealTier: 'm1' }), 0);
    expect(q.byPlan.health.employee).toBe(450);
    expect(q.byPlan.meal.employee).toBe(1200); // 1200/mo fully off take-home (employer 0%)
    expect(q.byPlan.nps.employee).toBe(0);
    // employer monthly = health employer (self 7200 + spouse 3600 + child 1800)/12 = 1050 + accident 1200/12 = 100 -> 1150
    expect(q.employerMonthly).toBe(1150);
  });

  it('NPS moves a percent of basic, entirely employee-side', () => {
    // 10% of a 40000 basic = 4000/mo employee, 0 employer
    const q = quoteEnrolment(PLANS, enrol({ healthTier: 'h5', npsTier: 'n10' }), 40000);
    expect(q.byPlan.nps.employee).toBe(4000);
    expect(q.byPlan.nps.employer).toBe(0);
  });

  it('the flexible allowance is company-funded (no employee deduction)', () => {
    const q = quoteEnrolment(PLANS, enrol({ healthTier: 'h5', flex: { learning: 1500 } }), 0);
    expect(q.byPlan.flex.employee).toBe(0);
    expect(q.byPlan.flex.employer).toBe(1500);
  });

  it('a waived / absent enrolment still carries the auto accident cover, fully employer-funded', () => {
    const q = quoteEnrolment(PLANS, undefined, 0);
    expect(q.byPlan.accident.employee).toBe(0);
    expect(q.byPlan.accident.employer).toBe(100); // 1200/yr / 12
    expect(q.byPlan.health.employee + q.byPlan.meal.employee + q.byPlan.nps.employee).toBe(0);
  });
});

describe('deductionPreview — the per-employee monthly amounts that feed payroll', () => {
  const db: BenefitsDb = {
    structures: [] as SalaryStructure[],
    employees: [
      emp({ id: 'a', code: 'EMP-0001', firstName: 'Aarav', status: 'active' }),
      emp({ id: 'b', code: 'EMP-0002', firstName: 'Bela', status: 'active' }),
      emp({ id: 'c', code: 'EMP-0003', firstName: 'Chitra', status: 'active' }),   // eligible, no enrolment -> 0, dropped
      emp({ id: 'f', code: 'EMP-0004', firstName: 'Fay', status: 'onboarding' }),  // not eligible -> excluded
    ],
  };
  const enrolments: Enrolment[] = [
    enrol({ employeeId: 'a', healthTier: 'h5', dependants: [{ id: 'd1', name: 'S', relation: 'spouse', dob: '1985-01-01' }, { id: 'd2', name: 'C', relation: 'child', dob: '2015-01-01' }], mealTier: 'm1' }),
    enrol({ employeeId: 'b', healthTier: 'h5', dependants: [{ id: 'd3', name: 'K', relation: 'child', dob: '2016-01-01' }], mealTier: 'm1' }),
  ];

  it('computes exact totals, drops the pending and the ineligible, and sorts by code', () => {
    const rows = deductionPreview(db, PLANS, enrolments, '2026-11-13', COVER_START).filter((r) => r.total > 0);
    expect(rows.map((r) => [r.code, r.health, r.meal, r.nps, r.total, r.note])).toEqual([
      ['EMP-0001', 450, 1200, 0, 1650, 'Health 450, Meal coupons 1200'], // Aarav
      ['EMP-0002', 150, 1200, 0, 1350, 'Health 150, Meal coupons 1200'], // Bela: child 3600 @50% = 1800/yr -> 150/mo
    ]);
    expect(rows.reduce((t, r) => t + r.total, 0)).toBe(3000);
  });
});

describe('eligibility, window, dependant and flex rules (the exact dashboard words)', () => {
  it('eligibility by status and the cover-start cut-off', () => {
    expect(enrolmentEligibility(emp({ status: 'active' }), COVER_START)).toEqual({ eligible: true });
    expect(enrolmentEligibility(emp({ status: 'onboarding' }), COVER_START).reason).toBe('Has not joined yet; enrols in the first week after joining.');
    expect(enrolmentEligibility(emp({ status: 'exited' }), COVER_START).reason).toBe('Has left the company.');
    expect(enrolmentEligibility(emp({ status: 'on_notice' }), COVER_START).reason).toBe('Leaves before the cover starts.');
    expect(enrolmentEligibility(emp({ status: 'active', lastWorkingDate: '2025-12-01' }), COVER_START).reason).toBe('Leaves before the cover starts.');
  });
  it('windowStatus', () => {
    const w = { opensOn: '2026-11-01', closesOn: '2026-11-20', extensions: [] };
    expect(windowStatus(w, '2026-11-13').state).toBe('open');
    expect(windowStatus(w, '2026-10-30').state).toBe('not_open');
    expect(windowStatus(w, '2026-11-25').state).toBe('closed');
  });
  it('validateDependants enforces the counts and age caps with the dashboard words', () => {
    const rules = { maxSpouse: 1, maxChildren: 2, childMaxAge: 25, maxParents: 2, parentMaxAge: 80 };
    expect(validateDependants(rules, [{ id: '1', name: 'A', relation: 'spouse', dob: '1985-01-01' }, { id: '2', name: 'B', relation: 'spouse', dob: '1986-01-01' }], COVER_START)[0]).toBe('This plan covers 1 spouse at most.');
    expect(validateDependants(rules, [{ id: '1', name: 'Old', relation: 'child', dob: '1990-01-01' }], COVER_START)[0]).toBe('Old will be 36 when cover starts. Children are covered up to 25.');
    expect(validateDependants(rules, [{ id: '1', name: '', relation: 'parent', dob: '1960-01-01' }], COVER_START)[0]).toBe('Add a name for the parent.');
    expect(validateDependants(rules, [{ id: '1', name: 'P', relation: 'parent', dob: '2000-01-01' }], COVER_START)[0]).toBe('P: check the date of birth. A parent aged 26 looks wrong.');
    expect(validateDependants(rules, [{ id: '1', name: 'S', relation: 'spouse', dob: '1985-01-01' }], COVER_START)).toEqual([]);
  });
  it('validateFlex enforces multiples of 250 and the monthly budget', () => {
    const flex = planOf(PLANS, 'flex')!;
    expect(validateFlex(flex, { learning: 300 })[0]).toBe('Use multiples of 250.');
    expect(validateFlex(flex, { learning: 3000 })[0]).toBe('You have allocated 3000 but the monthly budget is 2500.');
    expect(validateFlex(flex, { learning: -250 })[0]).toBe('Amounts cannot be negative.');
    expect(validateFlex(flex, { learning: 1500 })).toEqual([]);
  });
  it('tierOf / planOf / benefitsTag', () => {
    expect(tierOf(planOf(PLANS, 'health'), 'h5')!.sumInsured).toBe(500000);
    expect(tierOf(planOf(PLANS, 'health'), 'nope')).toBeUndefined();
    expect(benefitsTag('2026-11')).toBe('[benefits 2026-11]');
  });
});
