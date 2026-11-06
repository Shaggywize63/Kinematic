/**
 * What to do when Postgres/PostgREST refuses an expense write.
 *
 * Two jobs:
 *   1. `isUndefinedColumn` / `withoutKeys` let a write that carries OPTIONAL columns (the connected-B2B
 *      link columns, the GST columns) be retried once without them when the tenant database has not
 *      run that migration yet — so a missing optional column never costs a rep their claim.
 *   2. `dbFailure` turns the errors that are really about the caller's input (a date Postgres cannot
 *      read, a number too big for the column, a link to a row that is gone) into a 4xx with a sentence
 *      to show, instead of a 500 that production reduces to "Internal server error".
 */
import { AppError } from '../../utils';

export interface DbError { code?: string; message?: string; details?: string | null; hint?: string | null }

/** PostgREST answers PGRST204 ("Could not find the 'x' column of 'expense_claims' in the schema cache"); Postgres itself answers 42703. */
export function isUndefinedColumn(e: DbError | null | undefined): boolean {
  if (!e) return false;
  if (e.code === '42703' || e.code === 'PGRST204') return true;
  return /column .* does not exist|could not find the '.*' column/i.test(String(e.message ?? ''));
}

/** The column the error names, when it does. */
export function missingColumn(e: DbError | null | undefined): string | null {
  const msg = String(e?.message ?? '');
  const m = /could not find the '([^']+)' column/i.exec(msg) || /column "?([a-z0-9_]+)"? (?:of relation "[^"]+" )?does not exist/i.exec(msg);
  return m ? m[1] : null;
}

/** True when the failed write is explained by one of these optional columns being absent (or the error does not say which). */
export function blamesOptional(e: DbError | null | undefined, optional: readonly string[]): boolean {
  if (!isUndefinedColumn(e)) return false;
  const col = missingColumn(e);
  return col === null || optional.includes(col);
}

/** `row` without the given keys (a copy; rows may be a single object or a list). */
export function withoutKeys<T extends Record<string, unknown>>(row: T, keys: readonly string[]): T;
export function withoutKeys<T extends Record<string, unknown>>(row: T[], keys: readonly string[]): T[];
export function withoutKeys<T extends Record<string, unknown>>(row: T | T[], keys: readonly string[]): T | T[];
export function withoutKeys<T extends Record<string, unknown>>(row: T | T[], keys: readonly string[]): T | T[] {
  const strip = (r: T): T => {
    const out: Record<string, unknown> = { ...r };
    for (const k of keys) delete out[k];
    return out as T;
  };
  return Array.isArray(row) ? row.map(strip) : strip(row);
}

/** Does any row carry at least one of these keys? */
export function carriesAny(row: Record<string, unknown> | Array<Record<string, unknown>>, keys: readonly string[]): boolean {
  const rows = Array.isArray(row) ? row : [row];
  return rows.some((r) => keys.some((k) => Object.prototype.hasOwnProperty.call(r, k)));
}

/**
 * An AppError for a failed write. `what` completes "Couldn't ___": "save the claim", "save an expense line".
 * Input problems are 4xx with the reason; anything else stays a 500 (production shows it as a generic
 * server error, and the apps map that to a friendly retry message).
 */
export function dbFailure(e: DbError, what: string): AppError {
  const code = String(e?.code ?? '');
  const lead = `Couldn't ${what}`;
  switch (code) {
    case '22007': case '22008':
      return new AppError(400, `${lead}: one of the dates is not a valid day. Use the date picker or write it as YYYY-MM-DD.`, 'VALIDATION');
    case '22003':
      return new AppError(400, `${lead}: one of the numbers (an amount, distance or reading) is too large.`, 'VALIDATION');
    case '22001':
      return new AppError(400, `${lead}: some text is too long.`, 'VALIDATION');
    case '22P02':
      return new AppError(400, `${lead}: one of the values is in a format the server can't read (a number, date or id).`, 'VALIDATION');
    case '22P05': case '22021':
      return new AppError(400, `${lead}: the text contains characters that can't be stored. Remove any pasted special characters and try again.`, 'VALIDATION');
    case '23502':
      return new AppError(400, `${lead}: a required value is missing${missingNotNull(e)}.`, 'VALIDATION');
    case '23503':
      return new AppError(400, `${lead}: it refers to something that no longer exists (a linked account, form or claim). Reopen the claim and try again.`, 'VALIDATION');
    case '23505':
      return new AppError(409, `${lead}: it was already saved. Refresh your claims and check before adding it again.`, 'CONFLICT');
    case '23514':
      return new AppError(400, `${lead}: one of the values breaks a rule (for example an odometer reading after the trip lower than the reading before it).`, 'VALIDATION');
    default:
      return new AppError(500, e?.message || `${lead}`, 'DB');
  }
}

function missingNotNull(e: DbError): string {
  const m = /null value in column "([^"]+)"/i.exec(String(e.message ?? ''));
  return m ? ` (${m[1].replace(/_/g, ' ')})` : '';
}
