import { db, fail, HrmsScope, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { insertIdempotent, newId, notFound, now } from '../payroll/common';
import { complianceOut } from './mapping';

// Compliance tasks (the statutory calendar). A task is a statutory due date for one legal entity. The entity must be one of the org's
// (CASCADE-linked). The dashboard derives the task's status (upcoming / due_soon / filed / overdue) client-side, so the server stores and
// returns NO `status`; filed_on + reference are the markFiled fields (setting them records a filing, clearing them reopens it). The law,
// dates and enum shapes are validated by the schema.

const T = 'hrms_compliance_tasks';

const find = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

/** An entity of the org, or null. */
const orgEntity = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from('hrms_entities').select('id'), s).eq('id', id).maybeSingle()) as Row | null;

/** The effective compliance columns from a source object (create: the request; update: current merged with the patch). */
function columnsOf(src: Row): Row {
  return {
    name: String(src.name ?? '').trim(),
    law: src.law,
    due_on: src.due_on,
    entity_id: src.entity_id,
    state: src.state ?? null,
    filed_on: src.filed_on ?? null,
    reference: src.reference ?? null,
  };
}

export async function createCompliance(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: complianceOut(existing), created: false };
  }
  if (!(await orgEntity(s, String(input.entity_id)))) throw notFound('Entity not found');
  const columns = columnsOf(input);
  const r = await insertIdempotent(s, T, { id, ...columns }, !!input.id, () => find(s, id));
  return { row: complianceOut(r.row), created: r.created };
}

export async function updateCompliance(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Compliance task not found');
  if (patch.entity_id !== undefined && !(await orgEntity(s, String(patch.entity_id)))) throw notFound('Entity not found');
  const merged: Row = { ...current };
  for (const k of ['name', 'law', 'due_on', 'entity_id', 'state', 'filed_on', 'reference'] as const) {
    if (patch[k] !== undefined) merged[k] = patch[k];
  }
  const columns = columnsOf(merged);
  const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return complianceOut(res.data as Row);
}

export async function deleteCompliance(s: HrmsScope, id: string): Promise<{ id: string }> {
  const current = await find(s, id);
  if (!current) throw notFound('Compliance task not found');
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}
