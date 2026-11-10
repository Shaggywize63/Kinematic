import { AppError } from '../../utils';
import { CODE_PREFIX_KEY } from './schemas';
import { db, fail, HrmsScope, must, scopeCols, scoped } from './scope';

export const DEFAULT_CODE_PREFIX = 'EMP-';
const COUNTER = 'employee_code';
const CODE_PAD = 4;

/** All HRMS settings for the org, with defaults filled in. */
export async function getSettings(s: HrmsScope): Promise<Record<string, unknown>> {
  const rows = must(await scoped(db().from('hrms_settings').select('key,value'), s)) as Array<{ key: string; value: unknown }> | null;
  const out: Record<string, unknown> = { [CODE_PREFIX_KEY]: DEFAULT_CODE_PREFIX };
  for (const r of rows ?? []) out[r.key] = r.value;
  return out;
}

export async function getCodePrefix(s: HrmsScope): Promise<string> {
  const row = must(await scoped(db().from('hrms_settings').select('value'), s).eq('key', CODE_PREFIX_KEY).maybeSingle()) as { value?: unknown } | null;
  return typeof row?.value === 'string' && row.value ? row.value : DEFAULT_CODE_PREFIX;
}

export async function setCodePrefix(s: HrmsScope, value: string): Promise<Record<string, unknown>> {
  const { error } = await db().from('hrms_settings').upsert(
    { ...scopeCols(s), key: CODE_PREFIX_KEY, value, updated_at: new Date().toISOString() },
    { onConflict: 'org_id,key' },
  );
  if (error) throw fail(error);
  return getSettings(s);
}

export const formatCode = (prefix: string, n: number): string => `${prefix}${String(n).padStart(CODE_PAD, '0')}`;

/**
 * Hand out `count` consecutive employee codes. The number comes from hrms_next_code (one atomic upsert in Postgres), so
 * two concurrent creates never get the same one. A block is reserved in a single round trip.
 */
export async function reserveCodes(s: HrmsScope, count: number): Promise<string[]> {
  if (count < 1) return [];
  const prefix = await getCodePrefix(s);
  const args: Record<string, unknown> = { p_org: s.org_id, p_name: COUNTER };
  if (count > 1) args.p_count = count;
  const { data, error } = await db().rpc('hrms_next_code', args);
  if (error) throw fail(error);
  const last = Number(data);
  if (!Number.isInteger(last) || last < count) throw new AppError(500, 'Could not allocate an employee code', 'DB_ERROR');
  return Array.from({ length: count }, (_, i) => formatCode(prefix, last - count + 1 + i));
}
