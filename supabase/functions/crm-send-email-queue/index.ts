// Supabase Edge Function: crm-send-email-queue
// Picks up rows in crm_email_logs with status='queued' and attempts a send
// via the configured provider. Stub provider just marks them sent.
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

  const { data: queued } = await sb.from('crm_email_logs')
    .select('id, org_id, from_email, to_email, subject, body_html')
    .eq('status', 'queued').limit(50);

  let sent = 0;
  for (const log of queued ?? []) {
    // STUB: pretend the send succeeded.
    await sb.from('crm_email_logs').update({
      status: 'sent', sent_at: new Date().toISOString(),
      provider_message_id: `stub-${crypto.randomUUID()}`,
    }).eq('id', log.id);
    sent++;
  }
  return new Response(JSON.stringify({ sent }), { headers: { 'Content-Type': 'application/json' } });
});
