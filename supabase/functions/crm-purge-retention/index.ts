// Supabase Edge Function: crm-purge-retention
//
// Triggered on a slow schedule by pg_cron (e.g. daily). Posts to the
// Railway-hosted Node backend at /api/v1/cron/purge-retention, which runs the
// data-retention purge (GDPR Art.5(1)(e) / DPDP §8(7)): hard-removes
// soft-deleted CRM PII past its grace window and trims old GPS/telemetry.
//
// SAFETY: the Node side runs as a DRY RUN unless RETENTION_PURGE_ENABLED=true
// is set on Railway, so scheduling this before that flag is set only produces
// counts, never deletions. Add `?dry_run=true` here to force a preview.
//
// Auth:
//   - Inbound (from pg_cron):  Bearer SUPABASE_EDGE_SECRET
//   - Outbound (to Node):      Bearer KINEMATIC_EDGE_SECRET
//
// Env vars expected on Supabase:
//   SUPABASE_EDGE_SECRET     — the cron-side shared secret
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
    const r = await fetch(`${BASE_URL}/api/v1/cron/purge-retention`, {
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
