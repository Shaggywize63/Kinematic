/**
 * planogramVisionConfig.ts
 *
 * Per-tenant vision credentials for planogram shelf recognition.
 *
 * A specific client (MoiSoi) is pinned to a DEDICATED Anthropic API key and a
 * HIGHER-tier vision model, so its shelf recognition runs on a stronger model
 * (materially better SKU identification on packaging / small text) on a
 * SEPARATE key — without changing anything for every other tenant, which keeps
 * using the shared functional key + default model.
 *
 * Fully env-driven and inert until configured: with no MoiSoi key set the
 * resolver returns no override and the pipeline behaves byte-for-byte as before
 * (important for the Tata prod tenant and every other client). Because the
 * override is scoped by org_id / client_id, only MoiSoi captures are affected.
 *
 * Env:
 *   MOISOI_ANTHROPIC_API_KEY  dedicated Anthropic key for MoiSoi vision (the
 *                             "high-model key"). Never hard-coded — a secret.
 *   MOISOI_VISION_MODEL       model id for MoiSoi vision (default below) — only
 *                             takes effect when the dedicated key is set OR an
 *                             explicit model is configured.
 *   MOISOI_ORG_IDS            comma-separated org_id UUIDs treated as MoiSoi
 *                             (defaults to the known MoiSoi org on Kinematic).
 *   MOISOI_CLIENT_IDS         comma-separated client_id UUIDs treated as MoiSoi
 *                             (defaults to the known MoiSoi client on Kinematic).
 */

// Known MoiSoi identity on the Kinematic Supabase project (clldjlojtmrrpozydqxk).
// Used when the *_IDS env vars are unset so the pin works out of the box; set
// the env vars to add or change the matched ids.
const DEFAULT_MOISOI_ORG_IDS = ['d0000000-0000-4000-a000-000000000001'];
const DEFAULT_MOISOI_CLIENT_IDS = ['d0000000-0000-4000-a000-000000000002'];

// Default vision model for MoiSoi when a dedicated key is configured but no
// explicit MOISOI_VISION_MODEL is set. Sonnet is a strong packaging / small-text
// reader at ~40% of Opus' per-token cost, which is the dominant lever on the
// per-analysis bill (each pass ships the full MoiSoi reference pack). Revert to
// Opus for a capture-quality comparison via MOISOI_VISION_MODEL=claude-opus-4-8.
const DEFAULT_MOISOI_VISION_MODEL = 'claude-sonnet-5';

export interface VisionOverride {
  /** Dedicated key; undefined → caller uses the shared functional key. */
  apiKey?: string;
  /** Model id; undefined → caller uses the default vision model. */
  model?: string;
  /** 'moisoi' | 'default' — for logging. NEVER the key value. */
  label: string;
}

function parseIds(env: string | undefined, fallback: string[]): Set<string> {
  const raw = (env || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set((raw.length ? raw : fallback).map((s) => s.toLowerCase()));
}

function isMoiSoi(ctx: { orgId?: string | null; clientId?: string | null }): boolean {
  const orgIds = parseIds(process.env.MOISOI_ORG_IDS, DEFAULT_MOISOI_ORG_IDS);
  const clientIds = parseIds(process.env.MOISOI_CLIENT_IDS, DEFAULT_MOISOI_CLIENT_IDS);
  const o = (ctx.orgId || '').toLowerCase();
  const c = (ctx.clientId || '').toLowerCase();
  return (!!o && orgIds.has(o)) || (!!c && clientIds.has(c));
}

/**
 * Resolve the vision key + model for a capture's tenant context. Returns an
 * override ONLY for MoiSoi AND only when a dedicated key OR an explicit model is
 * configured; otherwise returns { label: 'default' } with no apiKey/model, so
 * the caller keeps its existing behaviour (shared functional key + default
 * model). We never push MoiSoi onto a higher model without a dedicated key,
 * because the shared functional key may not be provisioned for it.
 */
export function resolveVisionOverride(ctx: {
  orgId?: string | null;
  clientId?: string | null;
}): VisionOverride {
  if (!isMoiSoi(ctx)) return { label: 'default' };
  const apiKey = (process.env.MOISOI_ANTHROPIC_API_KEY || '').trim() || undefined;
  const explicitModel = (process.env.MOISOI_VISION_MODEL || '').trim() || undefined;
  const model = explicitModel || (apiKey ? DEFAULT_MOISOI_VISION_MODEL : undefined);
  if (!apiKey && !model) return { label: 'default' };
  return { apiKey, model, label: 'moisoi' };
}

/**
 * How a capture is scored against its planogram:
 *   'catalog' — the historical basis: presence / facings / availability are
 *               measured against the FULL expected catalog, so a SKU the outlet
 *               simply does not stock counts against the score.
 *   'present' — measured only against the expected SKUs actually PRESENT on the
 *               shelf, so not-stocked SKUs never penalise; the score reflects how
 *               well the products that ARE there are merchandised.
 */
export type ScoringBasis = 'catalog' | 'present';

/**
 * Resolve the scoring basis for a capture's tenant. MoiSoi is evaluated on a
 * PRESENT basis (its outlets stock only part of the range, so full-catalog
 * scoring is misleading); every other tenant keeps the historical CATALOG basis,
 * so the Tata prod composite is byte-for-byte unchanged. Overridable via
 * MOISOI_SCORING_BASIS (set to 'catalog' to revert MoiSoi).
 */
export function resolveScoringBasis(ctx: {
  orgId?: string | null;
  clientId?: string | null;
}): ScoringBasis {
  if (!isMoiSoi(ctx)) return 'catalog';
  const v = (process.env.MOISOI_SCORING_BASIS || 'present').trim().toLowerCase();
  return v === 'catalog' ? 'catalog' : 'present';
}
