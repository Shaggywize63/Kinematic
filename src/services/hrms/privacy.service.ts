import { AppError } from '../../utils';
import { REVEAL_FIELDS } from './schemas';
import { db, fail, HrmsScope, must, scopeCols, scoped } from './scope';
import { readBank, readPan, publicRow, Row } from './model';
import { getEmployeeRow } from './employees.service';

export type RevealField = (typeof REVEAL_FIELDS)[number];

/**
 * Return a sensitive value in full, after writing who asked, when, for which employee and field, and why.
 * The log row is written BEFORE the value is returned and a failed write means no value: nothing is revealed unrecorded.
 * Nothing is logged when there is nothing to reveal.
 */
export async function revealField(s: HrmsScope, employeeId: string, field: RevealField, reason: string): Promise<{ field: RevealField; value: unknown }> {
  const row = await getEmployeeRow(s, employeeId);
  let value: unknown;
  if (field === 'pan') {
    if (!row.pan_enc) throw new AppError(404, 'No PAN on file for this employee', 'NOT_FOUND');
    value = readPan(row);
  } else if (field === 'bank') {
    if (!row.bank_enc) throw new AppError(404, 'No bank details on file for this employee', 'NOT_FOUND');
    value = readBank(row);
  } else {
    if (!row.aadhaar_last4) throw new AppError(404, 'No Aadhaar on file for this employee', 'NOT_FOUND');
    value = row.aadhaar_last4;
  }
  if (!value) throw new AppError(500, 'This value cannot be read with the current encryption key', 'DECRYPT_FAILED');

  const { error } = await db().from('hrms_access_log').insert({
    ...scopeCols(s), at: new Date().toISOString(), by_user_id: s.user_id, by_name: s.actor, employee_id: employeeId, field, reason,
  });
  if (error) throw fail(error);
  return { field, value };
}

/** Newest first, at most 200. Optionally one employee's entries. */
export async function listAccessLog(s: HrmsScope, employeeId?: string, limit = 200): Promise<Row[]> {
  let q = scoped(db().from('hrms_access_log').select('*'), s);
  if (employeeId) q = q.eq('employee_id', employeeId);
  const rows = must(await q.order('at', { ascending: false }).limit(Math.min(200, Math.max(1, limit)))) as Row[] | null;
  return (rows ?? []).map(publicRow);
}
