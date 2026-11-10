import crypto from 'crypto';
import { AppError } from '../../utils';
import { db, fail, HrmsScope, isForeignKeyViolation, isUniqueViolation, must, scopeCols, scoped } from './scope';
import { publicRow, Row } from './model';

// The four org-structure lists: legal entities, locations, departments, designations. Same shape for all four:
// create (idempotent on a client-supplied id), partial update, and a delete that is refused with a plain reason
// while anything still points at the row.

export type MasterKind = 'entities' | 'locations' | 'departments' | 'designations';

interface Ref { table: string; col: string; one: string; many: string; fix: string; live?: boolean }
interface Config {
  table: string;
  noun: string;
  fields: readonly string[];
  refs: Ref[];
  /** Foreign keys of the row itself must exist in this org. */
  validate?: (s: HrmsScope, row: Row) => Promise<void>;
}

const exists = async (s: HrmsScope, table: string, id: string, live = false): Promise<boolean> => {
  let q = scoped(db().from(table).select('id'), s).eq('id', id);
  if (live) q = q.is('deleted_at', null);
  return !!must(await q.maybeSingle());
};

const employeesOf = (col: string, fix: string): Ref => ({ table: 'hrms_employees', col, one: 'employee', many: 'employees', fix, live: true });

export const MASTERS: Record<MasterKind, Config> = {
  entities: {
    table: 'hrms_entities', noun: 'legal entity',
    fields: ['name', 'pan', 'tan', 'cin', 'gstin', 'address', 'registrations', 'signatory'],
    refs: [
      { table: 'hrms_locations', col: 'entity_id', one: 'location', many: 'locations', fix: 'Move or delete them first.' },
      employeesOf('entity_id', 'Move them to another legal entity first.'),
    ],
  },
  locations: {
    table: 'hrms_locations', noun: 'location',
    fields: ['entity_id', 'name', 'state', 'city', 'address', 'metro', 'holiday_list_id'],
    refs: [employeesOf('location_id', 'Move them to another location first.')],
    validate: async (s, row) => {
      if (row.entity_id !== undefined && !(await exists(s, 'hrms_entities', String(row.entity_id)))) throw new AppError(400, 'entity_id: Unknown legal entity', 'VALIDATION');
    },
  },
  departments: {
    table: 'hrms_departments', noun: 'department',
    fields: ['name', 'head_id'],
    refs: [employeesOf('department_id', 'Move them to another department first.')],
    validate: async (s, row) => {
      if (row.head_id && !(await exists(s, 'hrms_employees', String(row.head_id), true))) throw new AppError(400, 'head_id: Unknown employee', 'VALIDATION');
    },
  },
  designations: {
    table: 'hrms_designations', noun: 'designation',
    fields: ['name', 'grade'],
    refs: [employeesOf('designation_id', 'Move them to another designation first.')],
  },
};

const pick = (src: Row, keys: readonly string[]): Row => {
  const out: Row = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
};

const find = async (s: HrmsScope, cfg: Config, id: string): Promise<Row | null> =>
  must(await scoped(db().from(cfg.table).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

export async function createMaster(s: HrmsScope, kind: MasterKind, input: Row): Promise<{ row: Row; created: boolean }> {
  const cfg = MASTERS[kind];
  const id = (input.id as string | undefined) ?? crypto.randomUUID();
  if (input.id) {
    const existing = await find(s, cfg, id);
    if (existing) return { row: publicRow(existing), created: false };
  }
  await cfg.validate?.(s, input);
  const res = await db().from(cfg.table).insert({ id, ...scopeCols(s), ...pick(input, cfg.fields) }).select('*').single();
  if (res.error) {
    if (input.id && isUniqueViolation(res.error, 'pkey')) {
      const mine = await find(s, cfg, id);
      if (mine) return { row: publicRow(mine), created: false };
      throw new AppError(409, 'This id is already in use', 'ID_IN_USE');
    }
    throw fail(res.error);
  }
  return { row: publicRow(res.data as Row), created: true };
}

export async function updateMaster(s: HrmsScope, kind: MasterKind, id: string, patch: Row): Promise<Row> {
  const cfg = MASTERS[kind];
  const current = await find(s, cfg, id);
  if (!current) throw new AppError(404, `${cap(cfg.noun)} not found`, 'NOT_FOUND');
  const change = pick(patch, cfg.fields);
  if (!Object.keys(change).length) return publicRow(current);
  await cfg.validate?.(s, change);
  const res = await scoped(db().from(cfg.table).update({ ...change, updated_at: new Date().toISOString() }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return publicRow(res.data as Row);
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Delete a row, unless something still points at it (409 with a plain reason). Drafts that were deleted earlier are
 * soft-deleted employee rows that still hold the foreign key; they are purged here so they cannot block the delete.
 */
export async function deleteMaster(s: HrmsScope, kind: MasterKind, id: string): Promise<{ id: string }> {
  const cfg = MASTERS[kind];
  if (!(await find(s, cfg, id))) throw new AppError(404, `${cap(cfg.noun)} not found`, 'NOT_FOUND');

  for (const ref of cfg.refs) {
    let q = scoped(db().from(ref.table).select('id', { count: 'exact', head: true }), s).eq(ref.col, id);
    if (ref.live) q = q.is('deleted_at', null);
    const { count, error } = await q;
    if (error) throw fail(error);
    if ((count ?? 0) > 0) {
      const n = count as number;
      throw new AppError(409, `This ${cfg.noun} still has ${n} ${n === 1 ? ref.one : ref.many}. ${ref.fix}`, 'IN_USE');
    }
  }
  for (const ref of cfg.refs.filter((r) => r.live)) {
    const purge = await scoped(db().from(ref.table).delete(), s).eq(ref.col, id).not('deleted_at', 'is', null);
    if (purge.error) throw fail(purge.error);
  }
  const { error } = await scoped(db().from(cfg.table).delete(), s).eq('id', id);
  if (error) {
    // Something was added between the check and the delete: the foreign key caught it.
    if (isForeignKeyViolation(error)) throw new AppError(409, `This ${cfg.noun} is still in use. Move what uses it first.`, 'IN_USE');
    throw fail(error);
  }
  return { id };
}
