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
  'first_name','last_name','email','phone','company','title','source','country','city','industry','notes',
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
  const { data: job } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).eq('id', job_id).single();
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

  await supabaseAdmin.from('crm_import_jobs').update({ status: 'previewing', mapping }).eq('id', job_id);
  return { mapped_sample: mapped.slice(0, 25), warnings };
}

/**
 * Runs the import inline (no Edge Function dispatch) so we get an atomic
 * summary back to the dashboard. For each row: apply mapping → call
 * findOrCreateLead → bucket as created or merged. Errors per row are
 * collected and returned without aborting the rest of the import.
 *
 * Returns the updated job row so the dashboard can display
 * job.summary.{total, created, merged, errors[]}.
 */
export async function commitJob(org_id: string, user_id: string | null, job_id: string) {
  const { data: job, error: loadErr } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).eq('id', job_id).single();
  if (loadErr || !job) throw new AppError(404, 'Import job not found', 'NOT_FOUND');

  await supabaseAdmin.from('crm_import_jobs').update({ status: 'running' }).eq('id', job_id);

  const mapping = (job.mapping ?? {}) as Record<string, string>;
  const stored = (job.data ?? {}) as { headers?: string[]; rows?: Record<string, unknown>[] };
  const rows = stored.rows ?? [];

  // Auto-create or fetch the single "Excel/CSV Import" lead source per org
  // so every import attributes its leads consistently. Reports and
  // assignment rules can then target this source by name.
  const source_id = await getOrCreateImportSource(org_id, user_id);

  let created = 0;
  let merged  = 0;
  const errors: Array<{ row: number; reason: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const mapped = mapRow(rows[i], mapping);
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

    // Skip rows with no identity at all — every other column comes through
    // as custom_fields on dedup-orchestrator anyway, but if there's no
    // name/email/phone there's nothing to do.
    if (!normalized.email && !normalized.phone && !normalized.first_name && !normalized.last_name) {
      errors.push({ row: i + 2 /* +2 to 1-index past the header row */, reason: 'No name, email, or phone' });
      continue;
    }

    try {
      const r = await findOrCreateLead({
        org_id,
        source_id,
        normalized,
        integration_id: null,
        raw_event_id: null,
        user_id,
      });
      if (r.was_new) created++; else merged++;
    } catch (e) {
      errors.push({ row: i + 2, reason: (e as Error).message?.slice(0, 200) ?? 'unknown' });
    }
  }

  const summary = { total: rows.length, created, merged, error_count: errors.length };
  // Preserve any errors from upload-time (e.g. row-cap warnings) by
  // appending instead of overwriting.
  const existingErrors = Array.isArray(job.errors) ? job.errors : [];

  const { data: updated, error: updErr } = await supabaseAdmin.from('crm_import_jobs')
    .update({
      status: errors.length > 0 && created + merged === 0 ? 'failed' : 'done',
      processed_rows: rows.length,
      inserted: created,
      skipped: merged + errors.length,
      errors: [...existingErrors, ...errors.slice(0, 100)], // cap stored errors at 100 to keep the row small
      summary,
      // Free the parsed-rows payload now that we're done — no need to keep ~10k row JSON around.
      data: null,
    })
    .eq('org_id', org_id).eq('id', job_id)
    .select('*').single();
  if (updErr) throw new AppError(500, updErr.message, 'DB_ERROR');

  return updated;
}

export async function getJob(org_id: string, job_id: string) {
  const { data, error } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).eq('id', job_id).single();
  if (error) throw new AppError(404, 'Import job not found', 'NOT_FOUND');
  return data;
}

export async function listJobs(org_id: string) {
  const { data } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).order('created_at', { ascending: false }).limit(50);
  return data ?? [];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

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
    out[dest] = row[src];
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
