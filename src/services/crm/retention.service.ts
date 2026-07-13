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

const DAY_MS = 86_400_000;

// CRM entity tables that soft-delete via deleted_at (verified against schema).
const SOFT_DELETE_TABLES = ['crm_leads', 'crm_contacts', 'crm_deals', 'crm_accounts', 'crm_activities'];
// Append-only location / telemetry tables, trimmed by created_at.
// NOTE: work_activity is intentionally EXCLUDED — it is retained (per product
// decision) and not age-trimmed by this job.
const LOCATION_TABLES = ['visit_logs', 'security_alerts', 'sos_alerts'];

export interface RetentionResult {
  dryRun: boolean;
  windows: { softDeleteDays: number; locationDays: number; auditDays: number | null };
  softDeletedPurged: Record<string, number>;
  locationTrimmed: Record<string, number>;
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

export async function runRetentionPurge(opts?: { dryRun?: boolean }): Promise<RetentionResult> {
  const softDeleteDays = Number(process.env.RETENTION_SOFT_DELETE_DAYS || 90);
  const locationDays = Number(process.env.RETENTION_LOCATION_DAYS || 180);
  const auditDays = Number(process.env.RETENTION_AUDIT_DAYS || 365);
  const purgeAudit = process.env.RETENTION_PURGE_AUDIT === 'true';

  // Destructive only when explicitly enabled; otherwise report what WOULD be purged.
  const enabled = process.env.RETENTION_PURGE_ENABLED === 'true';
  const dryRun = opts?.dryRun ?? !enabled;

  const softDeletedPurged: Record<string, number> = {};
  const locationTrimmed: Record<string, number> = {};
  const errors: string[] = [];
  let auditTrimmed: number | null = null;

  for (const t of SOFT_DELETE_TABLES) {
    try {
      softDeletedPurged[t] = await purge(t, 'deleted_at', cutoffIso(softDeleteDays), dryRun);
    } catch (e) {
      errors.push((e as Error).message);
      softDeletedPurged[t] = 0;
    }
  }

  for (const t of LOCATION_TABLES) {
    try {
      locationTrimmed[t] = await purge(t, 'created_at', cutoffIso(locationDays), dryRun);
    } catch (e) {
      errors.push((e as Error).message);
      locationTrimmed[t] = 0;
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
    (auditTrimmed ?? 0);

  return {
    dryRun,
    windows: { softDeleteDays, locationDays, auditDays: purgeAudit ? auditDays : null },
    softDeletedPurged,
    locationTrimmed,
    auditTrimmed,
    totalRows,
    errors,
  };
}
