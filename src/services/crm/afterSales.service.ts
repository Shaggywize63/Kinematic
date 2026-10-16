/**
 * After-Sales Feedback module (Rajkamal Jewellers — telecaller Phase 1).
 *
 * Admin enters, or bulk-uploads (CSV / Excel), after-sales customer records.
 * Each record becomes a `crm_leads` row tagged `custom_fields.campaign =
 * 'After-Sales'` and AUTO-ASSIGNED to the client's configured telecaller, so it
 * lands directly in that telecaller's "My Calls" queue (owner-scoped). The
 * telecaller then calls the customer and records feedback via the existing
 * Log Call flow.
 *
 * Design: reuse the shared lead pipeline (`leads.service.createLead`) so dedup,
 * scoring, custom-field coercion, client stamping and status validation all
 * apply unchanged. NO new tables — the record IS a lead, and the assignment
 * target lives in `crm_settings.config.after_sales` (client-scoped), read/written
 * exactly like every other per-client opt-in. Everything here is additive and
 * client-gated, so no other tenant's behaviour changes.
 */
import ExcelJS from 'exceljs';
import { parse as csvParse } from 'csv-parse/sync';
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { isTelecaller } from './telecaller.service';
import * as leadsSvc from './leads.service';
import type { Lead } from '../../types/crm.types';

export const AFTER_SALES_CAMPAIGN = 'After-Sales';

// ── Types ────────────────────────────────────────────────────────────────
export interface Telecaller {
  id: string;
  name: string;
  email: string | null;
}

export interface AfterSalesConfig {
  /** The single telecaller all After-Sales records are assigned to. */
  telecaller_id: string | null;
  /** Optional round-robin pool (future: more than one telecaller). When set and
   *  non-empty it takes precedence over `telecaller_id`. */
  round_robin_pool: string[];
}

/** One after-sales customer record as entered by an admin (manual or a CSV/XLSX row). */
export interface AfterSalesRecordInput {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  // Purchase context (stored on the lead's custom_fields).
  product?: string | null;
  purchase_date?: string | null;
  invoice_no?: string | null;
  purchase_amount?: number | string | null;
  // Optional after-sales feedback already known at entry time (same keys the
  // telecaller Log Call sheet uses, so it reads consistently everywhere).
  product_satisfaction?: string | null;
  staff_behaviour?: string | null;
  billing_experience?: string | null;
  after_sales_service?: string | null;
  customer_rating?: string | null;
  complaint?: string | null;
  complaint_priority?: string | null;
  resolution_required?: boolean | string | null;
  next_purchase_interest?: string | null;
  referral_potential?: string | null;
  notes?: string | null;
}

export interface ImportRowError { row: number; phone: string | null; reason: string }
export interface ImportResult {
  total: number;
  created: number;
  skipped: number; // duplicates (already exist)
  failed: number;
  errors: ImportRowError[];
  unassigned: boolean; // true when no telecaller was configured, so records are owner-less
}

// ── Telecaller directory (for the admin assignment picker) ─────────────────
export async function listTelecallers(org_id: string, client_id: string | null): Promise<Telecaller[]> {
  let q = supabaseAdmin.from('users')
    .select('id, name, email, role, org_role:org_roles!org_role_id(name)')
    .eq('org_id', org_id).is('deleted_at', null);
  if (client_id) q = q.eq('client_id', client_id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? [])
    .filter((u: any) => isTelecaller({ role: u.role, org_role_name: u.org_role?.name }))
    .map((u: any) => ({ id: u.id as string, name: (u.name as string) ?? 'Telecaller', email: (u.email as string) ?? null }));
}

// ── Assignment config (crm_settings.config.after_sales, client-scoped) ─────
function normaliseConfig(raw: unknown): AfterSalesConfig {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const pool = Array.isArray(o.round_robin_pool)
    ? (o.round_robin_pool as unknown[]).map(String).filter(Boolean)
    : [];
  const tid = typeof o.telecaller_id === 'string' && o.telecaller_id.trim() ? o.telecaller_id.trim() : null;
  return { telecaller_id: tid, round_robin_pool: pool };
}

/** Read the effective config for this scope: the client's own crm_settings row,
 *  else the org-level default row. Mirrors GET /crm/settings resolution. */
export async function getAfterSalesConfig(org_id: string, client_id: string | null): Promise<AfterSalesConfig> {
  const read = async (cid: string | null) => {
    let q = supabaseAdmin.from('crm_settings').select('config').eq('org_id', org_id);
    q = cid ? q.eq('client_id', cid) : q.is('client_id', null);
    const { data } = await q.limit(1);
    const cfg = (data as Array<{ config?: any }> | null)?.[0]?.config;
    return cfg && typeof cfg === 'object' ? (cfg.after_sales as unknown) : undefined;
  };
  const own = client_id ? await read(client_id) : undefined;
  return normaliseConfig(own ?? (await read(null)));
}

/** Upsert the client's own crm_settings row, merging `after_sales` into config.
 *  Mirrors the PATCH /crm/settings write path. */
export async function setAfterSalesConfig(
  org_id: string,
  client_id: string | null,
  next: Partial<AfterSalesConfig>,
): Promise<AfterSalesConfig> {
  // Validate any named telecaller actually resolves to a telecaller in scope so
  // we never strand records on a non-telecaller owner.
  const valid = new Set((await listTelecallers(org_id, client_id)).map((t) => t.id));
  if (next.telecaller_id && !valid.has(next.telecaller_id)) {
    throw new AppError(400, 'Selected user is not a telecaller in this client', 'NOT_A_TELECALLER');
  }
  const pool = (next.round_robin_pool ?? []).filter((id) => valid.has(id));

  let existingQuery = supabaseAdmin.from('crm_settings').select('id, config').eq('org_id', org_id);
  existingQuery = client_id ? existingQuery.eq('client_id', client_id) : existingQuery.is('client_id', null);
  const { data: existing } = await existingQuery.maybeSingle();
  const prevCfg = (existing?.config && typeof existing.config === 'object') ? existing.config as Record<string, unknown> : {};
  const prevAfter = normaliseConfig((prevCfg as any).after_sales);
  const merged: AfterSalesConfig & { rr_index?: number } = {
    telecaller_id: next.telecaller_id !== undefined ? (next.telecaller_id || null) : prevAfter.telecaller_id,
    round_robin_pool: next.round_robin_pool !== undefined ? pool : prevAfter.round_robin_pool,
  };
  const config = { ...prevCfg, after_sales: merged };
  const update = { org_id, client_id, config };
  if (existing?.id) {
    const { error } = await supabaseAdmin.from('crm_settings').update(update).eq('id', existing.id);
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
  } else {
    const { error } = await supabaseAdmin.from('crm_settings').insert(update);
    if (error) throw new AppError(500, error.message, 'DB_ERROR');
  }
  return normaliseConfig(merged);
}

// ── Owner resolution ───────────────────────────────────────────────────────
/** A stateful owner resolver for a batch: a single telecaller returns that id
 *  every time; a pool rotates round-robin starting from a seed. */
function ownerResolver(cfg: AfterSalesConfig): { next: () => string | null } {
  if (cfg.round_robin_pool.length > 0) {
    let i = 0;
    const pool = cfg.round_robin_pool;
    return { next: () => { const id = pool[i % pool.length]; i += 1; return id; } };
  }
  return { next: () => cfg.telecaller_id };
}

// ── Payload builder ─────────────────────────────────────────────────────────
const CUSTOM_FEEDBACK_KEYS = [
  'product_satisfaction', 'staff_behaviour', 'billing_experience', 'after_sales_service',
  'customer_rating', 'complaint', 'complaint_priority', 'next_purchase_interest', 'referral_potential',
] as const;

function splitName(input: AfterSalesRecordInput): { first_name: string | null; last_name: string | null } {
  const fn = (input.first_name ?? '').trim();
  const ln = (input.last_name ?? '').trim();
  if (fn || ln) return { first_name: fn || null, last_name: ln || null };
  const full = (input.name ?? '').trim();
  if (!full) return { first_name: null, last_name: null };
  const parts = full.split(/\s+/);
  return { first_name: parts[0], last_name: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

function buildLeadPayload(input: AfterSalesRecordInput, client_id: string | null, owner_id: string | null): Partial<Lead> {
  const { first_name, last_name } = splitName(input);
  const cf: Record<string, unknown> = { campaign: AFTER_SALES_CAMPAIGN };
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined) return;
    const s = typeof v === 'string' ? v.trim() : v;
    if (s === '' ) return;
    cf[k] = s;
  };
  put('product', input.product);
  put('purchase_date', input.purchase_date);
  put('invoice_no', input.invoice_no);
  if (input.purchase_amount !== null && input.purchase_amount !== undefined && String(input.purchase_amount).trim() !== '') {
    const n = Number(input.purchase_amount);
    if (!Number.isNaN(n)) cf.purchase_amount = n;
  }
  for (const k of CUSTOM_FEEDBACK_KEYS) put(k, (input as Record<string, unknown>)[k]);
  const rr = input.resolution_required;
  if (rr === true || (typeof rr === 'string' && ['yes', 'true', '1', 'on'].includes(rr.trim().toLowerCase()))) {
    cf.resolution_required = true;
  }
  put('import_notes', input.notes);

  const payload: Partial<Lead> = {
    first_name,
    last_name,
    phone: (input.phone ?? '').trim() || null,
    email: (input.email ?? '').trim() || null,
    city: (input.city ?? '').trim() || null,
    state: (input.state ?? '').trim() || null,
    is_b2c: true,
    client_id,
    custom_fields: cf,
  } as Partial<Lead>;
  if (owner_id) (payload as Record<string, unknown>).owner_id = owner_id;
  return payload;
}

// ── Single (manual) create ──────────────────────────────────────────────────
export async function createRecord(
  org_id: string,
  client_id: string | null,
  user_id: string | undefined,
  input: AfterSalesRecordInput,
): Promise<{ lead: unknown; owner_id: string | null; assigned: boolean }> {
  if (!(input.name ?? input.first_name ?? '').toString().trim() && !(input.last_name ?? '').toString().trim()) {
    throw new AppError(400, 'Customer name is required', 'VALIDATION');
  }
  if (!(input.phone ?? '').toString().trim()) {
    throw new AppError(400, 'Customer phone is required', 'VALIDATION');
  }
  const cfg = await getAfterSalesConfig(org_id, client_id);
  const owner_id = ownerResolver(cfg).next();
  const payload = buildLeadPayload(input, client_id, owner_id);
  // enforceRequired:false — admin data entry may capture partial records a human
  // completes later; dedup stays ON so a manual duplicate is reported (409).
  const lead = await leadsSvc.createLead({ org_id, user_id, payload, enforceRequired: false });
  return { lead, owner_id, assigned: !!owner_id };
}

// ── Bulk import (CSV / Excel) ────────────────────────────────────────────────
const normHeader = (h: string): string => h.toLowerCase().trim().replace(/[\s./-]+/g, '_').replace(/_+/g, '_');

// Maps many human header spellings onto the canonical AfterSalesRecordInput keys.
const HEADER_ALIASES: Record<string, keyof AfterSalesRecordInput> = {
  name: 'name', customer_name: 'name', customer: 'name', full_name: 'name',
  first_name: 'first_name', firstname: 'first_name',
  last_name: 'last_name', lastname: 'last_name', surname: 'last_name',
  phone: 'phone', mobile: 'phone', mobile_no: 'phone', mobile_number: 'phone', phone_no: 'phone',
  phone_number: 'phone', contact: 'phone', contact_no: 'phone', contact_number: 'phone',
  email: 'email', email_id: 'email', mail: 'email',
  city: 'city', town: 'city',
  state: 'state',
  product: 'product', item: 'product', product_name: 'product', item_name: 'product',
  purchase_date: 'purchase_date', invoice_date: 'purchase_date', bill_date: 'purchase_date', date_of_purchase: 'purchase_date',
  invoice_no: 'invoice_no', invoice: 'invoice_no', invoice_number: 'invoice_no', bill_no: 'invoice_no', bill_number: 'invoice_no',
  amount: 'purchase_amount', purchase_amount: 'purchase_amount', bill_amount: 'purchase_amount', value: 'purchase_amount',
  product_satisfaction: 'product_satisfaction',
  staff_behaviour: 'staff_behaviour', staff_behavior: 'staff_behaviour',
  billing_experience: 'billing_experience',
  after_sales_service: 'after_sales_service',
  customer_rating: 'customer_rating', rating: 'customer_rating',
  complaint: 'complaint', complaints: 'complaint',
  complaint_priority: 'complaint_priority', priority: 'complaint_priority',
  resolution_required: 'resolution_required',
  next_purchase_interest: 'next_purchase_interest',
  referral_potential: 'referral_potential',
  notes: 'notes', note: 'notes', remarks: 'notes', remark: 'notes',
};

function rowToInput(row: Record<string, unknown>): AfterSalesRecordInput {
  const out: AfterSalesRecordInput = {};
  for (const [rawKey, rawVal] of Object.entries(row)) {
    const canon = HEADER_ALIASES[normHeader(rawKey)];
    if (!canon) continue;
    const v = rawVal == null ? '' : String(rawVal).trim();
    if (v === '') continue;
    (out as Record<string, unknown>)[canon] = v;
  }
  return out;
}

/** Parse an uploaded CSV / XLSX buffer into an array of header-keyed row objects. */
async function parseRows(buffer: Buffer, filename: string, mimetype: string): Promise<Record<string, unknown>[]> {
  const name = (filename || '').toLowerCase();
  const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls')
    || mimetype.includes('spreadsheet') || mimetype.includes('excel');
  if (isExcel) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const headers: string[] = [];
    const headerRow = ws.getRow(1);
    headerRow.eachCell({ includeEmpty: true }, (cell, col) => { headers[col] = String(cell.value ?? '').trim(); });
    const rows: Record<string, unknown>[] = [];
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      const obj: Record<string, unknown> = {};
      let any = false;
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const h = headers[col];
        if (!h) return;
        let val: unknown = cell.value;
        if (val && typeof val === 'object') {
          const o = val as Record<string, unknown>;
          if ('text' in o) val = o.text;            // rich text / hyperlink
          else if ('result' in o) val = o.result;   // formula
          else if (o instanceof Date) val = (o as Date).toISOString();
        }
        if (val instanceof Date) val = val.toISOString();
        obj[h] = val;
        if (val != null && String(val).trim() !== '') any = true;
      });
      if (any) rows.push(obj);
    }
    return rows;
  }
  // CSV (default). `columns:true` keys each row by its header; bom strips a
  // leading UTF-8 BOM that Excel-exported CSVs carry.
  const text = buffer.toString('utf8');
  return csvParse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, unknown>[];
}

export async function importRecords(
  org_id: string,
  client_id: string | null,
  user_id: string | undefined,
  file: { buffer: Buffer; originalname: string; mimetype: string },
): Promise<ImportResult> {
  const rows = await parseRows(file.buffer, file.originalname, file.mimetype);
  const cfg = await getAfterSalesConfig(org_id, client_id);
  const resolver = ownerResolver(cfg);
  const unassigned = !cfg.telecaller_id && cfg.round_robin_pool.length === 0;

  const result: ImportResult = { total: rows.length, created: 0, skipped: 0, failed: 0, errors: [], unassigned };
  // Process sequentially so round-robin rotation and the duplicate check are
  // deterministic and we don't hammer the DB with a burst of concurrent inserts.
  let i = 0;
  for (const raw of rows) {
    i += 1;
    const input = rowToInput(raw);
    const phone = (input.phone ?? '').toString().trim() || null;
    const hasName = !!(input.name ?? input.first_name ?? input.last_name);
    if (!hasName || !phone) {
      result.failed += 1;
      result.errors.push({ row: i, phone, reason: !phone ? 'Missing phone' : 'Missing name' });
      continue;
    }
    const owner_id = resolver.next();
    const payload = buildLeadPayload(input, client_id, owner_id);
    try {
      await leadsSvc.createLead({ org_id, user_id, payload, enforceRequired: false });
      result.created += 1;
    } catch (e) {
      const err = e as AppError & { code?: string };
      if (err?.code === 'DUPLICATE_LEAD' || (err?.statusCode === 409)) {
        result.skipped += 1;
      } else {
        result.failed += 1;
        result.errors.push({ row: i, phone, reason: err?.message ? String(err.message).slice(0, 200) : 'Create failed' });
      }
    }
    if (result.errors.length >= 200) break; // cap the error payload size
  }
  return result;
}

// ── Admin list of after-sales records ────────────────────────────────────────
export async function listRecords(
  org_id: string,
  client_id: string | null,
  strict: boolean,
  opts: { limit?: number; search?: string } = {},
): Promise<Record<string, unknown>[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  let q = supabaseAdmin.from('crm_leads')
    .select('id, first_name, last_name, phone, email, city, state, status, owner_id, custom_fields, created_at, last_activity_at')
    .eq('org_id', org_id)
    .is('deleted_at', null)
    .eq('custom_fields->>campaign', AFTER_SALES_CAMPAIGN)
    .order('created_at', { ascending: false })
    .limit(limit);
  // Client scope: strict → only this client's rows; otherwise shared + own.
  if (client_id) q = strict ? q.eq('client_id', client_id) : q.or(`client_id.is.null,client_id.eq.${client_id}`);
  else q = q.is('client_id', null);
  const search = (opts.search ?? '').trim();
  if (search) {
    const safe = search.replace(/[%,()]/g, ' ').trim();
    if (safe) q = q.or(`first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,phone.ilike.%${safe}%`);
  }
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []) as Record<string, unknown>[];
}
