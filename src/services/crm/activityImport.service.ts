/**
 * Activity bulk import — CSV / XLSX.
 *
 * Three-stage flow, mirrors import.service.ts for leads but with
 * activity-specific shape:
 *   1. upload  → parses headers + rows, stashes in jobs.data with
 *                kind='activities' discriminator, returns heuristic
 *                mapping
 *   2. preview → applies mapping to a sample, resolves parent entity
 *                per row (lead by email/phone OR explicit lead_id),
 *                flags rows that can't resolve
 *   3. commit  → iterates the stored rows, creates crm_activities rows
 *                linked to the resolved entity. Errors per row are
 *                collected without aborting the rest.
 *
 * Activity rows MUST link to a parent (lead / contact / account / deal)
 * — the entity field is mandatory by design (see activitySchema in
 * validators). The importer resolves the parent in this priority:
 *   1. explicit lead_id / contact_id / deal_id / account_id (UUID)
 *   2. lead_phone — normalize and match crm_leads.phone in the org
 *   3. lead_email — match crm_leads.email
 *   4. contact_email — match crm_contacts.email
 * Rows that resolve to nothing are reported as errors, not silently
 * dropped — bulk-importing orphan activities was the source of two
 * support tickets we had last quarter.
 */
import { parse } from 'csv-parse/sync';
import * as ExcelJS from 'exceljs';
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

// Canonical activity columns the importer understands. Anything not in
// this list is dropped at map time (no custom-field smuggling via CSV).
const CANONICAL_FIELDS = [
  'type', 'subject', 'body', 'status',
  'due_at', 'completed_at',
  // Entity-resolution columns — at least one of these (or lead_id /
  // contact_id / deal_id / account_id) must be present per row.
  'lead_id', 'lead_email', 'lead_phone',
  'contact_id', 'contact_email',
  'deal_id',
  'account_id',
  'owner_email',
];

const VALID_TYPES = new Set(['call', 'email', 'meeting', 'task', 'note', 'sms', 'whatsapp']);
const VALID_STATUS = new Set(['open', 'in_progress', 'completed', 'cancelled']);

const MAX_PERSISTED_ROWS = 10_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function uploadFile(
  org_id: string,
  user_id: string | undefined,
  fileName: string,
  buffer: Buffer,
): Promise<{ job_id: string; headers: string[]; sample: Record<string, unknown>[]; suggested_mapping: Record<string, string> }> {
  const { headers, rows } = await parseHeadersAndSample(fileName, buffer);
  const suggested = heuristicMapping(headers);

  const capped = rows.slice(0, MAX_PERSISTED_ROWS);
  const truncated = rows.length > MAX_PERSISTED_ROWS;

  const { data, error } = await supabaseAdmin.from('crm_import_jobs').insert({
    org_id,
    kind: 'activities',
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

function heuristicMapping(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    const k = h.toLowerCase().replace(/[^a-z0-9]/g, '');
    // Identity / entity-resolution columns
    if (/^(leadid)$/.test(k)) out[h] = 'lead_id';
    else if (/^(contactid)$/.test(k)) out[h] = 'contact_id';
    else if (/^(dealid)$/.test(k)) out[h] = 'deal_id';
    else if (/^(accountid)$/.test(k)) out[h] = 'account_id';
    else if (/^(leademail|leadmail)$/.test(k)) out[h] = 'lead_email';
    else if (/^(leadphone|leadmobile|leadcontact)$/.test(k)) out[h] = 'lead_phone';
    else if (/^(contactemail|contactmail)$/.test(k)) out[h] = 'contact_email';
    else if (/^(owneremail|assigneeemail|repemail)$/.test(k)) out[h] = 'owner_email';
    // Generic — only map if not already matched by a more specific rule above
    else if (/^(email|mail)$/.test(k)) out[h] = 'lead_email';
    else if (/^(phone|mobile|contact)$/.test(k)) out[h] = 'lead_phone';
    // Activity-specific columns
    else if (/^(type|activitytype|kind)$/.test(k)) out[h] = 'type';
    else if (/^(subject|title|summary)$/.test(k)) out[h] = 'subject';
    else if (/^(body|description|notes|details)$/.test(k)) out[h] = 'body';
    else if (/^(status)$/.test(k)) out[h] = 'status';
    else if (/^(dueat|duedate|due|scheduledat|scheduled)$/.test(k)) out[h] = 'due_at';
    else if (/^(completedat|completed|donedate|completiondate)$/.test(k)) out[h] = 'completed_at';
  }
  return out;
}

export async function previewJob(org_id: string, job_id: string, mapping: Record<string, string>) {
  const { data: job } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).eq('id', job_id).eq('kind', 'activities').single();
  if (!job) throw new AppError(404, 'Import job not found', 'NOT_FOUND');

  const sample = (job.sample_rows ?? []) as Record<string, unknown>[];
  const mapped = sample.map((row) => mapRow(row, mapping));

  // Pre-resolve sample rows so the user sees which rows will / won't
  // attach to a parent before they commit the whole file.
  const warnings: Array<{ row: number; reason: string }> = [];
  for (let i = 0; i < mapped.length; i++) {
    const r = mapped[i];
    const issues = validateRow(r);
    if (issues.length) {
      warnings.push({ row: i, reason: issues.join('; ') });
      continue;
    }
    const resolved = await resolveEntity(org_id, r);
    if (!resolved) {
      warnings.push({ row: i, reason: 'Could not match a lead / contact / deal / account in this org' });
    }
  }

  await supabaseAdmin.from('crm_import_jobs').update({ status: 'previewing', mapping }).eq('id', job_id);
  return { mapped_sample: mapped.slice(0, 25), warnings };
}

export async function commitJob(org_id: string, job_id: string, user_id: string | null = null) {
  const { data: job, error: loadErr } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).eq('id', job_id).eq('kind', 'activities').single();
  if (loadErr || !job) throw new AppError(404, 'Import job not found', 'NOT_FOUND');

  await supabaseAdmin.from('crm_import_jobs').update({ status: 'running' }).eq('id', job_id);

  const mapping = (job.mapping ?? {}) as Record<string, string>;
  const stored = (job.data ?? {}) as { headers?: string[]; rows?: Record<string, unknown>[] };
  const rows = stored.rows ?? [];

  let created = 0;
  let skipped = 0;
  const errors: Array<{ row: number; reason: string }> = [];

  // Cache owner-email → user-id lookups so a 1000-row import doesn't
  // do 1000 individual SELECTs against `users`.
  const ownerCache = new Map<string, string | null>();

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2; // 1-indexed past the header row
    const r = mapRow(rows[i], mapping);

    const issues = validateRow(r);
    if (issues.length) {
      errors.push({ row: rowNumber, reason: issues.join('; ') });
      continue;
    }

    const resolved = await resolveEntity(org_id, r);
    if (!resolved) {
      errors.push({ row: rowNumber, reason: 'No matching lead / contact / deal / account' });
      continue;
    }

    let owner_id: string | null = null;
    if (r.owner_email) {
      const key = String(r.owner_email).toLowerCase().trim();
      if (ownerCache.has(key)) {
        owner_id = ownerCache.get(key) ?? null;
      } else {
        const { data: u } = await supabaseAdmin.from('users')
          .select('id').eq('org_id', org_id).ilike('email', key).maybeSingle();
        owner_id = (u?.id as string) ?? null;
        ownerCache.set(key, owner_id);
      }
    }

    const status = normaliseStatus(r);
    const payload: Record<string, unknown> = {
      org_id,
      type: r.type,
      subject: r.subject ?? null,
      body: r.body ?? null,
      status,
      due_at: parseDate(r.due_at),
      completed_at: status === 'completed' ? (parseDate(r.completed_at) ?? new Date().toISOString()) : parseDate(r.completed_at),
      owner_id,
      created_by: user_id ?? null,
      [resolved.entity_column]: resolved.entity_id,
    };

    const { error: insErr } = await supabaseAdmin.from('crm_activities').insert(payload);
    if (insErr) {
      errors.push({ row: rowNumber, reason: insErr.message.slice(0, 200) });
      continue;
    }
    created++;
  }

  // Skipped = error rows that didn't insert. Kept separate from `created`
  // for the dashboard summary.
  skipped = errors.length;

  const summary = { total: rows.length, created, skipped, error_count: errors.length };
  const existingErrors = Array.isArray(job.errors) ? job.errors : [];

  const { data: updated, error: updErr } = await supabaseAdmin.from('crm_import_jobs')
    .update({
      status: errors.length > 0 && created === 0 ? 'failed' : 'done',
      processed_rows: rows.length,
      inserted: created,
      skipped,
      errors: [...existingErrors, ...errors.slice(0, 100)],
      summary,
      data: null, // free the JSONB rows blob once we're done
    })
    .eq('org_id', org_id).eq('id', job_id)
    .select('*').single();
  if (updErr) throw new AppError(500, updErr.message, 'DB_ERROR');

  return updated;
}

export async function getJob(org_id: string, job_id: string) {
  const { data, error } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).eq('id', job_id).eq('kind', 'activities').single();
  if (error) throw new AppError(404, 'Import job not found', 'NOT_FOUND');
  return data;
}

export async function listJobs(org_id: string) {
  const { data } = await supabaseAdmin.from('crm_import_jobs').select('*')
    .eq('org_id', org_id).eq('kind', 'activities')
    .order('created_at', { ascending: false }).limit(50);
  return data ?? [];
}

// ── Helpers ────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [src, dest] of Object.entries(mapping)) {
    if (!dest || !CANONICAL_FIELDS.includes(dest)) continue;
    const v = row[src];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s.length === 0) continue;
    out[dest] = s;
  }
  return out;
}

function validateRow(r: Record<string, unknown>): string[] {
  const issues: string[] = [];
  // Type is the one truly mandatory field — without it we can't insert.
  if (!r.type) issues.push('missing type');
  else if (!VALID_TYPES.has(String(r.type).toLowerCase())) {
    issues.push(`invalid type "${r.type}" (allowed: ${[...VALID_TYPES].join(', ')})`);
  } else {
    r.type = String(r.type).toLowerCase();
  }
  // Need at least one entity-resolution hint. Empty rows otherwise
  // silently create orphan activities, which the validator forbids.
  const hasHint = Boolean(
    r.lead_id || r.contact_id || r.deal_id || r.account_id
    || r.lead_email || r.lead_phone || r.contact_email,
  );
  if (!hasHint) {
    issues.push('no parent entity column (need one of: lead_id, lead_email, lead_phone, contact_id, contact_email, deal_id, account_id)');
  }
  if (r.status && !VALID_STATUS.has(String(r.status).toLowerCase())) {
    issues.push(`invalid status "${r.status}" (allowed: ${[...VALID_STATUS].join(', ')})`);
  }
  return issues;
}

function normaliseStatus(r: Record<string, unknown>): string {
  if (r.status) return String(r.status).toLowerCase();
  // Backwards-compat: if completed_at is set, infer 'completed'.
  if (r.completed_at) return 'completed';
  return 'open';
}

function parseDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Resolve a row to the parent entity it should attach to. Returns
 * `{ entity_column, entity_id }` (e.g. `{ entity_column: 'lead_id',
 * entity_id: '...' }`) so the caller can spread it into the insert
 * payload directly. Priority order matches the file-header comment.
 */
async function resolveEntity(
  org_id: string,
  r: Record<string, unknown>,
): Promise<{ entity_column: string; entity_id: string } | null> {
  // 1. Explicit UUID columns — fastest path, no DB read needed for the
  //    happy case (we still verify the ID exists in this org).
  for (const col of ['lead_id', 'contact_id', 'deal_id', 'account_id'] as const) {
    const v = r[col];
    if (typeof v === 'string' && UUID_RE.test(v)) {
      const table = col === 'lead_id' ? 'crm_leads'
                  : col === 'contact_id' ? 'crm_contacts'
                  : col === 'deal_id' ? 'crm_deals'
                  : 'crm_accounts';
      const { data } = await supabaseAdmin.from(table).select('id')
        .eq('org_id', org_id).eq('id', v).is('deleted_at', null).maybeSingle();
      if (data) return { entity_column: col, entity_id: v };
    }
  }
  // 2. lead_phone — strip non-digits + match on the last 10 digits
  //    (handles "+91 99887 66555" / "99887-66555" / "9988766555").
  if (r.lead_phone) {
    const digits = String(r.lead_phone).replace(/\D/g, '');
    const last10 = digits.slice(-10);
    if (last10.length === 10) {
      // ILIKE %last10 catches +91, 0-prefixed, and raw 10-digit storage.
      const { data } = await supabaseAdmin.from('crm_leads').select('id')
        .eq('org_id', org_id).is('deleted_at', null)
        .ilike('phone', `%${last10}`).limit(1).maybeSingle();
      if (data) return { entity_column: 'lead_id', entity_id: data.id as string };
    }
  }
  // 3. lead_email — case-insensitive exact match.
  if (r.lead_email) {
    const email = String(r.lead_email).toLowerCase().trim();
    const { data } = await supabaseAdmin.from('crm_leads').select('id')
      .eq('org_id', org_id).is('deleted_at', null)
      .ilike('email', email).limit(1).maybeSingle();
    if (data) return { entity_column: 'lead_id', entity_id: data.id as string };
  }
  // 4. contact_email — same path on crm_contacts.
  if (r.contact_email) {
    const email = String(r.contact_email).toLowerCase().trim();
    const { data } = await supabaseAdmin.from('crm_contacts').select('id')
      .eq('org_id', org_id).is('deleted_at', null)
      .ilike('email', email).limit(1).maybeSingle();
    if (data) return { entity_column: 'contact_id', entity_id: data.id as string };
  }
  return null;
}
