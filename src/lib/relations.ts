import { supabaseAdmin } from './supabase';
import { logger } from './logger';

/**
 * Related rows fetched with a second, plain query instead of a PostgREST embed.
 *
 * `select('*, distributor:distributor_id(name)')` only works when the database has a FOREIGN KEY from that
 * column to the target table. The tenants' databases are not guaranteed to carry the same constraints (the
 * Kinematic project has none from orders / invoices to distributors, or from stock batches to skus), and
 * when the constraint is missing the whole request fails with "Could not find a relationship between ...
 * in the schema cache" - the order detail screen then shows an error even though the order is fine.
 *
 * A lookup by id needs no constraint, returns the same data where the embed worked, and is best-effort: if
 * the second query itself fails the caller gets an empty map (the related object is simply absent/null)
 * and a warning is logged, instead of the main record being refused.
 */

/** The columns named in a PostgREST select list, e.g. "name, gstin" -> ["name", "gstin"]. */
export function columnList(columns: string): string[] {
  return columns.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
}

/** A copy of [row] holding only [keys] (a missing key is null, like an embed of a NULL column). */
export function pickColumns(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = row[k] === undefined ? null : row[k];
  return out;
}

/** The distinct, non-empty string ids of [ids], in first-seen order. */
export function distinctIds(ids: ReadonlyArray<unknown>): string[] {
  const seen = new Set<string>();
  for (const v of ids) {
    if (typeof v === 'string' && v.length > 0) seen.add(v);
  }
  return Array.from(seen);
}

/**
 * Rows of [table] whose [idColumn] is one of [ids], keyed by that id, each holding exactly the requested
 * [columns] (what the embed would have returned). Never throws; an unreadable table gives an empty map.
 */
export async function fetchRelated(
  table: string,
  ids: ReadonlyArray<unknown>,
  columns: string,
  idColumn = 'id',
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const wanted = distinctIds(ids);
  if (wanted.length === 0) return out;

  const keys = columnList(columns);
  const select = keys.includes(idColumn) ? keys.join(', ') : [idColumn, ...keys].join(', ');
  try {
    const { data, error } = await supabaseAdmin.from(table).select(select).in(idColumn, wanted);
    if (error) {
      logger.warn(`[relations] ${table} lookup failed (${error.message}); continuing without it`);
      return out;
    }
    for (const raw of (data || []) as unknown as Array<Record<string, unknown>>) {
      const id = raw[idColumn];
      if (typeof id === 'string') out.set(id, pickColumns(raw, keys));
    }
  } catch (e) {
    logger.warn(`[relations] ${table} lookup threw (${e instanceof Error ? e.message : String(e)}); continuing without it`);
  }
  return out;
}
