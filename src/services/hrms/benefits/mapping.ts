import type { Row } from '../payroll/common';
import type { Enrolment, Plan } from './engine';

// Rows -> the wire for Benefits. Pure functions, no database access. Top-level keys snake_case, null for "nothing"; the
// nested objects/arrays are rebuilt in the dashboard's documented camelCase key order so jsonb's key-length sorting never
// scrambles them, exactly as the payroll / time / lifecycle mappings do. The one reserved-word column on the enrolment
// (`by` -> by_name) is mapped back to the dashboard's `by` on the wire.

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const bool = (v: unknown): boolean => !!v;

// ── plans ─────────────────────────────────────────────────────────────────────
const SHARE_KEYS = ['self', 'spouse', 'child', 'parent'] as const;
/** A { self?, spouse?, child?, parent? } percentage/premium map, rebuilt in order, keeping only the keys present. */
const shareMap = (v: unknown): Record<string, number> => {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of SHARE_KEYS) if (o[k] !== undefined && o[k] !== null) out[k] = Number(o[k]);
  return out;
};
/** A plan tier { id, label, sumInsured?, annualPremium?, monthlyAmount?, pctOfBasic? }; optional keys kept only if present. */
const tierOut = (t: Row): Row => {
  const o: Row = { id: str(t.id), label: str(t.label) };
  if (t.sumInsured !== undefined && t.sumInsured !== null) o.sumInsured = Number(t.sumInsured);
  if (t.annualPremium !== undefined && t.annualPremium !== null) o.annualPremium = shareMap(t.annualPremium);
  if (t.monthlyAmount !== undefined && t.monthlyAmount !== null) o.monthlyAmount = Number(t.monthlyAmount);
  if (t.pctOfBasic !== undefined && t.pctOfBasic !== null) o.pctOfBasic = Number(t.pctOfBasic);
  return o;
};
const dependantRulesOut = (v: unknown): Row | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Row;
  return { maxSpouse: num(o.maxSpouse), maxChildren: num(o.maxChildren), childMaxAge: num(o.childMaxAge), maxParents: num(o.maxParents), parentMaxAge: num(o.parentMaxAge) };
};
const basketsOut = (v: unknown): Row[] | null => (Array.isArray(v) ? v.map((b) => ({ id: str((b as Row).id), label: str((b as Row).label) })) : null);

/** A plan as the wire has it (the dashboard's Plan, snake_case top-level; the arithmetic shapes in camelCase). */
export const planOut = (r: Row): Row => ({
  id: r.id,
  kind: r.kind,
  name: str(r.name),
  summary: str(r.summary),
  provider: str(r.provider),
  auto: bool(r.auto),
  tiers: Array.isArray(r.tiers) ? r.tiers.map(tierOut) : [],
  employer_share_pct: shareMap(r.employer_share_pct),
  dependants: dependantRulesOut(r.dependants),
  flex_monthly: numOrNull(r.flex_monthly),
  baskets: basketsOut(r.baskets),
  tax_note: str(r.tax_note),
  cover_start: iso(r.cover_start),
  renews_on: iso(r.renews_on),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

// ── enrolments ────────────────────────────────────────────────────────────────
/** A dependant on an enrolment: { id, name, relation, dob }. */
const dependantOut = (d: Row): Row => ({ id: str(d.id), name: str(d.name), relation: d.relation, dob: iso(d.dob) });
/** The flex allocation { basketId: number }, numbers coerced. */
const flexOut = (v: unknown): Record<string, number> => {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(o).map(([k, val]) => [k, Number(val)]));
};
/** An enrolment as the wire has it; `by` comes from the physical by_name column. */
export const enrolmentOut = (r: Row): Row => ({
  id: r.id,
  employee_id: r.employee_id,
  status: r.status,
  submitted_on: iso(r.submitted_on),
  by: str(r.by_name),
  health_tier: r.health_tier ?? null,
  dependants: Array.isArray(r.dependants) ? r.dependants.map(dependantOut) : [],
  meal_tier: r.meal_tier ?? null,
  nps_tier: r.nps_tier ?? null,
  flex: flexOut(r.flex),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

// ── claims ────────────────────────────────────────────────────────────────────
/** A trail entry { on, status, note?, by }; note omitted when absent (jsonb may have stripped or scrambled it). */
const trailOut = (e: Row): Row => {
  const o: Row = { on: iso(e.on), status: e.status };
  if (e.note !== null && e.note !== undefined && e.note !== '') o.note = String(e.note);
  o.by = str(e.by);
  return o;
};
/** A claim as the wire has it (the dashboard's Claim, snake_case top-level). */
export const claimOut = (r: Row): Row => ({
  id: r.id,
  ref: str(r.ref),
  employee_id: r.employee_id,
  patient: str(r.patient),
  relation: r.relation,
  kind: r.kind,
  hospital: str(r.hospital),
  claimed: num(r.claimed),
  approved: numOrNull(r.approved),
  filed_on: iso(r.filed_on),
  closed_on: iso(r.closed_on),
  status: r.status,
  rejection_reason: r.rejection_reason ?? null,
  trail: Array.isArray(r.trail) ? r.trail.map(trailOut) : [],
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

// ── config (window / reminders / sent) ──────────────────────────────────────────
/** A window extension { on, days, reason, by }, rebuilt in order. */
const extensionOut = (e: Row): Row => ({ on: iso(e.on), days: num(e.days), reason: str(e.reason), by: str(e.by) });
/** A sent-map entry { on, rows, total, by }, rebuilt in order. */
const sentEntryOut = (e: Row): Row => ({ on: iso(e.on), rows: num(e.rows), total: num(e.total), by: str(e.by) });

export const windowOut = (r: Row | null): Row => ({
  opens_on: iso(r?.opens_on),
  closes_on: iso(r?.closes_on),
  extensions: Array.isArray(r?.extensions) ? (r!.extensions as Row[]).map(extensionOut) : [],
});
export const remindersOut = (r: Row | null): Record<string, string> => {
  const o = (r?.reminders && typeof r.reminders === 'object' && !Array.isArray(r.reminders) ? r.reminders : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
};
export const sentOut = (r: Row | null): Record<string, Row> => {
  const o = (r?.sent && typeof r.sent === 'object' && !Array.isArray(r.sent) ? r.sent : {}) as Record<string, Row>;
  return Object.fromEntries(Object.entries(o).map(([month, v]) => [month, sentEntryOut(v as Row)]));
};

// ── rows -> the engine model (camelCase) ─────────────────────────────────────
// The ported engine (engine.ts) works on the dashboard's camelCase Plan / Enrolment. These pure converters turn a stored
// row into that shape so the service can call planOf / tierOf / validateDependants / validateFlex / deductionPreview.
export const toEnginePlan = (r: Row): Plan => ({
  id: String(r.id),
  kind: r.kind,
  name: str(r.name),
  summary: str(r.summary),
  provider: str(r.provider),
  auto: bool(r.auto),
  tiers: Array.isArray(r.tiers) ? (r.tiers as Plan['tiers']) : [],
  employerSharePct: (r.employer_share_pct && typeof r.employer_share_pct === 'object' && !Array.isArray(r.employer_share_pct) ? r.employer_share_pct : {}) as Plan['employerSharePct'],
  dependants: (dependantRulesOut(r.dependants) ?? undefined) as Plan['dependants'],
  flexMonthly: numOrNull(r.flex_monthly) ?? undefined,
  baskets: (basketsOut(r.baskets) ?? undefined) as Plan['baskets'],
  taxNote: str(r.tax_note),
  coverStart: str(r.cover_start),
  renewsOn: str(r.renews_on),
});

export const toEngineEnrolment = (r: Row): Enrolment => ({
  employeeId: String(r.employee_id),
  status: r.status,
  submittedOn: str(r.submitted_on),
  by: str(r.by_name),
  healthTier: r.health_tier ?? undefined,
  dependants: Array.isArray(r.dependants) ? r.dependants.map((d: Row) => ({ id: str(d.id), name: str(d.name), relation: d.relation, dob: str(d.dob) })) : [],
  mealTier: r.meal_tier ?? undefined,
  npsTier: r.nps_tier ?? undefined,
  flex: flexOut(r.flex),
});
