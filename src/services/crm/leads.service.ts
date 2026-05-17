/**
 * Lead service: CRUD, dedup, scoring orchestration, conversion.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError, sanitisePostgrestSearch } from '../../utils';
import * as scoring from './ai/leadScoring.service';
import * as dedup from './dedup.service';
import * as assignment from './assignment.service';
import { triggerEdgeFunction } from './edge.client';
import * as automations from './automations.service';
import type { Lead, LeadStatus } from '../../types/crm.types';

// Helper: erase the structural-type-narrowing TS does on Lead so we can
// reach optional/dynamic columns (lifecycle_stage, lost_reason, won_*) that
// live on the DB row but aren't in the Lead interface. The "as unknown as"
// dance is what TS demands for casts between non-overlapping shapes.
const asRow = (x: unknown): Record<string, unknown> => x as Record<string, unknown>;

export interface CreateLeadInput {
  org_id: string;
  user_id?: string;
  payload: Partial<Lead>;
  skipDedup?: boolean;
}

export async function createLead({ org_id, user_id, payload, skipDedup }: CreateLeadInput) {
  if (!skipDedup) {
    if (payload.email) {
      const dup = await dedup.findLeadByEmail(org_id, payload.email);
      if (dup) {
        throw new AppError(409, `A lead with this email already exists (id=${dup.id})`, 'DUPLICATE_LEAD');
      }
    }
    if (payload.phone) {
      // Phone dedup runs alongside email — for B2C inbound where the user
      // forgets / reuses email, phone is the canonical identity. Helper
      // normalises both sides to last-10-digits so format variants collide.
      const dup = await dedup.findLeadByPhone(org_id, payload.phone);
      if (dup) {
        throw new AppError(409, `A lead with this phone already exists (id=${dup.id})`, 'DUPLICATE_LEAD');
      }
    }
  }

  const owner_id = payload.owner_id ?? (await assignment.assignOwner(org_id, payload));
  // Use client-specific ICP if the lead has a client_id stamped, else fall back to org-level.
  const { score, breakdown } = scoring.computeHeuristic(payload, await scoring.getIcp(org_id, payload.client_id ?? null));

  const p = asRow(payload);
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

  // Fire any automations subscribed to lead_created. Non-blocking — a
  // misconfigured automation can't 500 the create call.
  automations.fireForTrigger('lead_created', {
    org_id, user_id, entity: 'lead', entity_id: data.id,
    data: { lead: data, client_id: data.client_id },
  }).catch(() => {});

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
  if (filters.utm_source)   q = q.eq('utm_source',   String(filters.utm_source));
  if (filters.utm_campaign) q = q.eq('utm_campaign', String(filters.utm_campaign));
  if (filters.state)    q = q.eq('state',    String(filters.state));
  if (filters.city)     q = q.eq('city',     String(filters.city));
  if (filters.district) q = q.eq('district', String(filters.district));
  if (filters.block)    q = q.eq('block',    String(filters.block));
  if (filters.q) {
    const s = sanitisePostgrestSearch(filters.q);
    if (s) q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,company.ilike.%${s}%,email.ilike.%${s}%`);
  }
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
  if (enteringDisqualified && asRow(before).disqualified_at == null) {
    update.disqualified_at = nowIso;
  }

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

    if (enteringDisqualified) {
      const reason =
        asRow(payload).lost_reason
        ?? asRow(data).lost_reason
        ?? null;
      await supabaseAdmin.from('crm_lead_history').insert({
        lead_id: id, org_id, field: 'disqualified',
        old_value: before.status, new_value: { status: data.status, lost_reason: reason },
        changed_by: user_id ?? null,
      });
    }
  }

  if (before.status !== data.status) {
    automations.fireForTrigger('lead_status_changed', {
      org_id, user_id, entity: 'lead', entity_id: id,
      data: { lead: data, before, after: data, old_status: before.status, new_status: data.status, client_id: data.client_id },
    }).catch(() => {});
    if (enteringDisqualified) {
      automations.fireForTrigger('lead_disqualified', {
        org_id, user_id, entity: 'lead', entity_id: id,
        data: { lead: data, lost_reason: asRow(data).lost_reason ?? null, client_id: data.client_id },
      }).catch(() => {});
    }
  }

  const beforeStage = asRow(before).lifecycle_stage;
  const afterStage  = asRow(data).lifecycle_stage;
  if (beforeStage !== afterStage) {
    await supabaseAdmin.from('crm_lead_history').insert({
      lead_id: id, org_id, field: 'lifecycle_stage',
      old_value: beforeStage, new_value: afterStage, changed_by: user_id ?? null,
    });
    automations.fireForTrigger('lead_lifecycle_stage_changed', {
      org_id, user_id, entity: 'lead', entity_id: id,
      data: { lead: data, old_stage: beforeStage, new_stage: afterStage, client_id: data.client_id },
    }).catch(() => {});
  }

  if (before.owner_id !== data.owner_id) {
    await supabaseAdmin.from('crm_lead_history').insert({
      lead_id: id, org_id, field: 'owner_id',
      old_value: before.owner_id, new_value: data.owner_id, changed_by: user_id ?? null,
    });
    automations.fireForTrigger('lead_owner_changed', {
      org_id, user_id, entity: 'lead', entity_id: id,
      data: { lead: data, old_owner_id: before.owner_id, new_owner_id: data.owner_id, client_id: data.client_id },
    }).catch(() => {});
  }

  const profileChanged = ['title','company','industry','country','source_id'].some(k =>
    asRow(payload)[k] !== undefined);
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

/**
 * Mark a lead as won (status=converted, lifecycle_stage=customer) without
 * spawning Account+Contact+Deal records.
 *
 * Distinct from convertLead() which is the "full conversion" path that
 * creates downstream entities. markLeadAsWon() is the lightweight close-
 * the-loop path used by mobile + dashboard lead detail screens when the
 * rep just wants to flag the win + capture an optional reason. Reports
 * key on (status='converted' AND won_reason IS NOT NULL) to distinguish
 * "marked won" from "fully converted".
 *
 * Stamps won_reason / won_at on the lead row, writes a crm_lead_history
 * audit record, and fires the 'lead_converted' automation trigger so
 * downstream workflows (Slack alerts, follow-up tasks) still react.
 *
 * Graceful fallback: if the deployment hasn't run the won_reason / won_at
 * migration yet, retries with just status + lifecycle_stage and stashes
 * the reason into notes — so the action still succeeds on older DBs.
 */
export async function markLeadAsWon(
  org_id: string,
  id: string,
  reason?: string | null,
  user_id?: string,
): Promise<Lead> {
  const before = await getLead(org_id, id);

  const nowIso = new Date().toISOString();
  const coreUpdate: Record<string, unknown> = {
    status: 'converted',
    lifecycle_stage: 'customer',
    stage_changed_at: nowIso,
    updated_by: user_id ?? null,
    updated_at: nowIso,
  };
  const richUpdate = { ...coreUpdate, won_reason: reason ?? null, won_at: nowIso };

  let data: Lead;
  const richResult = await supabaseAdmin.from('crm_leads')
    .update(richUpdate).eq('org_id', org_id).eq('id', id).select('*').single();

  if (richResult.error) {
    const code = asRow(richResult.error).code as string | undefined;
    const msg  = (richResult.error.message ?? '').toLowerCase();
    const isMissingColumn =
      code === '42703' ||
      (msg.includes('column') && (msg.includes('won_reason') || msg.includes('won_at')));

    if (isMissingColumn) {
      // Older deployment without won_reason/won_at — stash reason into notes.
      const fallback: Record<string, unknown> = { ...coreUpdate };
      if (reason) fallback.notes = `Won reason: ${reason}`;
      const fallbackResult = await supabaseAdmin.from('crm_leads')
        .update(fallback).eq('org_id', org_id).eq('id', id).select('*').single();
      if (fallbackResult.error) throw new AppError(500, fallbackResult.error.message, 'DB_ERROR');
      data = fallbackResult.data as Lead;
    } else {
      throw new AppError(500, richResult.error.message, 'DB_ERROR');
    }
  } else {
    data = richResult.data as Lead;
  }

  if (before.status !== 'converted') {
    await supabaseAdmin.from('crm_lead_history').insert({
      lead_id: id,
      org_id,
      field: 'status',
      old_value: before.status,
      new_value: 'converted',
      changed_by: user_id ?? null,
    });
  }

  automations.fireForTrigger('lead_converted', {
    org_id, user_id, entity: 'lead', entity_id: id,
    data: { lead: data, won_reason: reason ?? null, client_id: asRow(data).client_id },
  }).catch(() => {});

  return data;
}

export async function convertLead(org_id: string, id: string, opts: {
  create_deal?: boolean; deal_name?: string; deal_amount?: number;
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

  automations.fireForTrigger('lead_converted', {
    org_id, user_id, entity: 'lead', entity_id: id,
    data: { lead, account_id, contact_id, deal_id, client_id: lead.client_id },
  }).catch(() => {});

  return { lead_id: id, account_id, contact_id, deal_id };
}

/**
 * Reopen a lead that was previously disqualified (lost/unqualified) or
 * converted. Flips the row back to 'working' and clears every
 * lifecycle-terminal field (lost_reason, disqualified_at, converted_*
 * FKs, is_converted, converted_at).
 */
export async function reopenLead(
  org_id: string,
  id: string,
  body: { reason?: string },
  user_id?: string,
) {
  const before = await getLead(org_id, id);

  if (before.status === 'working' || before.status === 'new') {
    throw new AppError(400, 'Lead is not disqualified or converted', 'LEAD_NOT_DISQUALIFIED');
  }

  const b = asRow(before);
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

  const { data: before, error: beforeErr } = await supabaseAdmin.from('crm_leads')
    .select('id, owner_id').eq('org_id', org_id).in('id', lead_ids);
  if (beforeErr) throw new AppError(500, beforeErr.message, 'DB_ERROR');
  const prevByLead = new Map<string, string | null>(
    (before ?? []).map((r) => [r.id as string, (r.owner_id as string | null) ?? null]),
  );

  const { error } = await supabaseAdmin.from('crm_leads')
    .update({ owner_id, updated_by: user_id ?? null }).eq('org_id', org_id).in('id', lead_ids);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

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
