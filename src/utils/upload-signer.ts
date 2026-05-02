import crypto from 'crypto';
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'distribution';
const SIGN_TTL_SEC = 5 * 60;

/**
 * Distribution upload paths are deterministic and bucket-scoped:
 *   org/<org_id>/distribution/<kind>/<uuid>.<ext>
 *
 * Kinds: cheque | pod | return | signature | kyc
 */
export type UploadKind = 'cheque' | 'pod' | 'return' | 'signature' | 'kyc';

export function buildUploadPath(orgId: string, kind: UploadKind, ext = 'jpg') {
  const id = crypto.randomUUID();
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'jpg';
  return `org/${orgId}/distribution/${kind}/${id}.${safeExt}`;
}

/**
 * Issue a short-lived signed PUT URL for the FE / dashboard to upload an
 * asset. Returns the public path so callers can persist it on the entity
 * (cheque_image_url, pod_image_url, etc).
 */
export async function signUpload(orgId: string, kind: UploadKind, ext = 'jpg') {
  const path = buildUploadPath(orgId, kind, ext);
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  if (error) {
    logger.error(`[upload-signer] failed: ${error.message}`);
    throw new Error(error.message);
  }
  return {
    upload_url: data.signedUrl,
    token: data.token,
    bucket: BUCKET,
    path,
    public_url: `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`,
    expires_in: SIGN_TTL_SEC,
  };
}

/**
 * Validates that a stored URL came from our signed-upload flow. Defends
 * against attackers pasting arbitrary URLs into cheque_image_url, pod_image_url, etc.
 */
export function isOurUploadUrl(url: string, orgId: string, kind?: UploadKind): boolean {
  if (!url || typeof url !== 'string') return false;
  const expectedPrefix = `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/org/${orgId}/distribution/`;
  if (!url.startsWith(expectedPrefix)) return false;
  if (kind && !url.startsWith(expectedPrefix + kind + '/')) return false;
  return true;
}
