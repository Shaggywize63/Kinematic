import type { Row } from '../payroll/common';

// Rows -> the wire for the Asset register. Pure functions, no database access. Top-level keys snake_case, null for
// "nothing". The two reserved-word columns are mapped back to the dashboard's field names: on_date -> `on`, by_name -> `by`.

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** An asset as the wire has it (the dashboard's Asset, snake_case): id, tag, type, make, model, serial, purchase_date,
 *  cost, warranty_end|null, condition, status, holder_id|null (+ the id/created_at/updated_at envelope every row has). */
export const assetOut = (r: Row): Row => ({
  id: r.id,
  tag: str(r.tag),
  type: r.type,
  make: str(r.make),
  model: str(r.model),
  serial: str(r.serial),
  purchase_date: iso(r.purchase_date),
  cost: num(r.cost),
  warranty_end: iso(r.warranty_end),
  condition: r.condition,
  status: r.status,
  holder_id: r.holder_id ?? null,
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

/** An asset event as the wire has it: id, asset_id, on, kind, from_id|null, to_id|null, condition|null, status,
 *  ack|null, note|null, by. ack and condition are null when the event kind does not record them. */
export const eventOut = (r: Row): Row => ({
  id: r.id,
  asset_id: r.asset_id,
  on: iso(r.on_date),
  kind: r.kind,
  from_id: r.from_id ?? null,
  to_id: r.to_id ?? null,
  condition: r.condition ?? null,
  status: r.status,
  ack: r.ack === null || r.ack === undefined ? null : !!r.ack,
  note: r.note ?? null,
  by: str(r.by_name),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});
