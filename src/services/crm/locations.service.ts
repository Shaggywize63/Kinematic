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

  const payload = cleaned.map(r => ({ ...r, org_id, client_id, created_by: user_id ?? null }));
  // upsert with ignoreDuplicates → exact-tuple matches are skipped, new rows are inserted.
  const { data, error } = await supabaseAdmin
    .from('crm_client_locations')
    .upsert(payload, { ignoreDuplicates: true, onConflict: 'org_id,client_id,state,city,district,block' })
    .select('id');
  if (error) {
    // Conflict spec may not match the partial-coalesce unique index — fall
    // back to plain insert and let the unique index reject dupes silently.
    const fallback = await supabaseAdmin.from('crm_client_locations').insert(payload).select('id');
    if (fallback.error && !/duplicate key/i.test(fallback.error.message)) {
      throw new AppError(500, fallback.error.message, 'DB_ERROR');
    }
    const inserted = fallback.data?.length ?? 0;
    return { inserted, skipped: cleaned.length - inserted, errors };
  }
  const inserted = data?.length ?? 0;
  return { inserted, skipped: cleaned.length - inserted, errors };
}
