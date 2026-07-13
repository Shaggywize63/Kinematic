import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest, forbidden } from '../utils';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * Short-lived signed-URL issuer for private storage objects.
 *
 * Lets the dashboard / apps display images (attendance selfies, form photos,
 * avatars, materials) once their buckets are flipped from public to PRIVATE —
 * the fix for SECURITY_AUDIT_2026-07.md PR-1 (world-readable selfie/photo
 * buckets). Callers request a signed URL instead of loading the raw public URL.
 *
 * Tenant-safe by construction: uploads are stored as
 *   `${org_id}/${user_id}/${uuid}.${ext}`   (see upload.controller.ts)
 * so we require the object path to start with the caller's own org_id, and
 * non-manager roles may only sign their OWN uploads. This prevents a signing
 * endpoint from becoming a cross-tenant / cross-user IDOR.
 */

// Buckets whose objects use the org/user path prefix and may be signed here.
const SIGNABLE_BUCKETS = new Set<string>([
  process.env.BUCKET_SELFIES || 'kinematic-selfies',
  process.env.BUCKET_FORM_PHOTOS || 'kinematic-form-photos',
  'kinematic-form-photos',
  'form-responses',
  process.env.BUCKET_AVATARS || 'kinematic-avatars',
  process.env.BUCKET_MATERIALS || 'kinematic-materials',
]);

const SIGN_TTL_SECONDS = 300; // 5 minutes — enough to render, short enough to not leak.

// Roles allowed to view any object within their org (e.g. a manager viewing a
// team member's attendance selfie). Everyone else is limited to their own uploads.
const MANAGER_ROLES = new Set<string>([
  'super_admin', 'admin', 'main_admin', 'sub_admin', 'city_manager', 'supervisor', 'client', 'hr',
]);

/** Accept either explicit bucket+path, or a stored Supabase object URL to parse. */
function parseObjectRef(bucket?: string, path?: string, url?: string): { bucket: string; path: string } | null {
  if (url) {
    const m = String(url).match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+?)(?:\?|$)/);
    if (!m) return null;
    return { bucket: decodeURIComponent(m[1]), path: decodeURIComponent(m[2]) };
  }
  if (bucket && path) return { bucket: String(bucket), path: String(path) };
  return null;
}

// GET /api/v1/media/sign?bucket=<b>&path=<p>   (or ?url=<stored object url>)
export const signMedia = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const ref = parseObjectRef(req.query.bucket as string, req.query.path as string, req.query.url as string);
  if (!ref) return badRequest(res, 'Provide bucket+path or a url');

  const { bucket, path } = ref;
  if (!SIGNABLE_BUCKETS.has(bucket)) return badRequest(res, 'Bucket is not signable');

  // Path-traversal / malformed-path guard.
  if (!path || path.includes('..') || path.startsWith('/') || path.includes('\\')) {
    return badRequest(res, 'Invalid object path');
  }

  // Tenant isolation via the object path prefix.
  if (!path.startsWith(`${user.org_id}/`)) return forbidden(res, 'Not permitted for this object');
  const isManager = MANAGER_ROLES.has(String(user.role || '').toLowerCase());
  if (!isManager && !path.startsWith(`${user.org_id}/${user.id}/`)) {
    return forbidden(res, 'Not permitted for this object');
  }

  const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, SIGN_TTL_SECONDS);
  if (error || !data?.signedUrl) return badRequest(res, 'Could not sign object');

  return ok(res, { url: data.signedUrl, expiresIn: SIGN_TTL_SECONDS });
});
