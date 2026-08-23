/**
 * Market-intelligence extraction from rep field notes.
 *
 * Every lead update (typed OR voice-dictated) is a free-text sentence about
 * what happened on the ground. This turns that sentence into structured
 * competitor / market signals — "Jindal quoted ₹2 less", "dealer out of 12mm",
 * "customer wants to buy next month" — and stores them in
 * `crm_competitor_signals`, which powers the Market Intelligence dashboard.
 *
 * Design mirrors updateSuggest.service.ts: a single-shot cheap Haiku call,
 * JSON-only, OFF the KINI chat quota. It runs fire-and-forget from
 * createUpdate(), so any failure (parse, network, model) is swallowed and can
 * never block or break the underlying update. Gated by a length heuristic and
 * the CRM_INTEL_EXTRACT_ENABLED kill-switch.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { complete as aiComplete } from './aiClient';

export type SignalType =
  | 'competitor_mention'
  | 'price'
  | 'stockout'
  | 'timeline'
  | 'quality'
  | 'intent'
  | 'other';

export type Stance = 'we_winning' | 'we_losing' | 'neutral';

const SIGNAL_TYPES: readonly SignalType[] = [
  'competitor_mention', 'price', 'stockout', 'timeline', 'quality', 'intent', 'other',
];
const STANCES: readonly Stance[] = ['we_winning', 'we_losing', 'neutral'];

// Skip trivial notes ("ok", "called, no answer") — not worth an LLM call.
const MIN_BODY_LEN = 20;

const SYSTEM = [
  'You are KINI, extracting competitive & market intelligence from a field sales rep\'s short free-text note about a lead.',
  'Reply with ONLY a JSON object of this exact shape:',
  '{ "signals": [ { "signal_type": "competitor_mention|price|stockout|timeline|quality|intent|other", "competitor_name": "string|null", "stance": "we_winning|we_losing|neutral", "price_delta": number|null, "confidence": 0-100, "body": "string" } ] }',
  'Rules:',
  '- Emit a signal ONLY when the note actually supports it. If there is no market/competitor signal at all, return {"signals": []}.',
  '- signal_type: use "price" when a price/discount is the point, "stockout" for availability/supply, "timeline" for purchase timing, "quality" for product-quality remarks, "intent" for the customer leaning toward a rival, "competitor_mention" when a rival is named without other specifics, else "other".',
  '- competitor_name: the rival brand/company named or clearly implied (e.g. "Jindal", "JSW", "Vizag"); null if none.',
  '- stance is from OUR perspective: "we_losing" if the customer leans to the competitor / the competitor is cheaper / we are being displaced; "we_winning" if we are preferred; else "neutral".',
  '- price_delta: the competitor price MINUS our price in the note\'s own unit (negative = competitor cheaper). null if no explicit price/delta is stated.',
  '- body: a ≤140-char evidence snippet paraphrasing the relevant part. Never invent facts not in the note.',
  '- Output JSON only — no prose, no markdown fences.',
].join('\n');

export interface ExtractedSignal {
  signal_type: SignalType;
  competitor_name: string | null;
  competitor_key: string | null;
  stance: Stance;
  price_delta: number | null;
  confidence: number;
  body: string;
}

function normalizeCompetitorKey(name: unknown): string | null {
  const s = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return s ? s.slice(0, 120) : null;
}

function coerce(raw: unknown, fallbackBody: string): ExtractedSignal[] {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const arr = Array.isArray(obj.signals) ? obj.signals : [];
  const out: ExtractedSignal[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const typeRaw = String(s.signal_type || '').toLowerCase();
    const signal_type = (SIGNAL_TYPES as readonly string[]).includes(typeRaw)
      ? (typeRaw as SignalType) : 'other';
    const stanceRaw = String(s.stance || 'neutral').toLowerCase();
    const stance = (STANCES as readonly string[]).includes(stanceRaw)
      ? (stanceRaw as Stance) : 'neutral';
    const competitor_name = s.competitor_name ? String(s.competitor_name).trim().slice(0, 120) : null;
    const priceRaw = s.price_delta;
    const price_delta = typeof priceRaw === 'number' && Number.isFinite(priceRaw) ? priceRaw : null;
    let confidence = Number(s.confidence);
    if (!Number.isFinite(confidence)) confidence = 50;
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));
    const body = String(s.body || fallbackBody || '').trim().slice(0, 280);
    if (!body) continue;
    out.push({
      signal_type,
      competitor_name: competitor_name || null,
      competitor_key: normalizeCompetitorKey(competitor_name),
      stance,
      price_delta,
      confidence,
      body,
    });
  }
  return out;
}

export interface ExtractSignalsInput {
  org_id: string;
  client_id: string | null;
  lead_id: string;
  update_id: string;
  author_id: string;
  body: string;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

/**
 * Extract market signals from one lead update and persist them. Best-effort:
 * returns the number of signals written, or 0 on any failure / disabled / too
 * short. NEVER throws — safe to call as `void extractSignalsFromUpdate(...)`.
 */
export async function extractSignalsFromUpdate(input: ExtractSignalsInput): Promise<number> {
  try {
    if (String(process.env.CRM_INTEL_EXTRACT_ENABLED ?? 'true').toLowerCase() === 'false') return 0;
    const text = (input.body || '').trim();
    if (text.length < MIN_BODY_LEN) return 0;

    const out = await aiComplete({
      org_id: input.org_id,
      model: process.env.CRM_INTEL_MODEL || process.env.CRM_NBA_MODEL || 'claude-haiku-4-5-20251001',
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ note: text }) }],
      max_tokens: 500,
    });
    const cleaned = out.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const signals = coerce(JSON.parse(cleaned), text);
    if (signals.length === 0) return 0;

    const now = new Date().toISOString();
    const rows = signals.map((s) => ({
      org_id: input.org_id,
      client_id: input.client_id,
      lead_id: input.lead_id,
      source: 'lead_update',
      source_id: input.update_id,
      signal_type: s.signal_type,
      competitor_name: s.competitor_name,
      competitor_key: s.competitor_key,
      stance: s.stance,
      price_delta: s.price_delta,
      city: input.city ?? null,
      state: input.state ?? null,
      postal_code: input.postal_code ?? null,
      body: s.body,
      confidence: s.confidence,
      created_by: input.author_id,
      created_at: now,
    }));

    const { error } = await supabaseAdmin.from('crm_competitor_signals').insert(rows);
    if (error) {
      console.warn(`[competitorIntel] insert failed: ${error.message}`);
      return 0;
    }
    return rows.length;
  } catch (e) {
    // Best-effort: a missing table (pre-migration), a parse miss, or a model
    // hiccup must never affect the update that triggered this.
    console.warn(`[competitorIntel] extraction skipped: ${(e as Error)?.message}`);
    return 0;
  }
}
