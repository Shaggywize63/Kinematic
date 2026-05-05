/**
 * Lead scoring: deterministic heuristic + Claude Haiku rerank.
 * Heuristic runs synchronously; LLM rerank runs in Edge Function.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { complete as aiComplete } from './aiClient';
import type { Lead, ScoreBreakdown } from '../../../types/crm.types';

export interface Icp {
  industries?: string[];
  company_sizes?: string[];
  titles?: string[];
}

export async function getIcp(org_id: string): Promise<Icp> {
  const { data } = await supabaseAdmin.from('crm_settings').select('config').eq('org_id', org_id).maybeSingle();
  return ((data?.config as Record<string, unknown>)?.icp as Icp) ?? {};
}

// B2B leans on title seniority, company match, and ICP industry signals.
function scoreB2B(lead: Partial<Lead>, icp: Icp): ScoreBreakdown {
  const b: ScoreBreakdown = { base: 0, title: 0, company_size: 0, source: 0, engagement: 0, recency: 0, icp: 0, model: 'heuristic_b2b_v1' };

  const t = (lead.title || '').toLowerCase();
  if (/(ceo|cto|cfo|cmo|coo|chief|founder|owner)/.test(t)) b.title = 20;
  else if (/(vp|vice president|head of)/.test(t)) b.title = 15;
  else if (/(director)/.test(t)) b.title = 10;
  else if (/(manager|lead)/.test(t)) b.title = 5;
  else if (t) b.title = 2;

  if ((lead.company || '').length > 0) b.company_size = 8;
  if (lead.source_id) b.source = 10;

  if (lead.last_activity_at) {
    const days = (Date.now() - new Date(lead.last_activity_at).getTime()) / (1000 * 60 * 60 * 24);
    b.recency = Math.max(0, Math.round(10 - days * 0.3));
    b.engagement = days < 7 ? 15 : days < 30 ? 8 : 3;
  }

  const industryMatch = icp.industries && lead.industry &&
    icp.industries.some((i) => i.toLowerCase() === (lead.industry || '').toLowerCase());
  const titleMatch = icp.titles && lead.title &&
    icp.titles.some((i) => (lead.title || '').toLowerCase().includes(i.toLowerCase()));
  if (industryMatch) b.icp = (b.icp ?? 0) + 5;
  if (titleMatch) b.icp = (b.icp ?? 0) + 5;
  return b;
}

// B2C ignores company/title and weighs reachability, consent, recency, and source quality.
function scoreB2C(lead: Partial<Lead>, _icp: Icp): ScoreBreakdown {
  const b: ScoreBreakdown = { base: 0, title: 0, company_size: 0, source: 0, engagement: 0, recency: 0, icp: 0, model: 'heuristic_b2c_v1' };

  if (lead.phone) (b as any).phone_present = 12;
  if (lead.email) (b as any).email_quality = 8;

  if ((lead as any).marketing_consent) (b as any).marketing_consent = 10;
  if ((lead as any).whatsapp_consent) (b as any).whatsapp_consent = 8;

  const referralLike = String(lead.source_id || '').toLowerCase().includes('referral');
  b.source = referralLike ? 15 : (lead.source_id ? 8 : 0);

  if (lead.city || lead.country) (b as any).geo = 5;

  if (lead.last_activity_at) {
    const days = (Date.now() - new Date(lead.last_activity_at).getTime()) / (1000 * 60 * 60 * 24);
    b.recency = Math.max(0, Math.round(15 - days * 0.5));
    b.engagement = days < 3 ? 20 : days < 14 ? 12 : days < 30 ? 6 : 2;
  }
  return b;
}

export function computeHeuristic(lead: Partial<Lead>, icp: Icp): { score: number; breakdown: ScoreBreakdown } {
  const isB2C = (lead as any).is_b2c === true;
  const breakdown = isB2C ? scoreB2C(lead, icp) : scoreB2B(lead, icp);

  const total = Math.max(0, Math.min(100,
    Object.entries(breakdown).reduce((sum, [k, v]) => {
      if (k === 'model' || k === 'total') return sum;
      return sum + (typeof v === 'number' ? v : 0);
    }, 0),
  ));
  breakdown.total = total;
  return { score: total, breakdown };
}

const SYSTEM_PROMPT = `You are a B2B sales lead qualification expert. Given a lead profile and a heuristic score, return JSON only:
{"adjustment": int -15..15, "reasons": [string], "confidence": "low"|"med"|"high"}.
Stay within ±15 of heuristic unless strong signal. Output JSON only, no prose.`;

export async function rerankWithLlm(
  org_id: string,
  lead: Partial<Lead>,
  base: { score: number; breakdown: ScoreBreakdown },
): Promise<{ score: number; breakdown: ScoreBreakdown }> {
  try {
    const userPayload = {
      lead: {
        first_name: lead.first_name, last_name: lead.last_name, email: lead.email,
        company: lead.company, title: lead.title, industry: lead.industry,
        country: lead.country, city: lead.city, source_id: lead.source_id,
      },
      heuristic_score: base.score,
      heuristic_breakdown: base.breakdown,
      icp: await getIcp(org_id),
    };
    const response = await aiComplete({
      org_id,
      model: process.env.CRM_LEAD_SCORING_MODEL || 'claude-haiku-4-5',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      max_tokens: 300,
    });
    const parsed = JSON.parse(extractJson(response));
    const adjustment = clamp(Number(parsed.adjustment ?? 0), -15, 15);
    const final = clamp(base.score + adjustment, 0, 100);
    const breakdown: ScoreBreakdown = {
      ...base.breakdown,
      llm_adjustment: adjustment,
      llm_reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 5) : [],
      llm_confidence: ['low','med','high'].includes(parsed.confidence) ? parsed.confidence : 'med',
      total: final,
      model: 'heuristic_v1+llm_rerank_v1',
    };
    return { score: final, breakdown };
  } catch {
    return base;
  }
}

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
function extractJson(s: string): string {
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : '{}';
}
