/**
 * aiUsageMeter.ts
 *
 * Records per-call token usage for the planogram vision API into `ai_usage`, so
 * the admin Billing section can cost API usage per client over a period.
 *
 * The vision call site (PlanogramVisionService.callVisionTool) is deep inside
 * recognizeShelf and has no org/client/capture context of its own. Rather than
 * thread that context through every helper, the capture-analysis entry points
 * (planogram.service) wrap the recognizeShelf call in `withMeter(ctx, …)`, which
 * stashes the context in an AsyncLocalStorage; `recordVisionUsage` reads it back
 * at the call site. ALS propagates across awaits, so the deep call still sees it.
 *
 * Metering NEVER affects the capture: `recordVisionUsage` is fire-and-forget and
 * swallows its own errors. Calls made outside a `withMeter` scope (e.g. the
 * planogram parse flow) simply record nothing.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { supabaseAdmin } from './supabase';
import { logger } from './logger';

export interface MeterContext {
  orgId: string;
  clientId?: string | null;
  captureId?: string | null;
  /** Metered feature; defaults to planogram_vision. */
  feature?: string;
}

const als = new AsyncLocalStorage<MeterContext>();

/** Run `fn` with a metering context active for every AI call it makes. */
export function withMeter<T>(ctx: MeterContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

/** The metering context for the current async execution, if any. */
export function currentMeter(): MeterContext | undefined {
  return als.getStore();
}

/** Raw token counts from an Anthropic `usage` block. */
export interface AnthropicUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/**
 * Persist one vision call's token usage, attributed to the current meter
 * context. No-op (and never throws) when there is no active context or the
 * write fails — billing must never break a capture.
 */
export async function recordVisionUsage(model: string, tool: string | null, usage: AnthropicUsage | null | undefined): Promise<void> {
  const ctx = als.getStore();
  if (!ctx || !usage) return;
  try {
    const { error } = await supabaseAdmin.from('ai_usage').insert({
      org_id: ctx.orgId,
      client_id: ctx.clientId ?? null,
      feature: ctx.feature ?? 'planogram_vision',
      model,
      capture_id: ctx.captureId ?? null,
      tool: tool ?? null,
      input_tokens: usage.input_tokens ?? 0,
      cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
    });
    if (error) logger.warn(`[aiUsageMeter] insert failed: ${error.message}`);
  } catch (e) {
    logger.warn(`[aiUsageMeter] insert threw: ${(e as Error)?.message || e}`);
  }
}
