/**
 * e-Way bill stub.
 *
 * For invoices > ₹50,000 inter-state (or as configured), the dispatch must
 * carry an e-way bill. Real integration calls NIC/GSP; this stub returns a
 * deterministic 12-digit number so test data flows.
 */

export const EWAY_THRESHOLD = 50000;

export interface EwayBillRequest {
  invoice_no: string;
  invoice_date: string;
  vehicle_no: string;
  distance_km?: number;
  from_state_code?: string | null;
  to_state_code?: string | null;
  total_value: number;
}

export interface EwayBillResult {
  eway_bill_no: string | null;
  valid_until: string | null;
  source: 'stub' | 'live';
}

export async function generateEwayBill(req: EwayBillRequest): Promise<EwayBillResult> {
  const live = process.env.EWAY_GSP_URL && process.env.EWAY_GSP_USER;
  if (!live) {
    // 12-digit deterministic-ish bill from invoice number + vehicle.
    const seed = (req.invoice_no + req.vehicle_no).replace(/[^0-9]/g, '') || Date.now().toString();
    const padded = (seed + '000000000000').slice(0, 12);
    const validity = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return { eway_bill_no: padded, valid_until: validity, source: 'stub' };
  }
  return { eway_bill_no: null, valid_until: null, source: 'live' };
}

export function ewayRequired(grandTotal: number): boolean {
  return grandTotal > EWAY_THRESHOLD;
}
