import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { missingColumn } from '../expenses/dbErrors';

/**
 * Account location columns are optional: a tenant database that never got them (the live Kinematic `crm_accounts`
 * has no `address_line1`, PostgREST says "Could not find the 'address_line1' column of 'crm_accounts' in the schema
 * cache") must still be able to create and edit accounts. A write that fails because one of these columns is
 * absent is retried without it, one column at a time, so a missing column costs the rep that field and never the
 * whole account. On CREATE the dropped values are kept in `custom_fields.location`, so what the rep typed is not
 * lost; `migration_account_location.sql` adds the columns and copies those values across.
 */
export const ACCOUNT_OPTIONAL_COLUMNS = [
  'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country', 'email',
] as const;

export async function writeAccountResilient<T>(
  payload: Record<string, unknown>,
  mode: 'create' | 'patch',
  run: (p: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  let p: Record<string, unknown> = { ...payload };
  const dropped: Record<string, unknown> = {};
  for (let attempt = 0; attempt <= ACCOUNT_OPTIONAL_COLUMNS.length; attempt++) {
    try {
      return await run(p);
    } catch (e) {
      const col = e instanceof AppError ? missingColumn({ message: e.message }) : null;
      const optional = ACCOUNT_OPTIONAL_COLUMNS as readonly string[];
      if (!col || !optional.includes(col) || !Object.prototype.hasOwnProperty.call(p, col)) throw e;
      dropped[col] = p[col];
      const next = { ...p };
      delete next[col];
      if (mode === 'create' && Object.keys(dropped).length) {
        // A PATCH would replace the stored custom_fields, so only a create (no existing values) keeps the stash.
        const cf = (next.custom_fields && typeof next.custom_fields === 'object') ? next.custom_fields as Record<string, unknown> : {};
        next.custom_fields = { ...cf, location: { ...dropped } };
      }
      logger.warn({ column: col, mode }, 'accounts: optional column missing in this database, retrying without it');
      p = next;
    }
  }
  return run(p);
}
