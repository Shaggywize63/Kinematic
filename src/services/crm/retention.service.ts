/**
 * Data-retention purge — GDPR Art. 5(1)(e) storage limitation, DPDP §8(7).
 *
 * Enforces a retention schedule by permanently removing personal data that has
 * outlived its purpose:
 *   1. Soft-deleted CRM rows (deleted_at older than the grace window) are
 *      hard-purged — closing the "soft-delete never erases PII" gap.
 *   2. Field-force location/telemetry history (GPS pings, work activity, SOS /
 *      security alerts) older than the location window is trimmed.
 *   3. Optionally, audit_log rows older than the audit window (OFF by default —
 *      audit_log is an immutability control; only trim it when an operator
 *      consciously opts in via RETENTION_PURGE_AUDIT=true).
 *
 * SAFETY: destructive. Runs as a DRY RUN (counts only, no deletes) unless
 * RETENTION_PURGE_ENABLED=true. A caller may also force a dry run explicitly.
 * Windows are env-tunable. Intended to be invoked by the cron edge-secret route.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { deleteStoredMedia } from '../../lib/storage';

const DAY_MS = 86_400_000;

// CRM entity tables that soft-delete via deleted_at (verified against schema).
const SOFT_DELETE_TABLES = ['crm_leads', 'crm_contacts', 'crm_deals', 'crm_accounts', 'crm_activities'];
// Append-only location / telemetry tables, trimmed by created_at.
// NOTE: work_activity (the continuous employee GPS trail) is EXCLUDED by
// default per a standing product decision, but can be age-trimmed for §8(7)
// storage-limitation by setting RETENTION_TRIM_WORK_ACTIVITY=true.
const LOCATION_TABLES = ['visit_logs', 'security_alerts', 'sos_alerts'];

/**
 * Tables carrying personal MEDIA (facial selfies, form photos, call audio).
 * Past the media window we delete the underlying storage object AND either null
 * the URL column (keeping the business row, e.g. an attendance/payroll record)
 * or delete the row entirely. This closes the gap where only the DB column was
 * cleared while the blob lived on forever. DPDP §8(7).
 */
interface MediaSpec {
  table: string;
  dateColumn: string;
  mediaColumns: string[];
  /** Bucket for bare-key columns (e.g. audio_path); URL columns self-describe. */
  defaultBucket?: string;
  action: 'null_media' | 'delete_row';
}
const MEDIA_TABLES: MediaSpec[] = [
  { table: 'attendance', dateColumn: 'created_at', mediaColumns: ['checkin_selfie_url', 'checkout_selfie_url'], action: 'null_media' },
  { table: 'form_submissions', dateColumn: 'created_at', mediaColumns: ['photo_url'], action: 'null_media' },
  { table: 'conversation_recordings', dateColumn: 'created_at', mediaColumns: ['audio_path'], defaultBucket: 'conversation-audio', action: 'delete_row' },
];
// Cap rows processed per media table per run — keeps a single daily job bounded.
const MEDIA_PAGE = 5000;

export interface RetentionResult {
  dryRun: boolean;
  windows: { softDeleteDays: number; locationDays: number; auditDays: number | null; mediaDays: number };
  softDeletedPurged: Record<string, number>;
  locationTrimmed: Record<string, number>;
  mediaPurged: Record<string, number>;
  storageObjectsDeleted: number;
  auditTrimmed: number | null;
  totalRows: number;
  errors: string[];
}

function cutoffIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/**
 * Count (dry run) or delete rows in `table` where `column` < cutoff.
 * Returns the number of rows affected/matched. Errors are surfaced to the caller.
 */
async function purge(table: string, column: 'deleted_at' | 'created_at', cutoff: string, dryRun: boolean): Promise<number> {
  if (dryRun) {
    const { count, error } = await supabaseAdmin
      .from(table)
      .select('*', { count: 'exact', head: true })
      .lt(column, cutoff);
    if (error) throw new Error(`${table} (count): ${error.message}`);
    return count ?? 0;
  }
  const { count, error } = await supabaseAdmin
    .from(table)
    .delete({ count: 'exact' })
    .lt(column, cutoff);
  if (error) throw new Error(`${table} (delete): ${error.message}`);
  return count ?? 0;
}

/**
 * Purge personal media past its window. Returns rows affected and storage
 * objects deleted. On a dry run, counts the eligible rows and deletes nothing.
 */
async function purgeMedia(spec: MediaSpec, cutoff: string, dryRun: boolean): Promise<{ rows: number; storageDeleted: number; errors: string[] }> {
  const errors: string[] = [];
  const { data, error } = await supabaseAdmin
    .from(spec.table)
    .select(['id', ...spec.mediaColumns].join(','))
    .lt(spec.dateColumn, cutoff)
    .limit(MEDIA_PAGE);
  if (error) throw new Error(`${spec.table} (media select): ${error.message}`);

  // Only rows that actually carry a media value are "eligible".
  const rows = (data ?? []) as unknown as Array<Record<string, any>>;
  const eligible = rows.filter((r) => spec.mediaColumns.some((c) => r[c]));
  if (dryRun || eligible.length === 0) {
    return { rows: eligible.length, storageDeleted: 0, errors };
  }

  // Delete the underlying storage objects first, so a later row-level failure
  // never leaves us having reported deletion of a blob we kept.
  const values: string[] = [];
  for (const r of eligible) for (const c of spec.mediaColumns) if (r[c]) values.push(r[c]);
  const storage = await deleteStoredMedia(values, spec.defaultBucket);
  errors.push(...storage.errors);

  const ids = eligible.map((r) => r.id);
  if (spec.action === 'delete_row') {
    const { error: delErr } = await supabaseAdmin.from(spec.table).delete().in('id', ids);
    if (delErr) errors.push(`${spec.table} (media delete): ${delErr.message}`);
  } else {
    const patch: Record<string, null> = {};
    for (const c of spec.mediaColumns) patch[c] = null;
    const { error: updErr } = await supabaseAdmin.from(spec.table).update(patch).in('id', ids);
    if (updErr) errors.push(`${spec.table} (media null): ${updErr.message}`);
  }

  return { rows: eligible.length, storageDeleted: storage.deleted, errors };
}

export async function runRetentionPurge(opts?: { dryRun?: boolean }): Promise<RetentionResult> {
  const softDeleteDays = Number(process.env.RETENTION_SOFT_DELETE_DAYS || 90);
  const locationDays = Number(process.env.RETENTION_LOCATION_DAYS || 180);
  const auditDays = Number(process.env.RETENTION_AUDIT_DAYS || 365);
  const mediaDays = Number(process.env.RETENTION_MEDIA_DAYS || 365);
  const purgeAudit = process.env.RETENTION_PURGE_AUDIT === 'true';
  const trimWorkActivity = process.env.RETENTION_TRIM_WORK_ACTIVITY === 'true';

  // Destructive only when explicitly enabled; otherwise report what WOULD be purged.
  const enabled = process.env.RETENTION_PURGE_ENABLED === 'true';
  const dryRun = opts?.dryRun ?? !enabled;

  const softDeletedPurged: Record<string, number> = {};
  const locationTrimmed: Record<string, number> = {};
  const mediaPurged: Record<string, number> = {};
  const errors: string[] = [];
  let auditTrimmed: number | null = null;
  let storageObjectsDeleted = 0;

  for (const t of SOFT_DELETE_TABLES) {
    try {
      softDeletedPurged[t] = await purge(t, 'deleted_at', cutoffIso(softDeleteDays), dryRun);
    } catch (e) {
      errors.push((e as Error).message);
      softDeletedPurged[t] = 0;
    }
  }

  const locationTables = trimWorkActivity ? [...LOCATION_TABLES, 'work_activity'] : LOCATION_TABLES;
  for (const t of locationTables) {
    try {
      // work_activity timestamps by captured_at; the others by created_at.
      const col = t === 'work_activity' ? 'captured_at' : 'created_at';
      locationTrimmed[t] = await purge(t, col as 'created_at', cutoffIso(locationDays), dryRun);
    } catch (e) {
      errors.push((e as Error).message);
      locationTrimmed[t] = 0;
    }
  }

  for (const spec of MEDIA_TABLES) {
    try {
      const r = await purgeMedia(spec, cutoffIso(mediaDays), dryRun);
      mediaPurged[spec.table] = r.rows;
      storageObjectsDeleted += r.storageDeleted;
      errors.push(...r.errors);
    } catch (e) {
      errors.push((e as Error).message);
      mediaPurged[spec.table] = 0;
    }
  }

  if (purgeAudit) {
    try {
      auditTrimmed = await purge('audit_log', 'created_at', cutoffIso(auditDays), dryRun);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  const totalRows =
    Object.values(softDeletedPurged).reduce((a, b) => a + b, 0) +
    Object.values(locationTrimmed).reduce((a, b) => a + b, 0) +
    Object.values(mediaPurged).reduce((a, b) => a + b, 0) +
    (auditTrimmed ?? 0);

  return {
    dryRun,
    windows: { softDeleteDays, locationDays, auditDays: purgeAudit ? auditDays : null, mediaDays },
    softDeletedPurged,
    locationTrimmed,
    mediaPurged,
    storageObjectsDeleted,
    auditTrimmed,
    totalRows,
    errors,
  };
}
