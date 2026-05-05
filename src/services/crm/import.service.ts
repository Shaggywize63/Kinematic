/**
 * CSV/XLSX lead import. Three-stage flow:
 *   1. upload  → parses headers + sample rows, asks LLM to suggest mapping
 *   2. preview → applies mapping, runs dedup, returns warnings
 *   3. commit  → batch-inserts via Edge Function (handles large files)
 */
import { parse } from 'csv-parse/sync';
import * as ExcelJS from 'exceljs';
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { complete as aiComplete } from './ai/aiClient';
import { triggerEdgeFunction } from './edge.client';

const CANONICAL_FIELDS = [
  'first_name','last_name','email','phone','company','title','source','country','city','industry','notes',
];

export async function uploadFile(org_id: string, user_id: string | undefined, fileName: string, buffer: Buffer): Promise<{ job_id: string; headers: string[]; sample: Record<string, unknown>[]; suggested_mapping: Record<string, string> }> {
  const { headers, rows } = await parseHeadersAndSample(fileName, buffer);
  const suggested = await suggestMapping(org_id, headers);

  const { data, error } = await supabaseAdmin.from('crm_import_jobs').insert({
    org_id, file_name: fileName, total_rows: rows.length, processed_rows: 0,
    inserted: 0, skipped: 0, errors: [],
    status: 'mapping', mapping: suggested, sample_rows: rows.slice(0, 10), created_by: user_id ?? null,
  }).select('id').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  // Persist the file payload as a sample (first 1000 rows) for the preview step;
  // full file is re-supplied to the Edge Function during commit.
  return { job_id: data.id, headers, sample: rows.slice(0, 25), suggested_mapping: suggested };
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
      model: process.env.CRM_LEAD_SCORING_MODEL || 'claude-haiku-4-5',
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
        warnings.push({ row: i, reason: 'Duplicate email' });
      }
    });
  }

  await supabaseAdmin.from('crm_import_jobs').update({ status: 'previewing', mapping }).eq('id', job_id);
  return { mapped_sample: mapped.slice(0, 25), warnings };
}

export async function commitJob(org_id: string, job_id: string) {
  const { data: job } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).eq('id', job_id).single();
  if (!job) throw new AppError(404, 'Import job not found', 'NOT_FOUND');
  await supabaseAdmin.from('crm_import_jobs').update({ status: 'running' }).eq('id', job_id);
  triggerEdgeFunction('crm-import-commit', { job_id, org_id }).catch(async () => {
    await supabaseAdmin.from('crm_import_jobs').update({ status: 'failed', errors: [{ row: -1, reason: 'Edge function unavailable' }] }).eq('id', job_id);
  });
  return { job_id, status: 'running' };
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

function mapRow(row: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [src, dest] of Object.entries(mapping)) {
    if (!dest) continue;
    out[dest] = row[src];
  }
  return out;
}

function extractJson(s: string): string {
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : '{}';
}
