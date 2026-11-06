import { AppError } from '../../utils';
import { logger } from '../../lib/logger';

/**
 * crm_activities.type carries a CHECK constraint (crm_activities_type_check) that only allows the seven built-in
 * types, but admins can add their own activity types (Settings → Activity types). Writing one of those fails with
 * `new row for relation "crm_activities" violates check constraint "crm_activities_type_check"`, so the activity
 * could not be saved at all.
 *
 * Until the constraint is lifted (migration_activity_type_check.sql), a write the constraint rejects is retried
 * with a built-in carrier type and the real type kept in `metadata.activity_type`; every read puts it back, so the
 * rest of the product sees the custom type either way. Once the constraint is gone new rows store the real type.
 */
export const BUILTIN_DB_TYPES = ['call', 'email', 'meeting', 'task', 'note', 'sms', 'whatsapp'] as const;
const CARRIER_TYPE = 'note';
const META_KEY = 'activity_type';

const isBuiltin = (t: unknown) => typeof t === 'string' && (BUILTIN_DB_TYPES as readonly string[]).includes(t.toLowerCase());

/** Did this write fail on the type constraint? */
export function violatesTypeCheck(e: unknown): boolean {
  return e instanceof AppError && /crm_activities_type_check/i.test(e.message);
}

/** The payload as the database will accept it: a built-in carrier type + the real type in metadata. */
export function withCarrierType(payload: Record<string, unknown>): Record<string, unknown> {
  const meta = (payload.metadata && typeof payload.metadata === 'object') ? payload.metadata as Record<string, unknown> : {};
  return { ...payload, type: CARRIER_TYPE, metadata: { ...meta, [META_KEY]: String(payload.type) } };
}

/** Run a write; if only the type constraint rejects it, run it again in carrier form. */
export async function writeActivityResilient<T>(payload: Record<string, unknown>, run: (p: Record<string, unknown>) => Promise<T>): Promise<T> {
  try {
    return await run(payload);
  } catch (e) {
    if (!violatesTypeCheck(e) || typeof payload.type !== 'string' || isBuiltin(payload.type)) throw e;
    logger.warn({ type: payload.type }, 'activities: custom type rejected by crm_activities_type_check, saving under a carrier type');
    return run(withCarrierType(payload));
  }
}

/** Read side: a row saved in carrier form shows its real type again. */
export function restoreCarrierType<T extends Record<string, unknown>>(row: T): T {
  const meta = row?.metadata;
  if (meta && typeof meta === 'object') {
    const real = (meta as Record<string, unknown>)[META_KEY];
    if (typeof real === 'string' && real && row.type === CARRIER_TYPE) return { ...row, type: real };
  }
  return row;
}
