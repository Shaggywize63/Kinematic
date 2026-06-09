// Supabase Edge Function: crm-dispatch-pushes
//
// Triggered every minute by pg_cron (job `crm-dispatch-pushes`). Posts to
// the Railway-hosted Node backend at /api/v1/cron/dispatch-pushes, which
// owns the firebase-admin SDK and sends the actual FCM messages. We keep
// the Firebase service-account secret on the Node side only — this edge
// function just bounces the request along with the shared secret.
//
// Auth:
//   - Inbound (from pg_cron):  Bearer SUPABASE_EDGE_SECRET — same pattern
//     as crm-send-email-queue. Without it any caller could trigger
//     repeated dispatches.
//   - Outbound (to Node):       Bearer KINEMATIC_EDGE_SECRET — Node will
//     reject anything else.
//
// Env vars expected on Supabase:
//   SUPABASE_EDGE_SECRET     — the cron-side shared secret
//   KINEMATIC_EDGE_SECRET    — the Node-side shared secret
//   KINEMATIC_BASE_URL       — defaults to the Railway production URL
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const SHARED_SECRET = Deno.env.get('SUPABASE_EDGE_SECRET') || '';
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
    const r = await fetch(`${BASE_URL}/api/v1/cron/dispatch-pushes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NODE_SECRET}`,
        'Content-Type': 'application/json',
      },
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
