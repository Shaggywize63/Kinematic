import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { previewConsume, consumeStock, PreviewLayer, RotationStrategy } from './batchStock.service';

/**
 * SCM Phase-2 dispatch/invoice consume hook + the org-setting that governs it.
 *
 * `scm_dispatch_consume_mode` (org_settings) has three values:
 *   - 'off'      (DEFAULT) — the hook is a COMPLETE no-op: no stock is read or
 *                 written and dispatch/invoice behaviour is byte-for-byte
 *                 unchanged. `runDispatchConsumeHook` returns null immediately.
 *   - 'advisory' — for every line whose SKU has `skus.track_batches = true` we
 *                 compute a READ-ONLY FEFO/FIFO `previewConsume` plan and surface
 *                 it (attached to the response + a structured log line). Stock is
 *                 NEVER mutated in this mode.
 *   - 'enforce'  — the plan is committed: `consumeStock` draws the layers down
 *                 for real. UNREACHABLE unless an admin explicitly sets this
 *                 mode via PATCH /api/v1/org-settings/scm-dispatch-consume-mode.
 *
 * The hook is defensive end-to-end: every failure (setting read, preview, or an
 * enforce draw-down) is caught and logged, never rethrown, so a consume
 * computation can NEVER fail the dispatch/invoice it hangs off.
 */

export type ScmDispatchConsumeMode = 'off' | 'advisory' | 'enforce';
export const SCM_DISPATCH_CONSUME_MODES: ScmDispatchConsumeMode[] = ['off', 'advisory', 'enforce'];
export const SCM_DISPATCH_CONSUME_DEFAULT: ScmDispatchConsumeMode = 'off';
export const SCM_DISPATCH_CONSUME_KEY = 'scm_dispatch_consume_mode';

/** Coerce a raw org_settings.value (a plain jsonb string, or a `{ value }`
 *  wrapper) to a valid mode, defaulting to 'off' for anything unrecognised or
 *  unset — so the hook is inert unless an admin deliberately turns it on. */
export function parseScmDispatchConsumeMode(raw: unknown): ScmDispatchConsumeMode {
  const v = raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)
    ? (raw as { value: unknown }).value
    : raw;
  const s = String(v ?? '').toLowerCase().trim();
  return (SCM_DISPATCH_CONSUME_MODES as string[]).includes(s)
    ? (s as ScmDispatchConsumeMode)
    : SCM_DISPATCH_CONSUME_DEFAULT;
}

/** Resolve the caller org's dispatch-consume mode. Missing row → 'off'. */
export async function resolveScmDispatchConsumeMode(orgId: string): Promise<ScmDispatchConsumeMode> {
  const { data, error } = await supabaseAdmin
    .from('org_settings')
    .select('value')
    .eq('org_id', orgId)
    .eq('key', SCM_DISPATCH_CONSUME_KEY)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return parseScmDispatchConsumeMode((data as { value?: unknown } | null)?.value);
}

export interface ScmConsumeLineResult {
  sku_id: string;
  requested: number;
  plan: PreviewLayer[];
  total_cost: number;
  available: number;
  shortfall: number;
  consumed: boolean;          // true ONLY when enforce mode actually drew stock down
  error?: string;
}

export interface ScmConsumeHookResult {
  mode: ScmDispatchConsumeMode;
  mutated: boolean;           // did anything change stock? (can only be true in enforce)
  lines: ScmConsumeLineResult[];
}

/**
 * Compute (advisory) or apply (enforce) batch consumption for a set of order /
 * invoice lines. Returns `null` when the mode is 'off' (complete no-op) or when
 * no line maps to a batch-tracked SKU (nothing to advise on).
 *
 * NEVER throws — the whole body is wrapped so the calling dispatch/invoice flow
 * is never broken; failures are logged and, where relevant, surfaced per line.
 */
export async function runDispatchConsumeHook(opts: {
  orgId: string; clientId: string | null; distributorId: string;
  lines: Array<{ sku_id: string; qty: number }>;
  strategy?: RotationStrategy;
  reason?: 'sale' | 'consume' | 'damage' | 'van_load';
  refType?: string | null; refId?: string | null; createdBy?: string | null;
}): Promise<ScmConsumeHookResult | null> {
  try {
    const mode = await resolveScmDispatchConsumeMode(opts.orgId);
    if (mode === 'off') return null; // hard no-op: touch nothing, add nothing.

    // Aggregate qty per SKU (an order can carry the same SKU on more than one line).
    const wanted = new Map<string, number>();
    for (const l of opts.lines || []) {
      const qty = Number(l?.qty);
      if (!l?.sku_id || !(qty > 0)) continue;
      wanted.set(l.sku_id, (wanted.get(l.sku_id) ?? 0) + qty);
    }
    if (wanted.size === 0) return null;

    // Batch tracking is OPT-IN per SKU — only track_batches=true SKUs route here.
    const { data: skuRows, error: skuErr } = await supabaseAdmin
      .from('skus').select('id').eq('track_batches', true).in('id', Array.from(wanted.keys()));
    if (skuErr) throw new Error(skuErr.message);
    const tracked = (skuRows || []).map((s: { id: string }) => s.id).filter((id) => wanted.has(id));
    if (tracked.length === 0) return null;

    const lines: ScmConsumeLineResult[] = [];
    let mutated = false;

    for (const skuId of tracked) {
      const requested = wanted.get(skuId)!;
      try {
        // Always compute the read-only plan first (also gives us the valuation
        // and shortfall for the advisory record).
        const preview = await previewConsume({
          orgId: opts.orgId, distributorId: opts.distributorId, skuId, qty: requested, strategy: opts.strategy,
        });

        if (mode === 'enforce' && preview.shortfall === 0 && preview.plan.length > 0) {
          // ENFORCE ONLY — the REAL draw-down. This branch is unreachable unless
          // an admin explicitly set the mode to 'enforce'. Gated on a
          // zero-shortfall preview so we never partially consume below the
          // requested qty (consumeStock would throw on insufficient stock anyway).
          const out = await consumeStock({
            orgId: opts.orgId, clientId: opts.clientId, distributorId: opts.distributorId, skuId, qty: requested,
            strategy: opts.strategy, reason: opts.reason ?? 'sale',
            refType: opts.refType ?? null, refId: opts.refId ?? null, createdBy: opts.createdBy ?? null,
          });
          mutated = true;
          lines.push({ sku_id: skuId, requested, plan: preview.plan, total_cost: out.totalCost, available: preview.available, shortfall: 0, consumed: true });
        } else {
          // ADVISORY (or enforce blocked by a shortfall) — NO mutation whatsoever.
          lines.push({ sku_id: skuId, requested, plan: preview.plan, total_cost: preview.totalCost, available: preview.available, shortfall: preview.shortfall, consumed: false });
        }
      } catch (lineErr) {
        // One bad line never fails the others (or the invoice).
        lines.push({ sku_id: skuId, requested, plan: [], total_cost: 0, available: 0, shortfall: requested, consumed: false, error: lineErr instanceof Error ? lineErr.message : 'preview failed' });
      }
    }

    const result: ScmConsumeHookResult = { mode, mutated, lines };
    // Structured, grep-friendly log line for proactive review / audit.
    logger.info('[scm.dispatch_consume] hook', {
      org_id: opts.orgId, distributor_id: opts.distributorId, mode, mutated,
      ref_type: opts.refType ?? null, ref_id: opts.refId ?? null,
      lines: lines.map((l) => ({ sku_id: l.sku_id, requested: l.requested, shortfall: l.shortfall, consumed: l.consumed, total_cost: l.total_cost })),
    });
    return result;
  } catch (err) {
    // Belt-and-suspenders: the hook must NEVER break a dispatch/invoice.
    logger.warn('[scm.dispatch_consume] hook failed (non-fatal)', {
      org_id: opts.orgId, distributor_id: opts.distributorId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
