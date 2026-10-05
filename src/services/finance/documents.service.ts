import crypto from 'crypto';
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { sendEmail } from '../crm/emails.service';
import { FinanceScope, scoped } from './scope';
import { computeDocument, LineInput, round2, num } from './money';
import { getSettings, getCustomer, pageParams, safeSearch } from './masters.service';
import { publicDocUrl } from './share';
import { renderDocumentPdf } from './pdf.service';

const db = () => supabaseAdmin;
const fail = (e: { message: string }) => new AppError(500, e.message, 'DB_ERROR');
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export type DocType = 'invoice' | 'quote';

export interface DocumentInput {
  customer_id: string;
  reference_number?: string | null;
  subject?: string | null;
  issue_date?: string;
  due_date?: string | null;
  expiry_date?: string | null;
  payment_terms_days?: number;
  place_of_supply?: string | null;
  bill_to?: Record<string, unknown>;
  ship_to?: Record<string, unknown>;
  items: LineInput[];
  adjustment?: number;
  adjustment_label?: string | null;
  notes?: string | null;
  terms?: string | null;
}

// Overdue / expired are derived from dates, never stored, so they can't go stale.
export function displayStatus(d: { doc_type: string; status: string; due_date?: string | null; expiry_date?: string | null; balance?: number | string }): string {
  const t = today();
  if (d.doc_type === 'invoice' && (d.status === 'sent' || d.status === 'partially_paid')
      && d.due_date && String(d.due_date) < t && Number(d.balance) > 0) return 'overdue';
  if (d.doc_type === 'quote' && d.status === 'sent' && d.expiry_date && String(d.expiry_date) < t) return 'expired';
  return d.status;
}

export async function addEvent(s: FinanceScope, documentId: string, event: string, detail: Record<string, unknown> = {}) {
  const { error } = await db().from('finance_document_events').insert({
    org_id: s.org_id, document_id: documentId, event, detail, actor: s.actor || null,
  });
  if (error) throw fail(error);
}

async function nextNumber(s: FinanceScope, kind: 'invoice' | 'quote' | 'payment'): Promise<string> {
  const { data, error } = await db().rpc('finance_next_number', { p_org: s.org_id, p_client: s.client_id, p_kind: kind });
  if (error || !data) throw new AppError(500, error?.message ?? 'Could not allocate a number', 'NUMBERING');
  return String(data);
}
export { nextNumber };

const isDuplicate = (e: { code?: string; message: string } | null) => !!e && (e.code === '23505' || /duplicate key/i.test(e.message));

/**
 * Allocate a number and insert with it. If the counter was moved onto a number that is already
 * taken (settings edited by hand), the unique index rejects the insert — skip ahead rather than fail.
 */
export async function insertNumbered<T>(
  s: FinanceScope, kind: 'invoice' | 'quote' | 'payment',
  insert: (number: string) => PromiseLike<{ data: T | null; error: { code?: string; message: string } | null }>,
): Promise<{ data: T; number: string }> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const number = await nextNumber(s, kind);
    const r = await insert(number);
    if (!r.error && r.data) return { data: r.data, number };
    if (!isDuplicate(r.error)) throw fail(r.error ?? { message: 'insert failed' });
  }
  throw new AppError(409, 'Could not find an unused number — check the numbering settings', 'NUMBERING');
}

async function loadRow(s: FinanceScope, id: string, docType?: DocType) {
  let q = scoped(db().from('finance_documents').select('*'), s).eq('id', id).is('deleted_at', null);
  if (docType) q = q.eq('doc_type', docType);
  const { data, error } = await q.maybeSingle();
  if (error) throw fail(error);
  if (!data) throw new AppError(404, `${docType === 'quote' ? 'Quote' : 'Invoice'} not found`, 'NOT_FOUND');
  return data;
}

async function loadItems(documentId: string) {
  const { data, error } = await db().from('finance_document_items').select('*').eq('document_id', documentId).order('position');
  if (error) throw fail(error);
  return data ?? [];
}

// ── build ───────────────────────────────────────────────────────────────────
async function prepare(s: FinanceScope, input: DocumentInput, customerLocked?: string) {
  const settings = await getSettings(s);
  const customer = await getCustomer(s, customerLocked ?? input.customer_id);

  // Tax-exempt items always price at 0% GST regardless of what the client sent.
  const itemIds = Array.from(new Set(input.items.map((i) => i.item_id).filter(Boolean))) as string[];
  const exempt = new Set<string>();
  if (itemIds.length) {
    const r = await scoped(db().from('finance_items').select('id,tax_preference'), s).in('id', itemIds);
    if (r.error) throw fail(r.error);
    for (const it of r.data ?? []) if (it.tax_preference === 'exempt') exempt.add(it.id as string);
  }
  const lines = input.items.map((l) => (l.item_id && exempt.has(l.item_id) ? { ...l, gst_rate: 0 } : l));

  const placeOfSupply = input.place_of_supply ?? customer.place_of_supply ?? settings.state_code ?? null;
  const calc = computeDocument(lines, {
    sellerStateCode: settings.state_code,
    placeOfSupply,
    adjustment: input.adjustment,
    taxExempt: customer.tax_preference === 'exempt',
  });
  return { settings, customer, placeOfSupply, calc };
}

function headerFields(
  input: DocumentInput, docType: DocType, p: Awaited<ReturnType<typeof prepare>>,
) {
  const issue = input.issue_date || today();
  const terms = input.payment_terms_days ?? p.customer.payment_terms_days ?? p.settings.default_payment_terms_days ?? 0;
  const c = p.customer;
  return {
    reference_number: input.reference_number ?? null,
    subject: input.subject ?? null,
    customer_id: c.id,
    customer_snapshot: {
      name: c.display_name, company_name: c.company_name, email: c.email, phone: c.mobile || c.work_phone,
      gstin: c.gstin, gst_treatment: c.gst_treatment, pan: c.pan,
    },
    bill_to: input.bill_to ?? c.billing_address ?? {},
    ship_to: input.ship_to ?? c.shipping_address ?? {},
    issue_date: issue,
    payment_terms_days: terms,
    due_date: docType === 'invoice' ? (input.due_date || addDays(issue, terms)) : null,
    expiry_date: docType === 'quote' ? (input.expiry_date || addDays(issue, 30)) : null,
    place_of_supply: p.placeOfSupply,
    seller_state_code: p.settings.state_code ?? null,
    ...p.calc.totals,
    adjustment_label: input.adjustment_label ?? null,
    // Only a MISSING field takes the default; an explicitly cleared one (null) stays empty.
    notes: input.notes !== undefined ? input.notes : p.settings.default_notes ?? null,
    terms: input.terms !== undefined ? input.terms : p.settings.default_terms ?? null,
  };
}

function itemRows(documentId: string, orgId: string, calc: ReturnType<typeof computeDocument>) {
  return calc.lines.map((l, i) => ({
    document_id: documentId, org_id: orgId, position: i, item_id: l.item_id, name: l.name, description: l.description,
    hsn_sac: l.hsn_sac, quantity: l.quantity, unit: l.unit, rate: l.rate, discount_pct: l.discount_pct,
    gst_rate: l.gst_rate, taxable_value: l.taxable_value, cgst: l.cgst, sgst: l.sgst, igst: l.igst, total: l.total,
    // Only sent when set, so documents without a duration still save on a database that predates the column.
    ...(l.duration_months ? { duration_months: l.duration_months } : {}),
  }));
}

export async function createDocument(
  s: FinanceScope, docType: DocType, input: DocumentInput, extra: Record<string, unknown> = {}, opts: { number?: string } = {},
) {
  const p = await prepare(s, input);
  const base = {
    org_id: s.org_id, client_id: s.client_id, doc_type: docType, status: 'draft',
    ...headerFields(input, docType, p),
    amount_paid: 0,
    balance: docType === 'invoice' ? p.calc.totals.total : 0,
    share_token: crypto.randomBytes(24).toString('base64url'),
    created_by: s.user_id || null,
    ...extra,
  };
  let data: Record<string, unknown>;
  let number: string;
  if (opts.number) {
    // Historical document keeping its original number (import). A clash is the caller's problem to report.
    number = opts.number;
    const r = await db().from('finance_documents').insert({ ...base, number }).select('*').single();
    if (r.error) {
      if (isDuplicate(r.error)) throw new AppError(409, `${number} already exists`, 'DUPLICATE_NUMBER');
      throw fail(r.error);
    }
    data = r.data as Record<string, unknown>;
  } else {
    const r = await insertNumbered(s, docType, (n) =>
      db().from('finance_documents').insert({ ...base, number: n }).select('*').single());
    data = r.data as Record<string, unknown>;
    number = r.number;
  }

  const ins = await db().from('finance_document_items').insert(itemRows(data.id as string, s.org_id, p.calc));
  if (ins.error) {
    await db().from('finance_documents').delete().eq('id', data.id);
    throw fail(ins.error);
  }
  await addEvent(s, data.id as string, 'created', { number });
  return getDocument(s, data.id as string, docType);
}

export async function updateDocument(s: FinanceScope, docType: DocType, id: string, input: DocumentInput) {
  const cur = await loadRow(s, id, docType);
  if (cur.status === 'void') throw new AppError(409, 'A voided invoice cannot be edited', 'VOID');
  if (cur.status === 'invoiced') throw new AppError(409, 'This quote was already converted to an invoice', 'INVOICED');
  const hasPayments = Number(cur.amount_paid) > 0;
  if (hasPayments && input.customer_id !== cur.customer_id) {
    throw new AppError(409, 'Cannot change the customer of an invoice that has payments', 'HAS_PAYMENTS');
  }

  const p = await prepare(s, input);
  const total = p.calc.totals.total;
  if (docType === 'invoice' && total < Number(cur.amount_paid)) {
    throw new AppError(409, `Total cannot be lower than the amount already paid (${Number(cur.amount_paid).toFixed(2)})`, 'BELOW_PAID');
  }

  const header = headerFields(input, docType, p);
  const paid = Number(cur.amount_paid);
  const balance = docType === 'invoice' ? round2(total - paid) : 0;
  let status = cur.status as string;
  if (docType === 'invoice' && status !== 'draft') status = balance <= 0 ? 'paid' : paid > 0 ? 'partially_paid' : 'sent';

  const oldItems = await loadItems(id);
  const del = await db().from('finance_document_items').delete().eq('document_id', id);
  if (del.error) throw fail(del.error);
  const ins = await db().from('finance_document_items').insert(itemRows(id, s.org_id, p.calc));
  if (ins.error) {
    if (oldItems.length) await db().from('finance_document_items').insert(oldItems);
    throw fail(ins.error);
  }

  const { error } = await scoped(db().from('finance_documents').update({
    ...header, balance, status, updated_by: s.user_id || null, updated_at: new Date().toISOString(),
  }), s).eq('id', id);
  if (error) throw fail(error);
  await addEvent(s, id, 'updated');
  return getDocument(s, id, docType);
}

// ── read ────────────────────────────────────────────────────────────────────
export async function getDocument(s: FinanceScope, id: string, docType?: DocType) {
  const doc = await loadRow(s, id, docType);
  const [items, events, pays] = await Promise.all([
    loadItems(id),
    db().from('finance_document_events').select('*').eq('document_id', id).order('created_at', { ascending: false }).limit(100),
    db().from('finance_payment_allocations')
      .select('id, amount, payment:finance_payments(id, payment_number, payment_date, mode, reference, deleted_at)')
      .eq('document_id', id),
  ]);
  if (events.error) throw fail(events.error);
  if (pays.error) throw fail(pays.error);
  const payments = (pays.data ?? [])
    .filter((a) => { const pm = (a as { payment?: { deleted_at?: string | null } }).payment; return pm && !pm.deleted_at; })
    .map((a) => ({ allocation_id: a.id, amount: a.amount, ...((a as unknown as { payment: object }).payment) }));
  return { ...doc, display_status: displayStatus(doc), items, events: events.data ?? [], payments };
}

const SORTS = new Set(['issue_date', 'number', 'total', 'balance', 'due_date', 'created_at']);

export async function listDocuments(s: FinanceScope, docType: DocType, query: Record<string, unknown>) {
  const { page, limit, from, to } = pageParams(query);
  let q = scoped(db().from('finance_documents').select(
    'id,number,reference_number,doc_type,status,customer_id,customer_snapshot,issue_date,due_date,expiry_date,total,amount_paid,balance,sent_at,created_at',
    { count: 'exact' }), s).eq('doc_type', docType).is('deleted_at', null);

  const status = String(query.status ?? '');
  if (status === 'overdue') {
    q = q.in('status', ['sent', 'partially_paid']).lt('due_date', today()).gt('balance', 0);
  } else if (status === 'unpaid') {
    q = q.in('status', ['sent', 'partially_paid']).gt('balance', 0);
  } else if (status === 'expired') {
    q = q.eq('status', 'sent').lt('expiry_date', today());
  } else if (status && status !== 'all') {
    q = q.eq('status', status);
  }
  if (query.customer_id) q = q.eq('customer_id', String(query.customer_id));
  if (query.from) q = q.gte('issue_date', String(query.from));
  if (query.to) q = q.lte('issue_date', String(query.to));
  const term = safeSearch(query.q);
  if (term) q = q.or(`number.ilike.%${term}%,reference_number.ilike.%${term}%,customer_snapshot->>name.ilike.%${term}%`);

  const sort = SORTS.has(String(query.sort)) ? String(query.sort) : 'issue_date';
  const asc = String(query.order).toLowerCase() === 'asc';
  const { data, error, count } = await q.order(sort, { ascending: asc }).order('created_at', { ascending: false }).range(from, to);
  if (error) throw fail(error);
  return {
    rows: (data ?? []).map((d) => ({ ...d, display_status: displayStatus(d) })),
    total: count ?? 0, page, limit,
  };
}

// ── lifecycle ───────────────────────────────────────────────────────────────
export async function deleteDocument(s: FinanceScope, docType: DocType, id: string) {
  const cur = await loadRow(s, id, docType);
  if (docType === 'invoice' && Number(cur.amount_paid) > 0) {
    throw new AppError(409, 'Delete the payments recorded against this invoice first', 'HAS_PAYMENTS');
  }
  if (docType === 'invoice' && !['draft', 'void'].includes(cur.status as string)) {
    throw new AppError(409, 'Void a sent invoice before deleting it', 'NOT_DELETABLE');
  }
  const { error } = await scoped(db().from('finance_documents').update({ deleted_at: new Date().toISOString() }), s).eq('id', id);
  if (error) throw fail(error);
  return { id };
}

export async function markSent(s: FinanceScope, docType: DocType, id: string) {
  const cur = await loadRow(s, id, docType);
  if (cur.status !== 'draft') throw new AppError(409, 'Only drafts can be marked as sent', 'NOT_DRAFT');
  const { error } = await scoped(db().from('finance_documents').update({ status: 'sent', sent_at: new Date().toISOString() }), s).eq('id', id);
  if (error) throw fail(error);
  await addEvent(s, id, 'marked_sent');
  return getDocument(s, id, docType);
}

export async function voidInvoice(s: FinanceScope, id: string) {
  const cur = await loadRow(s, id, 'invoice');
  if (cur.status === 'void') return getDocument(s, id, 'invoice');
  if (Number(cur.amount_paid) > 0) throw new AppError(409, 'Delete the payments recorded against this invoice before voiding it', 'HAS_PAYMENTS');
  const { error } = await scoped(db().from('finance_documents').update({
    status: 'void', balance: 0, voided_at: new Date().toISOString(),
  }), s).eq('id', id);
  if (error) throw fail(error);
  await addEvent(s, id, 'voided');
  return getDocument(s, id, 'invoice');
}

export async function setQuoteStatus(s: FinanceScope, id: string, status: 'accepted' | 'declined') {
  const cur = await loadRow(s, id, 'quote');
  if (cur.status === 'invoiced') throw new AppError(409, 'This quote was already converted to an invoice', 'INVOICED');
  if (cur.status === 'draft') throw new AppError(409, 'Send the quote before recording a response', 'NOT_SENT');
  const { error } = await scoped(db().from('finance_documents').update({ status }), s).eq('id', id);
  if (error) throw fail(error);
  await addEvent(s, id, status);
  return getDocument(s, id, 'quote');
}

function inputFromDocument(doc: Awaited<ReturnType<typeof getDocument>>): DocumentInput {
  return {
    customer_id: doc.customer_id as string,
    reference_number: doc.reference_number, subject: doc.subject,
    place_of_supply: doc.place_of_supply, bill_to: doc.bill_to, ship_to: doc.ship_to,
    adjustment: Number(doc.adjustment), adjustment_label: doc.adjustment_label,
    notes: doc.notes, terms: doc.terms,
    items: doc.items.map((i: Record<string, unknown>) => ({
      item_id: (i.item_id as string) ?? null, name: String(i.name), description: (i.description as string) ?? null,
      hsn_sac: (i.hsn_sac as string) ?? null, quantity: num(i.quantity), unit: (i.unit as string) ?? null,
      rate: num(i.rate), discount_pct: num(i.discount_pct), gst_rate: num(i.gst_rate),
      duration_months: (i.duration_months as number | null) ?? null,
    })),
  };
}

export async function cloneDocument(s: FinanceScope, docType: DocType, id: string) {
  const src = await getDocument(s, id, docType);
  return createDocument(s, docType, inputFromDocument(src)); // fresh dates, number, draft status
}

export async function convertQuoteToInvoice(s: FinanceScope, id: string) {
  const quote = await getDocument(s, id, 'quote');
  if (quote.status === 'invoiced') throw new AppError(409, 'This quote was already converted to an invoice', 'INVOICED');
  if (quote.status === 'declined') throw new AppError(409, 'A declined quote cannot be converted', 'DECLINED');
  const invoice = await createDocument(s, 'invoice', inputFromDocument(quote), { source_quote_id: id });
  const { error } = await scoped(db().from('finance_documents').update({
    status: 'invoiced', converted_invoice_id: invoice.id,
  }), s).eq('id', id);
  if (error) throw fail(error);
  await addEvent(s, id, 'converted', { invoice_id: invoice.id, invoice_number: invoice.number });
  return invoice;
}

// ── email ───────────────────────────────────────────────────────────────────
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const inr = (n: unknown) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function fill(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => vars[k] ?? '');
}

export interface SendInput { to?: string; cc?: string[]; subject?: string; message?: string; attach_pdf?: boolean }

export async function sendDocument(s: FinanceScope, docType: DocType, id: string, input: SendInput) {
  const doc = await getDocument(s, id, docType);
  if (doc.status === 'void') throw new AppError(409, 'A voided invoice cannot be sent', 'VOID');
  if (doc.status === 'invoiced') throw new AppError(409, 'This quote was already converted to an invoice', 'INVOICED');
  const settings = await getSettings(s);
  const to = (input.to || (doc.customer_snapshot as { email?: string })?.email || '').trim();
  if (!to) throw new AppError(400, 'The customer has no email address — enter a recipient', 'NO_RECIPIENT');

  const label = docType === 'invoice' ? 'Invoice' : 'Quote';
  const link = publicDocUrl(doc.share_token as string);
  const business = settings.business_name || 'Kinematic';
  const customerName = (doc.customer_snapshot as { name?: string })?.name || 'there';
  const vars: Record<string, string> = {
    customer_name: customerName, number: doc.number, total: inr(doc.balance > 0 ? doc.balance : doc.total),
    due_date: doc.due_date ?? '', business_name: business, link,
  };
  const subject = input.subject || fill(settings.email_subject_template || `${label} {{number}} from {{business_name}}`, vars);
  const intro = input.message
    || fill(settings.email_body_template || `Dear {{customer_name}},\n\nThank you for your business. Please find your ${label.toLowerCase()} {{number}} attached.`, vars);

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
  <p style="white-space:pre-line;line-height:1.5">${esc(intro)}</p>
  <table style="width:100%;border:1px solid #e3e3e3;border-radius:8px;margin:16px 0;border-collapse:collapse">
    <tr><td style="padding:10px 14px;color:#666">${label} #</td><td style="padding:10px 14px;text-align:right"><b>${esc(doc.number)}</b></td></tr>
    <tr><td style="padding:10px 14px;color:#666;border-top:1px solid #eee">${docType === 'invoice' ? 'Amount due' : 'Total'}</td>
        <td style="padding:10px 14px;text-align:right;border-top:1px solid #eee"><b>${inr(docType === 'invoice' ? doc.balance : doc.total)}</b></td></tr>
    ${docType === 'invoice' && doc.due_date ? `<tr><td style="padding:10px 14px;color:#666;border-top:1px solid #eee">Due date</td><td style="padding:10px 14px;text-align:right;border-top:1px solid #eee">${esc(doc.due_date)}</td></tr>` : ''}
  </table>
  <p style="text-align:center;margin:24px 0"><a href="${esc(link)}" style="background:#E01E2C;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold">View ${label.toLowerCase()}</a></p>
  <p style="color:#888;font-size:12px">Regards,<br>${esc(business)}</p></div>`;

  const attachments = input.attach_pdf === false ? undefined : [{
    filename: `${doc.number}.pdf`,
    content: (await renderDocumentPdf({ doc, items: doc.items, settings, payments: doc.payments })).toString('base64'),
    content_type: 'application/pdf',
  }];

  const result = await sendEmail({
    org_id: s.org_id, user_id: s.user_id || undefined, to, cc: input.cc, subject,
    body_html: html, attachments,
    from_email: process.env.FINANCE_FROM_EMAIL || undefined,
  }) as { suppressed?: string; status?: string; error?: string | null };

  if (result.suppressed) throw new AppError(422, `Not sent: this address is suppressed (${result.suppressed})`, 'SUPPRESSED');
  if (result.status === 'failed') throw new AppError(502, `Email provider rejected the message: ${result.error ?? 'unknown error'}`, 'EMAIL_FAILED');

  const patch: Record<string, unknown> = { sent_at: new Date().toISOString(), last_sent_to: to };
  if (doc.status === 'draft') patch.status = 'sent';
  const { error } = await scoped(db().from('finance_documents').update(patch), s).eq('id', id);
  if (error) throw fail(error);
  await addEvent(s, id, 'emailed', { to, cc: input.cc ?? [] });

  const provider = (process.env.EMAIL_PROVIDER || 'stub').toLowerCase();
  return { document: await getDocument(s, id, docType), delivery: { to, provider, live: provider !== 'stub' }, link };
}

export async function documentPdf(s: FinanceScope, docType: DocType, id: string) {
  const doc = await getDocument(s, id, docType);
  const settings = await getSettings(s);
  return { number: doc.number as string, pdf: await renderDocumentPdf({ doc, items: doc.items, settings, payments: doc.payments }) };
}

export async function shareLink(s: FinanceScope, docType: DocType, id: string) {
  const doc = await loadRow(s, id, docType);
  return { url: publicDocUrl(doc.share_token as string), token: doc.share_token };
}

// ── public (no login) ───────────────────────────────────────────────────────
async function publicLoad(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new AppError(404, 'Link not found', 'NOT_FOUND');
  const { data, error } = await db().from('finance_documents').select('*').eq('share_token', token).is('deleted_at', null).maybeSingle();
  if (error) throw fail(error);
  if (!data || data.status === 'draft') throw new AppError(404, 'Link not found', 'NOT_FOUND');
  const s: FinanceScope = { org_id: data.org_id as string, client_id: (data.client_id as string) ?? null, user_id: '', actor: 'customer' };
  return { row: data, s };
}

export async function publicDocument(token: string) {
  const { row, s } = await publicLoad(token);
  const [items, settings] = await Promise.all([loadItems(row.id as string), getSettings(s)]);
  if (!row.viewed_at) {
    await db().from('finance_documents').update({ viewed_at: new Date().toISOString() }).eq('id', row.id);
    await addEvent(s, row.id as string, 'viewed');
  }
  const { share_token: _t, created_by: _c, updated_by: _u, org_id: _o, client_id: _cl, ...doc } = row as Record<string, unknown>;
  return { document: { ...doc, display_status: displayStatus(row) }, items, settings: publicSettings(settings) };
}

export async function publicPdf(token: string) {
  const { row, s } = await publicLoad(token);
  const [items, settings] = await Promise.all([loadItems(row.id as string), getSettings(s)]);
  return { number: row.number as string, pdf: await renderDocumentPdf({ doc: row, items, settings, payments: [] }) };
}

/** Seller details safe to show a customer (no counters, templates or internal fields). */
export function publicSettings(st: Record<string, unknown>) {
  const keys = ['business_name', 'email', 'phone', 'website', 'address_line1', 'address_line2', 'city', 'state', 'state_code',
    'pincode', 'country', 'gstin', 'pan', 'logo_url', 'currency', 'bank_details', 'template'];
  return Object.fromEntries(keys.map((k) => [k, st[k]]));
}
