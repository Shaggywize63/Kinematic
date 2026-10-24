import { supabaseAdmin } from '../lib/supabase';
import { currentProjectKey } from '../lib/projects';

// Outlet approval policy. A field rep can propose an outlet; it is usable (order / collection pickers) only once a
// manager approves it. Pure functions — the controllers apply them.

const REP_ROLES = new Set(['executive', 'field_executive']);
const APPROVER_ROLES = new Set(['super_admin', 'admin', 'main_admin', 'sub_admin', 'city_manager']);

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export const APPROVAL_STATUSES: ApprovalStatus[] = ['pending', 'approved', 'rejected'];

/** Outlets a field rep creates start as pending; everyone else's are approved straight away. */
export function needsApproval(role: string | undefined | null): boolean {
  return REP_ROLES.has(String(role || '').toLowerCase());
}

export function canApprove(role: string | undefined | null): boolean {
  return APPROVER_ROLES.has(String(role || '').toLowerCase());
}

/** Fields only the approval flow may write; never taken from a request body. */
export const APPROVAL_FIELDS = ['approval_status', 'created_by', 'approved_by', 'approved_at', 'rejection_reason'] as const;

export function stripApprovalFields<T extends Record<string, unknown>>(body: T): Omit<T, typeof APPROVAL_FIELDS[number]> {
  const out: Record<string, unknown> = { ...body };
  for (const f of APPROVAL_FIELDS) delete out[f];
  return out as Omit<T, typeof APPROVAL_FIELDS[number]>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRADE_TYPES = new Set(['on_trade', 'off_trade']);

export interface NewOutletInput {
  name: string;
  owner_name: string | null;
  phone: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  /** Free-text retail category (Kirana, Pan Shop, …). */
  store_type: string | null;
  /** Channel: on_trade | off_trade. */
  trade_type: string | null;
  city_id: string | null;
  zone_id: string | null;
}

const text = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Validates what a rep may send when proposing an outlet. Only these fields are read, so nothing else (an id, a
 * client, an approval status) can ride in on the body. Returns the clean row or the reason it was refused.
 */
export function parseNewOutlet(body: any): { ok: true; value: NewOutletInput } | { ok: false; error: string } {
  const name = text(body?.name, 200);
  if (!name) return { ok: false, error: 'Outlet name is required' };

  const lat = num(body?.lat);
  const lng = num(body?.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return { ok: false, error: 'lat / lng must be numbers' };
  if ((lat === null) !== (lng === null)) return { ok: false, error: 'Send both lat and lng, or neither' };
  if (lat !== null && (Math.abs(lat) > 90 || Math.abs(lng as number) > 180)) return { ok: false, error: 'lat / lng are out of range' };

  const phone = text(body?.phone, 20);
  if (phone && !/^[0-9+()\-\s]{6,20}$/.test(phone)) return { ok: false, error: 'Phone number looks invalid' };

  const tradeType = text(body?.trade_type, 40)?.toLowerCase().replace(/[\s-]+/g, '_') ?? null;
  if (tradeType && !TRADE_TYPES.has(tradeType)) return { ok: false, error: 'trade_type must be on_trade or off_trade' };

  const cityId = text(body?.city_id, 64);
  const zoneId = text(body?.zone_id, 64);
  if ((cityId && !UUID_RE.test(cityId)) || (zoneId && !UUID_RE.test(zoneId))) return { ok: false, error: 'Invalid city or zone' };

  return {
    ok: true,
    value: {
      name, owner_name: text(body?.owner_name, 200), phone, address: text(body?.address, 500),
      lat, lng, store_type: text(body?.store_type, 80), trade_type: tradeType, city_id: cityId, zone_id: zoneId,
    },
  };
}

/** A short outlet code for a proposed outlet (the unique outlet ID reps and managers quote): OUT-XXXXXX. */
export function newOutletCode(random: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(random() * alphabet.length)];
  return `OUT-${s}`;
}


// ── Is outlet approval set up in THIS project's database? ────────────────────────────────────────────────
// The backend serves several tenants from one codebase, and a tenant's database only gets the approval columns
// once its migration is applied. Until then every outlet query must behave exactly as before, so each approval
// code path first asks this. "Yes" is remembered; "No" is re-checked after a minute so a migration applied later
// is picked up without a restart.
const NOT_READY_RECHECK_MS = 60_000;
const probes = new Map<string, { ready: boolean; at: number }>();

export async function approvalColumnsAvailable(): Promise<boolean> {
  const key = currentProjectKey();
  const hit = probes.get(key);
  if (hit && (hit.ready || Date.now() - hit.at < NOT_READY_RECHECK_MS)) return hit.ready;
  let ready = false;
  try {
    const { error } = await supabaseAdmin.from('stores').select('approval_status').limit(1);
    ready = !error;
  } catch {
    ready = false;
  }
  probes.set(key, { ready, at: Date.now() });
  return ready;
}

/** Test hook: forget what was learned about each project. */
export function resetApprovalProbe(): void {
  probes.clear();
}

/** A trade_type value can only be written once the column exists. */
export function withoutApprovalColumns<T extends Record<string, unknown>>(body: T): Omit<T, typeof APPROVAL_FIELDS[number] | 'trade_type'> {
  const out: Record<string, unknown> = { ...body };
  for (const f of APPROVAL_FIELDS) delete out[f];
  delete out.trade_type;
  return out as Omit<T, typeof APPROVAL_FIELDS[number] | 'trade_type'>;
}
