import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';

/**
 * Order numbers ("ORD-261012-00007": IST date + a per-day running number) and inserting an order under a number
 * that is guaranteed to be free.
 *
 * `gen_order_no` hands out `count(today's orders) + 1`, which is not safe: its day boundary was compared in the wrong
 * time zone (between 00:00 and 05:30 IST every order of the day was invisible to the count, so the second order of the
 * night got the same number as the first and the insert failed with 409 "Duplicate order"), and two orders created at
 * the same moment get the same number. A rep whose order is refused for a number clash would be told "duplicate",
 * which the app reads as "already saved". So the insert itself retries with the next free number.
 */

const MAX_ATTEMPTS = 6;

/** The numeric tail of "ORD-YYMMDD-00012" when it belongs to [datePart] (YYMMDD), else null. */
export function orderSeqOf(orderNo: unknown, datePart: string): number | null {
  if (typeof orderNo !== 'string') return null;
  const m = /^ORD-(\d{6})-(\d+)$/.exec(orderNo.trim());
  if (!m || m[1] !== datePart) return null;
  const n = parseInt(m[2], 10);
  return Number.isFinite(n) ? n : null;
}

/** "ORD-YYMMDD-00013" for [seq] (at least five digits). */
export function formatOrderNo(datePart: string, seq: number): string {
  return `ORD-${datePart}-${String(Math.max(1, Math.floor(seq))).padStart(5, '0')}`;
}

/** The YYMMDD part of an order number made by `gen_order_no`, else null (e.g. the `ORD-<timestamp>` fallback). */
export function datePartOf(orderNo: unknown): string | null {
  if (typeof orderNo !== 'string') return null;
  const m = /^ORD-(\d{6})-\d+$/.exec(orderNo.trim());
  return m ? m[1] : null;
}

interface PgError { code?: string; message?: string; details?: string }

/**
 * True when [error] is a unique violation on the ORDER NUMBER (not on the idempotency key: a repeat of the same
 * request is a genuine duplicate and must stay one).
 */
export function isOrderNoClash(error: PgError | null | undefined): boolean {
  if (!error || error.code !== '23505') return false;
  const text = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase();
  if (text.includes('idempotency')) return false;
  return text.includes('order_no');
}

/** The next free number after the highest one used today in [orgId]'s orders (so a clash can be stepped over). */
export async function nextFreeOrderNo(orgId: string, clashedNo: string, bump = 1): Promise<string> {
  const datePart = datePartOf(clashedNo);
  if (!datePart) return `${clashedNo}-${Date.now().toString(36)}`; // not a dated number: make it unique, keep it readable
  const { data } = await supabaseAdmin.from('orders')
    .select('order_no').eq('org_id', orgId).like('order_no', `ORD-${datePart}-%`)
    .order('order_no', { ascending: false }).limit(1);
  const top = Array.isArray(data) && data.length ? orderSeqOf((data[0] as { order_no?: unknown }).order_no, datePart) : null;
  const clashed = orderSeqOf(clashedNo, datePart) ?? 0;
  return formatOrderNo(datePart, Math.max(top ?? 0, clashed) + bump);
}

/**
 * Insert [orderRow]; when its order number is already taken, move to the next free one and try again (up to
 * [MAX_ATTEMPTS] times; two simultaneous orders may race for the same next number). Any other error is returned as is.
 */
export async function insertOrderWithFreeNo(orderRow: Record<string, unknown>, orgId: string) {
  let row = orderRow;
  let res = await supabaseAdmin.from('orders').insert(row).select().single();
  for (let attempt = 1; attempt < MAX_ATTEMPTS && res.error && isOrderNoClash(res.error); attempt++) {
    const taken = String(row.order_no);
    const next = await nextFreeOrderNo(orgId, taken, 1 + Math.floor(Math.random() * attempt));
    logger.warn(`[orders] order number ${taken} was taken; retrying as ${next}`);
    row = { ...row, order_no: next };
    res = await supabaseAdmin.from('orders').insert(row).select().single();
  }
  return res;
}
