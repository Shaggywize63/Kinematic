// Supabase Edge Function: crm-rescore-lead
// Rescore a single lead with Claude Haiku LLM rerank.
// Triggered by backend on lead create/update.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SHARED_SECRET = Deno.env.get('SUPABASE_EDGE_SECRET') || '';
const ANTHROPIC_FALLBACK_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

serve(async (req) => {
  if (SHARED_SECRET) {
    const auth = req.headers.get('Authorization') || '';
    if (auth !== `Bearer ${SHARED_SECRET}`) return new Response('Unauthorized', { status: 401 });
  }

  const { lead_id, org_id } = await req.json().catch(() => ({}));
  if (!lead_id || !org_id) return new Response('lead_id and org_id required', { status: 400 });

  const { data: lead } = await sb.from('crm_leads').select('*').eq('id', lead_id).eq('org_id', org_id).maybeSingle();
  if (!lead) return new Response('Lead not found', { status: 404 });

  const apiKey = await getOrgAnthropicKey(org_id);
  if (!apiKey) return new Response(JSON.stringify({ skipped: 'no_api_key' }), { headers: { 'Content-Type': 'application/json' } });

  const client = new Anthropic({ apiKey });
  const { data: settings } = await sb.from('crm_settings').select('config').eq('org_id', org_id).maybeSingle();
  const icp = settings?.config?.icp ?? {};

  const baseline = lead.score ?? 0;
  const breakdown = lead.score_breakdown ?? {};

  try {
    const msg = await client.messages.create({
      model: Deno.env.get('CRM_LEAD_SCORING_MODEL') || 'claude-3-haiku-20240307',
      max_tokens: 300,
      system: `You are a B2B sales lead qualification expert. Given a lead profile and heuristic score, return JSON only:
{"adjustment": int -15..15, "reasons": [string], "confidence": "low"|"med"|"high"}`,
      messages: [{ role: 'user', content: JSON.stringify({
        lead: { first_name: lead.first_name, last_name: lead.last_name, email: lead.email,
                company: lead.company, title: lead.title, industry: lead.industry, country: lead.country },
        heuristic_score: baseline, heuristic_breakdown: breakdown, icp,
      }) }],
    });
    const text = (msg.content[0] as { type: string; text?: string })?.text ?? '{}';
    const parsed = JSON.parse((text.match(/\{[\s\S]*\}/) ?? ['{}'])[0]);
    const adjustment = Math.max(-15, Math.min(15, Number(parsed.adjustment ?? 0)));
    const final = Math.max(0, Math.min(100, baseline + adjustment));

    const newBreakdown = {
      ...breakdown,
      llm_adjustment: adjustment,
      llm_reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 5) : [],
      llm_confidence: ['low','med','high'].includes(parsed.confidence) ? parsed.confidence : 'med',
      total: final,
      model: 'heuristic_v1+llm_rerank_v1',
    };

    await sb.from('crm_leads').update({
      score: final, score_breakdown: newBreakdown, score_updated_at: new Date().toISOString(),
    }).eq('id', lead_id).eq('org_id', org_id);

    await sb.from('crm_lead_scores').insert({
      lead_id, org_id, score: final, model: 'heuristic_v1+llm_rerank_v1', breakdown: newBreakdown,
    });

    return new Response(JSON.stringify({ ok: true, score: final }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});

async function getOrgAnthropicKey(org_id: string): Promise<string> {
  const { data } = await sb.from('org_api_keys').select('anthropic_api_key').eq('org_id', org_id).maybeSingle();
  return data?.anthropic_api_key || ANTHROPIC_FALLBACK_KEY;
}
