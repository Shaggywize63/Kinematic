import crypto from 'crypto';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import {
  db, fail, fetchAll, HrmsScope, isUniqueViolation, must, scopeCols, scoped,
} from './scope';
import {
  ApiEmployee, changeText, diffEmployee, historyRow, interpretBank, interpretPan, PLAIN_COLUMNS, readBank, readPan, REF_FIELDS, Row, sameValue,
  sealBank, sealPan, toApiEmployee, wouldCreateCycle,
} from './model';
import { reserveCodes } from './settings.service';

const EMP = 'hrms_employees';
const DOCS = 'hrms_employee_documents';
const HIST = 'hrms_employee_history';
export const HISTORY_CAP = 200;

// ── reading ─────────────────────────────────────────────────────────────────
/** One live (not deleted) employee row of the caller's org, or 404. */
export async function getEmployeeRow(s: HrmsScope, id: string): Promise<Row> {
  const row = must(await scoped(db().from(EMP).select('*'), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;
  if (!row) throw new AppError(404, 'Employee not found', 'NOT_FOUND');
  return row;
}

/** One employee with documents and history (newest first, capped), masked. */
export async function loadEmployee(s: HrmsScope, id: string): Promise<ApiEmployee> {
  const [row, docs, hist] = await Promise.all([
    getEmployeeRow(s, id),
    scoped(db().from(DOCS).select('*'), s).eq('employee_id', id).order('created_at', { ascending: true }),
    scoped(db().from(HIST).select('*'), s).eq('employee_id', id).order('at', { ascending: false }).limit(HISTORY_CAP),
  ]);
  return toApiEmployee(row, (must(docs) as Row[] | null) ?? [], (must(hist) as Row[] | null) ?? []);
}

/** Every live employee of the org with documents and history, masked. */
export async function listEmployees(s: HrmsScope): Promise<ApiEmployee[]> {
  const [rows, docs, hist] = await Promise.all([
    fetchAll<Row>((from, to) => scoped(db().from(EMP).select('*'), s).is('deleted_at', null).order('code', { ascending: true }).order('id', { ascending: true }).range(from, to)),
    fetchAll<Row>((from, to) => scoped(db().from(DOCS).select('*'), s).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to)),
    fetchAll<Row>((from, to) => scoped(db().from(HIST).select('*'), s).order('at', { ascending: false }).order('id', { ascending: false }).range(from, to)),
  ]);
  const docsBy = new Map<string, Row[]>();
  for (const d of docs) { const k = String(d.employee_id); (docsBy.get(k) ?? docsBy.set(k, []).get(k)!).push(d); }
  const histBy = new Map<string, Row[]>();
  for (const h of hist) {
    const k = String(h.employee_id);
    const list = histBy.get(k) ?? histBy.set(k, []).get(k)!;
    if (list.length < HISTORY_CAP) list.push(h);
  }
  return rows.map((r) => toApiEmployee(r, docsBy.get(String(r.id)) ?? [], histBy.get(String(r.id)) ?? []));
}

// ── references ──────────────────────────────────────────────────────────────
/** The org's structure as ids, to check foreign keys in memory. `employees` maps each live employee to who they report to. */
export interface OrgIndex {
  entities: Set<string>;
  /** location id -> its legal entity id */
  locations: Map<string, string>;
  departments: Set<string>;
  designations: Set<string>;
  employees: Map<string, string | null>;
}

export async function loadIndex(s: HrmsScope, withEmployees: boolean): Promise<OrgIndex> {
  const ids = (table: string, cols = 'id') => fetchAll<Row>((from, to) => scoped(db().from(table).select(cols), s).order('id', { ascending: true }).range(from, to));
  const [entities, locations, departments, designations, employees] = await Promise.all([
    ids('hrms_entities'), ids('hrms_locations', 'id,entity_id'), ids('hrms_departments'), ids('hrms_designations'),
    withEmployees
      ? fetchAll<Row>((from, to) => scoped(db().from(EMP).select('id,reporting_to_id'), s).is('deleted_at', null).order('id', { ascending: true }).range(from, to))
      : Promise.resolve([] as Row[]),
  ]);
  return {
    entities: new Set(entities.map((r) => String(r.id))),
    locations: new Map(locations.map((r) => [String(r.id), String(r.entity_id)])),
    departments: new Set(departments.map((r) => String(r.id))),
    designations: new Set(designations.map((r) => String(r.id))),
    employees: new Map(employees.map((r) => [String(r.id), (r.reporting_to_id as string | null) ?? null])),
  };
}

/** The first problem with the foreign keys in `r` (only keys that are present are checked), as a 400 message, or null. */
export function refProblem(ix: OrgIndex, r: Row, selfId?: string): string | null {
  if (r.entity_id !== undefined && !ix.entities.has(String(r.entity_id))) return 'entity_id: Unknown legal entity';
  if (r.location_id !== undefined && !ix.locations.has(String(r.location_id))) return 'location_id: Unknown location';
  if (r.department_id !== undefined && !ix.departments.has(String(r.department_id))) return 'department_id: Unknown department';
  if (r.designation_id !== undefined && !ix.designations.has(String(r.designation_id))) return 'designation_id: Unknown designation';
  if (r.reporting_to_id) {
    const m = String(r.reporting_to_id);
    if (selfId && m === selfId) return 'reporting_to_id: An employee cannot report to themselves';
    if (!ix.employees.has(m)) return 'reporting_to_id: Unknown employee';
    if (selfId && wouldCreateCycle(selfId, m, ix.employees)) return 'reporting_to_id: This would create a reporting loop';
  }
  return null;
}

/** Display names for the foreign-key ids in a set of changes, so the log reads "Sales" rather than a uuid. */
async function resolveNames(s: HrmsScope, ids: Partial<Record<keyof typeof REF_FIELDS, Set<string>>>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(Object.entries(ids).map(async ([field, set]) => {
    if (!set || !set.size) return;
    const table = REF_FIELDS[field as keyof typeof REF_FIELDS];
    const cols = table === EMP ? 'id,first_name,last_name,code' : 'id,name';
    const { data } = await scoped(db().from(table).select(cols), s).in('id', [...set]);
    for (const r of (data as unknown as Row[] | null) ?? []) {
      names.set(String(r.id), table === EMP ? `${String(r.first_name)} ${String(r.last_name ?? '')}`.trim() + ` (${String(r.code)})` : String(r.name));
    }
  }));
  return names;
}

// ── create ──────────────────────────────────────────────────────────────────
export interface CreatedEmployee { employee: ApiEmployee; created: boolean }

/** The insert row for a new employee (everything the input carries; the database fills the defaults for the rest). */
export function buildInsertRow(s: HrmsScope, id: string, code: string, input: Row): Row {
  const row: Row = { id, ...scopeCols(s), code };
  for (const col of PLAIN_COLUMNS) if (input[col] !== undefined) row[col] = input[col];
  const pan = interpretPan(input.pan);
  if ('value' in pan) row.pan_enc = sealPan(id, pan.value);
  const bank = interpretBank(input.bank, null);
  if ('value' in bank) row.bank_enc = sealBank(id, bank.value);
  return row;
}

const codeTaken = (code: string) => new AppError(409, `Employee code ${code} is already in use`, 'CODE_TAKEN');

function documentRows(s: HrmsScope, employeeId: string, docs: Row[], today: string): Row[] {
  return docs.map((d) => ({
    id: d.id ?? crypto.randomUUID(), ...scopeCols(s), employee_id: employeeId, type: d.type, name: d.name,
    uploaded_on: d.uploaded_on ?? today, status: d.status ?? 'pending', mandatory: d.mandatory ?? false, file_name: d.file_name ?? null,
  }));
}

/** Remove a just-inserted employee (cascades to its documents and history) when a later step failed: no half-created people. */
async function undoCreate(s: HrmsScope, id: string): Promise<void> {
  const { error } = await scoped(db().from(EMP).delete(), s).eq('id', id);
  if (error) logger.error(`[hrms] could not roll back employee ${id} after a failed create: ${error.message}`);
}

export async function createEmployee(s: HrmsScope, input: Row): Promise<CreatedEmployee> {
  const id = (input.id as string | undefined) ?? crypto.randomUUID();

  if (input.id) {
    // Idempotent: the same client id answers with the row that already exists.
    const existing = must(await scoped(db().from(EMP).select('id,deleted_at'), s).eq('id', id).maybeSingle()) as Row | null;
    if (existing) {
      if (existing.deleted_at) throw new AppError(409, 'This id belongs to a deleted employee', 'ID_IN_USE');
      return { employee: await loadEmployee(s, id), created: false };
    }
  }

  const ix = await loadIndex(s, !!input.reporting_to_id);
  const problem = refProblem(ix, input, id);
  if (problem) throw new AppError(400, problem, 'VALIDATION');

  let row: Row | null = null;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    const code = (input.code as string | undefined) ?? (await reserveCodes(s, 1))[0]!;
    const res = await db().from(EMP).insert(buildInsertRow(s, id, code, input)).select('*').single();
    if (!res.error) { row = res.data as Row; break; }
    if (isUniqueViolation(res.error, 'org_code')) {
      if (input.code) throw codeTaken(code);
      continue; // an auto code collided with a hand-typed one: take the next number
    }
    if (input.id && isUniqueViolation(res.error, 'pkey')) {
      // Lost a race with the same client id (or the id is another org's): answer idempotently if it is ours.
      const mine = must(await scoped(db().from(EMP).select('id').eq('id', id), s).maybeSingle()) as Row | null;
      if (mine) return { employee: await loadEmployee(s, id), created: false };
      throw new AppError(409, 'This id is already in use', 'ID_IN_USE');
    }
    throw fail(res.error);
  }
  if (!row) throw new AppError(409, 'Could not find a free employee code. Try again.', 'CODE_TAKEN');

  try {
    const now = new Date().toISOString();
    const hist = await db().from(HIST).insert(historyRow(s, { employee_id: id, field: 'Employee', from_value: null, to_value: 'Created' }, now));
    if (hist.error) throw fail(hist.error);
    const docs = documentRows(s, id, (input.documents as Row[] | undefined) ?? [], now.slice(0, 10));
    if (docs.length) {
      const ins = await db().from(DOCS).insert(docs);
      if (ins.error) throw fail(ins.error);
    }
  } catch (e) {
    await undoCreate(s, id);
    throw e;
  }
  return { employee: await loadEmployee(s, id), created: true };
}

// ── update ──────────────────────────────────────────────────────────────────
export async function updateEmployee(s: HrmsScope, id: string, patch: Row): Promise<ApiEmployee> {
  const current = await getEmployeeRow(s, id);
  if (patch.code !== undefined && patch.code !== current.code) throw new AppError(400, 'code: The employee code cannot be changed', 'CODE_IMMUTABLE');

  // 1. the plain columns that were sent
  const sent: Row = {};
  for (const col of PLAIN_COLUMNS) if (patch[col] !== undefined) sent[col] = patch[col];

  // 2. foreign keys + reporting line, checked only for what was sent
  if (Object.keys(REF_FIELDS).some((k) => sent[k] !== undefined)) {
    const ix = await loadIndex(s, !!sent.reporting_to_id);
    const problem = refProblem(ix, sent, id);
    if (problem) throw new AppError(400, problem, 'VALIDATION');
  }

  // 3. the sensitive pair: a masked echo is ignored, a new value is sealed, null clears
  const before: Row = { ...current, pan: current.pan_enc ? readPan(current) : null, bank: current.bank_enc ? readBank(current) : null };
  const after: Row = { ...sent };
  const dbPatch: Row = {};
  for (const [col, value] of Object.entries(sent)) if (!sameValue(current[col], value)) dbPatch[col] = value;

  const pan = interpretPan(patch.pan);
  if ('value' in pan && !sameValue(before.pan, pan.value)) { after.pan = pan.value; dbPatch.pan_enc = sealPan(id, pan.value); }
  if ('clear' in pan && current.pan_enc) { after.pan = null; dbPatch.pan_enc = null; }
  const bank = interpretBank(patch.bank, before.bank as ReturnType<typeof readBank>);
  if ('value' in bank && !sameValue(before.bank, bank.value)) { after.bank = bank.value; dbPatch.bank_enc = sealBank(id, bank.value); }
  if ('clear' in bank && current.bank_enc) { after.bank = null; dbPatch.bank_enc = null; }

  if (!Object.keys(dbPatch).length) return loadEmployee(s, id); // nothing really changed: no write, no log row

  // 4. the change log: one row per labelled field that changed
  const changes = diffEmployee(before, after);
  const want: Partial<Record<keyof typeof REF_FIELDS, Set<string>>> = {};
  for (const c of changes) {
    if (!(c.key in REF_FIELDS)) continue;
    const set = (want[c.key as keyof typeof REF_FIELDS] ??= new Set<string>());
    for (const v of [c.from, c.to]) if (v) set.add(String(v));
  }
  const names = changes.length ? await resolveNames(s, want) : new Map<string, string>();
  const at = new Date().toISOString();
  const rows = changes.map((c) => historyRow(s, { employee_id: id, field: c.field, from_value: changeText(c, 'from', names), to_value: changeText(c, 'to', names) }, at));

  // History first, then the change; if the change fails the history rows go again. A change is never applied unlogged.
  let inserted: Row[] = [];
  if (rows.length) {
    const h = await db().from(HIST).insert(rows).select('id');
    if (h.error) throw fail(h.error);
    inserted = (h.data as Row[] | null) ?? [];
  }
  const undoHistory = async () => {
    if (!inserted.length) return;
    const { error } = await scoped(db().from(HIST).delete(), s).in('id', inserted.map((r) => String(r.id)));
    if (error) logger.error(`[hrms] could not remove change-log rows after a failed update of ${id}: ${error.message}`);
  };

  const upd = await scoped(db().from(EMP).update({ ...dbPatch, updated_at: at }), s).eq('id', id).is('deleted_at', null).select('id');
  if (upd.error) { await undoHistory(); throw fail(upd.error); }
  if (!(upd.data as Row[] | null)?.length) { await undoHistory(); throw new AppError(404, 'Employee not found', 'NOT_FOUND'); }
  return loadEmployee(s, id);
}

// ── delete ──────────────────────────────────────────────────────────────────
/** Soft-delete a draft. Anyone who reported to the draft, and a department it headed, are un-pointed first (and logged). */
export async function deleteEmployee(s: HrmsScope, id: string): Promise<{ id: string }> {
  const row = await getEmployeeRow(s, id);
  if (row.status !== 'onboarding') {
    throw new AppError(409, 'Only a draft (onboarding) employee can be deleted. Mark the person as exited instead.', 'NOT_A_DRAFT');
  }
  const at = new Date().toISOString();
  const label = `${String(row.first_name)} ${String(row.last_name ?? '')}`.trim() + ` (${String(row.code)})`;

  const reportees = (must(await scoped(db().from(EMP).select('id'), s).eq('reporting_to_id', id).is('deleted_at', null)) as Row[] | null) ?? [];
  const logRows = [
    historyRow(s, { employee_id: id, field: 'Employee', from_value: null, to_value: 'Deleted' }, at),
    ...reportees.map((r) => historyRow(s, { employee_id: String(r.id), field: 'Reports to', from_value: label, to_value: null }, at)),
  ];
  const h = await db().from(HIST).insert(logRows).select('id');
  if (h.error) throw fail(h.error);
  const undoHistory = async () => {
    const { error } = await scoped(db().from(HIST).delete(), s).in('id', ((h.data as Row[] | null) ?? []).map((r) => String(r.id)));
    if (error) logger.error(`[hrms] could not remove change-log rows after a failed delete of ${id}: ${error.message}`);
  };

  try {
    if (reportees.length) must(await scoped(db().from(EMP).update({ reporting_to_id: null, updated_at: at }), s).eq('reporting_to_id', id).is('deleted_at', null));
    must(await scoped(db().from('hrms_departments').update({ head_id: null, updated_at: at }), s).eq('head_id', id));
    const upd = await scoped(db().from(EMP).update({ deleted_at: at, updated_at: at }), s).eq('id', id).is('deleted_at', null).select('id');
    if (upd.error) throw fail(upd.error);
    if (!(upd.data as Row[] | null)?.length) throw new AppError(404, 'Employee not found', 'NOT_FOUND');
  } catch (e) {
    await undoHistory();
    throw e;
  }
  return { id };
}
