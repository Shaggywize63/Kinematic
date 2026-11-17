// Compensation: pure logic, ported from the dashboard's rewards/compEngine.ts + rewards/seed.ts. No database, no express.
// Only the parts the server needs are here: band / guideline validation (reproduced as a backstop behind the zod shape
// checks), the merit-cycle membership and "does this proposal need a reason" checks the submit / approve gates use, and
// the default guidelines + standard band template the empty-state seed writes. The maths matches the dashboard exactly so
// the server's refusals and the client's are the same.

export type PerfBand = 'exceeds' | 'meets' | 'partial' | 'below' | 'unrated';
export type CompaZone = 'low' | 'mid' | 'high';

export const PERF_BANDS: readonly PerfBand[] = ['exceeds', 'meets', 'partial', 'below', 'unrated'];
export const COMPA_ZONES: readonly CompaZone[] = ['low', 'mid', 'high'];

export interface Guideline { min: number; max: number }   // percent range
export type Guidelines = Record<PerfBand, Record<CompaZone, Guideline>>;

export interface Band { grade: string; min: number; mid: number; max: number; market: number; published: boolean }
export interface Proposal { pct: number; reason?: string; by: string; on: string }

/** The minimal employee shape the cycle-membership check needs (from hrms_employees). */
export interface CycleEmployee {
  id: string;
  status: string;                   // onboarding | active | on_notice | exited
  annualCtc: number | null;
  joinDate: string;                 // YYYY-MM-DD
  contractEndDate?: string | null;
  designationId?: string | null;
}

// ───────────────────────────── defaults / templates ─────────────────────────────
/** The guideline matrix a brand-new cycle starts with (rewards/seed.ts DEFAULT_GUIDELINES). */
export const DEFAULT_GUIDELINES = (): Guidelines => ({
  exceeds: { low: { min: 10, max: 15 }, mid: { min: 8, max: 12 }, high: { min: 5, max: 8 } },
  meets: { low: { min: 6, max: 9 }, mid: { min: 4, max: 7 }, high: { min: 2, max: 4 } },
  partial: { low: { min: 2, max: 4 }, mid: { min: 1, max: 3 }, high: { min: 0, max: 2 } },
  below: { low: { min: 0, max: 2 }, mid: { min: 0, max: 1 }, high: { min: 0, max: 0 } },
  unrated: { low: { min: 3, max: 5 }, mid: { min: 2, max: 4 }, high: { min: 0, max: 2 } },
});

/** The sample band template the empty-state "Add the standard pay bands" writes (rewards/seed.ts makeComp). */
export const STANDARD_BANDS: Band[] = [
  { grade: 'W1', min: 210000, mid: 250000, max: 290000, market: 262000, published: true },
  { grade: 'E1', min: 300000, mid: 350000, max: 400000, market: 345000, published: true },
  { grade: 'E2', min: 480000, mid: 600000, max: 700000, market: 615000, published: true },
  { grade: 'E3', min: 1200000, mid: 1600000, max: 2000000, market: 1650000, published: true },
  { grade: 'M1', min: 800000, mid: 1000000, max: 1200000, market: 1020000, published: true },
  { grade: 'M3', min: 1800000, mid: 2400000, max: 3000000, market: 2350000, published: false },
];

// ───────────────────────────── validation (dashboard words) ─────────────────────────────
export function validateBand(b: Pick<Band, 'min' | 'mid' | 'max' | 'market'>): string | null {
  if (![b.min, b.mid, b.max, b.market].every((n) => Number.isFinite(n) && n > 0)) return 'Enter all four amounts as positive numbers.';
  if (!(b.min < b.mid && b.mid < b.max)) return 'The minimum must be below the midpoint, and the midpoint below the maximum.';
  if (b.max > b.min * 2.5) return 'A band wider than 2.5 times its minimum looks like a typing mistake.';
  return null;
}

export function validateGuideline(min: number, max: number): string | null {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 'Enter both numbers.';
  if (min < 0 || max > 50) return 'Use values from 0 to 50 percent.';
  if (min > max) return 'The lowest value cannot be above the highest.';
  return null;
}

// ───────────────────────────── bands / compa-ratio ─────────────────────────────
/** CTC divided by the band midpoint, to two decimals. 1.00 means paid at the midpoint. */
export function compaRatio(ctc: number, mid: number): number {
  return mid > 0 ? Math.round((ctc / mid) * 100) / 100 : 0;
}
export function zoneOf(compa: number): CompaZone {
  return compa < 0.9 ? 'low' : compa > 1.1 ? 'high' : 'mid';
}

// ───────────────────────────── merit cycle ─────────────────────────────
/** New CTC after an increment, rounded to the nearest 100 rupees so letters carry tidy numbers. */
export function newCtc(ctc: number, pct: number): number {
  return Math.round((ctc * (1 + pct / 100)) / 100) * 100;
}
/** The CTC a cycle works from: the figure before any increment issued in this cycle. */
export function baseCtcFor(e: CycleEmployee, applied: Record<string, { from: number }>): number {
  return applied[e.id]?.from ?? e.annualCtc ?? 0;
}

export function guidelineFor(g: Guidelines, perf: PerfBand | undefined, compa: number): Guideline {
  return g[perf ?? 'unrated'][zoneOf(compa)];
}

/** Add `months` to an ISO date (clamping the day to the shorter month), as the dashboard's addMonthsISO does. */
export function addMonthsISO(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const base = new Date(Date.UTC(y, (m - 1) + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, lastDay));
  return base.toISOString().slice(0, 10);
}

export interface CycleMember { employee: CycleEmployee; included: boolean; reason?: string }
/**
 * Who is in the cycle (rewards/compEngine.ts cycleMembership): working today (not on notice), joined at least six months
 * before the effective date, and, for a contract role, still employed on the effective date. The reason strings only
 * matter to the preview on the client; the submit/approve gates read `included`.
 */
export function cycleMembership(employees: CycleEmployee[], effectiveOn: string): CycleMember[] {
  const cutoff = addMonthsISO(effectiveOn, -6);
  return employees.filter((e) => e.status !== 'exited').map((e) => {
    if (e.status === 'onboarding') return { employee: e, included: false, reason: 'Has not joined yet' };
    if (!e.annualCtc) return { employee: e, included: false, reason: 'No CTC on file' };
    if (e.status === 'on_notice') return { employee: e, included: false, reason: 'Serving notice' };
    if (e.joinDate > cutoff) return { employee: e, included: false, reason: `Joined after ${cutoff}` };
    if (e.contractEndDate && e.contractEndDate < effectiveOn) return { employee: e, included: false, reason: `Contract ends ${e.contractEndDate}` };
    return { employee: e, included: true };
  });
}

export interface ProposalCheck { outside: boolean; needsReason: boolean; newCtc: number; delta: number }
/** Whether a proposal is outside the suggested range, and (if so) whether it still needs a reason. */
export function checkProposal(base: number, band: Band, perf: PerfBand | undefined, guidelines: Guidelines, p: Pick<Proposal, 'pct' | 'reason'> | undefined): ProposalCheck {
  const compa = compaRatio(base, band.mid);
  const guide = guidelineFor(guidelines, perf, compa);
  const pct = p?.pct ?? 0;
  const next = newCtc(base, pct);
  const outside = p != null && (pct < guide.min || pct > guide.max);
  return { outside, needsReason: outside && !(p?.reason ?? '').trim(), newCtc: next, delta: next - base };
}

/** Why a cycle cannot go to HR for approval yet, in the dashboard's plain sentences. Empty means it can. */
export function submitBlockers(args: { withProposal: number; missingReasons: number }): string[] {
  const out: string[] = [];
  if (args.withProposal === 0) out.push('Enter at least one proposed increment.');
  if (args.missingReasons > 0) out.push(args.missingReasons === 1 ? '1 proposal is outside the guidance and needs a reason.' : `${args.missingReasons} proposals are outside the guidance and need a reason.`);
  return out;
}
