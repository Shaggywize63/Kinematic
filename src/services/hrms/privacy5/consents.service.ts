import { db, fail, HrmsScope, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { insertIdempotent, newId, notFound, now } from '../payroll/common';
import { consentOut } from './mapping';

// Consent records (the DPDP ledger). A consent names an employee of the org (CASCADE-linked), a purpose, the notice version and when it
// was granted. Withdrawing is a PUT that sets withdrawn_at: the row stays on the ledger as evidence (the dashboard's withdrawConsent never
// deletes). Clearing withdrawn_at (null) re-grants. employee_id is fixed once created.

const T = 'hrms_consents';

const find = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

/** A live (not soft-deleted) employee of the org, or null. */
const liveEmployee = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from('hrms_employees').select('id'), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;

/** The effective consent columns from a source object (create: the request; update: current merged with the patch). */
function columnsOf(src: Row): Row {
  return {
    employee_id: src.employee_id,
    purpose: String(src.purpose ?? '').trim(),
    notice_version: String(src.notice_version ?? '').trim(),
    granted_at: src.granted_at,
    withdrawn_at: src.withdrawn_at ?? null,
  };
}

export async function createConsent(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: consentOut(existing), created: false };
  }
  if (!(await liveEmployee(s, String(input.employee_id)))) throw notFound('Employee not found');
  const columns = columnsOf(input);
  const r = await insertIdempotent(s, T, { id, ...columns }, !!input.id, () => find(s, id));
  return { row: consentOut(r.row), created: r.created };
}

export async function updateConsent(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Consent record not found');
  const merged: Row = { ...current };
  for (const k of ['purpose', 'notice_version', 'granted_at', 'withdrawn_at'] as const) {
    if (patch[k] !== undefined) merged[k] = patch[k];
  }
  const columns = columnsOf(merged);
  const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return consentOut(res.data as Row);
}

export async function deleteConsent(s: HrmsScope, id: string): Promise<{ id: string }> {
  const current = await find(s, id);
  if (!current) throw notFound('Consent record not found');
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}
