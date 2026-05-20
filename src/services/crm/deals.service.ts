/**
 * Deal service: CRUD, stage moves, win/lose, history.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import type { Deal } from '../../types/crm.types';

export async function listDeals(
  org_id: string,
  filters: Record<string, unknown> = {},
  client_id: string | null = null,
  options: { strictClient?: boolean } = {},
) {
  let q = supabaseAdmin.from('crm_deals').select('*, crm_deal_stages(name, stage_type, color)')
    .eq('org_id', org_id).is('deleted_at', null);
  if (client_id) {
    q = options.strictClient
      ? q.eq('client_id', client_id)
      : q.or(`client_id.is.null,client_id.eq.${client_id}`);
  }
  if (filters.pipeline_id) q = q.eq('pipeline_id', String(filters.pipeline_id));
  if (filters.stage_id) q = q.eq('stage_id', String(filters.stage_id));
  if (filters.owner_id) q = q.eq('owner_id', String(filters.owner_id));
  if (filters.account_id) q = q.eq('account_id', String(filters.account_id));
  if (filters.q) q = q.ilike('name', `%${String(filters.q)}%`);
  if (filters.from) q = q.gte('created_at', String(filters.from));
  if (filters.to) q = q.lte('created_at', String(filters.to));
  const limit = Math.min(Number(filters.limit ?? 50), 200);
  const page = Math.max(Number(filters.page ?? 1), 1);
  q = q.order('expected_close_date', { ascending: true, nullsFirst: false })
       .range((page - 1) * limit, page * limit - 1);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data ?? [];
}

export async function getDeal(org_id: string, id: string) {
  const { data, error } = await supabaseAdmin.from('crm_deals')
    .select('*, crm_deal_stages(name, stage_type, color, probability)')
    .eq('org_id', org_id).eq('id', id).is('deleted_at', null).single();
  if (error) throw new AppError(404, 'Deal not found', 'NOT_FOUND');
  return data;
}

export async function createDeal(org_id: string, payload: Partial<Deal>, user_id?: string) {
  const insertRow = {
    org_id,
    client_id: payload.client_id ?? null,
    pipeline_id: payload.pipeline_id, stage_id: payload.stage_id,
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
    custom_fields: payload.custom_fields ?? {},
    created_by: user_id ?? null,
  };
  const { data, error } = await supabaseAdmin.from('crm_deals').insert(insertRow).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  await supabaseAdmin.from('crm_deal_history').insert({
    deal_id: data.id, org_id, from_stage_id: null, to_stage_id: data.stage_id,
    from_amount: 0, to_amount: data.amount, changed_by: user_id ?? null,
  });
  return data as Deal;
}

export async function updateDeal(org_id: string, id: string, payload: Partial<Deal>, user_id?: string) {
  const before = await getDeal(org_id, id);
  const update = { ...payload, updated_by: user_id ?? null };
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
  return data as Deal;
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
  return updateDeal(org_id, id, {
    stage_id: wonStage.id,
    actual_close_date: payload.actual_close_date ?? new Date().toISOString().slice(0, 10),
    amount: payload.amount ?? deal.amount,
  } as Partial<Deal>, user_id);
}

export async function loseDeal(org_id: string, id: string, payload: { actual_close_date?: string | null; lost_reason?: string }, user_id?: string) {
  const deal = await getDeal(org_id, id);
  const { data: lostStage } = await supabaseAdmin.from('crm_deal_stages')
    .select('id').eq('pipeline_id', deal.pipeline_id).eq('stage_type', 'lost').limit(1).single();
  return updateDeal(org_id, id, {
    stage_id: lostStage.id,
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

  // Batch-resolve every stage UUID referenced in this trail. One round-trip
  // beats N+1 per row, and the set is bounded by the deal's lifetime
  // (typically <20 transitions).
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
    else event_type = 'updated';

    return {
      ...r,
      event_type,
      from_stage: fromStage,
      to_stage: toStage,
      // Alias `changed_at` as `created_at` so generic timeline renderers
      // (frontend uses `created_at`) work without a backend-aware helper.
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
