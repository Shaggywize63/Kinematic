/**
 * Mode of transport on a day's attendance — PURE logic, no I/O. (The DB-facing half, which reads the
 * signed-in user's expense policy, is transportMode.store.ts.)
 *
 * Opt-in per client: `clients.settings.attendance_rules.track_transport_mode:true` (default false). Only
 * then does the check-in accept a mode and the PATCH update it; a client that never turns it on never
 * has `attendance.transport_mode` read or written.
 *
 * The ids a rep may pick ("allowed modes"), in the order the apps show them:
 *   1. the vehicles of the user's resolved expense policy (`rules.vehicle_rates`), id/label exactly as
 *      the policy has them, flagged `vehicle:true`;
 *   2. `public_transport` and `other`, `vehicle:false`.
 * A policy with no vehicle rates offers `two_wheeler` and `car` (also `vehicle:true`) instead of 1.
 * A policy vehicle that happens to use one of the two fixed ids (e.g. an admin-created "Other") wins,
 * and the fixed entry is not listed twice.
 */

export interface TransportMode {
  id: string;
  label: string;
  /** True for a vehicle the rep drives/rides (can be claimed per km); false for public transport / other. */
  vehicle: boolean;
}

/** What an id may look like: lower-case letters, digits and underscores, 1..40 chars (the expense policy's vehicle ids). */
export const TRANSPORT_MODE_ID_RE = /^[a-z0-9_]{1,40}$/;

export const FIXED_TRANSPORT_MODES: ReadonlyArray<TransportMode> = Object.freeze([
  Object.freeze({ id: 'public_transport', label: 'Public transport', vehicle: false }),
  Object.freeze({ id: 'other', label: 'Other', vehicle: false }),
]);

export const DEFAULT_VEHICLE_TRANSPORT_MODES: ReadonlyArray<TransportMode> = Object.freeze([
  Object.freeze({ id: 'two_wheeler', label: 'Two-wheeler', vehicle: true }),
  Object.freeze({ id: 'car', label: 'Car', vehicle: true }),
]);

/** Does the client's resolved attendance rule set ask for the mode of transport? */
export function trackTransportModeOn(rules: { track_transport_mode?: unknown } | null | undefined): boolean {
  return rules?.track_transport_mode === true;
}

/** The allowed modes for a policy's vehicle rates (undefined / empty = the two defaults). */
export function buildTransportModes(
  vehicleRates?: ReadonlyArray<{ id: string; label: string }> | null,
): TransportMode[] {
  const out: TransportMode[] = [];
  const seen = new Set<string>();
  const add = (m: TransportMode) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    out.push({ id: m.id, label: m.label, vehicle: m.vehicle });
  };
  const vehicles = (vehicleRates ?? []).filter((v) => v && typeof v.id === 'string' && v.id && typeof v.label === 'string');
  if (vehicles.length) for (const v of vehicles) add({ id: v.id, label: v.label, vehicle: true });
  else for (const v of DEFAULT_VEHICLE_TRANSPORT_MODES) add(v);
  for (const m of FIXED_TRANSPORT_MODES) add(m);
  return out;
}

export type TransportModeCheck =
  | { ok: true; mode: string }
  | { ok: false; error: string };

/**
 * Validate a requested mode: a string of `[a-z0-9_]{1,40}` that is one of `allowed` (when `allowed` is
 * null the allow-list could not be loaded, so only the format is checked — a transient policy read
 * failure must not lose a check-in).
 */
export function validateTransportMode(raw: unknown, allowed: ReadonlyArray<TransportMode> | null): TransportModeCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'transport_mode must be a string' };
  if (!TRANSPORT_MODE_ID_RE.test(raw)) {
    return { ok: false, error: 'transport_mode must be 1-40 characters of lower-case letters, digits and underscores' };
  }
  if (allowed && !allowed.some((m) => m.id === raw)) {
    return { ok: false, error: `Unknown transport_mode "${raw}". Allowed: ${allowed.map((m) => m.id).join(', ')}` };
  }
  return { ok: true, mode: raw };
}

/** "own_bike" -> "Own Bike". */
export function humanizeTransportMode(id: string): string {
  return id.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** A mode's display label: from `modes` when listed, else the fixed / default labels, else the id made readable. */
export function labelForTransportMode(mode: string | null | undefined, modes?: ReadonlyArray<TransportMode> | null): string | null {
  if (typeof mode !== 'string' || !mode) return null;
  const hit = modes?.find((m) => m.id === mode)
    ?? FIXED_TRANSPORT_MODES.find((m) => m.id === mode)
    ?? DEFAULT_VEHICLE_TRANSPORT_MODES.find((m) => m.id === mode);
  return hit ? hit.label : (humanizeTransportMode(mode) || mode);
}

/** Is this id one of the always-available ones (its label needs no policy lookup)? */
export function isFixedTransportMode(id: string): boolean {
  return FIXED_TRANSPORT_MODES.some((m) => m.id === id);
}

/** A body/query value that counts as "the caller sent a mode" (null, undefined and '' mean they did not). */
export function hasTransportModeValue(raw: unknown): boolean {
  return raw !== undefined && raw !== null && raw !== '';
}
