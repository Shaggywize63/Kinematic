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

export function computeHeuristic(lead: Partial<Lead>, icp: Icp): { score: number; breakdown: ScoreBreakdown } {
  const breakdown: ScoreBreakdown = { base: 0, title: 0, company_size: 0, source: 0, engagement: 0, recency: 0, icp: 0, model: 'heuristic_v1' };

  const t = (lead.title || '').toLowerCase();
  if (/(ceo|cto|cfo|cmo|coo|chief|founder|owner)/.test(t)) breakdown.title = 20;
  else if (/(vp|vice president|head of)/.test(t)) breakdown.title = 15;
  else if (/(director)/.test(t)) breakdown.title = 10;
  else if (/(manager|lead)/.test(t)) breakdown.title = 5;
  else if (t) breakdown.title = 2;

  const company = (lead.company || '').toLowerCase();
  if (company.length > 0) breakdown.company_size = 8;

  const sourceWeights: Record<string, number> = {
    web_form: 15, referral: 18, manual: 5, csv: 5, email: 8, api: 10, campaign: 12, ads: 10, social: 7, event: 12,
  };
  if (lead.source_id) {
    breakdown.source = 10;
  }

  if (lead.last_activity_at) {
    const days = (Date.now() - new Date(lead.last_activity_at).getTime()) / (1000 * 60 * 60 * 24);
    breakdown.recency = Math.max(0, Math.round(10 - days * 0.3));
    breakdown.engagement = days < 7 ? 15 : days < 30 ? 8 : 3;
  }

  const industryMatch = icp.industries && lead.industry &&
    icp.industries.some(i => i.toLowerCase() === lead.industry!.toLowerCase());
  const titleMatch = icp.titles && lead.title &&
    icp.titles.some(i => lead.title!.toLowerCase().includes(i.toLowerCase()));
  if (industryMatch) breakdown.icp! += 5;
  if (titleMatch) breakdown.icp! += 5;

  const total = Math.max(0, Math.min(100,
    (breakdown.base ?? 0) + (breakdown.title ?? 0) + (breakdown.company_size ?? 0) +
    (breakdown.source ?? 0) + (breakdown.engagement ?? 0) + (breakdown.recency ?? 0) + (breakdown.icp ?? 0)
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
