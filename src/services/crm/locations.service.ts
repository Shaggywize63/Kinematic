/**
 * CRM client locations — flat hierarchy (state, city, district, block) scoped
 * to (org_id, client_id). Used to power cascading filters on /crm/leads and
 * to validate location values entered on lead create.
 *
 * Bulk import accepts an array of {state, city, district?, block?} rows;
 * duplicates are deduped via a unique index on the lower-cased tuple.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

export interface ClientLocation {
  id: string;
  org_id: string;
  client_id: string | null;
  state: string;
  city: string;
  district: string | null;
  block: string | null;
  is_active: boolean;
}

export interface LocationFilter {
  state?: string;
  city?: string;
  district?: string;
}

export async function listLocations(org_id: string, client_id: string | null, filter: LocationFilter = {}): Promise<ClientLocation[]> {
  let q = supabaseAdmin.from('crm_client_locations').select('*').eq('org_id', org_id).eq('is_active', true);
  // Client-level users (and org-admins with a client picked) see that
  // client's rows + the org-level defaults (client_id IS NULL).
  if (client_id) q = q.or(`client_id.is.null,client_id.eq.${client_id}`);
  if (filter.state)    q = q.eq('state',    filter.state);
  if (filter.city)     q = q.eq('city',     filter.city);
  if (filter.district) q = q.eq('district', filter.district);
  const { data, error } = await q.order('state').order('city').order('district').order('block');
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []) as ClientLocation[];
}

/** Distinct values at each level of the hierarchy. Used by the picker UI. */
export async function locationOptions(org_id: string, client_id: string | null) {
  const rows = await listLocations(org_id, client_id);
  const uniq = <T>(xs: T[]) => Array.from(new Set(xs.filter(Boolean) as T[]));
  return {
    states:    uniq(rows.map(r => r.state)),
    // Frontend filters these client-side; backend just hands over the raw set
    // so a single call powers all four cascading dropdowns.
    rows: rows.map(r => ({ state: r.state, city: r.city, district: r.district, block: r.block })),
  };
}

export async function createLocation(org_id: string, client_id: string | null, user_id: string | undefined, payload: { state: string; city: string; district?: string; block?: string }) {
  const insert = {
    org_id, client_id, created_by: user_id ?? null,
    state: payload.state.trim(),
    city: payload.city.trim(),
    district: payload.district?.trim() || null,
    block: payload.block?.trim() || null,
  };
  if (!insert.state || !insert.city) throw new AppError(400, 'state and city are required', 'VALIDATION');
  const { data, error } = await supabaseAdmin.from('crm_client_locations').insert(insert).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data as ClientLocation;
}

export async function deleteLocation(org_id: string, id: string) {
  // Hard delete — these are reference data, not transactional. Soft-delete
  // would just clutter the unique-index space.
  const { error } = await supabaseAdmin.from('crm_client_locations')
    .delete().eq('org_id', org_id).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
}

export interface BulkImportResult { inserted: number; skipped: number; errors: string[] }

/**
 * Bulk insert. Rows can be partial (district/block optional). Existing rows
 * (matched by the unique-index tuple) are skipped, not updated, so re-running
 * a CSV upload is idempotent. Errors are returned per row so the UI can
 * surface them inline.
 */
export async function bulkImport(org_id: string, client_id: string | null, user_id: string | undefined, rows: Array<Record<string, unknown>>): Promise<BulkImportResult> {
  const cleaned: Array<{ state: string; city: string; district: string | null; block: string | null }> = [];
  const errors: string[] = [];
  rows.forEach((r, i) => {
    const state = String(r.state ?? '').trim();
    const city  = String(r.city  ?? '').trim();
    if (!state || !city) { errors.push(`Row ${i + 1}: state and city are required`); return; }
    cleaned.push({
      state, city,
      district: String(r.district ?? '').trim() || null,
      block:    String(r.block    ?? '').trim() || null,
    });
  });
  if (cleaned.length === 0) return { inserted: 0, skipped: 0, errors };

  // Uniqueness key MUST mirror the DB's expression index
  // `ux_crm_client_locations_hierarchy`:
  //   (org_id, coalesce(client_id,'0…'), lower(state), lower(city),
  //    lower(coalesce(district,'')), lower(coalesce(block,'')))
  // so our in-memory dedupe matches exactly what the DB considers a dupe.
  const keyOf = (r: { state: string; city: string; district: string | null; block: string | null }) =>
    [r.state.toLowerCase(), r.city.toLowerCase(), (r.district ?? '').toLowerCase(), (r.block ?? '').toLowerCase()].join('|');

  // 1. Dedupe within the uploaded batch — a single collision used to abort
  //    the whole INSERT and leave 0 rows written (the bug that made bulk
  //    upload silently add nothing).
  const seen = new Set<string>();
  const deduped: typeof cleaned = [];
  for (const r of cleaned) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }

  // 2. Pre-filter against rows already stored in the SAME client bucket the
  //    unique index coalesces on (a client's rows are distinct from the
  //    org-level `client_id IS NULL` seed).
  let existingQ = supabaseAdmin.from('crm_client_locations')
    .select('state, city, district, block').eq('org_id', org_id);
  existingQ = client_id ? existingQ.eq('client_id', client_id) : existingQ.is('client_id', null);
  const { data: existing, error: exErr } = await existingQ;
  if (exErr) throw new AppError(500, exErr.message, 'DB_ERROR');
  const existingKeys = new Set((existing ?? []).map((r) => keyOf(r as any)));

  const toInsert = deduped.filter((r) => !existingKeys.has(keyOf(r)));
  const skipped = cleaned.length - toInsert.length;
  if (toInsert.length === 0) return { inserted: 0, skipped, errors };

  // 3. Plain chunked INSERT. No `onConflict` — PostgREST can't target the
  //    expression index by column list, and we've already removed every
  //    in-batch and pre-existing duplicate above, so a plain insert is safe.
  const payload = toInsert.map((r) => ({ ...r, org_id, client_id, created_by: user_id ?? null }));
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin.from('crm_client_locations').insert(slice).select('id');
    if (error) { errors.push(error.message); continue; }
    inserted += data?.length ?? 0;
  }
  return { inserted, skipped, errors };
}
