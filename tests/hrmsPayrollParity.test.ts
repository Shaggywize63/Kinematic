/**
 * Payroll engine parity: the server's port (src/services/hrms/payroll/engine) must reproduce, EXACTLY, what the dashboard engine
 * produced for every case in tests/fixtures/hrms-payroll-golden.json (generated from kinematic-dashboard src/lib/hrms/engine.ts +
 * rules.ts; the fixture is the oracle and is never edited by hand).
 *
 *   - 15 pay-run cases: the employees on the run, every payslip (lines in order, warnings text, wages) and the run totals
 *   - 7 full-and-final settlements
 *   - 162 salary breakups   - 28 income-tax cases   - 292 professional-tax / labour-welfare-fund lookups
 *
 * "Exactly" means deep equality of the JSON the engine returns: same numbers, same lines in the same order, same words. If a case
 * fails the port is wrong; do not loosen a comparison, fix the port (or, if the dashboard engine is the faulty one, report it).
 */
import fs from 'fs';
import path from 'path';
import {
  annualTax, buildBreakup, computeFnf, computePayRunPayslips, employeesForRun, lwfFor, professionalTax, runTotals,
} from '../src/services/hrms/payroll/engine';
import type { HrmsDb } from '../src/services/hrms/payroll/engine';

/* eslint-disable @typescript-eslint/no-explicit-any */
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hrms-payroll-golden.json'), 'utf8'));

/** What the generator JSON-serialised: undefined keys vanish, so compare through the same round trip. */
const wire = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));

/** The engine takes the dashboard's HrmsDb; only the collections it reads are filled. */
const dbOf = (input: any): HrmsDb => ({
  employees: [], shifts: [], structures: [], locations: [], entities: [], attendance: [], adjustments: [], loans: [], overtimeRules: [], payRuns: [], fnfCases: [],
  ...input,
}) as unknown as HrmsDb;

describe('the golden fixture is the one the parity requirement names', () => {
  it('holds 15 pay-run cases, 7 F&F, 162 breakups, 28 tax cases and 292 PT/LWF lookups', () => {
    expect(golden.cases).toHaveLength(15);
    expect(golden.fnf).toHaveLength(7);
    expect(golden.breakups).toHaveLength(162);
    expect(golden.taxes).toHaveLength(28);
    expect(golden.lookups).toHaveLength(292);
  });

  it('covers the branches it claims to: overtime, loans, adjustments of every kind, ESI, PT, PF, warnings', () => {
    const slips = golden.cases.flatMap((c: any) => c.expected.payslips);
    const has = (f: (s: any) => boolean) => slips.some(f);
    expect(slips).toHaveLength(194);
    expect(has((s) => s.earnings.some((l: any) => l.code === 'OT'))).toBe(true);
    expect(has((s) => s.deductions.some((l: any) => l.code === 'LOAN'))).toBe(true);
    for (const code of ['ARREAR', 'BONUS', 'INCENTIVE']) expect(has((s) => s.earnings.some((l: any) => l.code === code))).toBe(true);
    expect(has((s) => s.reimbursements.some((l: any) => l.code === 'REIMB'))).toBe(true);
    expect(has((s) => s.deductions.filter((l: any) => l.code === 'DED').length > 0)).toBe(true);
    expect(has((s) => s.deductions.some((l: any) => l.code === 'ESI'))).toBe(true);
    expect(has((s) => s.deductions.some((l: any) => l.code === 'PT'))).toBe(true);
    expect(has((s) => s.warnings.length > 0)).toBe(true);
  });
});

describe('pay runs: employees, payslips (lines in order, warning text) and totals', () => {
  it.each(golden.cases.map((c: any) => [c.name, c]))('%s', (_name: string, c: any) => {
    const db = dbOf(c.input);

    // who is on the run
    expect(employeesForRun(db, c.month, c.entityId).map((e) => e.id)).toEqual(c.expected.employeeIds);

    // every payslip, field for field
    const slips = computePayRunPayslips(db, c.month, c.entityId, 'run_golden');
    expect(slips).toHaveLength(c.expected.payslips.length);
    for (const s of slips) {
      expect(typeof s.id).toBe('string');
      expect(s.runId).toBe('run_golden');
    }
    const got = wire(slips.map(({ id, runId, ...rest }) => rest));
    c.expected.payslips.forEach((want: any, i: number) => {
      // per payslip so a failure names the person and the line that differs
      expect({ employeeId: got[i].employeeId, ...got[i] }).toEqual(want);
    });
    expect(got).toEqual(c.expected.payslips);

    // the run totals
    expect(runTotals({ payslips: slips } as any)).toEqual(c.expected.totals);
  });
});

describe('full and final settlements', () => {
  it.each(golden.fnf.map((c: any) => [c.name, c]))('%s', (_name: string, c: any) => {
    const result = computeFnf(dbOf(c.input), c.case);
    expect(wire(result)).toEqual(c.expected);
  });
});

describe('salary breakups from CTC', () => {
  it('reproduces all 162 (every structure x CTC x date x PF option)', () => {
    let n = 0;
    for (const b of golden.breakups) {
      const got = buildBreakup(b.structure, b.annualCtc, b.opts);
      expect({ at: `${b.structure.id} ${b.annualCtc} ${b.opts.asOn} pf=${b.opts.pfMember}/${b.opts.pfOnActual}`, v: wire(got) })
        .toEqual({ at: `${b.structure.id} ${b.annualCtc} ${b.opts.asOn} pf=${b.opts.pfMember}/${b.opts.pfOnActual}`, v: b.expected });
      n += 1;
    }
    expect(n).toBe(162);
  });

  it('applies the 50% wage rule add-back and the PF ceiling change on 17 Sep 2026', () => {
    const field = golden.breakups.filter((b: any) => b.structure.id === 'str_field' && b.annualCtc === 540000 && b.opts.pfMember && !b.opts.pfOnActual);
    const before = field.find((b: any) => b.opts.asOn === '2026-09-16');
    const after = field.find((b: any) => b.opts.asOn === '2026-09-17');
    expect(buildBreakup(before.structure, before.annualCtc, before.opts).pfWage).toBe(15000);
    expect(buildBreakup(after.structure, after.annualCtc, after.opts).pfWage).toBeGreaterThan(15000);
    expect(buildBreakup(after.structure, after.annualCtc, after.opts).wageTest.passes).toBe(false);
  });
});

describe('income tax', () => {
  it('reproduces all 28 cases (both regimes, metro and not, around the rebate and marginal relief)', () => {
    let n = 0;
    for (const t of golden.taxes) {
      expect({ i: t.input, v: wire(annualTax(t.input)) }).toEqual({ i: t.input, v: t.expected });
      n += 1;
    }
    expect(n).toBe(28);
  });
});

describe('professional tax and labour welfare fund lookups', () => {
  it('reproduces all 292 (PT: 7 states x 5 grosses x 2 genders x 4 months = 280; LWF: 4 states x 3 months = 12)', () => {
    let pt = 0; let lwf = 0;
    for (const l of golden.lookups) {
      if (l.kind === 'pt') {
        expect({ l, v: professionalTax(l.state, l.gross, l.gender, l.month) }).toEqual({ l, v: l.expected });
        pt += 1;
      } else {
        expect({ l, v: wire(lwfFor(l.state, l.month)) }).toEqual({ l, v: l.expected });
        lwf += 1;
      }
    }
    expect({ pt, lwf, total: pt + lwf }).toEqual({ pt: 280, lwf: 12, total: 292 });
  });
});
