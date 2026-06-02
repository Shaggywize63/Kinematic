/**
 * CSV/XLSX lead import. Three-stage flow:
 *   1. upload  → parses headers + rows, stashes full row set in jobs.data,
 *                heuristic + LLM-suggested column mapping
 *   2. preview → applies mapping to a 25-row sample, flags duplicates
 *   3. commit  → iterates the stored rows via findOrCreateLead (the same
 *                dedup orchestrator integrations use), returning
 *                {created, merged, errors} synchronously.
 *
 * The commit path used to dispatch to a Supabase Edge Function; now it
 * runs inline so we get atomic dedup + immediate response + a single
 * code path shared with provider webhooks.
 */
import { parse } from 'csv-parse/sync';
import * as ExcelJS from 'exceljs';
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { complete as aiComplete } from './ai/aiClient';
import { findOrCreateLead, type NormalizedLead } from './integrations/dedup.orchestrator';

const CANONICAL_FIELDS = [
  'first_name','last_name','email','phone','company','title','source','country','city','industry','notes','owner_email',
];

// Cap on rows persisted to crm_import_jobs.data so the JSONB column stays
// reasonable (~10MB at 5KB/row × 10k rows). Larger files truncate with a
// row in `summary.errors` flagging the dropped tail.
const MAX_PERSISTED_ROWS = 10_000;

const IMPORT_SOURCE_NAME = 'Excel/CSV Import';

export async function uploadFile(org_id: string, user_id: string | undefined, fileName: string, buffer: Buffer): Promise<{ job_id: string; headers: string[]; sample: Record<string, unknown>[]; suggested_mapping: Record<string, string> }> {
  const { headers, rows } = await parseHeadersAndSample(fileName, buffer);
  const suggested = await suggestMapping(org_id, headers);

  // Cap rows persisted so the JSONB doesn't blow up; remainder dropped
  // with a note in the eventual commit summary.
  const capped = rows.slice(0, MAX_PERSISTED_ROWS);
  const truncated = rows.length > MAX_PERSISTED_ROWS;

  const { data, error } = await supabaseAdmin.from('crm_import_jobs').insert({
    org_id,
    kind: 'leads',
    file_name: fileName,
    total_rows: rows.length,
    processed_rows: 0,
    inserted: 0,
    skipped: 0,
    errors: truncated
      ? [{ row: -1, reason: `File has ${rows.length} rows; only the first ${MAX_PERSISTED_ROWS} will be imported. Split the file and re-upload to import the rest.` }]
      : [],
    status: 'mapping',
    mapping: suggested,
    sample_rows: capped.slice(0, 10),
    data: { headers, rows: capped },
    created_by: user_id ?? null,
  }).select('id').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  return { job_id: data.id, headers, sample: capped.slice(0, 25), suggested_mapping: suggested };
}

async function parseHeadersAndSample(fileName: string, buffer: Buffer): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
    const records = parse(buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true, bom: true });
    const headers = records.length ? Object.keys(records[0]) : [];
    return { headers, rows: records as Record<string, unknown>[] };
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const wb = new ExcelJS.Workbook();
    // exceljs's typings expect a strict ArrayBuffer; Node's Buffer is a Uint8Array view over one.
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const headers: string[] = [];
    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell, idx) => { headers[idx - 1] = String(cell.value ?? '').trim(); });
    const rows: Record<string, unknown>[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const r: Record<string, unknown> = {};
      row.eachCell((cell, idx) => { r[headers[idx - 1]] = cell.value; });
      rows.push(r);
    });
    return { headers, rows };
  }
  throw new AppError(400, 'Only .csv, .tsv, .xlsx supported', 'UNSUPPORTED');
}

async function suggestMapping(org_id: string, headers: string[]): Promise<Record<string, string>> {
  const heuristic: Record<string, string> = {};
  for (const h of headers) {
    const k = h.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/^(firstname|fname|givenname|first)$/.test(k)) heuristic[h] = 'first_name';
    else if (/^(lastname|lname|surname|familyname|last)$/.test(k)) heuristic[h] = 'last_name';
    // Owner / assignee email MUST be checked before the generic email rule,
    // otherwise "owner_email" collapses onto `email` and the lead loses its
    // assignment (every imported lead then falls back to the importer).
    else if (/(owner|assignee|assignedto|leadowner|repemail|salesrep)/.test(k) && /(email|mail)/.test(k)) heuristic[h] = 'owner_email';
    else if (/^(owneremail|leadowner|assignee|assignedto)$/.test(k)) heuristic[h] = 'owner_email';
    else if (/(email|mail)/.test(k)) heuristic[h] = 'email';
    else if (/(phone|mobile|tel)/.test(k)) heuristic[h] = 'phone';
    else if (/(company|org|account|business)/.test(k)) heuristic[h] = 'company';
    else if (/(title|role|position|jobtitle)/.test(k)) heuristic[h] = 'title';
    else if (/(country)/.test(k)) heuristic[h] = 'country';
    else if (/(city|town)/.test(k)) heuristic[h] = 'city';
    else if (/(industry|vertical|sector)/.test(k)) heuristic[h] = 'industry';
    else if (/(source|channel)/.test(k)) heuristic[h] = 'source';
    else if (/(note|comment|description)/.test(k)) heuristic[h] = 'notes';
  }
  // Fill remaining via LLM if any header is unmapped
  const unmapped = headers.filter(h => !heuristic[h]);
  if (unmapped.length === 0) return heuristic;
  try {
    const reply = await aiComplete({
      org_id,
      model: process.env.CRM_LEAD_SCORING_MODEL || 'claude-haiku-4-5-20251001',
      system: `You map CSV headers to canonical lead fields. Allowed: ${CANONICAL_FIELDS.join(', ')}. Output JSON {"<header>": "<canonical>" | null}. JSON only.`,
      messages: [{ role: 'user', content: JSON.stringify({ headers: unmapped }) }],
      max_tokens: 400,
    });
    const json = JSON.parse(extractJson(reply));
    for (const h of unmapped) {
      const v = json[h];
      if (typeof v === 'string' && CANONICAL_FIELDS.includes(v)) heuristic[h] = v;
    }
  } catch {}
  return heuristic;
}

export async function previewJob(org_id: string, job_id: string, mapping: Record<string, string>) {
  // Filter by kind='leads' so a wrong job id (e.g. an activity-import
  // job id pasted in by mistake) returns 404 instead of being treated
  // as a lead import.
  const { data: job } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).eq('id', job_id).eq('kind', 'leads').single();
  if (!job) throw new AppError(404, 'Import job not found', 'NOT_FOUND');

  const sample = (job.sample_rows ?? []) as Record<string, unknown>[];
  const mapped = sample.map(row => mapRow(row, mapping));
  const warnings: Array<{ row: number; reason: string }> = [];
  const emails = mapped.map(r => (r.email as string)?.toLowerCase()).filter(Boolean);
  if (emails.length) {
    const { data: dups } = await supabaseAdmin.from('crm_leads').select('email')
      .eq('org_id', org_id).in('email', emails).is('deleted_at', null);
    const dupSet = new Set((dups ?? []).map(d => d.email?.toLowerCase()));
    mapped.forEach((r, i) => {
      if (r.email && dupSet.has((r.email as string).toLowerCase())) {
        warnings.push({ row: i, reason: 'Duplicate (will merge into existing lead)' });
      }
    });
  }

  // Persist the mapping AND return the refreshed job alongside the
  // mapped sample so the dashboard's Map → Review step can render
  // sample rows + the total_rows / status pills without a second
  // fetch. Keeps the {mapped_sample, warnings} keys for any older
  // callers that still read them.
  const { data: updatedJob } = await supabaseAdmin
    .from('crm_import_jobs')
    .update({ status: 'previewing', mapping })
    .eq('id', job_id)
    .select('*')
    .single();
  return {
    job: updatedJob ?? job,
    sample: mapped.slice(0, 25),
    mapped_sample: mapped.slice(0, 25),
    warnings,
  };
}

/**
 * Kicks off the import in the background and returns the job row IMMEDIATELY
 * (status='running', processed_rows=0). Long-running imports would otherwise
 * exceed the Railway request timeout and the FE would never see the result.
 *
 * The processing loop runs as an unawaited promise — Node keeps the work in
 * the event loop until it's done. The FE polls /jobs/:id to track progress
 * (processed_rows / total_rows) and detect completion (status='completed' /
 * 'failed').
 *
 * `user_id` is positional-last + optional so existing call sites
 * (crm.routes.ts:1521 `commitJob(orgId(req), body.job_id)`) keep working
 * without a route-file edit. When supplied, it stamps `created_by` on the
 * auto-created lead source so audit logs attribute the first import
 * correctly.
 */
export async function commitJob(
  org_id: string,
  job_id: string,
  user_id: string | null = null,
  client_id: string | null = null,
) {
  const { data: job, error: loadErr } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).eq('id', job_id).eq('kind', 'leads').single();
  if (loadErr || !job) throw new AppError(404, 'Import job not found', 'NOT_FOUND');

  const stored = (job.data ?? {}) as { headers?: string[]; rows?: Record<string, unknown>[] };
  const rows = stored.rows ?? [];

  // Flip to running + reset counters so the FE's first poll sees a clean state.
  await supabaseAdmin.from('crm_import_jobs').update({
    status: 'running', processed_rows: 0, inserted: 0, skipped: 0,
    total_rows: rows.length,
  }).eq('id', job_id);

  // Fire-and-forget. Node keeps this in the event loop until it finishes,
  // even after the HTTP response has been returned to the FE.
  void runCommitInBackground(org_id, job_id, user_id, client_id, rows, (job.mapping ?? {}) as Record<string, string>, Array.isArray(job.errors) ? job.errors : []);

  return { ...job, status: 'running', processed_rows: 0, total_rows: rows.length };
}

async function runCommitInBackground(
  org_id: string,
  job_id: string,
  user_id: string | null,
  client_id: string | null,
  rows: Record<string, unknown>[],
  mapping: Record<string, string>,
  existingErrors: any[],
) {
  // Auto-create or fetch the single "Excel/CSV Import" lead source per org
  // so every import attributes its leads consistently. Reports and
  // assignment rules can then target this source by name.
  const source_id = await getOrCreateImportSource(org_id, user_id);

  // Resolve the CSV's `owner_email` column to user ids up front. One query
  // for the whole org (tens of users, not thousands) → an email→id map,
  // so the parallel row loop below stays lookup-free and race-free. Without
  // this, owner_email was silently dropped and every lead fell back to the
  // importer as owner.
  const ownerByEmail = await buildOwnerEmailMap(org_id);

  let created = 0;
  let merged  = 0;
  const errors: Array<{ row: number; reason: string }> = [];
  // Parallelise findOrCreateLead. Each row was ~150-400ms sequentially
  // (3-6 DB roundtrips for hash lookup + insert + attribution); 8-way
  // parallel × in-process JS event loop drops a 1130-row import from
  // ~3-5 min to ~25-40s. Pool stays well under Supabase's default
  // connection ceiling, and per-row writes don't conflict because each
  // hits a different lead row.
  const CONCURRENCY = 10;
  // Write progress every PROGRESS_BATCH rows so the FE's poll sees the bar
  // tick. 50 keeps the DB write load light even on 10k-row imports.
  const PROGRESS_BATCH = 50;

  let nextProgressFlush = PROGRESS_BATCH;
  for (let chunkStart = 0; chunkStart < rows.length; chunkStart += CONCURRENCY) {
    const chunk = rows.slice(chunkStart, chunkStart + CONCURRENCY);
    await Promise.all(chunk.map(async (rawRow, j) => {
      const i = chunkStart + j;
      const mapped = mapRow(rawRow, mapping);
      const normalized: NormalizedLead = {
        first_name: textOrNull(mapped.first_name),
        last_name:  textOrNull(mapped.last_name),
        email:      textOrNull(mapped.email),
        phone:      textOrNull(mapped.phone),
        company:    textOrNull(mapped.company),
        title:      textOrNull(mapped.title),
        industry:   textOrNull(mapped.industry),
        country:    textOrNull(mapped.country),
        city:       textOrNull(mapped.city),
        notes:      textOrNull(mapped.notes),
      };

      if (!normalized.email && !normalized.phone && !normalized.first_name && !normalized.last_name) {
        errors.push({ row: i + 2, reason: 'No name, email, or phone' });
        return;
      }
      // Map the row's owner_email → user id. When present and matched, the
      // lead is assigned to that user; when absent or unmatched, owner_id
      // stays null and createLead's assignment chain (rule → creator →
      // default owner) takes over as before.
      const ownerEmail = textOrNull(mapped.owner_email);
      const owner_id = ownerEmail ? (ownerByEmail.get(ownerEmail.toLowerCase()) ?? null) : null;
      try {
        const r = await findOrCreateLead({
          org_id, source_id, normalized, owner_id,
          integration_id: null, raw_event_id: null, user_id,
          client_id: client_id ?? undefined,
        });
        // Counter increments in JS are safe under Promise.all — the event
        // loop runs synchronous code without preemption between awaits.
        if (r.was_new) created++; else merged++;
      } catch (e) {
        errors.push({ row: i + 2, reason: (e as Error).message?.slice(0, 200) ?? 'unknown' });
      }
    }));

    const processed = Math.min(chunkStart + chunk.length, rows.length);
    if (processed >= nextProgressFlush || processed === rows.length) {
      nextProgressFlush = processed + PROGRESS_BATCH;
      await supabaseAdmin.from('crm_import_jobs').update({
        processed_rows: processed,
        inserted: created,
        skipped: merged + errors.length,
      }).eq('id', job_id);
    }
  }

  const summary = { total: rows.length, created, merged, error_count: errors.length };
  await supabaseAdmin.from('crm_import_jobs').update({
    // crm_import_jobs.status is enum-constrained to
    // pending|mapping|previewing|running|completed|failed. Writing 'done'
    // here used to fail the CHECK constraint silently — the entire final
    // write got rolled back, the row stayed at status='running' with
    // summary=null, and the FE polled forever.
    status: errors.length > 0 && created + merged === 0 ? 'failed' : 'completed',
    processed_rows: rows.length,
    inserted: created,
    skipped: merged + errors.length,
    errors: [...existingErrors, ...errors.slice(0, 100)],
    summary,
    // Free the parsed-rows payload now that we're done — no need to keep
    // ~10k row JSON around once the import has run.
    data: null,
  }).eq('id', job_id);
}

export async function getJob(org_id: string, job_id: string) {
  const { data, error } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).eq('id', job_id).eq('kind', 'leads').single();
  if (error) throw new AppError(404, 'Import job not found', 'NOT_FOUND');

  // Self-heal: if the background loop wrote all rows but the final
  // summary update failed for any reason (CHECK violation, process
  // recycle, DB blip), the row stays at status='running' with
  // summary=null and the FE polls forever. Detect that on poll and
  // finalize inline so the user never sees a perpetually-stuck import.
  const row = data as any;
  const total = (row.total_rows as number) || 0;
  const processed = (row.processed_rows as number) || 0;
  if (row.status === 'running' && total > 0 && processed >= total && !row.summary) {
    const summary = {
      total,
      created: row.inserted ?? 0,
      merged: row.skipped ?? 0,
      error_count: Array.isArray(row.errors) ? row.errors.length : 0,
    };
    const { data: healed } = await supabaseAdmin
      .from('crm_import_jobs')
      .update({ status: 'completed', summary, data: null })
      .eq('id', job_id).eq('org_id', org_id)
      .select('*').single();
    return healed ?? { ...row, status: 'completed', summary };
  }
  return data;
}

export async function listJobs(org_id: string) {
  const { data } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).eq('kind', 'leads').order('created_at', { ascending: false }).limit(50);
  return data ?? [];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Builds a lowercased email → user-id map for the org so the import loop can
// resolve each row's `owner_email` to an owner without a per-row SELECT.
// Users with no email are skipped. Returns an empty map on error so the
// import degrades to the previous "assign to creator" behaviour rather than
// failing outright.
async function buildOwnerEmailMap(org_id: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { data: users } = await supabaseAdmin.from('users')
    .select('id, email').eq('org_id', org_id);
  for (const u of users ?? []) {
    const email = (u as { email?: string | null }).email;
    if (email) map.set(String(email).toLowerCase().trim(), (u as { id: string }).id);
  }
  return map;
}

async function getOrCreateImportSource(org_id: string, user_id: string | null): Promise<string> {
  const { data: existing } = await supabaseAdmin.from('crm_lead_sources')
    .select('id').eq('org_id', org_id).eq('name', IMPORT_SOURCE_NAME).maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: created, error } = await supabaseAdmin.from('crm_lead_sources')
    .insert({ org_id, name: IMPORT_SOURCE_NAME, created_by: user_id })
    .select('id').single();
  if (error || !created) {
    // Lost a race or a unique constraint blew up — re-fetch.
    const { data: again } = await supabaseAdmin.from('crm_lead_sources')
      .select('id').eq('org_id', org_id).eq('name', IMPORT_SOURCE_NAME).maybeSingle();
    if (again?.id) return again.id as string;
    throw new AppError(500, `Failed to create import lead source: ${error?.message ?? 'unknown'}`, 'DB_ERROR');
  }
  return created.id as string;
}

function mapRow(row: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [src, dest] of Object.entries(mapping)) {
    if (!dest) continue;
    const val = row[src];
    // First-non-empty wins. When two source columns map to the same
    // destination (a common auto-mapper accident — e.g. both `email`
    // and `owner_email` accidentally pointing at `email`), the second
    // one used to silently overwrite the first, and an empty CSV cell
    // would wipe a real value. Keep the earlier non-empty value
    // instead of nuking it.
    if (val === undefined || val === null) continue;
    if (typeof val === 'string' && val.trim() === '') continue;
    const existing = out[dest];
    if (existing !== undefined && existing !== null && !(typeof existing === 'string' && existing.trim() === '')) {
      continue;
    }
    out[dest] = val;
  }
  return out;
}

function textOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function extractJson(s: string): string {
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : '{}';
}
