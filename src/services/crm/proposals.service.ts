/**
 * Proposal / quote generation for CRM leads.
 *
 * A rep selects the products a lead is interested in (name, qty, price); we
 * generate an AI-tailored, org-branded PDF proposal, store it in Supabase
 * Storage, and let it be shared by WhatsApp (as a document), email, or
 * downloaded / saved on the phone via a signed URL.
 *
 * Tenant-agnostic: everything is org_id + client_id scoped. The AI cover note
 * uses the per-org Anthropic key + domain context when configured (see
 * orgAiContext), so a tenant's usage bills to its own key.
 */
import PDFDocument from 'pdfkit';
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { AIService } from '../ai.service';
import { getOrgAnthropicKey, getKiniDomainContext } from './ai/orgAiContext';
import { sendWhatsapp } from './whatsapp.service';

const BUCKET = process.env.SUPABASE_PROPOSAL_BUCKET || 'proposals';
const SIGNED_TTL = 7 * 24 * 60 * 60; // 7 days — long enough for a WhatsApp/email recipient

export interface Actor { id: string; org_id: string; client_id?: string | null; role?: string | null }

export interface ProposalItemInput {
  product_id?: string | null;
  name: string;
  description?: string | null;
  sku?: string | null;
  unit?: string | null;
  unit_price: number;
  quantity: number;
  discount_pct?: number;
  tax_rate_pct?: number;
}

export interface CreateProposalInput {
  lead_id: string;
  title?: string;
  items: ProposalItemInput[];
  terms?: string;
  valid_until?: string | null;
}

const money = (n: number) =>
  'INR ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Computed { subtotal: number; discount_total: number; tax_total: number; grand_total: number; rows: Array<ProposalItemInput & { net: number; tax: number; gross: number }>; }

function compute(items: ProposalItemInput[]): Computed {
  let subtotal = 0, discount_total = 0, tax_total = 0, grand_total = 0;
  const rows = items.map((it) => {
    const base = Number(it.unit_price || 0) * Number(it.quantity || 0);
    const disc = base * (Number(it.discount_pct || 0) / 100);
    const net = base - disc;
    const tax = net * (Number(it.tax_rate_pct ?? 18) / 100);
    const gross = net + tax;
    subtotal += base; discount_total += disc; tax_total += tax; grand_total += gross;
    return { ...it, net, tax, gross };
  });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { subtotal: r2(subtotal), discount_total: r2(discount_total), tax_total: r2(tax_total), grand_total: r2(grand_total), rows };
}

/** Short, professional AI cover note tailored to the lead + products. Falls back
 *  to a neutral templated note if the AI path is unavailable. */
async function coverNote(orgName: string, lead: any, items: ProposalItemInput[], orgId: string): Promise<string> {
  const productList = items.map((i) => `- ${i.name} x${i.quantity}`).join('\n');
  const domain = await getKiniDomainContext(orgId);
  const system = `You are a professional B2B proposal writer for ${orgName}. Write in first person plural, courteous and concise. No markdown, no headings, no subject line, no signature.${domain ? `\n\nCompany and product context:\n${domain}` : ''}`;
  const user = `Write a 120-160 word cover note for a sales proposal to ${lead?.first_name ?? ''} ${lead?.last_name ?? ''}${lead?.company ? ` at ${lead.company}` : ''}${lead?.city ? `, ${lead.city}` : ''}. Products proposed:\n${productList}\nEmphasise business value and outcomes for the customer, not just specifications, and end with a courteous call to action.`;
  try {
    const apiKey = (await getOrgAnthropicKey(orgId)) || undefined;
    const text = await AIService.callKiniAI({ system, messages: [{ role: 'user', content: user }], max_tokens: 500, apiKey });
    if (text && text.trim()) return text.trim();
  } catch (e: any) {
    logger.warn(`[proposals] cover-note AI failed, using fallback: ${e?.message || e}`);
  }
  const who = lead?.first_name ? ` ${lead.first_name}` : '';
  return `Dear${who},\n\nThank you for your interest in ${orgName}. Based on our discussion, we are pleased to share the following proposal covering the products best suited to your requirements. Our solutions are designed to improve productivity, reliability and total cost of ownership, backed by our nationwide service and support. We would be glad to arrange a demonstration and answer any questions. We look forward to partnering with you.`;
}

function buildPdf(opts: {
  orgName: string; org: any; lead: any; proposalNumber: string; title: string;
  cover: string; terms: string; validUntil: string | null; c: Computed; currency: string;
}): Promise<Buffer> {
  const { orgName, org, lead, proposalNumber, title, cover, terms, validUntil, c } = opts;
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (d: Buffer) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const ACCENT = '#0a3d91';   // professional blue
  const INK = '#1a1a1a';
  const MUTE = '#6b7280';
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // Header band
  doc.rect(0, 0, doc.page.width, 96).fill(ACCENT);
  doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text(orgName, left, 30);
  doc.fontSize(10).font('Helvetica').fillColor('#dbe4f5')
    .text([org?.address, [org?.city, org?.state].filter(Boolean).join(', '), org?.country].filter(Boolean).join('  |  '), left, 60, { width: width * 0.7 });
  doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold').text('PROPOSAL', right - 160, 34, { width: 160, align: 'right' });
  doc.fontSize(9).font('Helvetica').fillColor('#dbe4f5')
    .text(`No: ${proposalNumber}`, right - 160, 58, { width: 160, align: 'right' })
    .text(`Date: ${new Date().toLocaleDateString('en-IN')}`, right - 160, 70, { width: 160, align: 'right' });

  doc.fillColor(INK);
  let y = 120;

  // Prepared for
  doc.fontSize(9).font('Helvetica-Bold').fillColor(MUTE).text('PREPARED FOR', left, y);
  y += 14;
  const leadName = [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || lead?.company || 'Customer';
  doc.fontSize(12).font('Helvetica-Bold').fillColor(INK).text(leadName, left, y);
  y += 16;
  const sub = [lead?.company, lead?.title, [lead?.city, lead?.state].filter(Boolean).join(', ')].filter(Boolean).join('  |  ');
  if (sub) { doc.fontSize(9.5).font('Helvetica').fillColor(MUTE).text(sub, left, y); y += 14; }
  if (validUntil) { doc.fontSize(9).fillColor(MUTE).text(`Valid until: ${new Date(validUntil).toLocaleDateString('en-IN')}`, left, y); y += 14; }
  y += 6;

  if (title) { doc.fontSize(13).font('Helvetica-Bold').fillColor(ACCENT).text(title, left, y); y += 20; }

  // Cover note
  doc.fontSize(10).font('Helvetica').fillColor(INK).text(cover, left, y, { width, align: 'left', lineGap: 2 });
  y = doc.y + 16;

  // Items table
  const cols = { name: left, qty: left + width * 0.52, price: left + width * 0.62, disc: left + width * 0.78, amt: left + width * 0.86 };
  doc.rect(left, y, width, 20).fill('#eef2fb');
  doc.fillColor(ACCENT).fontSize(9).font('Helvetica-Bold');
  doc.text('PRODUCT', cols.name + 4, y + 6, { width: width * 0.5 });
  doc.text('QTY', cols.qty, y + 6, { width: width * 0.08, align: 'right' });
  doc.text('UNIT PRICE', cols.price, y + 6, { width: width * 0.14, align: 'right' });
  doc.text('DISC%', cols.disc, y + 6, { width: width * 0.07, align: 'right' });
  doc.text('AMOUNT', cols.amt, y + 6, { width: width * 0.14 - 4, align: 'right' });
  y += 22;

  doc.font('Helvetica').fillColor(INK).fontSize(9.5);
  for (const r of c.rows) {
    if (y > doc.page.height - 160) { doc.addPage(); y = 60; }
    const nameH = doc.heightOfString(r.name, { width: width * 0.5 });
    doc.font('Helvetica-Bold').fillColor(INK).text(r.name, cols.name + 4, y, { width: width * 0.5 });
    if (r.description) doc.font('Helvetica').fillColor(MUTE).fontSize(8).text(r.description, cols.name + 4, y + nameH, { width: width * 0.5 });
    const rowH = Math.max(nameH + (r.description ? 12 : 0), 14);
    doc.font('Helvetica').fillColor(INK).fontSize(9.5);
    doc.text(String(r.quantity), cols.qty, y, { width: width * 0.08, align: 'right' });
    doc.text(money(Number(r.unit_price)), cols.price, y, { width: width * 0.14, align: 'right' });
    doc.text(String(r.discount_pct || 0), cols.disc, y, { width: width * 0.07, align: 'right' });
    doc.text(money(r.net), cols.amt, y, { width: width * 0.14 - 4, align: 'right' });
    y += rowH + 8;
    doc.moveTo(left, y - 4).lineTo(right, y - 4).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
  }

  // Totals
  y += 6;
  const tX = left + width * 0.62;
  const tW = width * 0.24;
  const tot = (label: string, val: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5).fillColor(bold ? ACCENT : INK);
    doc.text(label, tX, y, { width: tW * 0.55 });
    doc.text(val, tX + tW * 0.5, y, { width: tW * 0.5 + (width * 0.14 - 4), align: 'right' });
    y += bold ? 18 : 14;
  };
  tot('Subtotal', money(c.subtotal));
  if (c.discount_total) tot('Discount', '- ' + money(c.discount_total));
  tot('Taxable value', money(c.subtotal - c.discount_total));
  tot('GST', money(c.tax_total));
  doc.moveTo(tX, y).lineTo(right, y).strokeColor(ACCENT).lineWidth(1).stroke(); y += 6;
  tot('Grand Total', money(c.grand_total), true);

  // Terms
  y += 16;
  if (y > doc.page.height - 140) { doc.addPage(); y = 60; }
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTE).text('TERMS & CONDITIONS', left, y); y += 14;
  doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(terms, left, y, { width, lineGap: 1.5 });

  // Footer
  doc.fontSize(8).fillColor(MUTE).text(`${orgName} — this proposal is system-generated and valid subject to the terms above.`,
    left, doc.page.height - 60, { width, align: 'center' });

  doc.end();
  return done;
}

const DEFAULT_TERMS = 'Prices are in INR and exclusive of any statutory levies unless stated. Taxes as applicable. Delivery and installation timelines confirmed on order. Payment terms as mutually agreed. This proposal is valid for 30 days from the date of issue.';

/** Create a proposal from selected products, generate the branded PDF, store it,
 *  and return the record plus a signed download URL. */
export async function createProposal(actor: Actor, input: CreateProposalInput) {
  if (!input.lead_id) throw new AppError(400, 'lead_id is required', 'BAD_REQUEST');
  if (!Array.isArray(input.items) || input.items.length === 0) throw new AppError(400, 'At least one product is required', 'NO_ITEMS');

  const { data: lead } = await supabaseAdmin.from('crm_leads')
    .select('id, first_name, last_name, company, title, city, state, email, phone, client_id')
    .eq('id', input.lead_id).eq('org_id', actor.org_id).maybeSingle();
  if (!lead) throw new AppError(404, 'Lead not found', 'NOT_FOUND');

  const { data: org } = await supabaseAdmin.from('organisations')
    .select('name, logo_url, address, city, state, country').eq('id', actor.org_id).maybeSingle();
  const orgName = (org as any)?.name || 'Proposal';

  const c = compute(input.items);
  const proposalNumber = `Q-${new Date().getFullYear()}-${Math.floor(Date.now() / 1000) % 100000}`;
  const title = input.title || 'Product Proposal';
  const terms = input.terms || DEFAULT_TERMS;
  const cover = await coverNote(orgName, lead, input.items, actor.org_id);

  // Persist the proposal + items.
  const { data: proposal, error: pErr } = await supabaseAdmin.from('crm_proposals').insert({
    org_id: actor.org_id, client_id: actor.client_id ?? (lead as any).client_id ?? null, lead_id: input.lead_id,
    proposal_number: proposalNumber, title, status: 'generated', currency: 'INR',
    subtotal: c.subtotal, discount_total: c.discount_total, tax_total: c.tax_total, grand_total: c.grand_total,
    cover_note: cover, terms, valid_until: input.valid_until ?? null, created_by: actor.id,
  }).select('*').single();
  if (pErr) throw new AppError(500, pErr.message, 'DB');

  const itemRows = c.rows.map((r, i) => ({
    proposal_id: proposal.id, product_id: r.product_id ?? null, name: r.name, description: r.description ?? null,
    sku: r.sku ?? null, unit: r.unit ?? null, unit_price: r.unit_price, quantity: r.quantity,
    discount_pct: r.discount_pct ?? 0, tax_rate_pct: r.tax_rate_pct ?? 18, line_total: r.net, position: i,
  }));
  await supabaseAdmin.from('crm_proposal_items').insert(itemRows);

  // Render + upload the PDF.
  const pdf = await buildPdf({ orgName, org, lead, proposalNumber, title, cover, terms, validUntil: input.valid_until ?? null, c, currency: 'INR' });
  const path = `org/${actor.org_id}/proposals/${proposal.id}.pdf`;
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true });
  if (upErr) throw new AppError(500, `PDF upload failed: ${upErr.message}`, 'STORAGE');
  await supabaseAdmin.from('crm_proposals').update({ pdf_path: path, pdf_generated_at: new Date().toISOString() }).eq('id', proposal.id);

  const url = await signedUrl(path);
  return { ...proposal, pdf_path: path, pdf_url: url, items: itemRows };
}

async function signedUrl(path: string): Promise<string | null> {
  const { data } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL);
  return data?.signedUrl ?? null;
}

export async function getProposal(actor: Actor, id: string) {
  const { data, error } = await supabaseAdmin.from('crm_proposals').select('*')
    .eq('id', id).eq('org_id', actor.org_id).is('deleted_at', null).maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB');
  if (!data) throw new AppError(404, 'Proposal not found', 'NOT_FOUND');
  const { data: items } = await supabaseAdmin.from('crm_proposal_items').select('*').eq('proposal_id', id).order('position');
  const url = (data as any).pdf_path ? await signedUrl((data as any).pdf_path) : null;
  return { ...data, items: items ?? [], pdf_url: url };
}

export async function listForLead(actor: Actor, lead_id: string) {
  const { data, error } = await supabaseAdmin.from('crm_proposals')
    .select('id, proposal_number, title, status, grand_total, currency, created_at, pdf_path')
    .eq('org_id', actor.org_id).eq('lead_id', lead_id).is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(50);
  if (error) throw new AppError(500, error.message, 'DB');
  return data ?? [];
}

/** Share a generated proposal by WhatsApp (as a document) or return the link for
 *  email / download. Returns the signed URL so clients can also save-to-phone. */
export async function shareProposal(actor: Actor, id: string, opts: { channel: 'whatsapp' | 'email' | 'link'; to?: string }) {
  const p = await getProposal(actor, id);
  if (!(p as any).pdf_path) throw new AppError(409, 'Proposal PDF not generated yet', 'NO_PDF');
  const url = (p as any).pdf_url as string | null;
  if (!url) throw new AppError(500, 'Could not sign proposal URL', 'STORAGE');

  if (opts.channel === 'whatsapp') {
    const toPhone = opts.to;
    if (!toPhone) throw new AppError(400, 'Recipient phone (to) is required for WhatsApp', 'BAD_REQUEST');
    await sendWhatsapp({
      org_id: actor.org_id, user_id: actor.id, to: toPhone,
      body_text: `Please find your proposal ${(p as any).proposal_number} attached.`,
      media_url: url, media_type: 'document', lead_id: (p as any).lead_id ?? null,
    });
    await supabaseAdmin.from('crm_proposals').update({ status: 'sent' }).eq('id', id);
    return { channel: 'whatsapp', sent: true, pdf_url: url };
  }

  // email / link: return the signed URL (the client opens a mail composer or a
  // download). Marking 'sent' is left to an explicit email-send integration.
  return { channel: opts.channel, sent: false, pdf_url: url };
}
