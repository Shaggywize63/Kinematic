import crypto from 'crypto';
import { AppError } from '../../../utils';
import { db, fail, HrmsScope, isUniqueViolation, must, scopeCols, scoped } from '../scope';
import { MONTH_RE } from './schemas';

// Small helpers shared by the payroll services.

/** A database row. `any` values on purpose: the payroll services read many typed columns, and the rows are checked by the schema, not by TypeScript. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export const newId = (): string => crypto.randomUUID();

export const refuse = (status: number, message: string, code: string) => new AppError(status, message, code);
export const invalid = (message: string) => new AppError(400, message, 'VALIDATION');
export const notFound = (message: string) => new AppError(404, message, 'NOT_FOUND');

/** The month in the URL: YYYY-MM or a 400. */
export function monthParam(v: string): string {
  if (!MONTH_RE.test(v)) throw invalid('month: Month must be YYYY-MM');
  return v;
}

/** The live (not deleted) employee columns the payroll rules need, or null. */
export async function findEmployee(s: HrmsScope, id: string): Promise<Row | null> {
  return must(await scoped(db().from('hrms_employees').select('id,code,first_name,last_name,entity_id,status,join_date,last_working_date'), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;
}

/** Insert one row; if it loses a race on a client-supplied id answer with the row that is there (ours) or a 409 (someone else's). */
export async function insertIdempotent(
  s: HrmsScope, table: string, row: Row, hadClientId: boolean, find: () => Promise<Row | null>,
  /** Turn a database error the caller expects (a unique index it relies on) into its own refusal. */
  mapError?: (e: { code?: string; message?: string }) => AppError | undefined,
): Promise<{ row: Row; created: boolean }> {
  const res = await db().from(table).insert({ ...scopeCols(s), ...row }).select('*').single();
  if (res.error) {
    const mapped = mapError?.(res.error);
    if (mapped) throw mapped;
    if (hadClientId && isUniqueViolation(res.error, 'pkey')) {
      const mine = await find();
      if (mine) return { row: mine, created: false };
      throw new AppError(409, 'This id is already in use', 'ID_IN_USE');
    }
    throw fail(res.error);
  }
  return { row: res.data as Row, created: true };
}

export const now = (): string => new Date().toISOString();
