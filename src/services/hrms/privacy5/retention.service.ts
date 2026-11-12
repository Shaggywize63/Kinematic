import { db, fail, HrmsScope, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { insertIdempotent, invalid, newId, notFound, now } from '../payroll/common';
import { retentionOut } from './mapping';
import { validateRetention } from './validation';

// Retention rules (policy records only -- nothing is deleted or anonymised on their basis this phase). dataset and basis are non-empty,
// keep_years is zero or more (sub-year periods allowed, e.g. 0.25 = 90 days), action is delete or anonymise. The dashboard edits
// keep_years + action; create (used by "Add the standard retention rules") carries the whole record.

const T = 'hrms_retention_rules';

const find = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

/** The effective columns from a source object, after the plain content checks. */
function columnsOf(src: Row): Row {
  const dataset = String(src.dataset ?? '').trim();
  const basis = String(src.basis ?? '').trim();
  const keepYears = Number(src.keep_years);
  const problem = validateRetention(dataset, basis, keepYears);
  if (problem) throw invalid(problem);
  return { dataset, keep_years: keepYears, basis, action: src.action };
}

export async function createRetention(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: retentionOut(existing), created: false };
  }
  const columns = columnsOf(input);
  const r = await insertIdempotent(s, T, { id, ...columns }, !!input.id, () => find(s, id));
  return { row: retentionOut(r.row), created: r.created };
}

export async function updateRetention(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Retention rule not found');
  const merged: Row = { ...current };
  for (const k of ['dataset', 'keep_years', 'basis', 'action'] as const) if (patch[k] !== undefined) merged[k] = patch[k];
  const columns = columnsOf(merged);
  const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return retentionOut(res.data as Row);
}

export async function deleteRetention(s: HrmsScope, id: string): Promise<{ id: string }> {
  const current = await find(s, id);
  if (!current) throw notFound('Retention rule not found');
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}
