/**
 * Guard rails for GET /crm/lookup/search, which reads a caller-named table with the service-role client.
 *
 * The picker is meant for "linked record" custom fields: tables the admin chose from /crm/lookup/targets
 * (the list_lookup_tables() RPC) plus the curated CRM tables. It must never become a generic table reader,
 * so (1) the target must be one of those, minus anything that holds credentials, and (2) credential-like columns
 * are removed from every row and cannot be used as a filter (a boolean oracle on a hidden column).
 */

/** Tables whose name says "credential": never offered as a lookup target, whatever the RPC lists. */
const SENSITIVE_TABLE_RE = /(integration|credential|secret|token|vault|oauth|api_?key|webhook|connection|session|audit_log|password|refresh|whatsapp_conn)/i;

/** Columns that never leave the server through a picker. */
const SENSITIVE_COLUMN_RE = /(secret|token|passw|hash|credential|api_?key|private|authcode|encrypted|cipher|refresh|session|fcm|apns|webhook|signature)/i;
const SENSITIVE_OTP_RE = /(^|_)otp($|_)/i;

export const isSensitiveTable = (name: string): boolean => SENSITIVE_TABLE_RE.test(name);
export const isSensitiveColumn = (name: string): boolean => SENSITIVE_COLUMN_RE.test(name) || SENSITIVE_OTP_RE.test(name);

/** May this table be read through the picker? Curated tables always; others only if the RPC offered them. */
export function isLookupTargetAllowed(target: string, curated: ReadonlySet<string>, offered: ReadonlySet<string>): boolean {
  if (curated.has(target)) return true;
  return offered.has(target) && !isSensitiveTable(target);
}

/** A copy of the row without credential-like columns. */
export function stripSensitiveColumns<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!isSensitiveColumn(k)) out[k] = v;
  return out as Partial<T>;
}

/** Per-project cache of the offered tables (the RPC scans the catalogue). */
const offeredCache = new Map<string, { at: number; tables: Set<string> }>();
const OFFERED_TTL_MS = 5 * 60_000;

export async function offeredLookupTables(
  project: string,
  load: () => Promise<Array<{ table_name: string }>>,
  now = Date.now(),
): Promise<Set<string>> {
  const hit = offeredCache.get(project);
  if (hit && now - hit.at < OFFERED_TTL_MS) return hit.tables;
  const tables = new Set((await load()).map((r) => r.table_name));
  offeredCache.set(project, { at: now, tables });
  return tables;
}

/** Test seam. */
export const _resetOfferedLookupCache = (): void => offeredCache.clear();
