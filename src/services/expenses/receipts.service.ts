/**
 * Receipt images: upload, store privately, and show to the people allowed to
 * see them.
 *
 * Objects live at {org_id}/{user_id}/{uuid}.{ext} in a PRIVATE bucket. The claim
 * stores the object reference as receipt_url; viewers never get a long-lived
 * link — getClaim signs a short-lived URL per receipt, gated by the claim's own
 * visibility rules (owner, approver in the chain, admin). That avoids relying on
 * the generic media signer's role list, which excludes some approver roles.
 */
import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from '../../lib/supabase';
import { currentProjectKey } from '../../lib/projects';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { scanReceipt, ReceiptMediaType } from './receiptScan.service';
import { Actor } from './access';

export const RECEIPT_BUCKET = process.env.BUCKET_RECEIPTS || 'kinematic-receipts';
const MAX_BYTES = 10 * 1024 * 1024;
const SIGN_TTL_SECONDS = 600;
// Buckets a claim's receipt may legitimately point at (older app builds uploaded
// receipts through the generic photo endpoint).
const SIGNABLE = new Set([RECEIPT_BUCKET, 'kinematic-form-photos', 'form-responses']);
const OBJECT_RE = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+?)(?:\?|$)/;

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
};
const SCANNABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** What the bytes actually are — never trust the declared content type alone. */
export function sniff(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (b.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('ascii');
    if (/^(heic|heix|hevc|hevx|mif1|msf1)/.test(brand)) return 'image/heic';
  }
  return null;
}

const bucketReady = new Set<string>();
async function ensureBucket(): Promise<void> {
  const key = `${currentProjectKey()}|${RECEIPT_BUCKET}`;
  if (bucketReady.has(key)) return;
  const { data } = await supabaseAdmin.storage.getBucket(RECEIPT_BUCKET);
  if (!data) {
    const { error } = await supabaseAdmin.storage.createBucket(RECEIPT_BUCKET, { public: false, fileSizeLimit: MAX_BYTES });
    // Another request may have created it first.
    if (error && !/exist/i.test(error.message)) throw new AppError(500, `Receipt storage is unavailable: ${error.message}`, 'STORAGE');
  }
  bucketReady.add(key);
}

export interface UploadedFile { buffer: Buffer; mimetype?: string; originalname?: string; size?: number }

export async function uploadReceipt(actor: Actor, file: UploadedFile, opts: { scan?: boolean } = {}) {
  if (!file?.buffer?.length) throw new AppError(400, 'No file received', 'NO_FILE');
  if (file.buffer.length > MAX_BYTES) throw new AppError(413, 'The file is larger than 10 MB', 'TOO_LARGE');
  const type = sniff(file.buffer);
  if (!type) throw new AppError(415, 'Upload a JPG, PNG, WebP, HEIC or PDF', 'UNSUPPORTED_TYPE');

  await ensureBucket();
  const path = `${actor.org_id}/${actor.id}/${uuidv4()}.${EXT[type]}`;
  const { error } = await supabaseAdmin.storage.from(RECEIPT_BUCKET).upload(path, file.buffer, { contentType: type, upsert: false });
  if (error) throw new AppError(500, `Could not store the receipt: ${error.message}`, 'STORAGE');

  const { data: pub } = supabaseAdmin.storage.from(RECEIPT_BUCKET).getPublicUrl(path);
  const { data: signed } = await supabaseAdmin.storage.from(RECEIPT_BUCKET).createSignedUrl(path, SIGN_TTL_SECONDS);

  // OCR is a convenience, never a requirement: a failure must not lose the upload.
  let scan: unknown = null;
  if (opts.scan !== false && SCANNABLE.has(type)) {
    try { scan = await scanReceipt(file.buffer.toString('base64'), type as ReceiptMediaType); }
    catch (e: any) { logger.warn(`[expenses] receipt OCR failed: ${e?.message || e}`); }
  }

  return {
    url: pub.publicUrl, path, bucket: RECEIPT_BUCKET, content_type: type, size: file.buffer.length,
    signed_url: signed?.signedUrl ?? null, scan,
  };
}

function parseRef(url: string): { bucket: string; path: string } | null {
  const m = String(url).match(OBJECT_RE);
  return m ? { bucket: decodeURIComponent(m[1]), path: decodeURIComponent(m[2]) } : null;
}

/**
 * A claim may only reference storage objects its owner uploaded. External https
 * links pass through untouched. This is what stops someone attaching another
 * person's (or another tenant's) object as their "receipt".
 */
export function assertReceiptsOwned(actor: Actor, items: Array<{ receipt_url?: string | null }>): void {
  for (const it of items) {
    if (!it.receipt_url) continue;
    const ref = parseRef(it.receipt_url);
    if (!ref) continue;
    if (!ref.path.startsWith(`${actor.org_id}/${actor.id}/`) || ref.path.includes('..')) {
      throw new AppError(400, 'A receipt on this claim was not uploaded by you', 'RECEIPT_FORBIDDEN');
    }
  }
}

/** A short-lived viewable URL for a stored receipt, or the link itself if external. */
export async function signReceipt(orgId: string, url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  const ref = parseRef(url);
  if (!ref) return url;
  // Re-checked at read time: only this tenant's objects, only known buckets.
  if (!SIGNABLE.has(ref.bucket) || !ref.path.startsWith(`${orgId}/`) || ref.path.includes('..')) return null;
  try {
    const { data, error } = await supabaseAdmin.storage.from(ref.bucket).createSignedUrl(ref.path, SIGN_TTL_SECONDS);
    return error ? null : (data?.signedUrl ?? null);
  } catch { return null; }
}
