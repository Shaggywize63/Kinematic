import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { getProjectConfig, currentProjectKey } from '../lib/projects';
import { AuthRequest } from '../types';
import { ok, created, badRequest, notFound, isDemo } from '../utils';
import { asyncHandler } from '../utils/asyncHandler';

// A stored material file_url may be a Supabase-storage object reference. Those
// buckets are PRIVATE, and a reference can even carry a stale cross-tenant host
// (e.g. a Vanrakshak file whose URL was written against the Tata storage host).
// So never hand the raw stored URL to a client: re-sign it against the CURRENT
// tenant's storage, from the object's bucket+path alone (host/public|sign and
// any token are ignored). An external URL (type 'link') is left untouched.
const STORAGE_OBJECT_RE = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?]+)\/([^?]+)/;

async function toTenantSignedUrl(rawUrl?: string | null): Promise<string | null | undefined> {
  if (!rawUrl) return rawUrl;
  const m = STORAGE_OBJECT_RE.exec(rawUrl);
  if (!m) return rawUrl; // not a storage object — an external link, leave as-is
  const bucket = decodeURIComponent(m[1]);
  const path = decodeURIComponent(m[2]);
  try {
    const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, 60 * 60);
    if (!error && data?.signedUrl) return data.signedUrl;
  } catch { /* fall through to host-rewrite */ }
  // Could not sign (e.g. object missing on this tenant): at minimum rewrite the
  // host to the current tenant so a stale cross-tenant host never reaches a client.
  const base = getProjectConfig(currentProjectKey()).url.replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

const materialSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(['video','pdf','slides','document','link','image']),
  file_url: z.string().url(),
  thumbnail_url: z.string().url().optional(),
  duration_min: z.number().int().optional(),
  page_count: z.number().int().optional(),
  target_roles: z.array(z.string()).default(['executive']),
  is_mandatory: z.boolean().default(false),
});

// GET /api/v1/learning
export const getMaterials = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, []);

  const { data, error } = await supabaseAdmin
    .from('learning_materials')
    .select(`
      *,
      learning_progress!left(is_completed, progress_pct, last_accessed)
    `)
    .eq('org_id', user.org_id)
    .eq('is_active', true)
    .contains('target_roles', [user.role])
    .order('is_mandatory', { ascending: false })
    .order('published_at', { ascending: false });

  if (error) return badRequest(res, error.message);

  const enriched = await Promise.all((data || []).map(async (m) => ({
    ...m,
    // Serve a fresh, tenant-correct signed URL — never the raw stored reference.
    file_url: await toTenantSignedUrl(m.file_url),
    thumbnail_url: await toTenantSignedUrl(m.thumbnail_url),
    my_progress: Array.isArray(m.learning_progress) && m.learning_progress.length > 0
      ? m.learning_progress[0]
      : null,
    learning_progress: undefined,
  })));

  return ok(res, enriched);
});

// POST /api/v1/learning  (admin+)
export const createMaterial = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: 'demo-mat' }, 'Material published (Demo)');
  const body = materialSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data, error } = await supabaseAdmin
    .from('learning_materials')
    .insert({ ...body.data, org_id: user.org_id, created_by: user.id, published_at: new Date().toISOString() })
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, data, 'Material published');
});

// POST /api/v1/learning/:id/progress
export const updateProgress = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { status: 'success' });
  const { id } = req.params;
  const { progress_pct, is_completed } = req.body;

  const { data: material } = await supabaseAdmin
    .from('learning_materials')
    .select('id')
    .eq('id', id)
    .eq('org_id', user.org_id)
    .single();

  if (!material) return notFound(res, 'Material not found');

  const { data, error } = await supabaseAdmin
    .from('learning_progress')
    .upsert({
      material_id: id,
      user_id: user.id,
      org_id: user.org_id,
      progress_pct: progress_pct ?? 0,
      is_completed: is_completed ?? false,
      last_accessed: new Date().toISOString(),
      ...(is_completed && { completed_at: new Date().toISOString() }),
    }, { onConflict: 'material_id,user_id' })
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return ok(res, data);
});
// DELETE /api/v1/learning/:id (admin+)
export const deleteMaterial = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, null, 'Material deleted (Demo)');
  const { id } = req.params;

  const { data, error } = await supabaseAdmin
    .from('learning_materials')
    .update({ is_active: false })
    .eq('id', id)
    .eq('org_id', user.org_id)
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Material not found');

  return ok(res, null, 'Material deleted');
});
