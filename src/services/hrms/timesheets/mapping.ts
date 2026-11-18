import type { Row } from '../payroll/common';
import { DEFAULT_POLICY, normaliseHours } from './engine';

// Rows -> the wire for Timesheets. Pure functions, no database access. Top-level keys snake_case; a sheet's lines and
// trail pass through in the dashboard's own camelCase shape ({ projectId, hours[7] } / { at, by, action, comment? }), as
// the other phase mappings do with their nested shapes.

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const projectOut = (r: Row): Row => ({
  id: r.id,
  name: str(r.name),
  client: str(r.client),
  kind: r.kind === 'internal' ? 'internal' : 'client',
  billable: !!r.billable,
  budget_hours: num(r.budget_hours),
  prior_hours: num(r.prior_hours),
  rate: num(r.rate),
  archived: !!r.archived,
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

export const linesOut = (v: unknown): Row[] =>
  arr(v).filter((l) => l && typeof l === 'object').map((l) => ({ projectId: String((l as Row).projectId ?? ''), hours: normaliseHours((l as Row).hours) }));

export const sheetOut = (r: Row): Row => ({
  id: r.id,
  employee_id: r.employee_id,
  week_start: iso(r.week_start),
  lines: linesOut(r.lines),
  status: r.status ?? 'draft',
  submitted_on: iso(r.submitted_on),
  decided_on: iso(r.decided_on),
  decided_by: r.decided_by ?? null,
  comment: r.comment ?? null,
  trail: arr(r.trail),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

/** The settings singleton (or the defaults when the org has never saved one). */
export const configOut = (r: Row | null): Row => ({
  policy: {
    max_per_day: r ? num(r.max_per_day) : DEFAULT_POLICY.maxPerDay,
    weekly_cap: r ? num(r.weekly_cap) : DEFAULT_POLICY.weeklyCap,
    standard_week: r ? num(r.standard_week) : DEFAULT_POLICY.standardWeek,
  },
  tracked_ids: arr(r?.tracked_ids).map(String),
});
