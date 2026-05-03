// Supabase Edge Function: crm-recompute-win-prob
// Hourly batch refresh of deal win probabilities.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SHARED_SECRET = Deno.env.get('SUPABASE_EDGE_SECRET') || '';
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

serve(async (req) => {
  if (SHARED_SECRET) {
    const auth = req.headers.get('Authorization') || '';
    if (auth !== `Bearer ${SHARED_SECRET}`) return new Response('Unauthorized', { status: 401 });
  }

  const { data: deals } = await sb.from('crm_deals')
    .select('id, org_id, stage_id, amount, created_at, win_probability_updated_at, crm_deal_stages!inner(probability, stage_type)')
    .is('deleted_at', null).eq('crm_deal_stages.stage_type', 'open').limit(1000);

  let updated = 0;
  for (const d of deals ?? []) {
    const stageProb = Number((d as { crm_deal_stages: { probability: number } }).crm_deal_stages?.probability ?? 50);
    const ageDays = (Date.now() - new Date(d.created_at).getTime()) / 86400000;
    const agePenalty = ageDays > 90 ? 0.7 : ageDays > 60 ? 0.85 : 1.0;
    const { count: activityCount } = await sb.from('crm_activities')
      .select('id', { count: 'exact', head: true }).eq('deal_id', d.id)
      .gte('completed_at', new Date(Date.now() - 30 * 86400000).toISOString());
    const engagement = Math.min(1.5, 0.7 + (activityCount ?? 0) * 0.1);
    const baseline = Math.max(0, Math.min(100, Math.round(stageProb * agePenalty * engagement)));
    const reasoning = `Stage ${stageProb}% × age ${agePenalty.toFixed(2)} × engagement ${engagement.toFixed(2)} = ${baseline}%.`;
    await sb.from('crm_deals').update({
      win_probability_ai: baseline,
      win_probability_reasoning: reasoning,
      win_probability_updated_at: new Date().toISOString(),
    }).eq('id', d.id);
    updated++;
  }
  return new Response(JSON.stringify({ updated }), { headers: { 'Content-Type': 'application/json' } });
});
