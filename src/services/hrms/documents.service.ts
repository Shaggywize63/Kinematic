import crypto from 'crypto';
import { AppError } from '../../utils';
import { db, fail, HrmsScope, isUniqueViolation, must, scopeCols, scoped } from './scope';
import { historyRow, publicRow, Row } from './model';
import { getEmployeeRow } from './employees.service';

const DOCS = 'hrms_employee_documents';
const FIELDS = ['type', 'name', 'uploaded_on', 'status', 'mandatory', 'file_name'] as const;

async function findDocument(s: HrmsScope, employeeId: string, docId: string): Promise<Row | null> {
  return must(await scoped(db().from(DOCS).select('*'), s).eq('employee_id', employeeId).eq('id', docId).maybeSingle()) as Row | null;
}

async function logDocument(s: HrmsScope, employeeId: string, name: unknown, from: string | null, to: string | null): Promise<void> {
  const { error } = await db().from('hrms_employee_history').insert(
    historyRow(s, { employee_id: employeeId, field: `Document: ${String(name)}`, from_value: from, to_value: to }, new Date().toISOString()),
  );
  if (error) throw fail(error);
}

/** Add a document record to an employee. A client-supplied id makes the call idempotent (the existing record is returned). */
export async function addDocument(s: HrmsScope, employeeId: string, input: Row): Promise<{ document: Row; created: boolean }> {
  await getEmployeeRow(s, employeeId);
  const id = (input.id as string | undefined) ?? crypto.randomUUID();
  if (input.id) {
    const existing = await findDocument(s, employeeId, id);
    if (existing) return { document: publicRow(existing), created: false };
  }
  const row: Row = {
    id, ...scopeCols(s), employee_id: employeeId, type: input.type, name: input.name,
    uploaded_on: input.uploaded_on ?? new Date().toISOString().slice(0, 10), status: input.status ?? 'pending',
    mandatory: input.mandatory ?? false, file_name: input.file_name ?? null,
  };
  const res = await db().from(DOCS).insert(row).select('*').single();
  if (res.error) {
    if (input.id && isUniqueViolation(res.error, 'pkey')) {
      const mine = await findDocument(s, employeeId, id);
      if (mine) return { document: publicRow(mine), created: false };
      throw new AppError(409, 'This id is already in use', 'ID_IN_USE');
    }
    throw fail(res.error);
  }
  await logDocument(s, employeeId, row.name, null, `Added (${String(row.status)})`);
  return { document: publicRow(res.data as Row), created: true };
}

/** Partial update of a document record. A status change or a new file name is logged on the employee. */
export async function updateDocument(s: HrmsScope, employeeId: string, docId: string, patch: Row): Promise<Row> {
  await getEmployeeRow(s, employeeId);
  const current = await findDocument(s, employeeId, docId);
  if (!current) throw new AppError(404, 'Document not found', 'NOT_FOUND');
  const change: Row = {};
  for (const f of FIELDS) if (patch[f] !== undefined && patch[f] !== current[f]) change[f] = patch[f];
  if (!Object.keys(change).length) return publicRow(current);

  const res = await scoped(db().from(DOCS).update({ ...change, updated_at: new Date().toISOString() }), s).eq('employee_id', employeeId).eq('id', docId).select('*').single();
  if (res.error) throw fail(res.error);
  const next = res.data as Row;
  if (change.status !== undefined) await logDocument(s, employeeId, next.name, String(current.status), String(next.status));
  else if (change.file_name !== undefined && next.file_name) await logDocument(s, employeeId, next.name, null, `File ${String(next.file_name)}`);
  return publicRow(next);
}

export async function deleteDocument(s: HrmsScope, employeeId: string, docId: string): Promise<{ id: string }> {
  await getEmployeeRow(s, employeeId);
  const current = await findDocument(s, employeeId, docId);
  if (!current) throw new AppError(404, 'Document not found', 'NOT_FOUND');
  const { error } = await scoped(db().from(DOCS).delete(), s).eq('employee_id', employeeId).eq('id', docId);
  if (error) throw fail(error);
  await logDocument(s, employeeId, current.name, String(current.status), 'Removed');
  return { id: docId };
}
