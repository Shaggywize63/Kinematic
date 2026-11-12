import { db, fail, HrmsScope, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { insertIdempotent, invalid, newId, notFound, now } from '../payroll/common';
import { issuedLetterOut } from './mapping';

// Issued letters (the register). A letter is pre-rendered text from the client; the server stores it as is (no PDF this phase). The
// employee must be one of the org's; template_id may be null (an ad-hoc letter) but, when given, must be one of the org's templates.
// PUT is mainly used to set `signed` once the signed copy is back (markLetterSigned), but body / type / issued_on may change too.

const T = 'hrms_issued_letters';

const find = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

const liveEmployee = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from('hrms_employees').select('id'), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;
const template = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from('hrms_letter_templates').select('id'), s).eq('id', id).maybeSingle()) as Row | null;

export async function createLetter(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: issuedLetterOut(existing), created: false };
  }
  if (!(await liveEmployee(s, String(input.employee_id)))) throw notFound('Employee not found');
  const templateId = input.template_id ?? null;
  if (templateId && !(await template(s, String(templateId)))) throw notFound('Template not found');
  const body = String(input.body ?? '');
  if (body.trim().length === 0) throw invalid('The letter body is empty');
  const columns = {
    employee_id: input.employee_id, template_id: templateId, type: input.type, issued_on: input.issued_on, body,
    signed: input.signed === undefined ? false : !!input.signed,
  };
  const r = await insertIdempotent(s, T, { id, ...columns }, !!input.id, () => find(s, id));
  return { row: issuedLetterOut(r.row), created: r.created };
}

export async function updateLetter(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Letter not found');
  if (patch.template_id !== undefined && patch.template_id !== null && !(await template(s, String(patch.template_id)))) throw notFound('Template not found');
  const columns: Row = {};
  for (const k of ['template_id', 'type', 'issued_on', 'signed'] as const) if (patch[k] !== undefined) columns[k] = k === 'signed' ? !!patch[k] : patch[k];
  if (patch.body !== undefined) {
    const body = String(patch.body ?? '');
    if (body.trim().length === 0) throw invalid('The letter body is empty');
    columns.body = body;
  }
  const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return issuedLetterOut(res.data as Row);
}

export async function deleteLetter(s: HrmsScope, id: string): Promise<{ id: string }> {
  const current = await find(s, id);
  if (!current) throw notFound('Letter not found');
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}
