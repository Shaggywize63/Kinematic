import type { Row } from '../payroll/common';

// Rows -> the wire for Compensation. Pure functions, no database access. Top-level keys snake_case; the band amounts come
// back from the physical band_min / band_mid / band_max columns as min / mid / max; the jsonb maps (guidelines, proposals,
// applied, decision) pass through in the dashboard's own camelCase shape, as the payroll / benefits mappings do with
// their nested shapes. perf and perf_notes are rebuilt as the two maps the dashboard's CompState keeps (perf: id -> band;
// perfNotes: id -> { evidence, reply? }).

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ── bands ─────────────────────────────────────────────────────────────────────
/** A pay band as the wire has it; the band_* columns are mapped back to the dashboard's min / mid / max. */
export const bandOut = (r: Row): Row => ({
  grade: str(r.grade),
  min: num(r.band_min),
  mid: num(r.band_mid),
  max: num(r.band_max),
  market: num(r.market),
  published: !!r.published,
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

// ── performance (two maps) ──────────────────────────────────────────────────────
/** perf: employeeId -> band, for the rows that carry a band. */
export function perfMapOut(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.band) out[String(r.employee_id)] = String(r.band);
  return out;
}
/** perfNotes: employeeId -> { evidence, reply? }, for the rows that carry a note or a reply. */
export function perfNotesOut(rows: Row[]): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const r of rows) {
    const hasEvidence = r.evidence !== null && r.evidence !== undefined && String(r.evidence) !== '';
    const hasReply = r.reply !== null && r.reply !== undefined && String(r.reply) !== '';
    if (!hasEvidence && !hasReply) continue;
    const note: Row = { evidence: hasEvidence ? str(r.evidence) : 'No evidence recorded.' };
    if (hasReply) note.reply = str(r.reply);
    out[String(r.employee_id)] = note;
  }
  return out;
}

// ── merit cycle ─────────────────────────────────────────────────────────────────
/** The cycle singleton as the wire has it; the jsonb maps pass through in the dashboard's camelCase shape. */
export const cycleOut = (r: Row | null): Row => ({
  id: r?.id ?? null,
  name: str(r?.name),
  effective_on: iso(r?.effective_on),
  budget_pct: num(r?.budget_pct),
  status: r?.status ?? 'draft',
  decision: r?.decision ?? null,
  guidelines: obj(r?.guidelines),
  proposals: obj(r?.proposals),
  applied: obj(r?.applied),
  created_at: iso(r?.created_at),
  updated_at: iso(r?.updated_at),
});

export { numOrNull };
