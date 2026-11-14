import { db, fail, HrmsScope, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { insertIdempotent, invalid, newId, notFound, now } from '../payroll/common';
import { planOut } from './mapping';

// The benefit plan catalogue. The dashboard has no "create plan" action (plans come from the sample seed and the
// empty-state "Add the standard benefit plans" posts those seed plans here), so there is no dashboard refusal wording to
// mirror: the plan kind / tier shapes are checked by the zod schema, and the service only guards a non-empty name. The
// nested arithmetic shapes (tiers, employer_share_pct, dependant rules, baskets) are stored as jsonb in the dashboard's
// camelCase shape and reproduced by the ported engine.

const T = 'hrms_benefit_plans';

const find = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

/** The effective plan columns from a source object (create: the request; update: current merged with the patch). */
function columnsOf(src: Row): Row {
  const name = String(src.name ?? '').trim();
  if (!name) throw invalid('Enter a name for the plan.');
  return {
    kind: src.kind,
    name,
    summary: src.summary == null ? '' : String(src.summary),
    provider: src.provider == null ? '' : String(src.provider),
    auto: !!src.auto,
    tiers: Array.isArray(src.tiers) ? src.tiers : [],
    employer_share_pct: src.employer_share_pct && typeof src.employer_share_pct === 'object' && !Array.isArray(src.employer_share_pct) ? src.employer_share_pct : {},
    dependants: src.dependants ?? null,
    flex_monthly: src.flex_monthly ?? null,
    baskets: src.baskets ?? null,
    tax_note: src.tax_note == null ? '' : String(src.tax_note),
    cover_start: src.cover_start,
    renews_on: src.renews_on,
  };
}

export async function createPlan(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: planOut(existing), created: false };
  }
  const columns = columnsOf(input);
  const r = await insertIdempotent(s, T, { id, ...columns }, !!input.id, () => find(s, id));
  return { row: planOut(r.row), created: r.created };
}

export async function updatePlan(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('That plan is not in the catalogue.');
  const merged: Row = { ...current };
  for (const k of ['kind', 'name', 'summary', 'provider', 'auto', 'tiers', 'employer_share_pct', 'dependants', 'flex_monthly', 'baskets', 'tax_note', 'cover_start', 'renews_on'] as const) {
    if (patch[k] !== undefined) merged[k] = patch[k];
  }
  const columns = columnsOf(merged);
  const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return planOut(res.data as Row);
}

export async function deletePlan(s: HrmsScope, id: string): Promise<{ id: string }> {
  const current = await find(s, id);
  if (!current) throw notFound('That plan is not in the catalogue.');
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}
