/**
 * Daily closing-stock — the small pure rules, unit-tested on the JVM-equivalent (Jest). The DB access lives in the
 * controller; this file only decides variance, how a day's worksheet merges system stock with the saved counts, and
 * which rows an admin may still adjust.
 *
 * A "closing stock" row is a physical count of one SKU at one distributor on one day. `system_qty` is the on-hand
 * balance snapshotted when the count was saved; `variance = physical_qty - system_qty`. A positive variance means
 * more stock was counted than the system knows (a receipt was missed); negative means less (shrinkage / unrecorded
 * issue). Approving a non-zero variance posts a stock adjustment of exactly `variance`, after which the row is
 * `adjusted` and can no longer be re-approved.
 */

export type ClosingStatus = 'recorded' | 'approved' | 'adjusted';

/** physical − system. A missing physical count yields null (nothing counted yet). */
export function variance(physicalQty: number | null | undefined, systemQty: number): number | null {
  if (physicalQty === null || physicalQty === undefined || !Number.isFinite(physicalQty)) return null;
  return Math.trunc(physicalQty) - Math.trunc(systemQty);
}

/** A whole, non-negative integer count, or null when the input is blank / not a number. Never throws. */
export function cleanCount(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

export interface StockOnHand { sku_id: string; qty: number }
export interface SavedCount {
  sku_id: string; physical_qty: number; system_qty: number; variance: number;
  status: ClosingStatus; id: string; note?: string | null;
}
export interface WorksheetRow {
  sku_id: string;
  system_qty: number;           // live on-hand now (what a fresh count would be measured against)
  physical_qty: number | null;  // the saved count for the day, or null if not counted yet
  variance: number | null;      // physical − the system snapshot stored with the count (null if not counted)
  status: ClosingStatus | 'uncounted';
  id: string | null;            // the saved row id, or null
  note: string | null;
}

/**
 * One row per SKU for the chosen distributor+day: every SKU the distributor holds stock of, plus any SKU that has a
 * saved count but no live on-hand row (e.g. counted to zero after the balance was cleared). The live on-hand drives
 * `system_qty` (so the admin counts against the current balance); the saved row, when present, supplies the physical
 * count and the variance recorded at save time.
 */
export function buildWorksheet(onHand: StockOnHand[], saved: SavedCount[]): WorksheetRow[] {
  const savedBySku = new Map<string, SavedCount>();
  for (const s of saved) savedBySku.set(s.sku_id, s);

  const rows: WorksheetRow[] = [];
  const seen = new Set<string>();
  for (const h of onHand) {
    if (seen.has(h.sku_id)) continue;
    seen.add(h.sku_id);
    const s = savedBySku.get(h.sku_id);
    rows.push({
      sku_id: h.sku_id,
      system_qty: Math.trunc(h.qty ?? 0),
      physical_qty: s ? s.physical_qty : null,
      variance: s ? s.variance : null,
      status: s ? s.status : 'uncounted',
      id: s ? s.id : null,
      note: s ? s.note ?? null : null,
    });
  }
  // Counted SKUs with no current on-hand row.
  for (const s of saved) {
    if (seen.has(s.sku_id)) continue;
    seen.add(s.sku_id);
    rows.push({
      sku_id: s.sku_id, system_qty: 0, physical_qty: s.physical_qty, variance: s.variance,
      status: s.status, id: s.id, note: s.note ?? null,
    });
  }
  return rows;
}

/** Only a `recorded` row with a non-zero variance can be approved into an adjustment. */
export function canApprove(row: { status: ClosingStatus; variance: number }): boolean {
  return row.status === 'recorded' && row.variance !== 0;
}

/** A day's variance roll-up for the report header. */
export function summarise(rows: Array<{ variance: number | null; status: ClosingStatus | 'uncounted' }>) {
  let counted = 0, matched = 0, over = 0, short = 0, adjusted = 0;
  for (const r of rows) {
    if (r.variance === null) continue;
    counted++;
    if (r.variance === 0) matched++;
    else if (r.variance > 0) over++;
    else short++;
    if (r.status === 'adjusted') adjusted++;
  }
  return { counted, matched, over, short, adjusted };
}
