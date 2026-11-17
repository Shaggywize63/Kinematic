import { db, fail, fetchAll, HrmsScope, isUniqueViolation, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, notFound, now } from '../payroll/common';
import { projectOut } from './mapping';

// The projects people log hours against. Create / edit / archive (an archived project stays on the weeks that used it but
// cannot be added to a new week). Names are unique per org, case-insensitive (the unique index is the backstop). A
// non-billable project carries no rate.

const T = 'hrms_ts_projects';

export async function listProjects(s: HrmsScope): Promise<Row[]> {
  return fetchAll<Row>((from, to) => scoped(db().from(T).select('*'), s).order('name', { ascending: true }).range(from, to));
}

export const findProject = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

const nameTaken = (name: string) => invalid(`There is already a project called ${name}.`);

async function assertNameFree(s: HrmsScope, name: string, exceptId?: string): Promise<void> {
  const rows = await listProjects(s);
  const clash = rows.find((p) => String(p.name).trim().toLowerCase() === name.trim().toLowerCase() && p.id !== exceptId);
  if (clash) throw nameTaken(name.trim());
}

export async function createProject(s: HrmsScope, input: {
  id?: string; name: string; client?: string; kind: 'client' | 'internal'; billable: boolean; budget_hours?: number; prior_hours?: number; rate?: number;
}): Promise<{ row: Row; created: boolean }> {
  if (input.id) {
    const mine = await findProject(s, input.id);
    if (mine) return { row: projectOut(mine), created: false };   // idempotent retry with the same client id
  }
  const name = input.name.trim();
  await assertNameFree(s, name);
  const row: Row = {
    ...scopeCols(s), name, client: (input.client ?? '').trim(), kind: input.kind, billable: input.billable,
    budget_hours: input.budget_hours ?? 0, prior_hours: input.prior_hours ?? 0, rate: input.billable ? (input.rate ?? 0) : 0,
  };
  if (input.id) row.id = input.id;
  const res = await db().from(T).insert(row).select('*').single();
  if (res.error) {
    if (isUniqueViolation(res.error, 'name')) throw nameTaken(name);
    throw fail(res.error);
  }
  return { row: projectOut(res.data as Row), created: true };
}

export async function updateProject(s: HrmsScope, id: string, patch: {
  name?: string; client?: string; kind?: 'client' | 'internal'; billable?: boolean; budget_hours?: number; prior_hours?: number; rate?: number; archived?: boolean;
}): Promise<Row> {
  const cur = await findProject(s, id);
  if (!cur) throw notFound('That project is not in the list.');
  const next: Row = { updated_at: now() };
  if (patch.name !== undefined) { await assertNameFree(s, patch.name, id); next.name = patch.name.trim(); }
  if (patch.client !== undefined) next.client = patch.client.trim();
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.billable !== undefined) next.billable = patch.billable;
  if (patch.budget_hours !== undefined) next.budget_hours = patch.budget_hours;
  if (patch.prior_hours !== undefined) next.prior_hours = patch.prior_hours;
  if (patch.rate !== undefined) next.rate = patch.rate;
  if (patch.archived !== undefined) next.archived = patch.archived;
  const billable = next.billable ?? cur.billable;
  if (!billable) next.rate = 0;
  const res = await scoped(db().from(T).update(next), s).eq('id', id).select('*');
  if (res.error) {
    if (isUniqueViolation(res.error, 'name')) throw nameTaken(String(patch.name ?? cur.name).trim());
    throw fail(res.error);
  }
  const rows = (res.data ?? []) as Row[];
  if (!rows.length) throw notFound('That project is not in the list.');
  return projectOut(rows[0]!);
}
