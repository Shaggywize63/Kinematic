import { db, fail, HrmsScope, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { insertIdempotent, invalid, newId, notFound, now } from '../payroll/common';
import { letterTemplateOut } from './mapping';
import { validateTemplate } from './validation';

// Letter templates. The rules are the dashboard's (TemplateEditor.tsx save()), with its words: name 2 to 80 characters, body at least
// 20 characters. type is one of the seven LetterType values (checked by the schema). Deleting a template is allowed even when letters
// were issued from it: the issued-letter register's template_id is set null (the rendered body is kept), so there is no delete guard.

const T = 'hrms_letter_templates';

const find = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

/** The effective columns from a source object, after the dashboard's name / body checks. */
function columnsOf(src: Row): Row {
  const name = String(src.name ?? '').trim();
  const body = String(src.body ?? '');
  const problem = validateTemplate(name, body);
  if (problem) throw invalid(problem);
  return { type: src.type, name, body };
}

export async function createLetterTemplate(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: letterTemplateOut(existing), created: false };
  }
  const columns = columnsOf(input);
  const r = await insertIdempotent(s, T, { id, ...columns }, !!input.id, () => find(s, id));
  return { row: letterTemplateOut(r.row), created: r.created };
}

export async function updateLetterTemplate(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Template not found');
  const merged: Row = { ...current };
  for (const k of ['type', 'name', 'body'] as const) if (patch[k] !== undefined) merged[k] = patch[k];
  const columns = columnsOf(merged);
  const res = await scoped(db().from(T).update({ ...columns, updated_at: now() }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return letterTemplateOut(res.data as Row);
}

export async function deleteLetterTemplate(s: HrmsScope, id: string): Promise<{ id: string }> {
  const current = await find(s, id);
  if (!current) throw notFound('Template not found');
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}
