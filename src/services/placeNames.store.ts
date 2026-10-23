/**
 * Reverse-geocode many GPS points to human place names, ONCE and consistently, for the daily travel report.
 *
 * Why this exists: the report used to ship only coordinates, and every dashboard browser reverse-geocoded each
 * point itself in the viewer's own Google locale — so one admin saw "Welfare Association, Sodepur, Panihati" and
 * another saw a wrong Vietnamese-script street for the SAME point. Resolving on the server (crm/places.service
 * pins English / India) gives one name everyone shares.
 *
 * Caching, cheapest first:
 *   - within a request: distinct points are collapsed to ~11 m cells (lat/lng to 4 decimals — the exact cell the
 *     dashboard place-name cache uses), so repeated/overlapping points cost one lookup;
 *   - across requests: resolved names are stored in `geo_places` (migrations/geo_place_cache.sql), so a point is
 *     geocoded at most once ever. The table is OPTIONAL — if it is absent (e.g. a tenant that hasn't had the
 *     migration), every read/write is swallowed and the point is geocoded live, still correct, just not persisted;
 *   - a short in-process negative cache, so a point Google can't name (or a transient failure) isn't retried on
 *     every report view within the same process.
 *
 * Best-effort by design: any failure resolves a point to no name, and the report simply omits `place` for it
 * (the dashboard then falls back to its own, now language-pinned, lookup). It never throws.
 */
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import { reverseGeocode } from './crm/places.service';

export interface GeoPoint { lat: number; lng: number }

/** The ~11 m cell key, matching the dashboard's place-name cache (lib/placeName.ts cellKey). */
export function placeCell(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

const valid = (lat: unknown, lng: unknown): lat is number =>
  typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
  && Math.abs(lat as number) <= 90 && Math.abs(lng as number) <= 180
  // (0,0) and anything hugging it is the apps' "no fix" placeholder, never a real place.
  && !(Math.abs(lat as number) < 0.5 && Math.abs(lng as number) < 0.5);

// Negative cache: cells Google returned nothing for, so one dead point isn't re-tried on every view.
const failedAt = new Map<string, number>();
const FAIL_TTL_MS = 60 * 60_000;
// At most this many live geocodes at once, so one report can't burst the Geocoding quota.
const MAX_CONCURRENT = 4;

/** Rows already cached in `geo_places` for these cells. Missing table / any error → empty (degrade to live geocode). */
async function readCache(cells: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!cells.length) return found;
  try {
    const { data, error } = await supabaseAdmin.from('geo_places').select('cell, name').in('cell', cells);
    if (error) return found; // table absent, or not yet in the PostgREST schema cache — just geocode
    for (const r of (data ?? []) as Array<{ cell: string; name: string | null }>) {
      if (r.name) found.set(r.cell, r.name);
    }
  } catch { /* best-effort */ }
  return found;
}

/** Persist newly resolved names. Best-effort: a missing table / error is swallowed (the name is still returned). */
async function writeCache(rows: Array<{ cell: string; name: string; lat: number; lng: number }>): Promise<void> {
  if (!rows.length) return;
  try {
    const { error } = await supabaseAdmin
      .from('geo_places')
      .upsert(rows.map((r) => ({ ...r, resolved_at: new Date().toISOString() })), { onConflict: 'cell' });
    if (error) logger.warn(`[placeNames] geo_places upsert skipped: ${error.message}`);
  } catch { /* best-effort */ }
}

/** Run `fn` over `items` at most `limit` at a time. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Resolve names for `points`, returning cell -> name for the cells that have one. Points that are invalid, that
 * Google can't name, or that fail, are simply absent from the map. Caller keys lookups with `placeCell`.
 */
export async function resolvePlaceNames(points: ReadonlyArray<GeoPoint>): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  // Distinct, valid cells with one representative coordinate each.
  const rep = new Map<string, GeoPoint>();
  for (const p of points) {
    if (!p || !valid(p.lat, p.lng)) continue;
    const cell = placeCell(p.lat, p.lng);
    if (!rep.has(cell)) rep.set(cell, { lat: p.lat, lng: p.lng });
  }
  if (rep.size === 0) return result;

  const cached = await readCache([...rep.keys()]);
  for (const [cell, name] of cached) result.set(cell, name);

  const now = Date.now();
  const toGeocode = [...rep.entries()].filter(([cell]) => {
    if (result.has(cell)) return false;
    const failed = failedAt.get(cell);
    return !(failed && now - failed < FAIL_TTL_MS);
  });

  const resolved = await mapLimited(toGeocode, MAX_CONCURRENT, async ([cell, pt]) => {
    const name = await reverseGeocode(pt.lat, pt.lng);
    return { cell, pt, name };
  });

  const toWrite: Array<{ cell: string; name: string; lat: number; lng: number }> = [];
  for (const { cell, pt, name } of resolved) {
    if (name) {
      result.set(cell, name);
      toWrite.push({ cell, name, lat: pt.lat, lng: pt.lng });
    } else {
      failedAt.set(cell, now);
    }
  }
  await writeCache(toWrite);
  return result;
}

/** Test helper. */
export function resetPlaceNameNegativeCache(): void { failedAt.clear(); }
