import { db, fail, fetchAll, HrmsScope, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, now } from '../payroll/common';
import { configOut } from './mapping';
import { DEFAULT_POLICY, Policy, policyError } from './engine';

// The timesheet settings singleton (unique org_id): the company limits (the dashboard's setPolicy ranges and words) and
// the people who track time. Load-or-default, change one aspect, upsert the whole row — the benefits / merit-cycle
// singleton pattern.

const T = 'hrms_ts_config';

export async function loadConfig(s: HrmsScope): Promise<Row | null> {
  return must(await scoped(db().from(T).select('*'), s).maybeSingle()) as Row | null;
}

export const policyOf = (row: Row | null): Policy => (row
  ? { maxPerDay: Number(row.max_per_day), weeklyCap: Number(row.weekly_cap), standardWeek: Number(row.standard_week) }
  : { ...DEFAULT_POLICY });

export const trackedOf = (row: Row | null): string[] => (Array.isArray(row?.tracked_ids) ? (row!.tracked_ids as unknown[]).map(String) : []);

async function save(s: HrmsScope, policy: Policy, tracked: string[]): Promise<Row> {
  const res = await db().from(T)
    .upsert({ ...scopeCols(s), max_per_day: policy.maxPerDay, weekly_cap: policy.weeklyCap, standard_week: policy.standardWeek, tracked_ids: tracked, updated_at: now() }, { onConflict: 'org_id' })
    .select('*').single();
  if (res.error) throw fail(res.error);
  return res.data as Row;
}

export async function setPolicy(s: HrmsScope, patch: { max_per_day?: number; weekly_cap?: number; standard_week?: number }): Promise<Row> {
  const cur = await loadConfig(s);
  const p = policyOf(cur);
  const next: Policy = {
    maxPerDay: patch.max_per_day ?? p.maxPerDay,
    weeklyCap: patch.weekly_cap ?? p.weeklyCap,
    standardWeek: patch.standard_week ?? p.standardWeek,
  };
  const err = policyError(next);
  if (err) throw invalid(err);
  return configOut(await save(s, next, trackedOf(cur)));
}

/** Who tracks time. Every id must be a current (not deleted) employee of the org; the list is stored de-duplicated. */
export async function setTracked(s: HrmsScope, ids: string[]): Promise<Row> {
  const wanted = [...new Set(ids)];
  if (wanted.length) {
    const people = await fetchAll<Row>((from, to) => scoped(db().from('hrms_employees').select('id'), s).is('deleted_at', null).in('id', wanted).range(from, to));
    const known = new Set(people.map((p) => String(p.id)));
    if (wanted.some((id) => !known.has(id))) throw invalid('Choose people from this company.');
  }
  const cur = await loadConfig(s);
  return configOut(await save(s, policyOf(cur), wanted));
}
