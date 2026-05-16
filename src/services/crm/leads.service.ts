/**
 * Lead service: CRUD, dedup, scoring orchestration, conversion.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError, sanitisePostgrestSearch } from '../../utils';
import * as scoring from './ai/leadScoring.service';
import * as dedup from './dedup.service';
import * as assignment from './assignment.service';
import { triggerEdgeFunction } from './edge.client';
import type { Lead, LeadStatus } from '../../types/crm.types';

export interface CreateLeadInput {
  org_id: string;
  user_id?: string;
  payload: Partial<Lead>;
  skipDedup?: boolean;
}

export async function createLead({ org_id, user_id, payload, skipDedup }: CreateLeadInput) {
  if (!skipDedup && payload.email) {
    const dup = await dedup.findLeadByEmail(org_id, payload.email);
    if (dup) {
      throw new AppError(409, `A lead with this email already exists (id=${dup.id})`, 'DUPLICATE_LEAD');
    }
  }

  const owner_id = payload.owner_id ?? (await assignment.assignOwner(org_id, payload));
  // Use client-specific ICP if the lead has a client_id stamped, else fall back to org-level.
  const { score, breakdown } = scoring.computeHeuristic(payload, await scoring.getIcp(org_id, payload.client_id ?? null));

  const p = payload as Record<string, unknown>;
  const nowIso = new Date().toISOString();
  const insertRow = {
    org_id,
    client_id: payload.client_id ?? null,
    first_name: payload.first_name ?? null,
    last_name: payload.last_name ?? null,
    email: payload.email ?? null,
    phone: payload.phone ?? null,
    company: payload.company ?? null,
    title: payload.title ?? null,
    source_id: payload.source_id ?? null,
    status: (payload.status as LeadStatus) ?? 'new',
    // Funnel position. Defaults to 'lead' at the DB level — only set
    // explicitly when the caller wants to start somewhere else (e.g. an
    // inbound subscriber form would set 'subscriber').
    lifecycle_stage: (p.lifecycle_stage as string | undefined) ?? undefined,
    owner_id,
    score,
    score_breakdown: breakdown,
    score_updated_at: nowIso,
    // Baseline for SLA tracking. Every lead starts "now" so the stuck-leads
    // query has a deterministic clock from creation. Bumped on every status
    // flip in updateLead.
    stage_changed_at: nowIso,
    country: payload.country ?? null,
    city: payload.city ?? null,
    industry: payload.industry ?? null,
    notes: payload.notes ?? null,
    tags: payload.tags ?? [],
    custom_fields: payload.custom_fields ?? {},
    // Campaign attribution — optional, only populated for inbound vectors
    // that actually carry UTM params (web form, ad click, email link).
    utm_source:   (p.utm_source   as string | undefined) ?? null,
    utm_medium:   (p.utm_medium   as string | undefined) ?? null,
    utm_campaign: (p.utm_campaign as string | undefined) ?? null,
    utm_term:     (p.utm_term     as string | undefined) ?? null,
    utm_content:  (p.utm_content  as string | undefined) ?? null,
    referrer_url: (p.referrer_url as string | undefined) ?? null,
    landing_page: (p.landing_page as string | undefined) ?? null,
    created_by: user_id ?? null,
  };

  const { data, error } = await supabaseAdmin.from('crm_leads').insert(insertRow).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  await supabaseAdmin.from('crm_lead_scores').insert({
    lead_id: data.id, org_id, score, model: 'heuristic_v1', breakdown,
  });

  triggerEdgeFunction('crm-rescore-lead', { lead_id: data.id, org_id }).catch(() => {});

  return data as Lead;
}

export async function listLeads(
  org_id: string,
  filters: Record<string, unknown> = {},
  client_id: string | null = null,
  options: { strictClient?: boolean } = {},
) {
  let q = supabaseAdmin.from('crm_leads').select('*')
    .eq('org_id', org_id).is('deleted_at', null);
  // Client scoping:
  //  - strictClient = true  -> only the caller's exact client_id
  //    (used for JWT-pinned client-level users; prevents legacy
  //    NULL-stamped leads from leaking across tenants).
  //  - strictClient = false -> rows already stamped with that
  //    client_id PLUS legacy NULL rows (used when an org-level
  //    admin picks a client from the global header picker, so they
  //    can administer the legacy data).
  if (client_id) {
    q = options.strictClient
      ? q.eq('client_id', client_id)
      : q.or(`client_id.is.null,client_id.eq.${client_id}`);
  }
  if (filters.status) q = q.eq('status', String(filters.status));
  if (filters.lifecycle_stage) q = q.eq('lifecycle_stage', String(filters.lifecycle_stage));
  if (filters.owner_id) q = q.eq('owner_id', String(filters.owner_id));
  if (filters.source_id) q = q.eq('source_id', String(filters.source_id));
  if (filters.score_gte) q = q.gte('score', Number(filters.score_gte));
  // UTM filters — used by source-ROI reports and saved searches.
  if (filters.utm_source)   q = q.eq('utm_source',   String(filters.utm_source));
  if (filters.utm_campaign) q = q.eq('utm_campaign', String(filters.utm_campaign));
  // Location hierarchy filters (state → city → district → block). Each level
  // is optional; backend applies whichever the picker has selected. Values
  // come from the crm_client_locations reference table, so exact match is
  // correct — partial ilike would let "Mumb" leak into "Mumbai".
  if (filters.state)    q = q.eq('state',    String(filters.state));
  if (filters.city)     q = q.eq('city',     String(filters.city));
  if (filters.district) q = q.eq('district', String(filters.district));
  if (filters.block)    q = q.eq('block',    String(filters.block));
  if (filters.q) {
    // Sanitise user-supplied search before interpolating into the .or()
    // filter. See utils/postgrest.ts for the threat model.
    const s = sanitisePostgrestSearch(filters.q);
    if (s) q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,company.ilike.%${s}%,email.ilike.%${s}%`);
  }
  // Date range filter (default column: created_at)
  if (filters.from) q = q.gte('created_at', String(filters.from));
  if (filters.to) q = q.lte('created_at', String(filters.to));
  const limit = Math.min(Number(filters.limit ?? 50), 200);
  const page = Math.max(Number(filters.page ?? 1), 1);
  q = q.order('score', { ascending: false }).order('created_at', { ascending: false })
       .range((page - 1) * limit, page * limit - 1);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []) as Lead[];
}

/**
 * "Stuck" leads — open leads whose stage hasn't moved in N days. Drives the
 * SLA aging dashboard so reps can see what's stalling. Excludes terminal
 * statuses (converted / lost / unqualified) because those are intentionally
 * not moving.
 */
export async function listStuckLeads(
  org_id: string,
  days: number,
  client_id: string | null = null,
  options: { strictClient?: boolean } = {},
) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let q = supabaseAdmin.from('crm_leads').select('*')
    .eq('org_id', org_id)
    .is('deleted_at', null)
    .in('status', ['new', 'working', 'nurturing', 'qualified'])
    .lt('stage_changed_at', cutoff);
  if (client_id) {
    q = options.strictClient
      ? q.eq('client_id', client_id)
      : q.or(`client_id.is.null,client_id.eq.${client_id}`);
  }
  q = q.order('stage_changed_at', { ascending: true }).limit(200);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []) as Lead[];
}

export async function getLead(org_id: string, id: string) {
  const { data, error } = await supabaseAdmin.from('crm_leads').select('*')
    .eq('org_id', org_id).eq('id', id).is('deleted_at', null).single();
  if (error) throw new AppError(404, 'Lead not found', 'NOT_FOUND');
  return data as Lead;
}

export async function updateLead(org_id: string, id: string, payload: Partial<Lead>, user_id?: string) {
  const before = await getLead(org_id, id);

  // If the caller is transitioning the lead into a disqualified state for
  // the first time, stamp disqualified_at server-side. We don't trust the
  // client to set it (and we don't want to overwrite a previous stamp if
  // the lead bounces between unqualified ↔ working).
  const DISQUALIFIED_STATES: LeadStatus[] = ['unqualified', 'lost'];
  const nowIso = new Date().toISOString();
  const enteringDisqualified =
    payload.status !== undefined
    && DISQUALIFIED_STATES.includes(payload.status as LeadStatus)
    && !DISQUALIFIED_STATES.includes(before.status as LeadStatus);

  const update: Record<string, unknown> = {
    ...payload,
    updated_by: user_id ?? null,
    updated_at: nowIso,
  };
  if (enteringDisqualified && (before as Record<string, unknown>).disqualified_at == null) {
    update.disqualified_at = nowIso;
  }

  // Stamp stage_changed_at on every status flip. Powers the SLA aging
  // dashboard + the listStuckLeads() query. Note: this fires on ALL
  // status transitions including into terminal states, so e.g. converted
  // leads have their stage_changed_at = their conversion moment — useful
  // for "time-to-convert" analytics.
  if (payload.status !== undefined && payload.status !== before.status) {
    update.stage_changed_at = nowIso;
  }

  const { data, error } = await supabaseAdmin.from('crm_leads')
    .update(update).eq('org_id', org_id).eq('id', id).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  if (before.status !== data.status) {
    await supabaseAdmin.from('crm_lead_history').insert({
      lead_id: id, org_id, field: 'status',
      old_value: before.status, new_value: data.status, changed_by: user_id ?? null,
    });

    // When the transition is into a disqualified state, also write a
    // dedicated 'disqualified' row carrying the lost_reason so reports
    // keyed on disqualification have a single canonical event to join
    // against (rather than scraping the status-change row + lost_reason
    // column separately).
    if (enteringDisqualified) {
      const reason =
        (payload as Record<string, unknown>).lost_reason
        ?? (data as Record<string, unknown>).lost_reason
        ?? null;
      await supabaseAdmin.from('crm_lead_history').insert({
        lead_id: id, org_id, field: 'disqualified',
        old_value: before.status, new_value: { status: data.status, lost_reason: reason },
        changed_by: user_id ?? null,
      });
    }
  }

  // Audit lifecycle_stage transitions separately from status. Same
  // history table, different `field` so funnel-conversion reports
  // (MQL→SQL→customer) can be built without intermixing workflow noise.
  const beforeStage = (before as Record<string, unknown>).lifecycle_stage;
  const afterStage  = (data   as Record<string, unknown>).lifecycle_stage;
  if (beforeStage !== afterStage) {
    await supabaseAdmin.from('crm_lead_history').insert({
      lead_id: id, org_id, field: 'lifecycle_stage',
      old_value: beforeStage, new_value: afterStage, changed_by: user_id ?? null,
    });
  }

  if (before.owner_id !== data.owner_id) {
    await supabaseAdmin.from('crm_lead_history').insert({
      lead_id: id, org_id, field: 'owner_id',
      old_value: before.owner_id, new_value: data.owner_id, changed_by: user_id ?? null,
    });
  }

  const profileChanged = ['title','company','industry','country','source_id'].some(k =>
    (payload as Record<string, unknown>)[k] !== undefined);
  if (profileChanged) {
    triggerEdgeFunction('crm-rescore-lead', { lead_id: id, org_id }).catch(() => {});
  }

  return data as Lead;
}

export async function deleteLead(org_id: string, id: string) {
  const { error } = await supabaseAdmin.from('crm_leads')
    .update({ deleted_at: new Date().toISOString() }).eq('org_id', org_id).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
}

export async function rescoreLead(org_id: string, id: string) {
  const lead = await getLead(org_id, id);
  const { score, breakdown } = scoring.computeHeuristic(lead, await scoring.getIcp(org_id));
  await supabaseAdmin.from('crm_leads').update({
    score, score_breakdown: breakdown, score_updated_at: new Date().toISOString(),
  }).eq('id', id).eq('org_id', org_id);
  await supabaseAdmin.from('crm_lead_scores').insert({
    lead_id: id, org_id, score, model: 'heuristic_v1', breakdown,
  });
  triggerEdgeFunction('crm-rescore-lead', { lead_id: id, org_id }).catch(() => {});
  return { score, breakdown };
}

export async function convertLead(org_id: string, id: string, opts: {
  create_deal?: boolean; deal_name?: string; deal_amount?: number;
  // Optional weight-based deal sizing — when both `deal_volume_kg` and
  // `deal_product_id` are passed, the deal amount is computed from the
  // product's price + weight_kg (volume / weight × price). Anything passed
  // in `deal_amount` wins if also present.
  deal_volume_kg?: number; deal_product_id?: string;
  pipeline_id?: string; stage_id?: string;
}, user_id?: string) {
  const lead = await getLead(org_id, id);
  if (lead.status === 'converted') throw new AppError(400, 'Lead already converted', 'ALREADY_CONVERTED');

  let account_id: string | null = null;
  if (lead.company) {
    const domain = lead.email?.split('@')[1] || null;
    const { data: existingAccount } = await supabaseAdmin.from('crm_accounts').select('id')
      .eq('org_id', org_id).eq('name', lead.company).is('deleted_at', null).maybeSingle();
    if (existingAccount?.id) {
      account_id = existingAccount.id;
    } else {
      const { data: acc, error: accErr } = await supabaseAdmin.from('crm_accounts').insert({
        org_id, name: lead.company, domain, industry: lead.industry, owner_id: lead.owner_id,
        created_by: user_id ?? null,
      }).select('id').single();
      if (accErr) throw new AppError(500, accErr.message, 'DB_ERROR');
      account_id = acc.id;
    }
  }

  let contact_id: string | null = null;
  if (lead.email) {
    const { data: existingContact } = await supabaseAdmin.from('crm_contacts').select('id')
      .eq('org_id', org_id).eq('email', lead.email).is('deleted_at', null).maybeSingle();
    if (existingContact?.id) {
      contact_id = existingContact.id;
    } else {
      const { data: c, error: cErr } = await supabaseAdmin.from('crm_contacts').insert({
        org_id, account_id,
        first_name: lead.first_name, last_name: lead.last_name, email: lead.email,
        phone: lead.phone, title: lead.title, owner_id: lead.owner_id,
        created_by: user_id ?? null,
      }).select('id').single();
      if (cErr) throw new AppError(500, cErr.message, 'DB_ERROR');
      contact_id = c.id;
    }
  }

  let deal_id: string | null = null;
  if (opts.create_deal !== false) {
    const pipeline_id = opts.pipeline_id || await getDefaultPipelineId(org_id);
    const stage_id = opts.stage_id || await getFirstOpenStageId(pipeline_id);

    // Resolve deal amount. Explicit deal_amount wins; otherwise derive from
    // (volume × product.price / product.weight_kg) when those are passed.
    let amount = opts.deal_amount ?? 0;
    if ((amount == null || amount === 0) && opts.deal_volume_kg && opts.deal_product_id) {
      const { data: product } = await supabaseAdmin.from('crm_products')
        .select('price, weight_kg').eq('id', opts.deal_product_id).eq('org_id', org_id).maybeSingle();
      if (product?.price && product?.weight_kg) {
        const ppk = Number(product.price) / Number(product.weight_kg);
        amount = Math.round(Number(opts.deal_volume_kg) * ppk);
      }
    }

    const { data: deal, error: dErr } = await supabaseAdmin.from('crm_deals').insert({
      org_id, pipeline_id, stage_id,
      name: opts.deal_name || `${lead.company || lead.email || 'New deal'} — Opportunity`,
      account_id, primary_contact_id: contact_id, lead_id: id,
      amount, owner_id: lead.owner_id, source_id: lead.source_id,
      created_by: user_id ?? null,
    }).select('id').single();
    if (dErr) throw new AppError(500, dErr.message, 'DB_ERROR');
    deal_id = deal.id;
  }

  // Flip is_converted alongside status='converted' + the converted_* FKs.
  // The boolean is what downstream funnel reports filter on (status is
  // mutable from the UI; is_converted is the canonical lifecycle flag).
  // Also bump lifecycle_stage → 'customer' so the HubSpot-style funnel
  // (lead → MQL → SQL → customer) is consistent with the workflow status.
  const nowIso = new Date().toISOString();
  await supabaseAdmin.from('crm_leads').update({
    status: 'converted',
    is_converted: true,
    lifecycle_stage: 'customer',
    converted_at: nowIso,
    converted_account_id: account_id, converted_contact_id: contact_id, converted_deal_id: deal_id,
    stage_changed_at: nowIso,
    updated_by: user_id ?? null,
  }).eq('org_id', org_id).eq('id', id);

  return { lead_id: id, account_id, contact_id, deal_id };
}

/**
 * Reopen a lead that was previously disqualified (lost/unqualified) or
 * converted. Flips the row back to 'working' and clears every
 * lifecycle-terminal field (lost_reason, disqualified_at, converted_*
 * FKs, is_converted, converted_at).
 *
 * Important: this does NOT delete the previously-converted deal /
 * contact / account records. The reopen just *disconnects* the lead
 * from them so the rep can re-work the lead — the user might convert
 * it again later to a new or existing deal. Leaving the downstream
 * entities intact also preserves any activity history / pipeline
 * movement that happened after the original conversion.
 *
 * The reopen event is captured as a single `crm_lead_history` row with
 * `field='reopened'`, `old_value` snapshotting the previous terminal
 * state (status, converted FKs, lost_reason, disqualified_at) and
 * `new_value={reason}` so reports can attribute the action.
 */
export async function reopenLead(
  org_id: string,
  id: string,
  body: { reason?: string },
  user_id?: string,
) {
  const before = await getLead(org_id, id);

  // Cheap guard — re-opening an already-active lead is almost certainly
  // a stale UI / double-click. Refuse so the audit log doesn't fill with
  // no-op reopen events.
  if (before.status === 'working' || before.status === 'new') {
    throw new AppError(400, 'Lead is not disqualified or converted', 'LEAD_NOT_DISQUALIFIED');
  }

  const b = before as Record<string, unknown>;
  const previousState = {
    status: before.status,
    is_converted: b.is_converted ?? null,
    lifecycle_stage: b.lifecycle_stage ?? null,
    converted_account_id: b.converted_account_id ?? null,
    converted_contact_id: b.converted_contact_id ?? null,
    converted_deal_id: b.converted_deal_id ?? null,
    converted_at: b.converted_at ?? null,
    lost_reason: b.lost_reason ?? null,
    disqualified_at: b.disqualified_at ?? null,
  };

  const nowIso = new Date().toISOString();
  // Roll lifecycle_stage back to 'sql' on re-open from a converted state
  // (the rep was treating this as a customer; now they're working it
  // again — SQL is the highest pre-customer stage). For disqualified
  // re-opens, leave the stage as it was — they didn't graduate forward.
  const wasCustomer = b.lifecycle_stage === 'customer';
  const update: Record<string, unknown> = {
    status: 'working',
    is_converted: false,
    converted_at: null,
    converted_account_id: null,
    converted_contact_id: null,
    converted_deal_id: null,
    lost_reason: null,
    disqualified_at: null,
    stage_changed_at: nowIso,
    updated_by: user_id ?? null,
    updated_at: nowIso,
  };
  if (wasCustomer) update.lifecycle_stage = 'sql';

  const { data, error } = await supabaseAdmin.from('crm_leads')
    .update(update).eq('org_id', org_id).eq('id', id).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  await supabaseAdmin.from('crm_lead_history').insert({
    lead_id: id, org_id, field: 'reopened',
    old_value: previousState,
    new_value: { reason: body.reason ?? null },
    changed_by: user_id ?? null,
  });

  return data as Lead;
}

async function getDefaultPipelineId(org_id: string): Promise<string> {
  const { data } = await supabaseAdmin.from('crm_pipelines').select('id')
    .eq('org_id', org_id).eq('is_default', true).maybeSingle();
  if (!data) throw new AppError(400, 'No default pipeline configured. Run crm_seed_defaults() for this org.', 'NO_PIPELINE');
  return data.id;
}

async function getFirstOpenStageId(pipeline_id: string): Promise<string> {
  const { data } = await supabaseAdmin.from('crm_deal_stages').select('id')
    .eq('pipeline_id', pipeline_id).eq('stage_type', 'open').order('position').limit(1).maybeSingle();
  if (!data) throw new AppError(400, 'No open stages in pipeline', 'NO_STAGE');
  return data.id;
}

export async function listScoreHistory(org_id: string, lead_id: string) {
  const { data, error } = await supabaseAdmin.from('crm_lead_scores').select('*')
    .eq('org_id', org_id).eq('lead_id', lead_id).order('computed_at', { ascending: false }).limit(50);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

export async function bulkAssign(org_id: string, lead_ids: string[], owner_id: string, user_id?: string) {
  if (lead_ids.length === 0) return { updated: 0 };

  // Fetch previous owners so the audit rows can record from→to. One round
  // trip is acceptable cost for audit completeness — without this,
  // bulk-reassign was the only owner-change path that bypassed the
  // crm_lead_history audit table (single-record updateLead() already
  // writes one).
  const { data: before, error: beforeErr } = await supabaseAdmin.from('crm_leads')
    .select('id, owner_id').eq('org_id', org_id).in('id', lead_ids);
  if (beforeErr) throw new AppError(500, beforeErr.message, 'DB_ERROR');
  const prevByLead = new Map<string, string | null>(
    (before ?? []).map((r) => [r.id as string, (r.owner_id as string | null) ?? null]),
  );

  const { error } = await supabaseAdmin.from('crm_leads')
    .update({ owner_id, updated_by: user_id ?? null }).eq('org_id', org_id).in('id', lead_ids);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  // Skip rows where the owner didn't actually change (e.g. caller passed
  // the same owner_id), to keep the audit log signal-to-noise high.
  const historyRows = lead_ids
    .filter((lead_id) => prevByLead.get(lead_id) !== owner_id)
    .map((lead_id) => ({
      lead_id,
      org_id,
      field: 'owner_id',
      old_value: prevByLead.get(lead_id) ?? null,
      new_value: owner_id,
      changed_by: user_id ?? null,
    }));
  if (historyRows.length > 0) {
    await supabaseAdmin.from('crm_lead_history').insert(historyRows);
  }

  return { updated: lead_ids.length };
}
