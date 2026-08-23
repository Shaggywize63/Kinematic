/**
 * AI Smart Filters — translate a salesperson's plain-English request into a
 * validated set of lead-list filter params.
 *
 * The AI may ONLY emit keys from a fixed whitelist; every value is validated
 * and coerced here, so a hallucinated column or operator can never reach the
 * query. The returned `params` are exactly what GET /api/v1/crm/leads already
 * understands — so the existing, fully tenant-scoped leads list does the fetch
 * (no new query path, no scoping to re-implement). Degrades to an empty filter
 * (all leads) if the model is unavailable or returns junk.
 */
import { AIService } from '../../ai.service';
import { logger } from '../../../lib/logger';

export interface SmartFilterResult {
  params: Record<string, string>; // ready to send to GET /crm/leads
  explanation: string;            // human-readable "interpreted as …"
  mine: boolean;                  // caller wants their own leads (route maps to owner_id)
}

const STATUSES = ['new', 'working', 'qualified', 'unqualified', 'converted'];
const SORTS = ['name', 'created', 'updated', 'score', 'status'];
const STRING_KEYS = ['city', 'state', 'district', 'industry', 'utm_source', 'utm_campaign'];
const DAY_KEYS = ['created_within_days', 'not_contacted_days', 'no_activity_days'];

const SYSTEM = `You convert a salesperson's plain-English request into a CRM lead filter.
Return ONLY a JSON object: { "params": { ... }, "mine": boolean, "explanation": string }.

Allowed "params" keys (emit ONLY these; omit any you don't need):
- q: free-text match on name/company/email/phone
- status: one of ${STATUSES.join('|')}
- status_in: comma-separated subset of the statuses (e.g. open leads = "new,working,qualified")
- score_gte: number 0-100 (hot / high-intent leads are usually >= 70)
- score_lte: number 0-100 (cold / low-intent leads)
- score_grade: a single grade letter if the user names one (A/B/C/D)
- city, state, district: a place name exactly as the user says it
- industry: an industry name
- is_b2c: "true" for individual/consumer leads, "false" for business/B2B
- is_converted: "true" or "false"
- created_within_days: integer — created in the last N days ("today"=1, "this week"=7, "this month"=30)
- not_contacted_days: integer — not contacted in the last N days (includes never-contacted)
- no_activity_days: integer — no activity in the last N days (going cold / stale)
- utm_source, utm_campaign: a marketing source / campaign name
- sort: one of ${SORTS.join('|')}; order: "asc" or "desc"

Set "mine": true only if the user asks for THEIR OWN leads ("my leads", "assigned to me").
"explanation" is one short plain-English sentence describing the filter.
Never invent values the user did not imply. Output JSON only — no prose, no markdown.`;

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : v != null && typeof v !== 'object' ? String(v) : '';
const bool = (v: unknown): boolean => v === true || v === 'true';

function validate(p: any): SmartFilterResult {
  // Accept the filter keys either nested under `params` (as instructed) OR flat
  // at the top level (some models drop the wrapper). validate only reads known
  // whitelisted keys, so treating the whole object as the params bag is safe —
  // `explanation`/`mine` simply aren't in the whitelist and are ignored here.
  const inP = (p && typeof p.params === 'object' && p.params) || (p && typeof p === 'object' ? p : {});
  const out: Record<string, string> = {};

  if (str(inP.q)) out.q = str(inP.q).slice(0, 120);
  if (STATUSES.includes(str(inP.status))) out.status = str(inP.status);
  if (str(inP.status_in)) {
    const vals = str(inP.status_in).split(',').map((s) => s.trim()).filter((s) => STATUSES.includes(s));
    if (vals.length) out.status_in = vals.join(',');
  }
  const sg = num(inP.score_gte);
  if (sg != null) out.score_gte = String(Math.max(0, Math.min(100, Math.round(sg))));
  const sl = num(inP.score_lte);
  if (sl != null) out.score_lte = String(Math.max(0, Math.min(100, Math.round(sl))));
  if (str(inP.score_grade)) out.score_grade = str(inP.score_grade).toUpperCase().slice(0, 2);
  for (const k of STRING_KEYS) if (str(inP[k])) out[k] = str(inP[k]).slice(0, 80);
  if (inP.is_b2c !== undefined) out.is_b2c = String(bool(inP.is_b2c));
  if (inP.is_converted !== undefined) out.is_converted = String(bool(inP.is_converted));
  for (const k of DAY_KEYS) {
    const n = num(inP[k]);
    if (n != null && n > 0) out[k] = String(Math.min(3650, Math.round(n)));
  }
  if (SORTS.includes(str(inP.sort))) {
    out.sort = str(inP.sort);
    const order = str(inP.order).toLowerCase();
    if (order === 'asc' || order === 'desc') out.order = order;
  }

  return {
    params: out,
    explanation: str(p?.explanation).slice(0, 240) || 'Filtered leads.',
    mine: bool(p?.mine),
  };
}

export async function interpretSmartFilter(query: string): Promise<SmartFilterResult> {
  const q = query.trim();
  if (!q) return { params: {}, explanation: 'Type a request to filter leads.', mine: false };

  // Model source mirrors the other CRM-AI features (nba/summarize/etc.) so we
  // inherit the same prod-configured, valid model. Using a brand-new env var
  // that isn't set in prod would fall back to a bare alias the API may reject —
  // which previously made every request fail into the "all leads" fallback.
  const text = await AIService.callKiniAI({
    model: process.env.SMART_FILTER_MODEL || process.env.CRM_NBA_MODEL || 'claude-haiku-4-5',
    max_tokens: 500,
    system: SYSTEM,
    messages: [{ role: 'user', content: q.slice(0, 500) }],
  });
  // NOTE: a callKiniAI failure (bad key/model, upstream error) is deliberately
  // NOT swallowed here — it propagates so the UI shows a real error instead of a
  // misleading "showing all leads". Only a parse miss (model returned no usable
  // JSON) degrades to an empty filter.
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      logger.warn('[smart-filter] model returned no JSON object');
      return { params: {}, explanation: 'Could not detect specific filters — showing all leads.', mine: false };
    }
    return validate(JSON.parse(text.slice(start, end + 1)));
  } catch (e: any) {
    logger.warn(`[smart-filter] parse failed: ${e?.message || e}`);
    return { params: {}, explanation: 'Could not detect specific filters — showing all leads.', mine: false };
  }
}
