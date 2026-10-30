/**
 * aiPricing.ts
 *
 * Per-model Anthropic prices (USD per MILLION tokens) for costing `ai_usage`.
 * Cost is computed at read time (Billing endpoint) rather than stored, so a rate
 * change here re-prices history with no backfill.
 *
 * Rates are matched by model-name family (opus / sonnet / haiku), so new dated
 * model ids (claude-sonnet-5, claude-opus-4-8, …) price correctly without edits.
 * Cache tiers follow Anthropic's prompt-cache pricing: a cache WRITE bills ~1.25x
 * base input, a cache READ ~0.1x. Update these when Anthropic prices change.
 */

export interface ModelRate {
  /** USD per 1M tokens. */
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// Keyword → rate. First substring match (case-insensitive) wins; order matters
// only in that every key is distinct, so matching is unambiguous in practice.
const RATES: Array<{ match: string; rate: ModelRate }> = [
  { match: 'opus',   rate: { input: 15,   output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { match: 'sonnet', rate: { input: 3,    output: 15, cacheWrite: 3.75,  cacheRead: 0.3 } },
  { match: 'haiku',  rate: { input: 0.8,  output: 4,  cacheWrite: 1.0,   cacheRead: 0.08 } },
];

// Fallback when a model name matches no family (unknown/new tier). Uses the
// Sonnet rate so an unrecognised model is costed sensibly, not at zero.
const FALLBACK: ModelRate = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

export function rateForModel(model: string): ModelRate {
  const m = (model || '').toLowerCase();
  for (const r of RATES) if (m.includes(r.match)) return r.rate;
  return FALLBACK;
}

export interface UsageTokens {
  model: string;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
}

/** USD cost of one usage row (or a summed-up aggregate for a single model). */
export function costUsd(u: UsageTokens): number {
  const r = rateForModel(u.model);
  return (
    (u.input_tokens * r.input) +
    (u.cache_write_tokens * r.cacheWrite) +
    (u.cache_read_tokens * r.cacheRead) +
    (u.output_tokens * r.output)
  ) / 1_000_000;
}

/**
 * Default USD→OMR conversion. The Omani Rial is pegged (1 OMR = 2.6008 USD →
 * 1 USD ≈ 0.38449 OMR); overridable via env for the rare peg revaluation. The
 * dashboard's OMR toggle uses the rate the Billing endpoint returns so both
 * sides agree.
 */
export function usdToOmrRate(): number {
  const raw = Number(process.env.USD_TO_OMR_RATE);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.38449;
}
