/**
 * Distribution → Tally enqueue poller.
 *
 * Runs every 30 seconds in-process (started from app.ts). For every org
 * with an active Tally integration, finds invoices / payments / returns
 * created since the integration's `last_sync_at` (or last 24h on cold
 * start) and inserts "pending" rows into distribution_integration_events.
 * The XML payload itself is rendered lazily on the agent's GET /jobs
 * call — this keeps the poller cheap and avoids stale XML when source
 * rows are amended (e.g. cheque payment flips from pending→cleared).
 *
 * Pure backstop: the design assumes a future controller-side enqueue
 * (single-line `await enqueueDistEvent(...)` in invoices/payments/
 * returns controllers) for true real-time sync. The poller catches any
 * gaps from missed controller-side enqueues, restart windows, or hot-
 * patched rows. Idempotent via UNIQUE (integration_id, ref_table,
 * ref_id) enforced at insert time.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';

const POLL_INTERVAL_MS = 30_000;
const COLD_START_LOOKBACK_HOURS = 24;

let timer: NodeJS.Timeout | null = null;

export function startTallyEnqueuePoller(): void {
  if (timer) return; // already running
  // Run once on boot (after a small delay so app.ts finishes init), then on interval.
  setTimeout(() => {
    runOnce().catch(e => logger.error({ err: (e as Error).message }, 'tally poller initial run failed'));
    timer = setInterval(() => {
      runOnce().catch(e => logger.error({ err: (e as Error).message }, 'tally poller tick failed'));
    }, POLL_INTERVAL_MS);
  }, 5_000);
}

export function stopTallyEnqueuePoller(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

async function runOnce(): Promise<void> {
  const { data: integrations, error } = await supabaseAdmin
    .from('distribution_integrations')
    .select('id, org_id, last_sync_at')
    .eq('provider', 'tally')
    .eq('status', 'active');
  if (error) {
    logger.error({ err: error.message }, 'tally poller: integrations query failed');
    return;
  }
  if (!integrations || integrations.length === 0) return;

  for (const integration of integrations) {
    try {
      await enqueueForIntegration(integration as { id: string; org_id: string; last_sync_at: string | null });
    } catch (e) {
      logger.error({ integration_id: integration.id, err: (e as Error).message }, 'tally poller: per-integration enqueue failed');
    }
  }
}

async function enqueueForIntegration(integration: { id: string; org_id: string; last_sync_at: string | null }) {
  const since = integration.last_sync_at
    ? new Date(integration.last_sync_at)
    : new Date(Date.now() - COLD_START_LOOKBACK_HOURS * 3_600_000);
  const sinceIso = since.toISOString();

  let enqueued = 0;

  // Invoices — trigger on issued_at (the moment Kinematic locks the
  // invoice as final; pre-issue drafts are intentionally not synced).
  const { data: invoices } = await supabaseAdmin
    .from('invoices')
    .select('id')
    .eq('org_id', integration.org_id)
    .eq('status', 'issued')
    .gte('issued_at', sinceIso)
    .limit(500);
  enqueued += await insertEvents(integration.id, integration.org_id, 'invoice', 'invoices', (invoices ?? []).map(r => r.id as string));

  // Payments — only cleared payments push to Tally (cheques wait until
  // the bank-clearance status flip lands).
  const { data: payments } = await supabaseAdmin
    .from('payments')
    .select('id')
    .eq('org_id', integration.org_id)
    .eq('status', 'cleared')
    .gte('received_at', sinceIso)
    .limit(500);
  enqueued += await insertEvents(integration.id, integration.org_id, 'payment', 'payments', (payments ?? []).map(r => r.id as string));

  // Returns — only approved / credited returns push as credit notes.
  const { data: returns } = await supabaseAdmin
    .from('returns')
    .select('id')
    .eq('org_id', integration.org_id)
    .in('status', ['credited', 'supervisor_approved'])
    .gte('created_at', sinceIso)
    .limit(500);
  enqueued += await insertEvents(integration.id, integration.org_id, 'credit_note', 'returns', (returns ?? []).map(r => r.id as string));

  // Move the watermark forward so we don't re-scan the same window every tick.
  await supabaseAdmin.from('distribution_integrations')
    .update({ last_sync_at: new Date().toISOString() })
    .eq('id', integration.id);

  if (enqueued > 0) {
    logger.info({ integration_id: integration.id, enqueued }, 'tally poller: enqueued events');
  }
}

/**
 * Inserts pending events for the given (ref_table, kind, ids) batch.
 * Skips rows that already have an event row (dedup via
 * distribution_integration_events.ref_table + ref_id index). xml_payload
 * is empty — rendered on-demand in the agent-polling endpoint.
 */
async function insertEvents(
  integration_id: string,
  org_id: string,
  kind: string,
  ref_table: string,
  ref_ids: string[],
): Promise<number> {
  if (ref_ids.length === 0) return 0;

  // Filter out ids that already have an event row for this integration.
  const { data: existing } = await supabaseAdmin
    .from('distribution_integration_events')
    .select('ref_id')
    .eq('integration_id', integration_id)
    .eq('ref_table', ref_table)
    .in('ref_id', ref_ids);
  const existingSet = new Set((existing ?? []).map(r => r.ref_id as string));
  const toInsert = ref_ids.filter(id => !existingSet.has(id));
  if (toInsert.length === 0) return 0;

  const rows = toInsert.map(ref_id => ({
    org_id, integration_id, kind, ref_table, ref_id,
    xml_payload: '',                    // rendered lazily by the GET /jobs handler
    status: 'pending',
    next_attempt_at: new Date().toISOString(),
  }));
  const { error } = await supabaseAdmin.from('distribution_integration_events').insert(rows);
  if (error) {
    logger.error({ integration_id, ref_table, err: error.message }, 'tally poller: bulk insert failed');
    return 0;
  }
  return toInsert.length;
}
