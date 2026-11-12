/**
 * Backfill of lead numbers for leads created before numbering existed (or while the database was not migrated).
 *
 * Admin-only, connected-B2B clients only. Leads without a `ref_no` are numbered oldest first, each in the
 * financial-year series of its OWN created_at (a lead from Jan 2026 gets SR/LD/2526-n, one from May 2026 gets
 * SR/LD/2627-n), through the same allocator as new leads. Resumable and idempotent: each call handles up to `limit`
 * leads and says how many remain; a lead that already has a number is never touched; a dry run allocates nothing.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { isTenantAdmin } from '../../middleware/auth';
import { isB2bClient } from '../../lib/b2bClients';
import { tryAllocateLeadRef } from '../../lib/leadRef';
import { isMissingSchemaError } from './accountMerge.service';

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 2000;
export const NOT_MIGRATED_MESSAGE = 'Lead numbers are not set up in this database yet. Apply migration_lead_ref_and_type.sql.';
const SAMPLE_SIZE = 10;
const PAGE = 200;

export interface BackfillInput {
  orgId: string;
  /** The caller's client scope (JWT client or the X-Client-Id picker). */
  clientId: string | null;
  user: { role?: string | null } | null | undefined;
  dryRun?: boolean;
  limit?: number;
}
export interface BackfillResult {
  dry_run: boolean;
  total_missing: number;
  processed: number;
  remaining: number;
  sample: Array<{ id: string; name: string; ref_no: string | null }>;
}

interface LeadRow { id: string; first_name?: string | null; last_name?: string | null; company?: string | null; created_at: string }
const leadName = (l: LeadRow): string => [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || l.company || '(no name)';

export async function backfillLeadRefs(input: BackfillInput): Promise<BackfillResult> {
  if (!isTenantAdmin(input.user)) throw new AppError(403, 'Only an admin can number existing leads.', 'FORBIDDEN');
  const clientId = input.clientId;
  if (!clientId || !isB2bClient(clientId)) throw new AppError(400, 'Lead numbers are not used by this client', 'NOT_APPLICABLE');
  const dryRun = input.dryRun !== false;
  const limit = Math.max(1, Math.min(Math.floor(Number(input.limit ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT, MAX_LIMIT));
  const notMigrated = () => new AppError(503, NOT_MIGRATED_MESSAGE, 'NOT_MIGRATED');

  // Live leads of this client that still have no number.
  const missing = () => supabaseAdmin.from('crm_leads')
    .select('id, first_name, last_name, company, created_at', { count: 'exact' })
    .eq('org_id', input.orgId).eq('client_id', clientId)
    .is('deleted_at', null).is('ref_no', null)
    .order('created_at', { ascending: true }).order('id', { ascending: true });

  const first = await missing().range(0, Math.min(limit, PAGE) - 1);
  if (first.error) {
    if (isMissingSchemaError(first.error)) throw notMigrated();
    throw new AppError(500, first.error.message, 'DB_ERROR');
  }
  const totalMissing = first.count ?? (first.data ?? []).length;

  if (dryRun) {
    // Count only: nothing is allocated or written.
    const wouldDo = ((first.data ?? []) as LeadRow[]).slice(0, SAMPLE_SIZE);
    return {
      dry_run: true, total_missing: totalMissing, processed: 0, remaining: totalMissing,
      sample: wouldDo.map((l) => ({ id: l.id, name: leadName(l), ref_no: null })),
    };
  }

  let processed = 0;
  let skipped = 0; // leads left un-numbered this run (failed save / taken by someone else): they stay at the top of the missing set
  const sample: BackfillResult['sample'] = [];
  let batch = (first.data ?? []) as LeadRow[];
  let stop = false;
  while (batch.length > 0 && processed < limit && !stop) {
    for (const lead of batch) {
      if (processed >= limit) break;
      const alloc = await tryAllocateLeadRef(clientId, new Date(lead.created_at));
      if (!alloc.ref) {
        // The counter is missing (database not migrated) or failing: stop here rather than hammer it. Nothing was
        // written for this lead; a later call picks up where this one stopped.
        if (alloc.notMigrated && processed === 0) throw notMigrated();
        logger.warn({ clientId, leadId: lead.id, processed }, 'lead ref backfill: counter unavailable, stopping');
        stop = true;
        break;
      }
      // Guarded write: only a lead that still has no number is stamped (a concurrent create/backfill wins).
      const { data: upd, error } = await supabaseAdmin.from('crm_leads')
        .update({ ref_no: alloc.ref })
        .eq('org_id', input.orgId).eq('id', lead.id).is('ref_no', null).is('deleted_at', null)
        .select('id');
      if (error) {
        if (isMissingSchemaError(error)) throw notMigrated();
        logger.warn({ clientId, leadId: lead.id, err: error.message }, 'lead ref backfill: could not save a number, skipping the lead');
        skipped++;
        continue;
      }
      if (!Array.isArray(upd) || upd.length === 0) continue; // someone else numbered or removed it meanwhile (it leaves the missing set)
      processed++;
      if (sample.length < SAMPLE_SIZE) sample.push({ id: lead.id, name: leadName(lead), ref_no: alloc.ref });
    }
    if (stop || processed >= limit) break;
    // Numbered leads drop out of the "missing" set, so the next page starts just after the ones we had to skip.
    const next = await missing().range(skipped, skipped + Math.min(limit - processed, PAGE) - 1);
    if (next.error) break;
    batch = (next.data ?? []) as LeadRow[];
  }

  const after = await missing().range(0, 0);
  const remaining = after.error ? Math.max(0, totalMissing - processed) : (after.count ?? Math.max(0, totalMissing - processed));
  return { dry_run: false, total_missing: totalMissing, processed, remaining, sample };
}
