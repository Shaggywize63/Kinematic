/**
 * e-Invoice (IRP) integration stub.
 *
 * Produces an IRN-shaped payload locally. When real GSP credentials are
 * configured (NIC/ClearTax/Cygnet) callers should swap this implementation
 * for a real client; the contract below stays the same.
 *
 * We intentionally do NOT block invoice issue if the IRP is unreachable —
 * the invoice is persisted with `irn=null` and a background job (M2.5)
 * retries IRN generation. The dashboard surfaces the missing IRN.
 */

import crypto from 'crypto';

export interface EInvoicePayload {
  invoice_no: string;
  invoice_date: string;
  seller: { gstin?: string | null; legal_name?: string | null; state_code?: string | null };
  buyer:  { gstin?: string | null; legal_name?: string | null; state_code?: string | null };
  place_of_supply?: string | null;
  items: Array<{
    sku_code?: string | null;
    sku_name?: string | null;
    hsn_code?: string | null;
    qty: number;
    unit_price: number;
    taxable_value: number;
    gst_rate: number;
    cgst: number;
    sgst: number;
    igst: number;
    cess: number;
  }>;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  grand_total: number;
}

export interface EInvoiceResult {
  irn: string | null;
  qr_code_url: string | null;
  source: 'stub' | 'live';
  raw?: unknown;
}

export async function generateIRN(payload: EInvoicePayload): Promise<EInvoiceResult> {
  const live = process.env.EINVOICE_GSP_URL && process.env.EINVOICE_GSP_USER;
  if (!live) {
    // Deterministic 64-char hex IRN derived from canonical payload.
    const canon = JSON.stringify(payload);
    const irn = crypto.createHash('sha256').update(canon).digest('hex');
    return { irn, qr_code_url: null, source: 'stub' };
  }
  // Live GSP integration would go here. Fail soft: return null so the
  // invoice still issues; a background retry can fill the IRN later.
  try {
    // Placeholder for real fetch().
    return { irn: null, qr_code_url: null, source: 'live' };
  } catch (e: any) {
    return { irn: null, qr_code_url: null, source: 'live', raw: { error: e.message } };
  }
}
