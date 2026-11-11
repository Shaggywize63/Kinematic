/**
 * Receipt → expense-line OCR. Takes a photo of a receipt/bill and returns the
 * structured fields so a rep can add an expense line pre-filled — merchant,
 * date, amount, tax and a best-guess category — instead of typing it in.
 *
 * Mirrors the business-card scan (direct Anthropic /messages with an image
 * block + AIService.getFunctionalKey). Single-shot; a parse/network failure
 * degrades to an all-null result so the scan button never hard-errors — the rep
 * just fills the line by hand.
 */
import { AppError } from '../../utils';
import { AIService } from '../ai.service';
import { logger } from '../../lib/logger';
import { usableScanDate } from './expenseInput';

export type ReceiptCategory = 'travel' | 'food' | 'lodging' | 'fuel' | 'toll' | 'misc';
const CATEGORIES: ReceiptCategory[] = ['travel', 'food', 'lodging', 'fuel', 'toll', 'misc'];
/** Finance (business bills) use a wider set than a field claim: a Google Ads or cloud invoice is not "misc". */
export const FINANCE_CATEGORIES = [
  'rent', 'software', 'professional_fees', 'telecom', 'utilities', 'office', 'marketing', 'equipment',
  'travel', 'lodging', 'fuel', 'toll', 'food', 'entertainment', 'personal', 'misc', 'other',
] as const;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export interface ReceiptFields {
  merchant: string | null;
  txn_date: string | null;      // YYYY-MM-DD
  amount: number | null;        // grand total
  currency: string | null;      // ISO code e.g. INR
  tax_amount: number | null;    // GST/tax portion if shown
  category: string | null;      // a ReceiptCategory for claims; a FINANCE_CATEGORIES value for Finance bills
  // Tax-invoice details (GST credit needs them). Null when the document does not show them.
  supplier_gstin: string | null;   // the SELLER's 15-character GSTIN (never the buyer's)
  invoice_number: string | null;
  gst_rate: number | null;         // combined GST %, e.g. 18 for CGST 9% + SGST 9%
}

const EMPTY: ReceiptFields = {
  merchant: null, txn_date: null, amount: null, currency: null, tax_amount: null, category: null,
  supplier_gstin: null, invoice_number: null, gst_rate: null,
};

export type ReceiptMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
export type ScanKind = 'claim' | 'finance';

const systemPrompt = (kind: ScanKind): string => [
  'You are an OCR + expense-extraction engine for receipts, bills and tax invoices (Indian business context).',
  'You receive ONE receipt or invoice (a photo or a PDF) and must return ONLY a JSON object of this exact shape:',
  '{ "merchant": string|null, "txn_date": string|null, "amount": number|null, "currency": string|null, "tax_amount": number|null, "category": string|null, "supplier_gstin": string|null, "invoice_number": string|null, "gst_rate": number|null }',
  'Rules:',
  '- merchant is the SELLER / supplier (who issued the document), not the buyer.',
  '- amount is the GRAND TOTAL payable for this document (after tax and after any credits or discounts shown in its summary), as a plain number — no currency symbol, no thousands separators. For a multi-page invoice use the total in the first-page summary.',
  '- tax_amount is the TOTAL GST/VAT/service-tax in rupees (CGST + SGST + IGST added up) if the document breaks it out, else null. Use null when the document says 0% or charges no tax.',
  '- gst_rate is the combined GST percentage (CGST 9% + SGST 9% = 18; IGST 18% = 18), else null.',
  '- supplier_gstin is the SELLER\'s 15-character Indian GSTIN (2 digits, 5 letters, 4 digits, letter, letter or digit, Z, letter or digit). Never use the buyer\'s ("Bill to") GSTIN. Null if the seller has no valid GSTIN printed.',
  '- invoice_number is the invoice / bill number printed on the document.',
  '- txn_date is the invoice or bill date in YYYY-MM-DD. Interpret DD/MM/YYYY as day-first (Indian format).',
  '- currency is the ISO code (default "INR" if a ₹/Rs document shows no code).',
  kind === 'finance'
    ? `- category MUST be one of: ${FINANCE_CATEGORIES.join(', ')}. Map: advertising/ads→marketing; SaaS/cloud/AI subscription→software; rent→rent; phone/internet→telecom; electricity/water→utilities; accountant/lawyer/consultant→professional_fees; laptops/devices→equipment; restaurant/cafe→food; hotel→lodging; cab/train/flight→travel; anything else→other.`
    : '- category MUST be one of: travel, food, lodging, fuel, toll, misc. Map: restaurant/cafe/food→food; hotel/stay→lodging; petrol/diesel/fuel→fuel; toll/fastag→toll; cab/train/bus/flight/auto→travel; anything else→misc.',
  '- Use null for any field the document does not show. Never invent a total that is not printed.',
  '- Output JSON only — no prose, no markdown fences.',
].join('\n');

function str(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim() : '';
  return t || null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^\d.\-]/g, '');
    const n = Number(cleaned);
    return isFinite(n) && cleaned !== '' ? n : null;
  }
  return null;
}

function cat(v: unknown, kind: ScanKind): string | null {
  const t = typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  const allowed: readonly string[] = kind === 'finance' ? FINANCE_CATEGORIES : CATEGORIES;
  return allowed.includes(t) ? t : null;
}

/** A GSTIN only if it is shaped like one — a foreign supplier's tax number is not. */
export function usableGstin(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim().toUpperCase().replace(/\s+/g, '') : '';
  return GSTIN_RE.test(t) ? t : null;
}

const usableRate = (n: number | null): number | null => (n != null && n >= 0 && n <= 40 ? Math.round(n * 100) / 100 : null);

/** The model's text → fields. Anything unusable degrades to null; never throws. */
export function parseReceiptText(text: string, kind: ScanKind = 'claim'): ReceiptFields {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return { ...EMPTY };
    const p = JSON.parse(text.substring(start, end + 1));
    const tax = num(p.tax_amount);
    return {
      merchant: str(p.merchant),
      // Only a real day: a date the model wrote in another shape would fail the line's save later.
      txn_date: usableScanDate(p.txn_date),
      amount: usableAmount(num(p.amount)),
      currency: str(p.currency)?.toUpperCase() ?? null,
      tax_amount: tax != null && tax >= 0 ? tax : null,
      category: cat(p.category, kind),
      supplier_gstin: usableGstin(p.supplier_gstin),
      invoice_number: str(p.invoice_number)?.slice(0, 60) ?? null,
      gst_rate: usableRate(num(p.gst_rate)),
    };
  } catch (err: any) {
    logger.warn(`[receipt-scan] parse failed: ${err?.message || err}`);
    return { ...EMPTY };
  }
}

/** A total that can be saved on a line (positive, within the column). */
export function usableAmount(n: number | null): number | null {
  return n != null && n > 0 && n <= 10_000_000 ? Math.round(n * 100) / 100 : null;
}

export async function scanReceipt(imageBase64: string, mediaType: ReceiptMediaType = 'image/jpeg', kind: ScanKind = 'claim'): Promise<ReceiptFields> {
  const apiKey = await AIService.getFunctionalKey();
  const model = process.env.RECEIPT_SCAN_MODEL || process.env.CARD_SCAN_MODEL || 'claude-haiku-4-5';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      system: systemPrompt(kind),
      messages: [{
        role: 'user',
        content: [
          mediaType === 'application/pdf'
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageBase64 } }
            : { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: 'Extract the expense fields from this document. JSON only.' },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const err: any = await response.json().catch(() => ({}));
    throw new AppError(response.status, err?.error?.message || `Receipt scan failed (${response.status})`, 'RECEIPT_SCAN_ERROR');
  }

  const data: any = await response.json();
  const text: string = data?.content?.[0]?.text || '';
  return parseReceiptText(text, kind);
}
