/**
 * Deal service: CRUD, stage moves, win/lose, history.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { validateAndStampCustomFields } from './customFields.service';
import type { Deal } from '../../types/crm.types';
import * as automations from './automations.service';

export async function listDeals(
  org_id: string,
  filters: Record<string, unknown> = {},
  client_id: string | null = null,
  options: { strictClient?: boolean } = {},
) {
  const { rows } = await listDealsWithCount(org_id, filters, client_id, options);
  return rows;
}

/**
 * Counts the full filter set in the same Supabase call as the page of
 * rows so the list endpoint can render real "Page N of M" pagination
 * without an extra round trip. Status is server-side here too — kanban
 * already passes status='open', and the list view passes the user's
 * picked status, so pagination always reflects the visible set.
 */
export async function listDealsWithCount(
  org_id: string,
  filters: Record<string, unknown> = {},
  client_id: string | null = null,
  options: { strictClient?: boolean; visibleOwnerIds?: string[] | null } = {},
): Promise<{ rows: Deal[]; total: number; page: number; limit: number }> {
  const limit = Math.min(Number(filters.limit ?? 50), 200);
  const page = Math.max(Number(filters.page ?? 1), 1);

  let q = supabaseAdmin.from('crm_deals').select('*, crm_deal_stages(name, stage_type, color)', { count: 'exact' })
    .eq('org_id', org_id).is('deleted_at', null);
  if (client_id) {
    q = options.strictClient
      ? q.eq('client_id', client_id)
      : q.or(`client_id.is.null,client_id.eq.${client_id}`);
  }
  // Hierarchy-RBAC scope: route passes the subtree owner ids only when
  // the caller's client has uses_hierarchy_rbac = true; otherwise null
  // and we keep the legacy unfiltered behaviour.
  if (options.visibleOwnerIds !== undefined && options.visibleOwnerIds !== null) {
    if (options.visibleOwnerIds.length === 0) return { rows: [], total: 0, page, limit };
    q = q.in('owner_id', options.visibleOwnerIds);
  }
  if (filters.pipeline_id) q = q.eq('pipeline_id', String(filters.pipeline_id));
  if (filters.stage_id) q = q.eq('stage_id', String(filters.stage_id));
  if (filters.owner_id) q = q.eq('owner_id', String(filters.owner_id));
  if (filters.account_id) q = q.eq('account_id', String(filters.account_id));
  if (filters.status) q = q.eq('status', String(filters.status));
  if (filters.q) q = q.ilike('name', `%${String(filters.q)}%`);
  if (filters.from) q = q.gte('created_at', String(filters.from));
  if (filters.to) q = q.lte('created_at', String(filters.to));
  // Sorting. An explicit whitelisted `sort` (+`order`) wins; otherwise fall back
  // to the historical default (soonest expected close first). Whitelisted so a
  // caller can only order by real, safe columns.
  const SORT_COLUMNS: Record<string, string> = {
    name: 'name', amount: 'amount', status: 'status',
    expected_close_date: 'expected_close_date', close_date: 'expected_close_date',
    stage: 'stage_id', created: 'created_at', created_at: 'created_at',
    updated: 'updated_at', updated_at: 'updated_at',
  };
  const sortKey = filters.sort ? String(filters.sort) : '';
  const ascending = String(filters.order ?? '').toLowerCase() === 'asc';
  if (sortKey && SORT_COLUMNS[sortKey]) {
    q = q.order(SORT_COLUMNS[sortKey], { ascending, nullsFirst: false });
  } else {
    q = q.order('expected_close_date', { ascending: true, nullsFirst: false });
  }
  q = q.range((page - 1) * limit, page * limit - 1);
  const { data, error, count } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return { rows: (data ?? []) as Deal[], total: count ?? 0, page, limit };
}

/**
 * Sum of value (amount) and volume (kg, from the weight view) across the
 * ENTIRE filtered set — not just the current page — so the deals page can
 * show an accurate total under pagination. Filters mirror listDealsWithCount.
 */
export async function dealsTotals(
  org_id: string,
  filters: Record<string, unknown> = {},
  client_id: string | null = null,
  options: { strictClient?: boolean; visibleOwnerIds?: string[] | null } = {},
): Promise<{ total_value: number; total_volume_kg: number; count: number }> {
  let q = supabaseAdmin.from('crm_deals')
    .select('amount, custom_fields, weight:crm_v_deal_weight(total_kg)')
    .eq('org_id', org_id).is('deleted_at', null);
  if (client_id) {
    q = options.strictClient
      ? q.eq('client_id', client_id)
      : q.or(`client_id.is.null,client_id.eq.${client_id}`);
  }
  if (options.visibleOwnerIds !== undefined && options.visibleOwnerIds !== null) {
    if (options.visibleOwnerIds.length === 0) return { total_value: 0, total_volume_kg: 0, count: 0 };
    q = q.in('owner_id', options.visibleOwnerIds);
  }
  if (filters.pipeline_id) q = q.eq('pipeline_id', String(filters.pipeline_id));
  if (filters.stage_id) q = q.eq('stage_id', String(filters.stage_id));
  if (filters.owner_id) q = q.eq('owner_id', String(filters.owner_id));
  if (filters.account_id) q = q.eq('account_id', String(filters.account_id));
  if (filters.status) q = q.eq('status', String(filters.status));
  if (filters.q) q = q.ilike('name', `%${String(filters.q)}%`);
  if (filters.from) q = q.gte('created_at', String(filters.from));
  if (filters.to) q = q.lte('created_at', String(filters.to));
  // Cap so a pathological org can't pull unbounded rows; totals on a set
  // larger than this are still representative for the header stat.
  q = q.limit(10000);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  let total_value = 0;
  let total_volume_kg = 0;
  for (const r of (data ?? []) as Array<{ amount?: number | null; custom_fields?: Record<string, unknown> | null; weight?: Array<{ total_kg?: number | string | null }> | { total_kg?: number | string | null } | null }>) {
    total_value += Number(r.amount ?? 0);
    // Volume captured on the deal (custom_fields.volume_kg) wins; fall back
    // to the line-items weight view for deals created through that path.
    const cfVol = r.custom_fields ? Number((r.custom_fields as Record<string, unknown>).volume_kg) : NaN;
    if (Number.isFinite(cfVol) && cfVol > 0) {
      total_volume_kg += cfVol;
    } else {
      const w = Array.isArray(r.weight) ? r.weight[0] : r.weight;
      total_volume_kg += Number(w?.total_kg ?? 0);
    }
  }
  return { total_value, total_volume_kg, count: (data ?? []).length };
}

export async function getDeal(org_id: string, id: string) {
  const { data, error } = await supabaseAdmin.from('crm_deals')
    .select('*, crm_deal_stages(name, stage_type, color, probability)')
    .eq('org_id', org_id).eq('id', id).is('deleted_at', null).single();
  if (error) throw new AppError(404, 'Deal not found', 'NOT_FOUND');
  return data;
}

/**
 * Resolve a sensible pipeline + opening stage when the caller didn't
 * supply one. Lead → deal conversions, CSV imports, mobile creates and
 * single-pipeline clients all hit this path: forcing a dropdown of one
 * option (or, worse, a 400 because pipeline_id is missing) is bad UX.
 *
 * Selection rule, in order:
 *   1. The single matching pipeline (if exactly one exists for the
 *      org/client scope) — that one is implicitly the default.
 *   2. The pipeline flagged `is_default = true`.
 *   3. The first pipeline (oldest by created_at) as last resort.
 *
 * `client_id` scoping mirrors the rest of the CRM: client-pinned
 * pipelines plus legacy NULL-stamped ones are both eligible.
 */
async function resolveDefaultPipeline(org_id: string, client_id?: string | null) {
  let q = supabaseAdmin.from('crm_pipelines')
    .select('id, is_default, client_id, created_at, crm_deal_stages(id, position, stage_type)')
    .eq('org_id', org_id).eq('is_active', true).is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (client_id) q = q.or(`client_id.is.null,client_id.eq.${client_id}`);
  const { data } = await q;
  const list = (data ?? []) as any[];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  // Prefer the tenant-owned default over the shared/global default — a
  // client that has explicitly picked their own default shouldn't fall
  // back to the platform's pipeline. If they haven't picked one, use the
  // shared default; otherwise the first pipeline in the list.
  return list.find((p) => p.is_default && p.client_id)
      ?? list.find((p) => p.is_default)
      ?? list[0];
}

export async function createDeal(org_id: string, payload: Partial<Deal>, user_id?: string) {
  let pipeline_id = payload.pipeline_id;
  let stage_id = payload.stage_id;

  // If the caller didn't pin a pipeline, fall back to the org/client's
  // default. Critical for: lead conversion (no UI to pick), mobile
  // create (form omits pipeline_id), CSV imports, and the "client has
  // only one pipeline" UX where forcing a dropdown is noise.
  if (!pipeline_id) {
    const chosen = await resolveDefaultPipeline(org_id, payload.client_id ?? null);
    if (!chosen) {
      throw new AppError(400, 'No pipeline configured for this organisation. Create a pipeline before adding deals.', 'NO_PIPELINE');
    }
    pipeline_id = chosen.id;
    if (!stage_id) {
      const stages = ((chosen as any).crm_deal_stages || [])
        // Open stages only, sorted by position — opening a deal directly
        // into a Won/Lost stage would skip the funnel.
        .filter((s: any) => s.stage_type !== 'won' && s.stage_type !== 'lost')
        .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
      stage_id = stages[0]?.id;
    }
  }

  const cleanedCustomFields = await validateAndStampCustomFields(
    org_id, payload.client_id ?? null, 'deal', payload.custom_fields,
  );

  const insertRow = {
    org_id,
    client_id: payload.client_id ?? null,
    pipeline_id, stage_id,
    name: payload.name,
    account_id: payload.account_id ?? null,
    primary_contact_id: payload.primary_contact_id ?? null,
    lead_id: payload.lead_id ?? null,
    amount: payload.amount ?? 0,
    currency: payload.currency ?? 'INR',
    expected_close_date: payload.expected_close_date ?? null,
    probability: payload.probability ?? null,
    owner_id: payload.owner_id ?? null,
    source_id: payload.source_id ?? null,
    next_step: payload.next_step ?? null,
    tags: payload.tags ?? [],
    custom_fields: cleanedCustomFields,
    created_by: user_id ?? null,
  };
  const { data, error } = await supabaseAdmin.from('crm_deals').insert(insertRow).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  await supabaseAdmin.from('crm_deal_history').insert({
    deal_id: data.id, org_id, from_stage_id: null, to_stage_id: data.stage_id,
    from_amount: 0, to_amount: data.amount, changed_by: user_id ?? null,
  });
  automations.fireForTrigger('deal_created', {
    org_id, user_id, entity: 'deal', entity_id: data.id,
    data: { deal: data, client_id: (data as { client_id?: string | null }).client_id ?? null },
  }).catch(() => {});
  return data as Deal;
}

export async function updateDeal(org_id: string, id: string, payload: Partial<Deal>, user_id?: string) {
  const before = await getDeal(org_id, id);
  // Per-type validate + stamp formulas. Merging the incoming patch on top
  // of the existing blob means a formula referencing fields the rep didn't
  // touch in this PATCH still recomputes against current state.
  if (payload.custom_fields !== undefined) {
    const beforeCf = ((before as Deal & { custom_fields?: Record<string, unknown> | null }).custom_fields ?? {});
    const merged = { ...beforeCf, ...payload.custom_fields };
    payload.custom_fields = await validateAndStampCustomFields(
      org_id, (before as { client_id?: string | null }).client_id ?? null, 'deal', merged,
    );
  }
  const update = { ...payload, updated_by: user_id ?? null };
  // When the rep moves the deal into a won/lost stage, stamp
  // actual_close_date so the salesCycle + forecast reports can read
  // it. Without this every deal stayed null and both reports were
  // permanently empty. winDeal()/loseDeal() already set this
  // explicitly; this catches the case where the rep just dragged the
  // card to a won/lost stage via moveStage / kanban.
  if (payload.stage_id && payload.stage_id !== before.stage_id && !(update as Record<string, unknown>).actual_close_date) {
    const { data: stage } = await supabaseAdmin.from('crm_deal_stages')
      .select('stage_type').eq('id', payload.stage_id).maybeSingle();
    if (stage?.stage_type === 'won' || stage?.stage_type === 'lost') {
      (update as Record<string, unknown>).actual_close_date = new Date().toISOString().slice(0, 10);
    }
  }
  const { data, error } = await supabaseAdmin.from('crm_deals').update(update)
    .eq('org_id', org_id).eq('id', id).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  if (before.amount !== data.amount || before.stage_id !== data.stage_id) {
    const last = await lastHistory(org_id, id);
    const tip = last ? Math.round((Date.now() - new Date(last.changed_at).getTime()) / 1000) : null;
    await supabaseAdmin.from('crm_deal_history').insert({
      deal_id: id, org_id,
      from_stage_id: before.stage_id, to_stage_id: data.stage_id,
      from_amount: before.amount, to_amount: data.amount,
      changed_by: user_id ?? null, time_in_previous_stage_seconds: tip,
    });
  }

  // Closed-quantity edits — record one history entry per PATCH so the
  // deal-detail timeline shows when the rep last updated closed numbers
  // and which products moved. We compare the before/after maps and emit
  // a single human-readable note like
  //   "Updated closed quantities: Tiscon 32mm: 0 → 5, Tiscon 25mm: 2 → 3"
  // — capped at 4 products + "…" so the note stays printable.
  try {
    const beforeCf = ((before as Deal & { custom_fields?: Record<string, unknown> | null }).custom_fields ?? {}) as Record<string, unknown>;
    const afterCf  = ((data   as Deal & { custom_fields?: Record<string, unknown> | null }).custom_fields ?? {}) as Record<string, unknown>;
    const beforeClosed = (beforeCf.closed_quantities as Record<string, unknown>) ?? {};
    const afterClosed  = (afterCf.closed_quantities  as Record<string, unknown>) ?? {};
    const beforeJson = JSON.stringify(sortKeys(beforeClosed));
    const afterJson  = JSON.stringify(sortKeys(afterClosed));
    if (beforeJson !== afterJson) {
      const changed: Array<{ pid: string; from: number; to: number }> = [];
      const allPids = new Set([...Object.keys(beforeClosed), ...Object.keys(afterClosed)]);
      for (const pid of allPids) {
        const fromN = Number(beforeClosed[pid] ?? 0);
        const toN   = Number(afterClosed[pid]  ?? 0);
        if (fromN !== toN) changed.push({ pid, from: fromN, to: toN });
      }
      if (changed.length > 0) {
        const pids = changed.map((c) => c.pid);
        const { data: products } = await supabaseAdmin.from('crm_products')
          .select('id, name').eq('org_id', org_id).in('id', pids);
        const nameById = new Map((products ?? []).map((p) => [p.id as string, (p.name as string) || (p.id as string).slice(0, 8)]));
        const parts = changed.slice(0, 4).map((c) => `${nameById.get(c.pid) ?? c.pid.slice(0, 8)}: ${c.from} → ${c.to}`);
        const more = changed.length > 4 ? `, +${changed.length - 4} more` : '';
        await supabaseAdmin.from('crm_deal_history').insert({
          deal_id: id, org_id,
          from_stage_id: data.stage_id, to_stage_id: data.stage_id,
          from_amount: data.amount, to_amount: data.amount,
          changed_by: user_id ?? null,
          note: `Updated closed quantities: ${parts.join(', ')}${more}`,
        });
      }
    }
  } catch { /* non-fatal — the deal update itself succeeded */ }

  // Fire deal automations centrally — winDeal / loseDeal / moveStage / kanban
  // drag all route through updateDeal, so this one place covers every path.
  const dealClientId = (before as { client_id?: string | null }).client_id
    ?? (data as { client_id?: string | null }).client_id ?? null;
  if (before.stage_id !== data.stage_id) {
    automations.fireForTrigger('deal_stage_changed', {
      org_id, user_id, entity: 'deal', entity_id: id,
      data: { deal: data, before, after: data, old_stage_id: before.stage_id, new_stage_id: data.stage_id, client_id: dealClientId },
    }).catch(() => {});
  }
  if (data.status === 'won' && before.status !== 'won') {
    automations.fireForTrigger('deal_won', {
      org_id, user_id, entity: 'deal', entity_id: id,
      data: { deal: data, before, client_id: dealClientId },
    }).catch(() => {});
  }
  if (data.status === 'lost' && before.status !== 'lost') {
    automations.fireForTrigger('deal_lost', {
      org_id, user_id, entity: 'deal', entity_id: id,
      data: { deal: data, before, lost_reason: (data as { lost_reason?: string | null }).lost_reason ?? null, client_id: dealClientId },
    }).catch(() => {});
  }

  return data as Deal;
}

// Deterministic key sort so JSON.stringify diffs aren't fooled by key
// order. Only one level deep — the closed_quantities map is flat.
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, k) => {
    acc[k] = obj[k];
    return acc;
  }, {});
}

export async function deleteDeal(org_id: string, id: string) {
  const { error } = await supabaseAdmin.from('crm_deals')
    .update({ deleted_at: new Date().toISOString() }).eq('org_id', org_id).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
}

export async function moveStage(org_id: string, id: string, stage_id: string, user_id?: string) {
  return updateDeal(org_id, id, { stage_id }, user_id);
}

export async function winDeal(org_id: string, id: string, payload: { actual_close_date?: string | null; amount?: number }, user_id?: string) {
  const deal = await getDeal(org_id, id);
  const { data: wonStage } = await supabaseAdmin.from('crm_deal_stages')
    .select('id').eq('pipeline_id', deal.pipeline_id).eq('stage_type', 'won').limit(1).single();
  // Won amount: caller's explicit value wins. Otherwise compute the
  // actual closed value from custom_fields.closed_quantities (filled in
  // on the deal Products card) using the linked lead's product_lines
  // for the price / weight / unit context. Falls back to the existing
  // deal.amount when neither is available — same number the rep saw on
  // the open deal before they marked it won.
  let nextAmount: number | null | undefined = payload.amount;
  if (nextAmount == null) {
    nextAmount = await computeClosedAmount(org_id, deal) ?? deal.amount;
  }
  return updateDeal(org_id, id, {
    stage_id: wonStage.id,
    // Explicit status flip so the deals list, dashboard filters, and
    // analytics that key on `status` (not stage_type) all see "won"
    // immediately — without this the column stayed at 'open' until a
    // separate cron / trigger reconciled it.
    status: 'won',
    actual_close_date: payload.actual_close_date ?? new Date().toISOString().slice(0, 10),
    amount: nextAmount,
  } as Partial<Deal>, user_id);
}

/**
 * Sum (price / weight_kg) × (closed_qty × unitFactor) across the deal's
 * closed_quantities map, joined against the linked lead's product_lines
 * for the unit (kg / tonne) on each line and the products catalogue for
 * price + weight. Returns null when there's nothing to compute — caller
 * decides the fallback.
 */
async function computeClosedAmount(
  org_id: string,
  deal: Deal,
): Promise<number | null> {
  const dealCf = ((deal as Deal & { custom_fields?: Record<string, unknown> | null }).custom_fields ?? {}) as Record<string, unknown>;
  const closed = (dealCf.closed_quantities as Record<string, unknown> | undefined) ?? {};
  const closedPids = Object.entries(closed)
    .filter(([, v]) => Number(v) > 0)
    .map(([k]) => k);
  if (closedPids.length === 0) return null;

  // Pull the unit on each line from the linked lead (if any) so a Tonne
  // line stays a Tonne when we multiply.
  let unitByPid = new Map<string, string>();
  const leadId = (deal as Deal & { lead_id?: string | null }).lead_id ?? null;
  if (leadId) {
    const { data: lead } = await supabaseAdmin.from('crm_leads')
      .select('custom_fields').eq('org_id', org_id).eq('id', leadId).maybeSingle();
    const leadCf = ((lead?.custom_fields as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
    const lines = leadCf.product_lines;
    if (Array.isArray(lines)) {
      for (const l of lines as Array<Record<string, unknown>>) {
        const pid = typeof l.product_id === 'string' ? l.product_id : '';
        const unit = typeof l.measuring_unit === 'string' ? l.measuring_unit : '';
        if (pid) unitByPid.set(pid, unit);
      }
    }
  }

  // Batch-fetch the product catalogue rows we need.
  const { data: products } = await supabaseAdmin.from('crm_products')
    .select('id, price, weight_kg').eq('org_id', org_id).in('id', closedPids);
  const byId = new Map((products ?? []).map((p) => [p.id as string, p]));

  let total = 0;
  for (const pid of closedPids) {
    const p = byId.get(pid) as { price?: number | string | null; weight_kg?: number | string | null } | undefined;
    const price = Number(p?.price ?? 0);
    const weight = Number(p?.weight_kg ?? 0);
    const qty = Number(closed[pid] ?? 0);
    if (price <= 0 || weight <= 0 || qty <= 0) continue;
    const unit = (unitByPid.get(pid) ?? '').trim().toLowerCase();
    const factor = unit === 'tonne' ? 1000 : 1;
    total += (price / weight) * (qty * factor);
  }
  return total > 0 ? Math.round(total * 100) / 100 : null;
}

export async function loseDeal(org_id: string, id: string, payload: { actual_close_date?: string | null; lost_reason?: string }, user_id?: string) {
  const deal = await getDeal(org_id, id);
  const { data: lostStage } = await supabaseAdmin.from('crm_deal_stages')
    .select('id').eq('pipeline_id', deal.pipeline_id).eq('stage_type', 'lost').limit(1).single();
  return updateDeal(org_id, id, {
    stage_id: lostStage.id,
    status: 'lost',
    actual_close_date: payload.actual_close_date ?? new Date().toISOString().slice(0, 10),
    lost_reason: payload.lost_reason ?? null,
  } as Partial<Deal>, user_id);
}

/**
 * Returns the deal's audit trail enriched for the frontend.
 *
 * The raw `crm_deal_history` table stores stage transitions as UUIDs
 * (`from_stage_id` / `to_stage_id`) and timestamps the row with
 * `changed_at`. The CRM detail page's history card expects:
 *   - human-readable stage NAMES (so it can render "Qualification → Proposal")
 *   - an `event_type` discriminator ("stage_changed", "amount_changed",
 *     "created") to drive the row label
 *   - `created_at` as the timestamp (matches its date formatter)
 *
 * We resolve stage IDs → names in a single batched lookup against
 * `crm_deal_stages`, then derive the event type from which fields
 * changed. Rows for deals with no stage transitions still pass through
 * (they'll show as "Updated" with timestamp only).
 */
export async function dealHistory(org_id: string, id: string) {
  const { data, error } = await supabaseAdmin.from('crm_deal_history')
    .select('*').eq('org_id', org_id).eq('deal_id', id)
    .order('changed_at', { ascending: false }).limit(100);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = data ?? [];
  if (rows.length === 0) return rows;

  const stageIds = Array.from(new Set(
    rows.flatMap((r: any) => [r.from_stage_id, r.to_stage_id]).filter(Boolean),
  )) as string[];
  const nameById = new Map<string, string>();
  if (stageIds.length > 0) {
    const { data: stages } = await supabaseAdmin.from('crm_deal_stages')
      .select('id, name').in('id', stageIds);
    (stages ?? []).forEach((s: any) => nameById.set(s.id, s.name));
  }

  return rows.map((r: any) => {
    const fromStage = r.from_stage_id ? nameById.get(r.from_stage_id) ?? null : null;
    const toStage   = r.to_stage_id   ? nameById.get(r.to_stage_id)   ?? null : null;
    const stageChanged = r.from_stage_id !== r.to_stage_id;
    const amountChanged = Number(r.from_amount ?? 0) !== Number(r.to_amount ?? 0);

    let event_type: string;
    if (!r.from_stage_id && r.to_stage_id) event_type = 'created';
    else if (stageChanged) event_type = 'stage_changed';
    else if (amountChanged) event_type = 'amount_changed';
    else if (r.note) event_type = 'note';
    else event_type = 'updated';

    return {
      ...r,
      event_type,
      from_stage: fromStage,
      to_stage: toStage,
      created_at: r.changed_at,
    };
  });
}

async function lastHistory(org_id: string, deal_id: string) {
  const { data } = await supabaseAdmin.from('crm_deal_history')
    .select('changed_at').eq('org_id', org_id).eq('deal_id', deal_id)
    .order('changed_at', { ascending: false }).limit(1).maybeSingle();
  return data;
}
