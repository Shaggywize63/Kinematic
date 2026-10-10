/**
 * Attendance rules — DB-facing half (the pure logic is attendanceRules.service.ts).
 *
 * Rules live in `clients.settings.attendance_rules` (jsonb). Reads go through
 * the shared 60s per-client settings cache (lib/clientFlags); the admin write
 * path always reads FRESH from the DB, merges only `attendance_rules`, and
 * clears the cache so every other `clients.settings` key is preserved.
 *
 * Client scope for the admin endpoints: the JWT `client_id` (client-pinned
 * users), else the `X-Client-Id` header (org admins), else 400 "Select a client
 * first". A header-supplied client must belong to the caller's org (its
 * `org_id` or `owner_org_id`; super_admin excepted), so one tenant's admin
 * can't edit another's.
 */
import { supabaseAdmin } from '../lib/supabase';
import { getClientSettings, clearClientFlagCache } from '../lib/clientFlags';
import { logger } from '../lib/logger';
import { AppError } from '../utils';
import { AuthRequest } from '../types';
import {
  applyLate, computeLate, mergeRulesIntoSettings, resolveAttendanceRules,
  type AttendanceRules, type LateInfo, type ResolvedAttendanceRules,
} from './attendanceRules.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SELECT_CLIENT_FIRST = 'Select a client first';

// ── resolved rules for one / many clients (cached) ────────────────────────

/** Resolved rules for a client (cached ≤60s). A null/unknown client reads as unconfigured defaults. */
export async function rulesForClient(clientId: string | null | undefined): Promise<ResolvedAttendanceRules> {
  return resolveAttendanceRules(await getClientSettings(clientId));
}

/** Resolved rules for each distinct client id (cached ≤60s). */
export async function rulesForClients(clientIds: Iterable<string | null | undefined>): Promise<Map<string, ResolvedAttendanceRules>> {
  const ids = Array.from(new Set(Array.from(clientIds).filter((c): c is string => !!c)));
  const entries = await Promise.all(ids.map(async (id) => [id, await rulesForClient(id)] as const));
  return new Map(entries);
}

/**
 * Attach `late` to every row that has a `checkin_at`, using the rules of the
 * row's own `client_id` (falling back to `fallbackClientId`). Rows of
 * unconfigured clients are left untouched. Never throws: a failure here must
 * not break the attendance response it decorates.
 */
export async function annotateLate<T extends { checkin_at?: unknown; client_id?: string | null }>(
  rows: T[] | null | undefined,
  fallbackClientId?: string | null,
): Promise<T[]> {
  const list = rows ?? [];
  try {
    const punched = list.filter((r) => r && r.checkin_at);
    if (punched.length === 0) return list;
    const clientOf = (r: T) => r.client_id ?? fallbackClientId ?? null;
    const rules = await rulesForClients(punched.map(clientOf));
    for (const r of punched) {
      const cid = clientOf(r);
      if (cid) applyLate(r, rules.get(cid));
    }
  } catch (e) {
    logger.warn(`[attendance-rules] could not annotate late info: ${(e as Error)?.message ?? e}`);
  }
  return list;
}

/**
 * `{ late }` for a record under an already-loaded rules map, or `{}` when the
 * record has no check-in or its client is unconfigured — spread it into a
 * hand-built response object so legacy clients get no new key.
 */
export function lateFields(
  rec: { checkin_at?: unknown; client_id?: string | null } | null | undefined,
  rules: Map<string, ResolvedAttendanceRules>,
  fallbackClientId?: string | null,
): { late?: LateInfo } {
  if (!rec?.checkin_at) return {};
  const cid = rec.client_id ?? fallbackClientId;
  const resolved = cid ? rules.get(cid) : undefined;
  if (!resolved?.configured) return {};
  const late = computeLate(rec.checkin_at as string | number | Date, resolved.rules);
  return late ? { late } : {};
}

/** A user's client id (for rows that carry none). Null when unknown. */
export async function clientIdOfUser(userId: string | null | undefined): Promise<string | null> {
  if (!userId || !UUID_RE.test(userId)) return null;
  try {
    const { data } = await supabaseAdmin.from('users').select('client_id').eq('id', userId).maybeSingle();
    return ((data as { client_id?: string | null } | null)?.client_id) ?? null;
  } catch { return null; }
}

// ── client scope + admin read/write ───────────────────────────────────────

export interface RulesClientScope { clientId: string | null; pinned: boolean }

/** JWT-pinned client wins; otherwise a well-formed X-Client-Id header; otherwise none. */
export function rulesClientScope(req: AuthRequest): RulesClientScope {
  const pinned = req.user?.client_id;
  if (pinned && UUID_RE.test(String(pinned))) return { clientId: String(pinned), pinned: true };
  const raw = req.headers['x-client-id'];
  const header = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (header && UUID_RE.test(header)) return { clientId: header, pinned: false };
  return { clientId: null, pinned: false };
}

export interface ClientRow { id: string; org_id?: string | null; owner_org_id?: string | null; settings?: unknown }

export async function fetchClientRow(clientId: string): Promise<ClientRow | null> {
  // owner_org_id only exists on org-per-client projects; fall back without it.
  let res = await supabaseAdmin.from('clients').select('id, org_id, owner_org_id, settings').eq('id', clientId).maybeSingle();
  if (res.error && /owner_org_id|42703/.test(`${res.error.message} ${res.error.code ?? ''}`)) {
    res = await supabaseAdmin.from('clients').select('id, org_id, settings').eq('id', clientId).maybeSingle();
  }
  if (res.error && res.error.code === 'PGRST116') return null;       // no such row
  if (res.error) throw new AppError(500, res.error.message, 'DB_ERROR');
  return (res.data as ClientRow | null) ?? null;
}

/**
 * Fresh `clients` row for the request's client scope. Throws 400 when no client
 * is in scope, 404 when it doesn't exist or (header scope) isn't the caller's.
 */
async function loadScopedClient(req: AuthRequest): Promise<ClientRow> {
  const { clientId, pinned } = rulesClientScope(req);
  if (!clientId) throw new AppError(400, SELECT_CLIENT_FIRST, 'CLIENT_REQUIRED');
  const row = await fetchClientRow(clientId);
  if (!row) throw new AppError(404, 'Client not found', 'NOT_FOUND');
  if (!pinned && !callerMayUseClient(req, row)) throw new AppError(404, 'Client not found', 'NOT_FOUND');
  return row;
}

/**
 * May the caller act on a client they picked with X-Client-Id (not pinned by
 * their JWT)? Yes when the client lives in, or is owned by, the caller's org —
 * or the caller is the platform super_admin (same reach as the team list).
 */
export function callerMayUseClient(req: AuthRequest, row: ClientRow): boolean {
  if ((req.user?.role ?? '').toLowerCase() === 'super_admin') return true;
  const org = req.user?.org_id;
  return !!org && (row.org_id === org || row.owner_org_id === org);
}

/** Admin read: the scoped client's rules, straight from the DB (not the cache). */
export async function readScopedRules(req: AuthRequest): Promise<ResolvedAttendanceRules> {
  const row = await loadScopedClient(req);
  return resolveAttendanceRules(row.settings);
}

/**
 * Admin write: merge `patch` into `clients.settings.attendance_rules`, keeping
 * every other settings key. (Read-modify-write like the other settings writers
 * — a single-statement jsonb `||` would need a SQL function/migration.)
 */
export async function saveScopedRules(req: AuthRequest, patch: Partial<AttendanceRules>): Promise<ResolvedAttendanceRules> {
  const row = await loadScopedClient(req);
  const merged = mergeRulesIntoSettings(row.settings, patch);
  const { error } = await supabaseAdmin.from('clients').update({ settings: merged }).eq('id', row.id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  clearClientFlagCache(row.id);
  return resolveAttendanceRules(merged);
}

/**
 * Read-only rules for ANY authenticated user (GET /attendance/rules). A
 * client-pinned user is served from the cache; an org user with no client in
 * scope gets the unconfigured defaults (not an error — it's a convenience read
 * for the apps); an X-Client-Id header is ownership-checked.
 */
export async function readRulesForViewer(req: AuthRequest): Promise<ResolvedAttendanceRules> {
  const { clientId, pinned } = rulesClientScope(req);
  if (!clientId) return resolveAttendanceRules(null);
  if (pinned) return rulesForClient(clientId);
  const row = await loadScopedClient(req);
  return resolveAttendanceRules(row.settings);
}
