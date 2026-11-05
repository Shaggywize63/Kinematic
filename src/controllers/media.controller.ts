import { Response } from 'express';
import { adminClientFor, knownProjectKeys, getProjectConfig, currentProjectKey } from '../lib/projects';
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

/** Accept either explicit bucket+path, or a stored Supabase object URL to parse.
 *  When a url is given we also capture its host, which identifies the storage
 *  gateway (hence the Supabase project) the object physically lives in. */
function parseObjectRef(bucket?: string, path?: string, url?: string): { bucket: string; path: string; host?: string } | null {
  if (url) {
    const m = String(url).match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+?)(?:\?|$)/);
    if (!m) return null;
    let host: string | undefined;
    try { host = new URL(String(url)).host; } catch { /* not an absolute URL — no host hint */ }
    return { bucket: decodeURIComponent(m[1]), path: decodeURIComponent(m[2]), host };
  }
  if (bucket && path) return { bucket: String(bucket), path: String(path) };
  return null;
}

/**
 * Ordered, de-duplicated list of projects to try signing the object against.
 *
 * A private object physically lives in exactly ONE project's storage backend,
 * which is NOT necessarily the current request's project. Mobile apps upload
 * without an `X-Kinematic-Project` header, so they land in the default (Tata)
 * stack even when the owning row lives in another project's DB — e.g. a
 * Kinematic-org selfie sits in the default stack while the dashboard signs as
 * the `kinematic` project. Signing against the wrong stack returns NoSuchKey,
 * so the raw URL leaks through and the image breaks.
 *
 * We therefore try, in order: the project whose gateway host matches the stored
 * URL (definitive when a url was supplied), then the current request's project,
 * then every other known project — and return the first that signs. The org-id
 * path-prefix authorization above is unchanged and independent of which storage
 * backend holds the bytes, so probing several backends for the SAME fixed path
 * can never cross tenants.
 */
function signingCandidates(host?: string): string[] {
  const keys = knownProjectKeys();
  const byHost = host
    ? keys.find((k) => { try { return new URL(getProjectConfig(k).url).host === host; } catch { return false; } })
    : undefined;
  return [byHost, currentProjectKey(), ...keys]
    .filter((k): k is string => !!k)
    .filter((k, i, a) => a.indexOf(k) === i);
}

/** Longest expiry a caller may ask for (a downloaded report's links). */
export const MAX_SIGN_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Most objects one batch call signs. */
export const MAX_SIGN_BATCH = 200;

/** Requested expiry in seconds: the short default unless a valid larger value is asked for, capped at 7 days. */
export function resolveSignTtl(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= SIGN_TTL_SECONDS) return SIGN_TTL_SECONDS;
  return Math.min(n, MAX_SIGN_TTL_SECONDS);
}

type SignResult = { url: string; expiresIn: number } | { error: string; forbidden?: boolean };

/** Sign one object for the caller (tenant/role checks included). Never throws. */
async function signObject(
  user: NonNullable<AuthRequest['user']>,
  ref: { bucket: string; path: string; host?: string } | null,
  ttl: number,
): Promise<SignResult> {
  if (!ref) return { error: 'Provide bucket+path or a url' };
  const { bucket, path, host } = ref;
  if (!SIGNABLE_BUCKETS.has(bucket)) return { error: 'Bucket is not signable' };

  // Path-traversal / malformed-path guard.
  if (!path || path.includes('..') || path.startsWith('/') || path.includes('\\')) {
    return { error: 'Invalid object path' };
  }

  // Tenant isolation via the object path prefix.
  if (!path.startsWith(`${user.org_id}/`)) return { error: 'Not permitted for this object', forbidden: true };
  const isManager = MANAGER_ROLES.has(String(user.role || '').toLowerCase());
  if (!isManager && !path.startsWith(`${user.org_id}/${user.id}/`)) {
    return { error: 'Not permitted for this object', forbidden: true };
  }

  // The object may live in a different project's storage than the current
  // request's (mobile uploads land in the default stack) — try each candidate
  // project until one signs. Authorization is already enforced above.
  for (const key of signingCandidates(host)) {
    try {
      const { data, error } = await adminClientFor(key).storage.from(bucket).createSignedUrl(path, ttl);
      if (!error && data?.signedUrl) return { url: data.signedUrl, expiresIn: ttl };
    } catch { /* project unreachable / object not here — try the next */ }
  }
  return { error: 'Could not sign object' };
}

// GET /api/v1/media/sign?bucket=<b>&path=<p>   (or ?url=<stored object url>)  [&ttl=<seconds, max 7 days>]
export const signMedia = asyncHandler(async (req: AuthRequest, res: Response) => {
  const ref = parseObjectRef(req.query.bucket as string, req.query.path as string, req.query.url as string);
  const r = await signObject(req.user!, ref, resolveSignTtl(req.query.ttl));
  if ('error' in r) return r.forbidden ? forbidden(res, r.error) : badRequest(res, r.error);
  return ok(res, r);
});

// POST /api/v1/media/sign-batch  { urls: string[], ttl?: seconds }  ->  { urls: { [stored]: signed | null } }
// For report exports: one call signs every photo of a report with a long-lived link. A URL that is
// not signable, not the caller's to see or missing maps to null — the rest still sign.
export const signMediaBatch = asyncHandler(async (req: AuthRequest, res: Response) => {
  const raw = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const urls: string[] = Array.from(new Set<string>(raw.filter((u: unknown): u is string => typeof u === 'string' && u.length > 0 && u.length < 2048)));
  if (urls.length === 0) return badRequest(res, 'Provide urls');
  if (urls.length > MAX_SIGN_BATCH) return badRequest(res, `At most ${MAX_SIGN_BATCH} urls per call`);
  const ttl = resolveSignTtl(req.body?.ttl);
  const out: Record<string, string | null> = {};
  await Promise.all(urls.map(async (u) => {
    const r = await signObject(req.user!, parseObjectRef(undefined, undefined, u), ttl);
    out[u] = 'url' in r ? r.url : null;
  }));
  return ok(res, { urls: out, expiresIn: ttl });
});
