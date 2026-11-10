import crypto from 'crypto';
import { logger } from '../../lib/logger';
import { db, fail, fetchAll, HrmsScope, isUniqueViolation, scoped } from './scope';
import { ApiEmployee, historyRow, Row, toApiEmployee } from './model';
import { employeeCreate, issueText } from './schemas';
import { loadIndex, buildInsertRow, refProblem, OrgIndex } from './employees.service';
import { reserveCodes } from './settings.service';

// Bulk create: up to 500 rows, each validated on its own. A bad row is reported ({ row, error }) and skipped; it never
// fails the others ("atomic per row, not per file"). A dry run validates everything and writes nothing (and uses up no
// employee codes).
//
// Row shape: the same as POST /employees (snake_case, optional client `id`, optional `code`, `pan`, `bank`,
// `aadhaar_last4`), plus a convenience for spreadsheets: `department`, `designation` and `location` may be given as NAMES
// (matched case-insensitively) instead of `*_id`, and `entity_id` is taken from the location when it is not given.
// `row` in an error is the 1-based position in `rows`.

export interface ImportError { row: number; error: string }
export interface ImportResult {
  dry_run: boolean;
  total: number;
  /** Rows that passed validation (a dry run stops here). */
  valid: number;
  /** Rows actually written; always 0 on a dry run. */
  created: number;
  /** Rows whose client `id` already existed: left as they are, not an error. */
  existing: number;
  failed: number;
  errors: ImportError[];
  employees: ApiEmployee[];
}

const CHUNK = 100;
const lc = (v: unknown) => String(v ?? '').trim().toLowerCase();

interface Names { entities: Map<string, string>; locations: Map<string, string>; departments: Map<string, string>; designations: Map<string, string> }

async function loadNames(s: HrmsScope): Promise<Names> {
  const byName = async (table: string) => {
    const rows = await fetchAll<Row>((from, to) => scoped(db().from(table).select('id,name'), s).order('id', { ascending: true }).range(from, to));
    const m = new Map<string, string>();
    for (const r of rows) if (!m.has(lc(r.name))) m.set(lc(r.name), String(r.id)); // first one wins on a duplicate name
    return m;
  };
  const [entities, locations, departments, designations] = await Promise.all([
    byName('hrms_entities'), byName('hrms_locations'), byName('hrms_departments'), byName('hrms_designations'),
  ]);
  return { entities, locations, departments, designations };
}

/** Fill `*_id` from names where the id is missing. Returns an error text for a name that matches nothing. */
function resolveNames(raw: Row, names: Names, ix: OrgIndex): { row: Row; error?: string } {
  const row: Row = { ...raw };
  const pairs: Array<[string, string, Map<string, string>, string]> = [
    ['department', 'department_id', names.departments, 'department'],
    ['designation', 'designation_id', names.designations, 'designation'],
    ['location', 'location_id', names.locations, 'location'],
    ['entity', 'entity_id', names.entities, 'legal entity'],
  ];
  for (const [nameKey, idKey, map, noun] of pairs) {
    const given = row[nameKey];
    delete row[nameKey];
    if (row[idKey] !== undefined && row[idKey] !== null && row[idKey] !== '') continue;
    if (given === undefined || given === null || String(given).trim() === '') continue;
    const id = map.get(lc(given));
    if (!id) return { row, error: `Unknown ${noun} "${String(given).slice(0, 80)}"` };
    row[idKey] = id;
  }
  if ((row.entity_id === undefined || row.entity_id === null || row.entity_id === '') && typeof row.location_id === 'string') {
    const entity = ix.locations.get(row.location_id);
    if (entity) row.entity_id = entity;
  }
  return { row };
}

export async function importEmployees(s: HrmsScope, rows: unknown[], dryRun: boolean): Promise<ImportResult> {
  const errors: ImportError[] = [];
  const [ix, names, live] = await Promise.all([
    loadIndex(s, true),
    loadNames(s),
    fetchAll<Row>((from, to) => scoped(db().from('hrms_employees').select('id,code'), s).is('deleted_at', null).order('id', { ascending: true }).range(from, to)),
  ]);
  const takenCodes = new Set(live.map((r) => String(r.code).toLowerCase()));
  const takenIds = new Set(live.map((r) => String(r.id)));

  // 1. validate every row in memory
  interface Ready { row: number; id: string; input: Row }
  const ready: Ready[] = [];
  const seenCodes = new Set<string>();
  const seenIds = new Set<string>();
  let existing = 0;
  rows.forEach((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push({ row: n, error: 'Each row must be an object' }); return; }
    const named = resolveNames(raw as Row, names, ix);
    if (named.error) { errors.push({ row: n, error: named.error }); return; }
    const parsed = employeeCreate.safeParse(named.row);
    if (!parsed.success) { errors.push({ row: n, error: issueText(parsed.error.issues, 3) }); return; }
    const input = { ...(parsed.data as Row) };
    delete input.documents; // documents are added through their own endpoint
    const id = (input.id as string | undefined) ?? crypto.randomUUID();
    if (input.id && takenIds.has(id)) { existing += 1; return; } // idempotent re-run: already there
    if (seenIds.has(id)) { errors.push({ row: n, error: 'id: Repeated in this file' }); return; }
    const problem = refProblem(ix, input, id);
    if (problem) { errors.push({ row: n, error: problem }); return; }
    if (input.code) {
      const key = String(input.code).toLowerCase();
      if (takenCodes.has(key)) { errors.push({ row: n, error: `code: ${String(input.code)} is already in use` }); return; }
      if (seenCodes.has(key)) { errors.push({ row: n, error: `code: ${String(input.code)} is repeated in this file` }); return; }
      seenCodes.add(key);
    }
    seenIds.add(id);
    ready.push({ row: n, id, input });
  });

  const base = { dry_run: dryRun, total: rows.length, valid: ready.length, existing };
  if (dryRun) {
    errors.sort((a, b) => a.row - b.row);
    return { ...base, created: 0, failed: errors.length, errors, employees: [] };
  }

  // 2. codes for the rows that did not bring their own (one round trip for the whole block)
  const needCodes = ready.filter((r) => !r.input.code);
  const codes = needCodes.length ? await reserveCodes(s, needCodes.length) : [];
  let next = 0;
  const withCode = ready.map((r) => ({ ...r, code: (r.input.code as string | undefined) ?? codes[next++]! }));

  // 3. write: whole chunks at once, falling back to row by row inside a chunk that fails so each error lands on its row
  const created: Array<{ row: Row; at: string; n: number }> = [];
  const now = new Date().toISOString();
  const fallback = async (r: (typeof withCode)[number]) => {
    const res = await db().from('hrms_employees').insert(buildInsertRow(s, r.id, r.code, r.input)).select('*').single();
    if (res.error) {
      if (isUniqueViolation(res.error, 'org_code')) { errors.push({ row: r.row, error: `code: ${r.code} is already in use` }); return; }
      logger.warn(`[hrms] import row ${r.row} failed: ${res.error.message}`);
      errors.push({ row: r.row, error: 'Could not be saved' });
      return;
    }
    created.push({ row: res.data as Row, at: now, n: r.row });
  };
  for (let i = 0; i < withCode.length; i += CHUNK) {
    const chunk = withCode.slice(i, i + CHUNK);
    const res = await db().from('hrms_employees').insert(chunk.map((r) => buildInsertRow(s, r.id, r.code, r.input))).select('*');
    if (!res.error) {
      const back = new Map(((res.data as Row[] | null) ?? []).map((r) => [String(r.id), r]));
      chunk.forEach((r) => { const row = back.get(r.id); if (row) created.push({ row, at: now, n: r.row }); });
      continue;
    }
    if (fail(res.error).statusCode === 503) throw fail(res.error);
    for (const r of chunk) await fallback(r);
  }

  // 4. one "Created" line per new employee
  const createdHistory = new Map<string, Row>();
  if (created.length) {
    const hist = await db().from('hrms_employee_history').insert(
      created.map((c) => historyRow(s, { employee_id: String(c.row.id), field: 'Employee', from_value: null, to_value: 'Created' }, c.at)),
    ).select('*');
    for (const h of (hist.data as Row[] | null) ?? []) createdHistory.set(String(h.employee_id), h);
    if (hist.error) {
      // The people exist but their "Created" line could not be written: take them out again rather than leave them unlogged.
      logger.error(`[hrms] import: change-log write failed (${hist.error.message}); rolling the batch back`);
      await scoped(db().from('hrms_employees').delete(), s).in('id', created.map((c) => String(c.row.id)));
      throw fail(hist.error);
    }
  }

  errors.sort((a, b) => a.row - b.row);
  const out = created.sort((a, b) => a.n - b.n).map((c) => toApiEmployee(c.row, [], createdHistory.has(String(c.row.id)) ? [createdHistory.get(String(c.row.id))!] : []));
  return { ...base, created: out.length, failed: errors.length, errors, employees: out };
}
