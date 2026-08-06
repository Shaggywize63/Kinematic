// Supabase Edge Function: crm-sync-google-calendars
//
// Triggered periodically by pg_cron (job `crm-sync-google-calendars`). Posts
// to the Railway-hosted Node backend at /api/v1/cron/sync-google-calendars,
// which pulls each connected rep's recent + upcoming Google Calendar events
// into crm_activities (the inbound half of the two-way calendar sync). All
// Google token plumbing lives on the Node side; this edge function just
// bounces the request along with the shared secret.
//
// Auth:
//   - Inbound (from pg_cron):  Bearer CRM_EDGE_SECRET — same pattern as the
//     other crm-* cron edge functions. Without it any caller could trigger
//     repeated syncs.
//   - Outbound (to Node):       Bearer KINEMATIC_EDGE_SECRET — Node rejects
//     anything else (requireEdgeSecret).
//
// Env vars expected on Supabase:
//   CRM_EDGE_SECRET          — the cron-side shared secret (SUPABASE_ prefix is reserved)
//   KINEMATIC_EDGE_SECRET    — the Node-side shared secret
//   KINEMATIC_BASE_URL       — defaults to the Railway production URL
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const SHARED_SECRET = Deno.env.get('CRM_EDGE_SECRET') || Deno.env.get('SUPABASE_EDGE_SECRET') || '';
const NODE_SECRET   = Deno.env.get('KINEMATIC_EDGE_SECRET') || '';
const BASE_URL      = Deno.env.get('KINEMATIC_BASE_URL') || 'https://api.kinematicapp.com';

serve(async (req) => {
  if (SHARED_SECRET) {
    const auth = req.headers.get('Authorization') || '';
    if (auth !== `Bearer ${SHARED_SECRET}`) return new Response('Unauthorized', { status: 401 });
  }
  if (!NODE_SECRET) {
    return new Response(
      JSON.stringify({ error: 'KINEMATIC_EDGE_SECRET not set on Supabase' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const r = await fetch(`${BASE_URL}/api/v1/cron/sync-google-calendars`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NODE_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit: 200 }),
    });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
});
