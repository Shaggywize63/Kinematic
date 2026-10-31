/**
 * Mode of transport — DB-facing half (the rules are transportMode.service.ts).
 *
 * The modes a person may pick come from THEIR resolved expense policy (`rules.vehicle_rates`), so this
 * reads the policy — but only when something actually needs it: a client whose `track_transport_mode`
 * rule is off never gets here, and an attendance row without a stored mode is never annotated.
 *
 * Nothing in this file throws on a policy read failure: a mode picker or a label must never break
 * attendance. Failures are logged and degrade to the default modes / a humanised label.
 */
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import { resolvePoliciesForUsers, resolvePolicyForUserId } from './expenses/policy.service';
import {
  buildTransportModes, extraTransportModesFromSettings, isFixedTransportMode, labelForTransportMode,
  type TransportMode,
} from './transportMode.service';

/** People per policy lookup (keeps the `id in (...)` URL short). */
const POLICY_LOOKUP_CHUNK = 100;

export interface TransportModeUser {
  id: string;
  org_id: string;
  client_id?: string | null;
}

export interface ResolvedTransportModes {
  modes: TransportMode[];
  /** False when the policy could not be read: `modes` is then only the defaults and must not be used to reject a request. */
  resolved: boolean;
}

/**
 * The admin-configured extra transport modes (e.g. Train, Walk) for a client, from
 * `clients.settings.attendance_rules.extra_transport_modes`. [] for a user with no client or when the
 * key isn't set, and never throws — a read failure just means no extras, not a broken picker.
 */
async function extraModesForClient(clientId: string | null | undefined): Promise<Array<{ id: string; label: string }>> {
  if (!clientId) return [];
  try {
    const { data } = await supabaseAdmin.from('clients').select('settings').eq('id', clientId).maybeSingle();
    return extraTransportModesFromSettings((data as { settings?: unknown } | null)?.settings);
  } catch (e) {
    logger.warn(`[transport-mode] could not read extra modes for client=${clientId}: ${(e as Error)?.message ?? e}`);
    return [];
  }
}

/** The modes `user` may pick (their policy's vehicles, then the client's extra modes, then public transport and other). */
export async function transportModesForUser(user: TransportModeUser): Promise<ResolvedTransportModes> {
  const extra = await extraModesForClient(user.client_id ?? null);
  try {
    const policy = await resolvePolicyForUserId(user.org_id, user.client_id ?? null, user.id);
    return { modes: buildTransportModes(policy.rules.vehicle_rates, extra), resolved: true };
  } catch (e) {
    logger.warn(`[transport-mode] could not resolve the expense policy for user=${user.id}: ${(e as Error)?.message ?? e}`);
    return { modes: buildTransportModes(null, extra), resolved: false };
  }
}

interface LabelledRow {
  user_id?: string | null;
  org_id?: string | null;
  client_id?: string | null;
  transport_mode?: unknown;
  transport_label?: unknown;
}

/**
 * Add `transport_label` IN PLACE to every attendance row that has a stored `transport_mode` (rows
 * without one are left untouched, so a client that never uses the feature sees no new key and costs no
 * query). A fixed id (public_transport / other) is labelled without any lookup; a vehicle id is labelled
 * from the row owner's expense policy, falling back to the id made readable.
 *
 * `fallback` supplies the org / client for rows that carry none (e.g. an admin-override row).
 */
export async function annotateTransportLabels<T extends LabelledRow>(
  rows: T[] | null | undefined,
  fallback: { orgId?: string | null; clientId?: string | null } = {},
): Promise<T[]> {
  const list = rows ?? [];
  const withMode = list.filter((r) => r && typeof r.transport_mode === 'string' && r.transport_mode);
  if (withMode.length === 0) return list;

  // Fixed ids and anything we cannot look up get a label straight away.
  const needPolicy = new Map<string, { orgId: string; clientId: string | null; rows: T[] }>();
  for (const r of withMode) {
    const mode = r.transport_mode as string;
    const orgId = r.org_id ?? fallback.orgId ?? null;
    if (isFixedTransportMode(mode) || !r.user_id || !orgId) {
      r.transport_label = labelForTransportMode(mode);
      continue;
    }
    const clientId = r.client_id ?? fallback.clientId ?? null;
    const key = `${orgId}|${clientId ?? ''}`;
    const group = needPolicy.get(key) ?? needPolicy.set(key, { orgId, clientId, rows: [] }).get(key)!;
    group.rows.push(r);
  }

  await Promise.all(Array.from(needPolicy.values()).map(async (g) => {
    // The client's own extra modes (Train, Walk, …) label those ids exactly, even if the policy read fails.
    const extra = await extraModesForClient(g.clientId);
    // Distinct people, in chunks: the lookup is an `id in (...)` filter and a long list overflows the URL.
    const people = Array.from(new Set(g.rows.map((r) => String(r.user_id))));
    let policies: Map<string, Awaited<ReturnType<typeof resolvePolicyForUserId>>> | null = null;
    try {
      const chunks: string[][] = [];
      for (let i = 0; i < people.length; i += POLICY_LOOKUP_CHUNK) chunks.push(people.slice(i, i + POLICY_LOOKUP_CHUNK));
      const maps = await Promise.all(chunks.map((ids) => resolvePoliciesForUsers(g.orgId, g.clientId, ids)));
      policies = new Map(maps.flatMap((m) => Array.from(m.entries())));
    } catch (e) {
      logger.warn(`[transport-mode] could not resolve policies to label modes: ${(e as Error)?.message ?? e}`);
    }
    for (const r of g.rows) {
      const modes = buildTransportModes(policies ? policies.get(String(r.user_id))?.rules.vehicle_rates : null, extra);
      r.transport_label = labelForTransportMode(r.transport_mode as string, modes);
    }
  }));
  return list;
}
