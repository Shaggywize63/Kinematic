/**
 * Split an array into fixed-size batches.
 *
 * Primary use: keeping PostgREST `.in(column, ids)` lists small enough that the
 * request URL stays under the Supabase/Kong URI-length limit. A single `.in()`
 * over thousands of UUIDs builds a 60-160 KB URL that 414s or hangs at the
 * proxy — batching the ids (200 at a time) keeps every request URL small while
 * returning the same rows. See the CRM lead-export enrichment.
 */
export function chunk<T>(arr: readonly T[], size = 200): T[][] {
  if (size <= 0) return arr.length ? [arr.slice()] : [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
