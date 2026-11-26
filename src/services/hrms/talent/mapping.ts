import type { Row } from '../payroll/common';

// Rows -> the wire for Talent. Pure functions, no database access. Top-level keys snake_case; a skill goes out under its
// stable key (the dashboard's Skill.id IS the key). Maps keyed exactly as the dashboard holds them: ratings by
// `${employeeId}|${skillId}`, requirements as designationId -> skillKey -> level, placements by employeeId.

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 10));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const int = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

export const skillOut = (r: Row): Row => ({ id: str(r.key), name: str(r.name), group: str(r.skill_group), blurb: str(r.blurb) });

/** requirement rows -> { designationId: { skillKey: level } }. */
export function requirementsOut(rows: Row[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const d = str(r.designation_id); const k = str(r.skill_key);
    if (!d || !k) continue;
    (out[d] ??= {})[k] = int(r.required_level);
  }
  return out;
}

export const ratingValue = (r: Row): Row => ({ level: int(r.level), note: str(r.note), by: str(r.by_name), on: iso(r.on_date) });
/** rating rows -> { `${employeeId}|${skillId}`: Rating }. */
export function ratingsOut(rows: Row[]): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const r of rows) {
    const e = str(r.employee_id); const k = str(r.skill_key);
    if (!e || !k) continue;
    out[`${e}|${k}`] = ratingValue(r);
  }
  return out;
}

export const successorOut = (r: Row): Row => ({
  employee_id: r.employee_id, readiness: str(r.readiness), actions: strArray(r.actions), added_on: iso(r.added_on),
});
export const changeOut = (r: Row): Row => ({
  id: r.id, on: iso(r.on_date), by: str(r.by_name), kind: str(r.kind),
  employee_id: r.employee_id ?? null, from: r.from_text ?? null, to: r.to_text ?? null, reason: str(r.reason),
});

export const roleOut = (r: Row, successors: Row[], changes: Row[]): Row => ({
  id: r.id,
  title: str(r.title),
  department_id: r.department_id ?? null,
  location_id: r.location_id ?? null,
  incumbent_id: r.incumbent_id ?? null,
  role_since: iso(r.role_since),
  retirement_age: int(r.retirement_age),
  why: str(r.why),
  successors: successors.map(successorOut),
  history: changes.map(changeOut),
});

export const placementValue = (r: Row): Row => ({
  employee_id: r.employee_id, performance: int(r.performance), potential: int(r.potential), rationale: str(r.rationale), by: str(r.by_name), on: iso(r.on_date),
});
/** placement rows -> { employeeId: Placement }. */
export function placementsOut(rows: Row[]): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const r of rows) { const e = str(r.employee_id); if (e) out[e] = placementValue(r); }
  return out;
}

export const logOut = (r: Row): Row => ({ id: r.id, at: r.at ?? null, by: str(r.by_name), action: str(r.action), detail: r.detail ?? null });
