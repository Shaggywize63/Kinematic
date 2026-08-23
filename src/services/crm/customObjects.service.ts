/**
 * Custom Objects engine — user-defined CRM entity types beyond the built-in
 * lead / contact / deal / account.
 *
 *   - `crm_custom_objects`  : the object-type definitions (key, labels, icon).
 *   - `crm_custom_records`  : the rows for each object type (title + data jsonb).
 *
 * Fields are NOT a new table: a custom object's fields live in
 * `crm_custom_field_defs` with `entity_type = <object.key>`, so records reuse
 * the exact same validation / coercion / formula / lookup machinery as the
 * built-in entities (validateAndStampCustomFields).
 *
 * All access is tenant-scoped (org + client). Object types may be org-wide
 * (client_id null) or client-specific; records inherit their object's scope.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { validateAndStampCustomFields } from './customFields.service';

const KEY_RE = /^[a-z][a-z0-9_]{1,48}$/;
const RESERVED_KEYS = new Set(['lead', 'deal', 'contact', 'account', 'activity']);

export interface CustomObjectInput {
  key?: string;
  label?: string;
  label_plural?: string;
  icon?: string | null;
  description?: string | null;
  is_active?: boolean;
}

export interface CustomRecordInput {
  title?: string | null;
  data?: Record<string, unknown> | null;
  owner_id?: string | null;
}

interface CustomObject {
  id: string;
  org_id: string;
  client_id: string | null;
  key: string;
  label: string;
  label_plural: string;
  icon: string | null;
  description: string | null;
  is_active: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// ── Object types ──────────────────────────────────────────────────────────

export async function listObjects(org_id: string, client_id: string | null): Promise<CustomObject[]> {
  let q = supabaseAdmin
    .from('crm_custom_objects')
    .select('*')
    .eq('org_id', org_id)
    .is('deleted_at', null)
    .order('label', { ascending: true });
  if (client_id) q = q.or(`client_id.is.null,client_id.eq.${client_id}`);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []) as CustomObject[];
}

/** Resolve an object by its id (uuid) or its key, scoped to the tenant. */
export async function getObject(org_id: string, client_id: string | null, idOrKey: string): Promise<CustomObject> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrKey);
  let q = supabaseAdmin
    .from('crm_custom_objects')
    .select('*')
    .eq('org_id', org_id)
    .is('deleted_at', null)
    .eq(isUuid ? 'id' : 'key', idOrKey);
  if (client_id) q = q.or(`client_id.is.null,client_id.eq.${client_id}`);
  const { data, error } = await q.maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if (!data) throw new AppError(404, 'Custom object not found', 'NOT_FOUND');
  return data as CustomObject;
}

export async function createObject(
  org_id: string, client_id: string | null, input: CustomObjectInput, user_id: string | null,
): Promise<CustomObject> {
  const key = str(input.key).toLowerCase();
  const label = str(input.label);
  if (!KEY_RE.test(key)) {
    throw new AppError(400, 'key must be lowercase letters/numbers/underscores, 2-49 chars, starting with a letter', 'BAD_INPUT');
  }
  if (RESERVED_KEYS.has(key)) throw new AppError(400, `"${key}" is a reserved built-in entity`, 'BAD_INPUT');
  if (!label) throw new AppError(400, 'label is required', 'BAD_INPUT');

  const row = {
    org_id,
    client_id: client_id ?? null,
    key,
    label,
    label_plural: str(input.label_plural) || `${label}s`,
    icon: input.icon ?? null,
    description: input.description ?? null,
    is_active: input.is_active ?? true,
    created_by: user_id,
  };
  const { data, error } = await supabaseAdmin.from('crm_custom_objects').insert(row).select('*').single();
  if (error) {
    if (error.code === '23505') throw new AppError(409, `An object with key "${key}" already exists`, 'DUPLICATE');
    throw new AppError(500, error.message, 'DB_ERROR');
  }
  return data as CustomObject;
}

export async function updateObject(
  org_id: string, id: string, input: CustomObjectInput,
): Promise<CustomObject> {
  // key is immutable (field defs + records are bound to it); label/meta only.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.label !== undefined) patch.label = str(input.label);
  if (input.label_plural !== undefined) patch.label_plural = str(input.label_plural);
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.description !== undefined) patch.description = input.description;
  if (input.is_active !== undefined) patch.is_active = !!input.is_active;

  const { data, error } = await supabaseAdmin
    .from('crm_custom_objects')
    .update(patch)
    .eq('org_id', org_id).eq('id', id).is('deleted_at', null)
    .select('*').maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if (!data) throw new AppError(404, 'Custom object not found', 'NOT_FOUND');
  return data as CustomObject;
}

export async function deleteObject(org_id: string, id: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('crm_custom_objects')
    .update({ deleted_at: new Date().toISOString() })
    .eq('org_id', org_id).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
}

// ── Records ───────────────────────────────────────────────────────────────

export async function listRecords(
  org_id: string, client_id: string | null, obj: CustomObject,
  opts: { limit?: number; page?: number; q?: string; owner_id?: string | null } = {},
): Promise<{ rows: unknown[]; total: number }> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const page = Math.max(1, opts.page ?? 1);
  const from = (page - 1) * limit;

  let q = supabaseAdmin
    .from('crm_custom_records')
    .select('*', { count: 'exact' })
    .eq('org_id', org_id)
    .eq('object_id', obj.id)
    .is('deleted_at', null);
  if (client_id) q = q.or(`client_id.is.null,client_id.eq.${client_id}`);
  if (opts.owner_id) q = q.eq('owner_id', opts.owner_id);
  if (str(opts.q)) q = q.ilike('title', `%${str(opts.q)}%`);
  q = q.order('updated_at', { ascending: false }).range(from, from + limit - 1);

  const { data, error, count } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return { rows: data ?? [], total: count ?? 0 };
}

export async function getRecord(org_id: string, id: string): Promise<unknown> {
  const { data, error } = await supabaseAdmin
    .from('crm_custom_records')
    .select('*')
    .eq('org_id', org_id).eq('id', id).is('deleted_at', null)
    .maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if (!data) throw new AppError(404, 'Record not found', 'NOT_FOUND');
  return data;
}

export async function createRecord(
  org_id: string, client_id: string | null, obj: CustomObject,
  input: CustomRecordInput, user_id: string | null,
): Promise<unknown> {
  // Validate/coerce the field values against the object's field defs
  // (entity_type = obj.key), enforcing required fields like the interactive
  // create paths do for built-in entities.
  const data = await validateAndStampCustomFields(
    org_id, client_id, obj.key, input.data ?? {}, { enforceRequired: true },
  );
  const row = {
    object_id: obj.id,
    org_id,
    client_id: client_id ?? null,
    title: input.title ? str(input.title) : null,
    data,
    owner_id: input.owner_id ?? user_id ?? null,
    created_by: user_id,
  };
  const { data: rec, error } = await supabaseAdmin.from('crm_custom_records').insert(row).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return rec;
}

export async function updateRecord(
  org_id: string, client_id: string | null, obj: CustomObject, id: string, input: CustomRecordInput,
): Promise<unknown> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) patch.title = input.title ? str(input.title) : null;
  if (input.owner_id !== undefined) patch.owner_id = input.owner_id;
  if (input.data !== undefined) {
    patch.data = await validateAndStampCustomFields(
      org_id, client_id, obj.key, input.data ?? {}, { enforceRequired: true },
    );
  }
  const { data, error } = await supabaseAdmin
    .from('crm_custom_records')
    .update(patch)
    .eq('org_id', org_id).eq('id', id).is('deleted_at', null)
    .select('*').maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if (!data) throw new AppError(404, 'Record not found', 'NOT_FOUND');
  return data;
}

export async function deleteRecord(org_id: string, id: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('crm_custom_records')
    .update({ deleted_at: new Date().toISOString() })
    .eq('org_id', org_id).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
}
