/**
 * Travel allowance by vehicle, with odometer readings.
 *
 * An admin lists the vehicle types a policy pays for and the per-km cost of each
 * (`rules.vehicle_rates`). When a policy has any, a mileage line is no longer a
 * typed distance priced at one flat rate: the rep picks the vehicle, enters the
 * odometer before and after the trip (with a photo of each), and the server works
 * out the distance (after − before) and the amount (distance × that vehicle's
 * rate). The client never gets to type either number.
 *
 * Policies without vehicle rates are untouched — every function here is a no-op
 * for them, and the odometer columns are only written when a line actually
 * carries odometer data.
 *
 * Saving a DRAFT is lenient on purpose (the starting reading is taken in the
 * morning, the ending one in the evening); what is mandatory is enforced when the
 * claim is submitted — see `odometerViolations`.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { currentProjectKey } from '../../lib/projects';
import { AppError } from '../../utils';

export interface VehicleRate {
  /** Stable key stored on claim lines (e.g. "bike"). Survives a relabel. */
  id: string;
  label: string;
  rate_per_km: number;
}

export const MAX_VEHICLE_RATES = 20;

export interface OdometerFields {
  vehicle_type?: string | null;
  odometer_start?: number | null;
  odometer_end?: number | null;
  odometer_start_photo_url?: string | null;
  odometer_end_photo_url?: string | null;
}

export const ODOMETER_KEYS = [
  'vehicle_type', 'odometer_start', 'odometer_end', 'odometer_start_photo_url', 'odometer_end_photo_url',
] as const;
export const ODOMETER_PHOTO_KEYS = ['odometer_start_photo_url', 'odometer_end_photo_url'] as const;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** "Two-wheeler (bike)" → "two_wheeler_bike". */
export function vehicleId(label: string): string {
  return String(label ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

/** Clean an admin-supplied list: labelled, non-negative rate, unique ids, capped. */
export function normalizeVehicleRates(raw: unknown): VehicleRate[] {
  if (!Array.isArray(raw)) return [];
  const out: VehicleRate[] = [];
  const used = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const label = String(o.label ?? '').trim().slice(0, 40);
    const rate = num(o.rate_per_km);
    if (!label || rate == null || rate < 0) continue;
    const base = vehicleId(String(o.id ?? '')) || vehicleId(label);
    if (!base) continue;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`.slice(0, 40);
    used.add(id);
    out.push({ id, label, rate_per_km: round2(rate) });
    if (out.length >= MAX_VEHICLE_RATES) break;
  }
  return out;
}

export const vehicleFlowOn = (rules?: { vehicle_rates?: VehicleRate[] } | null): boolean => !!rules?.vehicle_rates?.length;

/** The policy's only vehicle, or null when it has none or several (with several the rep must pick one). */
export function soleVehicle(rates?: ReadonlyArray<VehicleRate> | null): VehicleRate | null {
  return rates && rates.length === 1 ? rates[0] : null;
}

const isBlankVehicle = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * Sole-vehicle default. A mileage line that arrives without a vehicle (null / undefined / '') under a policy
 * that pays for exactly ONE vehicle is that vehicle: older app builds cannot pre-select it, and there is
 * nothing to choose between. With two or more rates nothing changes (the rep must pick), and a vehicle that
 * is named but is not in the policy is left alone so it is still an error exactly as before.
 * Pure: returns the same object when there is nothing to fill in.
 */
export function withSoleVehicle<T extends OdometerFields & { category?: string | null }>(
  item: T, rates?: ReadonlyArray<VehicleRate> | null,
): T {
  if (item.category !== 'mileage' || !isBlankVehicle(item.vehicle_type)) return item;
  const sole = soleVehicle(rates);
  return sole ? { ...item, vehicle_type: sole.id } : item;
}

/** Did this line carry any vehicle / odometer field at all (even an explicit null)? */
export const hasOdometerInput = (i: object): boolean =>
  ODOMETER_KEYS.some((k) => (i as Record<string, unknown>)[k] !== undefined);

/**
 * Price a mileage line from its odometer readings and vehicle. Never throws — an
 * unusable pair simply leaves the line unpriced and `odometerViolations` explains
 * it. (Use `assertOdometerOrder` where a bad pair must be refused outright.)
 *
 * A line without a vehicle under a policy with exactly one vehicle rate is priced
 * at, and returned with, that vehicle (see `withSoleVehicle`).
 */
export function priceVehicleLine<T extends OdometerFields & { category?: string | null; amount?: number | null; distance_km?: number | null }>(
  item: T, rates: VehicleRate[],
): T {
  if (item.category !== 'mileage') return item;
  const line = withSoleVehicle(item, rates);
  const start = num(line.odometer_start);
  const end = num(line.odometer_end);
  if (start != null && end != null && end >= start) {
    const km = round2(end - start);
    const rate = rates.find((r) => r.id === line.vehicle_type);
    return { ...line, distance_km: km, amount: rate ? round2(km * rate.rate_per_km) : 0 };
  }
  // Only one reading so far (or an impossible pair): nothing to price yet.
  return { ...line, distance_km: null, amount: 0 };
}

/** Refuse a saved line whose "after" reading is below its "before" reading. */
export function assertOdometerOrder(items: Array<OdometerFields & { category?: string | null }>): void {
  for (const i of items) {
    const start = num(i.odometer_start);
    const end = num(i.odometer_end);
    if (start != null && end != null && end < start) {
      throw new AppError(400, 'The odometer reading after the trip is lower than the reading before it', 'ODOMETER_INVALID');
    }
  }
}

export interface OdometerProblem {
  code: 'vehicle_missing' | 'odometer_missing' | 'odometer_invalid' | 'odometer_photo_missing';
  detail: string;
}

/** What is still missing on one mileage line before it can be submitted. */
export function odometerProblems(
  item: OdometerFields & { category?: string | null },
  rules: { vehicle_rates?: VehicleRate[]; odometer_photos_required?: boolean },
): OdometerProblem[] {
  if (item.category !== 'mileage' || !vehicleFlowOn(rules)) return [];
  const problems: OdometerProblem[] = [];
  // (a blank vehicle is the policy's only vehicle when it has exactly one rate)
  const vehicle = withSoleVehicle(item, rules.vehicle_rates).vehicle_type;
  if (!rules.vehicle_rates!.some((r) => r.id === vehicle)) {
    problems.push({ code: 'vehicle_missing', detail: 'Pick the vehicle you travelled in.' });
  }
  const start = num(item.odometer_start);
  const end = num(item.odometer_end);
  if (start == null || end == null) {
    problems.push({ code: 'odometer_missing', detail: 'Enter the odometer reading before and after the trip.' });
  } else if (end < start) {
    problems.push({ code: 'odometer_invalid', detail: 'The odometer reading after the trip is lower than the reading before it.' });
  }
  if (rules.odometer_photos_required !== false && (!item.odometer_start_photo_url || !item.odometer_end_photo_url)) {
    problems.push({ code: 'odometer_photo_missing', detail: 'Add a photo of the odometer before and after the trip.' });
  }
  return problems;
}

// ── schema probe ────────────────────────────────────────────────────────────
const probe = new Map<string, { ok: boolean; at: number }>();

/**
 * Has this database run migrations/expense_odometer.sql? Cached per project.
 * Until it has, a line that carries odometer data is refused with a clear message
 * instead of failing the whole insert on an unknown column.
 */
export async function hasOdometerColumns(): Promise<boolean> {
  const key = currentProjectKey();
  const hit = probe.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? 5 * 60_000 : 30_000)) return hit.ok;
  let ok = false;
  try {
    const { error } = await supabaseAdmin.from('expense_claim_items')
      .select('vehicle_type, odometer_start, odometer_end, odometer_start_photo_url, odometer_end_photo_url').limit(1);
    ok = !error;
  } catch { ok = false; }
  probe.set(key, { ok, at: Date.now() });
  return ok;
}

/** Test seam: forget the cached answer. */
export function _resetOdometerProbe(): void { probe.clear(); }

/** Throw when lines carry odometer data this database cannot store yet. */
export async function assertOdometerStorable(items: object[]): Promise<void> {
  if (!items.some(hasOdometerInput)) return;
  if (await hasOdometerColumns()) return;
  throw new AppError(
    409,
    'Odometer readings need a one-time database update (migrations/expense_odometer.sql). Ask your administrator to apply it.',
    'ODOMETER_NOT_ENABLED',
  );
}
