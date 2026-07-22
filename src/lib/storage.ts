/**
 * Storage-object helpers for data erasure / retention (DPDP §8(7), §12).
 *
 * The DSAR erase and the retention purge historically only nulled the DB
 * columns that HOLD a media URL/path — the underlying object in Supabase
 * Storage (attendance selfies, form photos, call-recording audio, lead
 * avatars) was orphaned and lived on indefinitely. These helpers turn a
 * stored value (a public/signed URL, or a bare object key) into a
 * `{ bucket, key }` reference and batch-delete the real objects.
 */
import { supabaseAdmin } from './supabase';

export interface StorageRef {
  bucket: string;
  key: string;
}

/**
 * Parse a stored media value into a `{ bucket, key }` reference.
 *
 * Handles the three shapes we persist:
 *   1. Supabase public URL   …/storage/v1/object/public/<bucket>/<key>
 *   2. Supabase signed URL   …/storage/v1/object/sign/<bucket>/<key>?token=…
 *   3. A bare object key      "<org>/<user>/<uuid>.jpg"  (needs defaultBucket)
 *
 * Returns null for empty values or foreign URLs (e.g. the demo Unsplash
 * placeholder) that we must never attempt to delete.
 */
export function parseStorageRef(value: string | null | undefined, defaultBucket?: string): StorageRef | null {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const marker = '/storage/v1/object/';
  const idx = raw.indexOf(marker);
  if (idx !== -1) {
    // Everything after the marker, minus any query string / fragment.
    let rest = raw.slice(idx + marker.length).split(/[?#]/)[0];
    // Strip the access-mode segment (public | sign | authenticated).
    rest = rest.replace(/^(public|sign|authenticated)\//, '');
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const bucket = decodeURIComponent(rest.slice(0, slash));
    const key = decodeURIComponent(rest.slice(slash + 1));
    if (!bucket || !key) return null;
    return { bucket, key };
  }

  // Not a URL. Only treat it as an object key when we know the bucket AND the
  // value isn't some other absolute URL we don't own.
  if (/^https?:\/\//i.test(raw)) return null;
  if (!defaultBucket) return null;
  // A value may be stored as "<bucket>/<key>" — if it leads with the known
  // bucket, drop that prefix so we don't double it.
  const key = raw.startsWith(`${defaultBucket}/`) ? raw.slice(defaultBucket.length + 1) : raw;
  if (!key) return null;
  return { bucket: defaultBucket, key };
}

/**
 * Delete a set of storage objects, grouped per bucket and chunked to stay
 * within Supabase's remove() limits. Error-tolerant: a failure on one bucket
 * is collected and reporting continues — retention/erasure must not abort
 * halfway. Returns the number of objects successfully requested for deletion.
 */
export async function deleteStorageObjects(
  refs: Array<StorageRef | null | undefined>,
): Promise<{ deleted: number; errors: string[] }> {
  const errors: string[] = [];
  const byBucket = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!ref) continue;
    if (!byBucket.has(ref.bucket)) byBucket.set(ref.bucket, new Set());
    byBucket.get(ref.bucket)!.add(ref.key);
  }

  let deleted = 0;
  const CHUNK = 100;
  for (const [bucket, keySet] of byBucket) {
    const keys = [...keySet];
    for (let i = 0; i < keys.length; i += CHUNK) {
      const batch = keys.slice(i, i + CHUNK);
      const { error } = await supabaseAdmin.storage.from(bucket).remove(batch);
      if (error) {
        errors.push(`${bucket}: ${error.message}`);
      } else {
        deleted += batch.length;
      }
    }
  }
  return { deleted, errors };
}

/** Convenience: parse a list of stored values and delete the resolved objects. */
export async function deleteStoredMedia(
  values: Array<string | null | undefined>,
  defaultBucket?: string,
): Promise<{ deleted: number; errors: string[] }> {
  return deleteStorageObjects(values.map((v) => parseStorageRef(v, defaultBucket)));
}
