/**
 * Screenshots (and other images) attached to a support ticket.
 *
 * **Why these files live in the support project, not the customer's.** A ticket is always stored in the
 * Kinematic project, but the customer raising it may live in any project, and the platform operator who works
 * the ticket lives in the Kinematic one. The generic `POST /upload/:type` endpoint writes to whichever project
 * the caller is in, so a screenshot uploaded by a Tata user would sit in Tata's storage and the operator could
 * never be issued a signed URL for it. Everything here therefore goes into ONE private bucket in the support
 * project, which both sides can be served from.
 *
 * **Why the path carries the org.** The browser uploads first and then names the files when it creates the
 * ticket, so the create path receives client-supplied descriptors. Objects are stored under
 * `support/<org_id>/<uuid>.<ext>` and `toAttachments` refuses anything outside the requester's own prefix —
 * otherwise a customer could claim another customer's object id and have the server hand them a signed URL
 * for someone else's screenshot.
 *
 * The bucket is private: nothing here is ever a directly fetchable URL. `signAttachments` issues short-lived
 * signed URLs, and only for a ticket the caller is already allowed to see.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { logger } from '../../lib/logger';

export const SUPPORT_BUCKET = (process.env.BUCKET_SUPPORT_ATTACHMENTS || 'support-attachments').trim();
export const MAX_ATTACHMENTS = 5;
export const MAX_BYTES = 8 * 1024 * 1024;
/** How long a display URL stays valid. Long enough to open a ticket and look; short enough not to leak. */
const SIGN_TTL_SECONDS = 10 * 60;

/** Images only — a support screenshot is a picture, and this keeps the attack surface small. */
export const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

export interface SupportAttachment {
  path: string;
  bucket: string;
  name: string;
  size: number;
  content_type: string;
  uploaded_at: string;
}

export interface SignedAttachment extends SupportAttachment {
  /** Null when the object has gone or signing failed — the UI shows the name without a link. */
  url: string | null;
}

export class AttachmentError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const clean = (v: unknown, max: number): string => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);

/** A readable file name, stripped of any path the browser may have included. */
const safeName = (v: unknown): string => {
  const base = clean(v, 120).split(/[\\/]/).pop() || 'screenshot';
  return base.replace(/[^\w .()-]/g, '_') || 'screenshot';
};

/** The prefix every object for this org must sit under. */
export const prefixFor = (orgId: string): string => `support/${orgId}/`;

let bucketReady = false;
/** Create the private bucket on first use, so no environment needs manual setup. */
async function ensureBucket(db: SupabaseClient): Promise<void> {
  if (bucketReady) return;
  try {
    const { data } = await db.storage.getBucket(SUPPORT_BUCKET);
    if (!data) {
      const { error } = await db.storage.createBucket(SUPPORT_BUCKET, {
        public: false,
        fileSizeLimit: MAX_BYTES,
        allowedMimeTypes: Object.keys(ALLOWED_TYPES),
      });
      // Another concurrent upload may have won the race.
      if (error && !/exist/i.test(error.message)) throw error;
    }
    bucketReady = true;
  } catch (e: any) {
    logger.warn(`[support] could not ensure the attachments bucket: ${e?.message || e}`);
    throw new AttachmentError(500, 'Attachments are not available right now.');
  }
}

/** Test seam. */
export const _resetAttachmentState = (): void => { bucketReady = false; };

export interface IncomingFile {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer: Buffer;
}

/**
 * Store the uploaded files and describe them. `db` must be the SUPPORT project's admin client — the caller
 * owns that choice so this module never imports the ticket service (and so the two cannot form a cycle).
 */
export async function uploadAttachments(
  db: SupabaseClient,
  files: IncomingFile[],
  who: { orgId: string | null | undefined },
): Promise<SupportAttachment[]> {
  const orgId = clean(who.orgId, 64);
  if (!orgId) throw new AttachmentError(400, 'We could not tell which organisation this belongs to.');
  if (!files.length) throw new AttachmentError(400, 'Choose at least one image.');
  if (files.length > MAX_ATTACHMENTS) throw new AttachmentError(400, `Attach up to ${MAX_ATTACHMENTS} images.`);

  for (const f of files) {
    const ext = ALLOWED_TYPES[String(f.mimetype ?? '')];
    if (!ext) throw new AttachmentError(400, 'Attach a PNG, JPEG, WEBP or HEIC image.');
    if ((f.size ?? f.buffer.length) > MAX_BYTES) {
      throw new AttachmentError(400, `Each image must be under ${Math.round(MAX_BYTES / (1024 * 1024))} MB.`);
    }
  }

  await ensureBucket(db);

  const out: SupportAttachment[] = [];
  for (const f of files) {
    const contentType = String(f.mimetype);
    const ext = ALLOWED_TYPES[contentType];
    const path = `${prefixFor(orgId)}${randomUUID()}.${ext}`;
    const { error } = await db.storage.from(SUPPORT_BUCKET)
      .upload(path, f.buffer, { contentType, upsert: false });
    if (error) {
      logger.warn(`[support] attachment upload failed: ${error.message}`);
      throw new AttachmentError(500, 'That image could not be uploaded. Please try again.');
    }
    out.push({
      path,
      bucket: SUPPORT_BUCKET,
      name: safeName(f.originalname),
      size: Number(f.size ?? f.buffer.length) || 0,
      content_type: contentType,
      uploaded_at: new Date().toISOString(),
    });
  }
  return out;
}

/**
 * Descriptors the client sent back when creating the ticket, reduced to the ones it is actually entitled to
 * name: our bucket, our prefix for THIS org, a known image type. Anything else is dropped silently rather
 * than failing the ticket — losing a screenshot is much better than losing the report.
 */
export function toAttachments(v: unknown, orgId: string | null | undefined): SupportAttachment[] {
  const org = clean(orgId, 64);
  if (!org || !Array.isArray(v)) return [];
  const prefix = prefixFor(org);
  const out: SupportAttachment[] = [];
  for (const raw of v.slice(0, MAX_ATTACHMENTS * 2)) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const path = clean(a.path, 300);
    const bucket = clean(a.bucket, 100);
    const contentType = clean(a.content_type, 100);
    if (bucket !== SUPPORT_BUCKET) continue;
    if (!path.startsWith(prefix) || path.includes('..')) continue;
    if (!ALLOWED_TYPES[contentType]) continue;
    const size = Number(a.size);
    out.push({
      path,
      bucket,
      name: safeName(a.name),
      size: Number.isFinite(size) && size > 0 ? Math.min(size, MAX_BYTES) : 0,
      content_type: contentType,
      uploaded_at: clean(a.uploaded_at, 40) || new Date().toISOString(),
    });
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

/** Whatever is on the row, read back as descriptors (the column is jsonb, so trust nothing). */
export function fromRow(v: unknown): SupportAttachment[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const a = raw as Record<string, unknown>;
    const path = clean(a.path, 300);
    if (!path) return [];
    return [{
      path,
      bucket: clean(a.bucket, 100) || SUPPORT_BUCKET,
      name: safeName(a.name),
      size: Number(a.size) || 0,
      content_type: clean(a.content_type, 100) || 'image/png',
      uploaded_at: clean(a.uploaded_at, 40),
    }];
  });
}

/**
 * Short-lived display URLs. Never throws: a ticket whose screenshot has gone should still open, with the
 * file name shown and no link.
 */
export async function signAttachments(db: SupabaseClient, list: SupportAttachment[]): Promise<SignedAttachment[]> {
  const out: SignedAttachment[] = [];
  for (const a of list) {
    let url: string | null = null;
    try {
      const { data, error } = await db.storage.from(a.bucket || SUPPORT_BUCKET)
        .createSignedUrl(a.path, SIGN_TTL_SECONDS);
      if (error) logger.warn(`[support] signing ${a.path} failed: ${error.message}`);
      url = data?.signedUrl ?? null;
    } catch (e: any) {
      logger.warn(`[support] signing ${a.path} threw: ${e?.message || e}`);
    }
    out.push({ ...a, url });
  }
  return out;
}
