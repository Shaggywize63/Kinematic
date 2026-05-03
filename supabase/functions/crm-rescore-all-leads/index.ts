// Supabase Edge Function: crm-rescore-all-leads
// Scheduled daily 02:00 UTC. Picks leads whose score is older than 24h
// and re-triggers per-lead rescore.
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
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: leads } = await sb.from('crm_leads').select('id, org_id')
    .is('deleted_at', null).neq('status', 'converted')
    .or(`score_updated_at.is.null,score_updated_at.lt.${cutoff}`).limit(500);

  let processed = 0;
  for (const lead of leads ?? []) {
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/crm-rescore-lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SHARED_SECRET}` },
        body: JSON.stringify({ lead_id: lead.id, org_id: lead.org_id }),
      });
      processed++;
    } catch { /* continue */ }
  }
  return new Response(JSON.stringify({ processed }), { headers: { 'Content-Type': 'application/json' } });
});
