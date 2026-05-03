// Supabase Edge Function: crm-import-commit
// Receives a job_id; reads pending sample rows for the job, batches inserts.
// (For production scale, swap to streaming the source file from Storage.)
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
  const { job_id, org_id } = await req.json();
  const { data: job } = await sb.from('crm_import_jobs').select('*').eq('id', job_id).eq('org_id', org_id).maybeSingle();
  if (!job) return new Response('Job not found', { status: 404 });

  const sample = (job.sample_rows ?? []) as Record<string, unknown>[];
  const mapping = job.mapping ?? {};
  const rows = sample.map(r => mapRow(r, mapping));

  let inserted = 0, skipped = 0;
  const errors: Array<{ row: number; reason: string }> = [];
  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize).map((r, idx) => {
      try {
        return {
          org_id,
          first_name: r.first_name ?? null,
          last_name: r.last_name ?? null,
          email: r.email ? String(r.email).toLowerCase().trim() : null,
          phone: r.phone ?? null,
          company: r.company ?? null,
          title: r.title ?? null,
          country: r.country ?? null,
          city: r.city ?? null,
          industry: r.industry ?? null,
          notes: r.notes ?? null,
          status: 'new',
          score: 0,
          score_breakdown: {},
          tags: [],
          custom_fields: {},
        };
      } catch (e) {
        errors.push({ row: i + idx, reason: (e as Error).message });
        return null;
      }
    }).filter(Boolean);

    if (batch.length === 0) continue;
    const { data, error } = await sb.from('crm_leads').insert(batch).select('id');
    if (error) {
      errors.push({ row: i, reason: error.message });
      skipped += batch.length;
    } else {
      inserted += data?.length ?? 0;
    }
    await sb.from('crm_import_jobs').update({
      processed_rows: Math.min(i + batchSize, rows.length), inserted, skipped, errors,
    }).eq('id', job_id);
  }

  await sb.from('crm_import_jobs').update({ status: 'completed' }).eq('id', job_id);
  return new Response(JSON.stringify({ inserted, skipped, errors_count: errors.length }), { headers: { 'Content-Type': 'application/json' } });
});

function mapRow(row: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [src, dest] of Object.entries(mapping)) {
    if (!dest) continue;
    out[dest] = row[src];
  }
  return out;
}
