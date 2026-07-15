/**
 * Per-type validation + coercion for custom_fields on lead/deal POST/PATCH.
 *
 * Until now the route validator accepted `custom_fields: z.record(z.unknown())`
 * — a free-form blob — so a misconfigured client could persist `{ score:
 * "not-a-number" }`, `{ visited_on: "yesterday" }`, or a select value that
 * isn't in the admin's option list. The backend never noticed; the bug
 * surfaced later when reports tried to sum or filter on those keys.
 *
 * This helper looks up the field defs for the entity and coerces / validates
 * each known key. Keys not in the def list pass through untouched (the blob
 * is intentionally extensible; we only police what the admin has defined).
 *
 * Coercion is deliberately forgiving — "true" → true, "5" → 5, "2026-06-13"
 * → date string — because real clients send a mix of typed and string
 * values. We only THROW when the value is genuinely unparseable for the
 * declared type (e.g. `score: "abc"` on a number field), since that's a
 * client bug we want surfaced as a 400 rather than persisted as garbage.
 */

import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { stampFormulaValues } from './formula.service';

type FieldDef = {
  field_key: string;
  field_type: string;
  options?: string[] | null;
  formula?: string | null;
};

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/** Loads the active field defs for an entity, scoped to the tenant. We
 *  intentionally fetch the full set (universal + client-scoped) so a
 *  field defined as universal is validated for every client. */
async function loadDefs(orgId: string, clientId: string | null, entity: string): Promise<FieldDef[]> {
  let q = supabaseAdmin
    .from('crm_custom_field_defs')
    .select('field_key, field_type, options, formula')
    .eq('org_id', orgId)
    .eq('entity_type', entity)
    .eq('is_active', true);
  if (clientId) {
    q = q.or(`client_id.is.null,client_id.eq.${clientId}`);
  }
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []) as FieldDef[];
}

function coerceBool(v: unknown, key: string): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  }
  if (typeof v === 'number') return v !== 0;
  throw new AppError(400, `custom_fields.${key}: expected boolean, got ${typeof v}`, 'BAD_CUSTOM_FIELD');
}

function coerceNumber(v: unknown, key: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  throw new AppError(400, `custom_fields.${key}: expected number, got ${JSON.stringify(v)}`, 'BAD_CUSTOM_FIELD');
}

function coerceDate(v: unknown, key: string): string {
  if (typeof v !== 'string') {
    throw new AppError(400, `custom_fields.${key}: expected ISO date string`, 'BAD_CUSTOM_FIELD');
  }
  // Accept either YYYY-MM-DD or a full ISO datetime — we just verify the
  // prefix parses; downstream consumers only read the date portion.
  if (!ISO_DATE_PREFIX.test(v) || Number.isNaN(Date.parse(v))) {
    throw new AppError(400, `custom_fields.${key}: invalid date "${v}"`, 'BAD_CUSTOM_FIELD');
  }
  return v;
}

function coerceMultiselect(v: unknown, key: string): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  // Tolerate a CSV string from older clients — split on comma + trim.
  if (typeof v === 'string') {
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  throw new AppError(400, `custom_fields.${key}: expected array of strings`, 'BAD_CUSTOM_FIELD');
}

/**
 * Validate + coerce a custom_fields payload against the defs for `entity`,
 * then stamp computed formula values. Returns the cleaned object — callers
 * should write THIS back to `payload.custom_fields` before the DB insert.
 */
export async function validateAndStampCustomFields(
  orgId: string,
  clientId: string | null,
  entity: 'lead' | 'deal' | 'contact' | 'account' | 'activity',
  incoming: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown>> {
  const input = { ...(incoming ?? {}) };
  // Empty payload + no defs → nothing to do; skip the round trip.
  if (Object.keys(input).length === 0) return input;
  const defs = await loadDefs(orgId, clientId, entity);
  if (defs.length === 0) return input;
  const byKey = new Map(defs.map((d) => [d.field_key, d]));

  for (const [key, raw] of Object.entries(input)) {
    const def = byKey.get(key);
    if (!def) continue; // unknown key — free-form blob behaviour preserved
    // Null / undefined / empty string → drop the key so the DB stores
    // `null` instead of "" (matches what the dashboard sends on clear).
    if (raw === null || raw === undefined || raw === '') {
      delete input[key];
      continue;
    }
    switch (def.field_type) {
      case 'boolean':
        input[key] = coerceBool(raw, key);
        break;
      case 'number':
      case 'currency':
        input[key] = coerceNumber(raw, key);
        break;
      case 'date':
      case 'datetime':
        input[key] = coerceDate(raw, key);
        break;
      case 'multiselect':
        input[key] = coerceMultiselect(raw, key);
        break;
      case 'select':
      case 'radio': {
        // Coerce to string; do NOT reject values outside `options` — admins
        // edit option lists over time and we don't want to invalidate
        // historic values (or the legacy "free-text became a picker" case).
        input[key] = String(raw);
        break;
      }
      case 'formula':
        // Client-supplied formula values are ignored — stampFormulaValues
        // below recomputes them server-side from the current payload.
        delete input[key];
        break;
      case 'lookup': {
        // The web picker sends `{ id, label, target_table }`; mobile sends
        // the bare id string. Canonicalise to the id — the old default
        // branch String()'d the object and persisted the literal
        // "[object Object]" (detail panels hydrate ids to labels via
        // /lookup/search?ids=, so the bare id renders correctly everywhere).
        const id = (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string')
          ? (raw as { id: string }).id
          : null;
        if (id) { input[key] = id; break; }
        if (typeof raw === 'string') { input[key] = raw; break; }
        throw new AppError(400, `custom_fields.${key}: expected a record id`, 'BAD_CUSTOM_FIELD');
      }
      default:
        // text / longtext / email / phone / url — store as string
        input[key] = typeof raw === 'string' ? raw : String(raw);
    }
  }

  // After coercion, recompute formula values so they reflect the cleaned
  // (typed) inputs — `score * weight` won't work if `score` is still the
  // string "5". stampFormulaValues is a no-op if no formula defs exist.
  return stampFormulaValues(defs, input);
}
