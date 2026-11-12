import type { Row } from '../payroll/common';

// Rows -> the wire. Pure functions, no database access. Top-level keys snake_case, null for "nothing". Dates are 'YYYY-MM-DD' strings,
// timestamps ISO, keep_years a JSON number. The compliance row carries NO `status` (the dashboard derives it from due_on / filed_on / today).

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

// ── compliance tasks ────────────────────────────────────────────────────────
export const complianceOut = (r: Row): Row => ({
  id: r.id, name: r.name, law: r.law, due_on: iso(r.due_on), entity_id: r.entity_id,
  state: r.state ?? null, filed_on: iso(r.filed_on), reference: r.reference ?? null,
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

// ── consent records ─────────────────────────────────────────────────────────
export const consentOut = (r: Row): Row => ({
  id: r.id, employee_id: r.employee_id, purpose: str(r.purpose), notice_version: str(r.notice_version),
  granted_at: iso(r.granted_at), withdrawn_at: iso(r.withdrawn_at),
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

// ── retention rules ─────────────────────────────────────────────────────────
// keep_years is coerced to a number (a numeric column can come back as a string from some drivers).
export const retentionOut = (r: Row): Row => ({
  id: r.id, dataset: str(r.dataset), keep_years: Number(r.keep_years), basis: str(r.basis), action: r.action,
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});
