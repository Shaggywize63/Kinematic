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

export type ReceiptCategory = 'travel' | 'food' | 'lodging' | 'fuel' | 'toll' | 'misc';
const CATEGORIES: ReceiptCategory[] = ['travel', 'food', 'lodging', 'fuel', 'toll', 'misc'];

export interface ReceiptFields {
  merchant: string | null;
  txn_date: string | null;      // YYYY-MM-DD
  amount: number | null;        // grand total
  currency: string | null;      // ISO code e.g. INR
  tax_amount: number | null;    // GST/tax portion if shown
  category: ReceiptCategory | null;
}

const EMPTY: ReceiptFields = {
  merchant: null, txn_date: null, amount: null, currency: null, tax_amount: null, category: null,
};

export type ReceiptMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

const SYSTEM = [
  'You are an OCR + expense-extraction engine for receipts and bills (Indian field-sales context).',
  'You receive ONE photo of a receipt and must return ONLY a JSON object of this exact shape:',
  '{ "merchant": string|null, "txn_date": string|null, "amount": number|null, "currency": string|null, "tax_amount": number|null, "category": string|null }',
  'Rules:',
  '- amount is the GRAND TOTAL actually paid (after tax), as a plain number — no currency symbol, no thousands separators.',
  '- tax_amount is the GST/VAT/service-tax portion if the receipt breaks it out, else null.',
  '- txn_date is the bill date in YYYY-MM-DD. Interpret DD/MM/YYYY as day-first (Indian format).',
  '- currency is the ISO code (default "INR" if a ₹/Rs receipt shows no code).',
  '- category MUST be one of: travel, food, lodging, fuel, toll, misc. Map: restaurant/cafe/food→food; hotel/stay→lodging; petrol/diesel/fuel→fuel; toll/fastag→toll; cab/train/bus/flight/auto→travel; anything else→misc.',
  '- Use null for any field the receipt does not show. Never invent a total that is not printed.',
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

function cat(v: unknown): ReceiptCategory | null {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (CATEGORIES as string[]).includes(t) ? (t as ReceiptCategory) : null;
}

export async function scanReceipt(imageBase64: string, mediaType: ReceiptMediaType = 'image/jpeg'): Promise<ReceiptFields> {
  const apiKey = await AIService.getFunctionalKey();
  const model = process.env.RECEIPT_SCAN_MODEL || process.env.CARD_SCAN_MODEL || 'claude-sonnet-4-6';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: 'Extract the expense fields from this receipt. JSON only.' },
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
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return { ...EMPTY };
    const p = JSON.parse(text.substring(start, end + 1));
    return {
      merchant: str(p.merchant),
      txn_date: str(p.txn_date),
      amount: num(p.amount),
      currency: str(p.currency)?.toUpperCase() ?? null,
      tax_amount: num(p.tax_amount),
      category: cat(p.category),
    };
  } catch (err: any) {
    logger.warn(`[receipt-scan] parse failed: ${err?.message || err}`);
    return { ...EMPTY };
  }
}
