import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { FinanceScope, scoped } from './scope';

const db = () => supabaseAdmin;
const fail = (e: { message: string }) => new AppError(500, e.message, 'DB_ERROR');

export function pageParams(q: Record<string, unknown>, defLimit = 25) {
  const page = Math.max(1, parseInt(String(q.page ?? '1'), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(q.limit ?? defLimit), 10) || defLimit));
  return { page, limit, from: (page - 1) * limit, to: (page - 1) * limit + limit - 1 };
}

/** Strip characters that would break out of a PostgREST .or() filter / ilike pattern. */
export function safeSearch(q: unknown): string {
  return String(q ?? '').replace(/[,()%*\\:]/g, ' ').trim().slice(0, 80);
}

function pick<T extends Record<string, unknown>>(src: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

// ── Settings ────────────────────────────────────────────────────────────────
const SETTINGS_FIELDS = [
  'business_name', 'email', 'phone', 'website', 'address_line1', 'address_line2', 'city', 'state', 'state_code',
  'pincode', 'country', 'gstin', 'pan', 'logo_url', 'fiscal_year_start_month', 'invoice_prefix', 'invoice_next_number',
  'quote_prefix', 'quote_next_number', 'payment_prefix', 'payment_next_number', 'number_padding',
  'default_payment_terms_days', 'default_notes', 'default_terms', 'bank_details', 'template',
  'email_subject_template', 'email_body_template',
] as const;

export async function getSettings(s: FinanceScope) {
  const find = () => scoped(db().from('finance_settings').select('*'), s).maybeSingle();
  let { data, error } = await find();
  if (error) throw fail(error);
  if (!data) {
    const ins = await db().from('finance_settings').insert({ org_id: s.org_id, client_id: s.client_id });
    // A concurrent request may have created it first (unique index) — just re-read.
    if (ins.error && !/duplicate key/i.test(ins.error.message)) throw fail(ins.error);
    ({ data, error } = await find());
    if (error || !data) throw fail(error ?? { message: 'settings missing' });
  }
  return data;
}

export async function updateSettings(s: FinanceScope, patch: Record<string, unknown>) {
  await getSettings(s);
  const row = { ...pick(patch, SETTINGS_FIELDS), updated_at: new Date().toISOString() };
  const { data, error } = await scoped(db().from('finance_settings').update(row), s).select('*').single();
  if (error) throw fail(error);
  return data;
}

// ── Customers ───────────────────────────────────────────────────────────────
const CUSTOMER_FIELDS = [
  'customer_type', 'salutation', 'first_name', 'last_name', 'company_name', 'display_name', 'email', 'work_phone',
  'mobile', 'language', 'currency', 'gst_treatment', 'gstin', 'place_of_supply', 'pan', 'tax_preference',
  'payment_terms_days', 'billing_address', 'shipping_address', 'contact_persons', 'remarks', 'portal_enabled', 'is_active',
] as const;

export async function listCustomers(s: FinanceScope, query: Record<string, unknown>) {
  const { page, limit, from, to } = pageParams(query);
  let q = scoped(db().from('finance_customers').select('*', { count: 'exact' }), s).is('deleted_at', null);
  if (query.status === 'active') q = q.eq('is_active', true);
  if (query.status === 'inactive') q = q.eq('is_active', false);
  const term = safeSearch(query.q);
  if (term) q = q.or(`display_name.ilike.%${term}%,company_name.ilike.%${term}%,email.ilike.%${term}%,mobile.ilike.%${term}%,gstin.ilike.%${term}%`);
  const { data, error, count } = await q.order('display_name', { ascending: true }).range(from, to);
  if (error) throw fail(error);
  const rows = data ?? [];

  // Outstanding receivables per customer on this page.
  const ids = rows.map((r) => r.id as string);
  const outstanding = new Map<string, number>();
  if (ids.length) {
    const inv = await scoped(db().from('finance_documents').select('customer_id,balance'), s)
      .eq('doc_type', 'invoice').in('status', ['sent', 'partially_paid']).is('deleted_at', null).in('customer_id', ids);
    if (inv.error) throw fail(inv.error);
    for (const r of inv.data ?? []) {
      outstanding.set(r.customer_id as string, (outstanding.get(r.customer_id as string) ?? 0) + Number(r.balance));
    }
  }
  return {
    rows: rows.map((r) => ({ ...r, outstanding: Math.round((outstanding.get(r.id as string) ?? 0) * 100) / 100 })),
    total: count ?? rows.length, page, limit,
  };
}

export async function getCustomer(s: FinanceScope, id: string) {
  const { data, error } = await scoped(db().from('finance_customers').select('*'), s).eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) throw fail(error);
  if (!data) throw new AppError(404, 'Customer not found', 'NOT_FOUND');
  const inv = await scoped(db().from('finance_documents').select('balance,status,due_date,total'), s)
    .eq('doc_type', 'invoice').eq('customer_id', id).is('deleted_at', null).neq('status', 'draft').neq('status', 'void');
  if (inv.error) throw fail(inv.error);
  const today = new Date().toISOString().slice(0, 10);
  let outstanding = 0, overdue = 0, billed = 0;
  for (const r of inv.data ?? []) {
    billed += Number(r.total);
    outstanding += Number(r.balance);
    if (Number(r.balance) > 0 && r.due_date && String(r.due_date) < today) overdue += Number(r.balance);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { ...data, outstanding: r2(outstanding), overdue: r2(overdue), total_billed: r2(billed) };
}

export async function createCustomer(s: FinanceScope, input: Record<string, unknown>) {
  const row = { ...pick(input, CUSTOMER_FIELDS), org_id: s.org_id, client_id: s.client_id, created_by: s.user_id || null };
  const { data, error } = await db().from('finance_customers').insert(row).select('*').single();
  if (error) throw fail(error);
  return data;
}

export async function updateCustomer(s: FinanceScope, id: string, input: Record<string, unknown>) {
  await getCustomer(s, id);
  const row = { ...pick(input, CUSTOMER_FIELDS), updated_by: s.user_id || null, updated_at: new Date().toISOString() };
  const { data, error } = await scoped(db().from('finance_customers').update(row), s).eq('id', id).select('*').single();
  if (error) throw fail(error);
  return data;
}

export async function deleteCustomer(s: FinanceScope, id: string) {
  await getCustomer(s, id);
  const docs = await scoped(db().from('finance_documents').select('id', { count: 'exact', head: true }), s).eq('customer_id', id).is('deleted_at', null);
  const pays = await scoped(db().from('finance_payments').select('id', { count: 'exact', head: true }), s).eq('customer_id', id).is('deleted_at', null);
  if ((docs.count ?? 0) > 0 || (pays.count ?? 0) > 0) {
    throw new AppError(409, 'This customer has invoices, quotes or payments. Mark them inactive instead of deleting.', 'HAS_TRANSACTIONS');
  }
  const { error } = await scoped(db().from('finance_customers').update({ deleted_at: new Date().toISOString() }), s).eq('id', id);
  if (error) throw fail(error);
  return { id };
}

// ── Items ───────────────────────────────────────────────────────────────────
const ITEM_FIELDS = ['name', 'item_type', 'unit', 'hsn_sac', 'tax_preference', 'gst_rate', 'selling_price', 'description', 'is_active'] as const;

export async function listItems(s: FinanceScope, query: Record<string, unknown>) {
  const { page, limit, from, to } = pageParams(query, 50);
  let q = scoped(db().from('finance_items').select('*', { count: 'exact' }), s).is('deleted_at', null);
  if (query.status === 'active') q = q.eq('is_active', true);
  if (query.status === 'inactive') q = q.eq('is_active', false);
  if (query.item_type === 'goods' || query.item_type === 'service') q = q.eq('item_type', query.item_type);
  const term = safeSearch(query.q);
  if (term) q = q.or(`name.ilike.%${term}%,hsn_sac.ilike.%${term}%,description.ilike.%${term}%`);
  const { data, error, count } = await q.order('name', { ascending: true }).range(from, to);
  if (error) throw fail(error);
  return { rows: data ?? [], total: count ?? 0, page, limit };
}

export async function getItem(s: FinanceScope, id: string) {
  const { data, error } = await scoped(db().from('finance_items').select('*'), s).eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) throw fail(error);
  if (!data) throw new AppError(404, 'Item not found', 'NOT_FOUND');
  return data;
}

export async function createItem(s: FinanceScope, input: Record<string, unknown>) {
  const row = { ...pick(input, ITEM_FIELDS), org_id: s.org_id, client_id: s.client_id, created_by: s.user_id || null };
  const { data, error } = await db().from('finance_items').insert(row).select('*').single();
  if (error) throw fail(error);
  return data;
}

export async function updateItem(s: FinanceScope, id: string, input: Record<string, unknown>) {
  await getItem(s, id);
  const row = { ...pick(input, ITEM_FIELDS), updated_by: s.user_id || null, updated_at: new Date().toISOString() };
  const { data, error } = await scoped(db().from('finance_items').update(row), s).eq('id', id).select('*').single();
  if (error) throw fail(error);
  return data;
}

export async function deleteItem(s: FinanceScope, id: string) {
  await getItem(s, id);
  const { error } = await scoped(db().from('finance_items').update({ deleted_at: new Date().toISOString() }), s).eq('id', id);
  if (error) throw fail(error);
  return { id };
}
