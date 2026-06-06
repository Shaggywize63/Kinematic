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

  // Owner resolution: explicit owner_id wins, then assignment rules, then
  // the creator (user_id), then the org-wide default, then null. Passing
  // user_id into assignOwner lets the rule engine still take precedence
  // when a real rule matches, while keeping the "creator becomes owner"
  // fallback for the common "rep types in a new lead" case.
  const owner_id = payload.owner_id ?? (await assignment.assignOwner(org_id, payload, user_id));
  // Unified scorer — branches B2B/B2C correctly, no zero-padding of
  // off-profile signals in the breakdown. Engagement is skipped on
  // creation since there are no activities for a lead that doesn't
  // exist yet; rescoreLead picks them up later from crm_activities +
  // crm_lead_updates.
  const { score, breakdown } = await scoring.computeUnifiedScore(
    org_id, payload.client_id ?? null, payload, { skipEngagement: true },
  );

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
    // Geo coordinates captured on add (device GPS / manual). Optional — the
    // map falls back to the city centroid when absent.
    latitude:  (p.latitude  as number | undefined) ?? null,
    longitude: (p.longitude as number | undefined) ?? null,
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
    photo_url:    (p.photo_url    as string | undefined) ?? null,
    created_by: user_id ?? null,
  };

  const { data, error } = await supabaseAdmin.from('crm_leads').insert(insertRow).select('*').single();
  if (error) {
    // Race-safe net for the dedup unique indexes (ux_crm_leads_org_email_open
    // and ux_crm_leads_org_phone_hash_open). If two parallel POSTs both
    // pass the pre-insert dedup check, one of them lands here with
    // Postgres error 23505 — translate it to the same 409 the synchronous
    // path returns so the API contract stays consistent.
    const pgCode = (error as { code?: string }).code;
    if (pgCode === '23505') {
      throw new AppError(409, 'A lead with this email or phone already exists.', 'DUPLICATE_LEAD');
    }
    throw new AppError(500, error.message, 'DB_ERROR');
  }

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
  options: { strictClient?: boolean; effectiveCities?: string[] | null; visibleOwnerIds?: string[] | null; selfOwnerId?: string | null; includeNullCity?: boolean } = {},
) {
  const { rows } = await listLeadsWithCount(org_id, filters, client_id, options);
  return rows;
}

/**
 * Same filter set as listLeads but returns both the page of rows AND the
 * total row count (matching the full filter, not the page). Used by the
 * paginated list endpoint so the UI can render "Page 2 of 47" and a
 * jump-to-page control. Counts are computed in the same Supabase query
 * via `{ count: 'exact' }` so this is one DB round trip, not two.
 */
export async function listLeadsWithCount(
  org_id: string,
  filters: Record<string, unknown> = {},
  client_id: string | null = null,
  options: { strictClient?: boolean; effectiveCities?: string[] | null; visibleOwnerIds?: string[] | null; selfOwnerId?: string | null; includeNullCity?: boolean } = {},
): Promise<{ rows: Lead[]; total: number; page: number; limit: number }> {
  const limit = Math.min(Number(filters.limit ?? 50), 200);
  const page = Math.max(Number(filters.page ?? 1), 1);

  let q = supabaseAdmin.from('crm_leads').select('*', { count: 'exact' })
    .eq('org_id', org_id).is('deleted_at', null);
  if (client_id) {
    q = options.strictClient
      ? q.eq('client_id', client_id)
      : q.or(`client_id.is.null,client_id.eq.${client_id}`);
  }
  // City scope, broadened so it never hides a lead from the people who
  // must always see it. A lead is visible when ANY of these hold:
  //   • its city is in the caller's effective city set (the existing rule);
  //   • the caller OWNS it (owner_id = self) — a rep always sees their own
  //     leads even when the lead carries no city or a city outside their
  //     scope (e.g. web-form / Excel-imported leads with no geo);
  //   • the lead has no city AND the caller is a tenant-wide admin
  //     (data_scope='all') — city-less leads aren't pinned to any region,
  //     so an admin should see them rather than have them vanish.
  // Expressed as a single PostgREST OR so pagination + exact count stay
  // correct in one round trip.
  // Visibility scope — a lead is visible if ANY of these hold:
  //   • its city is in the caller's effective city set (so a city-allocated
  //     user like an Area Sales Officer sees every lead in their cities,
  //     whoever created it — e.g. the Consumer Champions working there);
  //   • the caller owns it (always);
  //   • its owner is in the caller's hierarchy subtree (team scope);
  //   • it has no city and there's no hierarchy owner bound (admin /
  //     data_scope='all') — city-less leads aren't pinned to a region.
  //
  // Combined into a SINGLE PostgREST OR. Previously the city scope and the
  // hierarchy owner scope were applied as two filters (i.e. AND-ed), which
  // hid every city lead from an 'own'-scope ASO: their subtree is just
  // themselves, and they own none of the leads their Consumer Champions
  // create. OR-ing the two restores the intended "see my cities OR my team".
  const hasCityScope = options.effectiveCities !== undefined && options.effectiveCities !== null;
  const hasOwnerScope = options.visibleOwnerIds !== undefined && options.visibleOwnerIds !== null;
  if (hasCityScope || hasOwnerScope) {
    const orParts: string[] = [];
    if (hasCityScope && options.effectiveCities!.length > 0) {
      // Quote each city for the in.() list so names with spaces/commas
      // (e.g. "Vasco da Gama") parse correctly.
      const cityCsv = options.effectiveCities!
        .map((c) => `"${String(c).replace(/[\\"]/g, (m) => '\\' + m)}"`)
        .join(',');
      orParts.push(`city.in.(${cityCsv})`);
    }
    if (options.selfOwnerId) orParts.push(`owner_id.eq.${options.selfOwnerId}`);
    if (hasOwnerScope && options.visibleOwnerIds!.length > 0) {
      orParts.push(`owner_id.in.(${options.visibleOwnerIds!.join(',')})`);
    }
    // Null-city leads: only surface broadly when there's NO hierarchy owner
    // bound (admin / data_scope='all'). Under hierarchy they're already
    // covered by the owner-subtree term, so we must not OR-in every
    // city-less lead (that would leak other regions' leads to an ASO).
    if (options.includeNullCity && !hasOwnerScope) orParts.push('city.is.null');
    if (orParts.length === 0) {
      return { rows: [], total: 0, page, limit };
    }
    q = q.or(orParts.join(','));
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
  if (filters.score_grade) q = q.eq('score_grade', String(filters.score_grade));
  if (filters.is_converted !== undefined) q = q.eq('is_converted', String(filters.is_converted) === 'true');
  if (filters.q) {
    const s = sanitisePostgrestSearch(filters.q);
    if (s) q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,company.ilike.%${s}%,email.ilike.%${s}%,phone.ilike.%${s}%`);
  }
  if (filters.from) q = q.gte('created_at', String(filters.from));
  if (filters.to) q = q.lte('created_at', String(filters.to));
  // Sorting. An explicit `sort` query param wins; otherwise we fall back to
  // the "latest-update first" default below so a rep typing in a note (or any
  // backend event that bumps latest_update_at) bubbles the row to the top.
  const sortKey = filters.sort ? String(filters.sort) : '';
  const ascending = String(filters.order ?? '').toLowerCase() === 'asc';
  // Whitelist sortable columns → real DB columns. Name maps to first_name
  // with last_name as the tie-breaker so "by name" reads alphabetically.
  const SORT_COLUMNS: Record<string, string> = {
    name: 'first_name',
    created: 'created_at',
    created_at: 'created_at',
    updated: 'updated_at',
    updated_at: 'updated_at',
    score: 'score',
    company: 'company',
    status: 'status',
  };
  if (sortKey && SORT_COLUMNS[sortKey]) {
    q = q.order(SORT_COLUMNS[sortKey], { ascending, nullsFirst: false });
    if (sortKey === 'name') q = q.order('last_name', { ascending, nullsFirst: false });
    q = q.range((page - 1) * limit, page * limit - 1);
  } else {
  // Default sort: latest-update first so a rep typing in a note (or any
  // backend event that bumps latest_update_at) bubbles the row to the
  // top. Falls back to updated_at then score so leads with no updates
  // yet still get a sensible order. Existing `sort=score` callers stay
  // honoured via the explicit filter handling above.
  q = q.order('latest_update_at', { ascending: false, nullsFirst: false })
       .order('updated_at', { ascending: false })
       .order('score', { ascending: false })
       .range((page - 1) * limit, page * limit - 1);
  }
  const { data, error, count } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return { rows: (data ?? []) as Lead[], total: count ?? 0, page, limit };
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
  // v2 path — pulls real engagement signals from crm_activities +
  // crm_lead_updates so a hot lead with recent WhatsApp / call traffic
  // gets the engagement credit the v1 heuristic was blind to.
  const result = await scoring.computeUnifiedScore(
    org_id, (lead as any).client_id ?? null, lead, { skipEngagement: false },
  );
  // grade is computed inside computeUnifiedScore but the existing
  // crm_leads schema also has score_grade — keep it in sync so the list
  // view's grade chip matches the breakdown's grade.
  await supabaseAdmin.from('crm_leads').update({
    score: result.score,
    score_grade: result.grade,
    score_breakdown: result.breakdown,
    score_updated_at: new Date().toISOString(),
  }).eq('id', id).eq('org_id', org_id);
  await supabaseAdmin.from('crm_lead_scores').insert({
    lead_id: id, org_id, score: result.score, grade: result.grade,
    model: result.breakdown.model || 'heuristic_v2', breakdown: result.breakdown,
  });
  // Edge function still runs the async LLM rerank with profile-aware
  // prompt; it'll update score + breakdown in place when it finishes.
  triggerEdgeFunction('crm-rescore-lead', { lead_id: id, org_id }).catch(() => {});
  return { score: result.score, breakdown: result.breakdown, grade: result.grade };
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
  // Multi-product deal lines. Each row carries the product, the pieces
  // and/or kg the rep entered, and the computed subtotal. If present,
  // overrides the single-product fields above.
  deal_line_items?: Array<{ product_id?: string; pieces?: number; volume_kg?: number; subtotal?: number }>;
  pipeline_id?: string; stage_id?: string;
}, user_id?: string) {
  const lead = await getLead(org_id, id);
  if (lead.status === 'converted') throw new AppError(400, 'Lead already converted', 'ALREADY_CONVERTED');

  // Convert inherits the source lead's client_id onto every downstream
  // record (account, contact, deal). Without this, the new rows land with
  // client_id=null and the strict client scoping in crm.routes.ts hides
  // them from the user who just created them — looked exactly like
  // "convert did nothing" because they vanished from the filtered list.
  const leadClientId = (lead.client_id ?? null) as string | null;

  let account_id: string | null = null;
  if (lead.company) {
    const domain = lead.email?.split('@')[1] || null;
    const { data: existingAccount } = await supabaseAdmin.from('crm_accounts').select('id')
      .eq('org_id', org_id).eq('name', lead.company).is('deleted_at', null).maybeSingle();
    if (existingAccount?.id) {
      account_id = existingAccount.id;
    } else {
      const { data: acc, error: accErr } = await supabaseAdmin.from('crm_accounts').insert({
        org_id, client_id: leadClientId,
        name: lead.company, domain, industry: lead.industry, owner_id: lead.owner_id,
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
        org_id, client_id: leadClientId, account_id,
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
    // Client-aware pipeline resolution. Pass the lead's client_id so
    // tenants with a client-specific default (e.g. Tata Tiscon's
    // "Home Construction Pipeline") get THEIR default, not the
    // org-wide one. Previously the helper assumed only one
    // `is_default=true` row per org and crashed with
    // "No default pipeline configured" when both existed.
    const pipeline_id = opts.pipeline_id || await getDefaultPipelineId(org_id, leadClientId);
    const stage_id = opts.stage_id || await getFirstOpenStageId(pipeline_id);

    let amount = opts.deal_amount ?? 0;
    let totalVolumeKg: number | null = null;
    let lineItemsForCustomFields: Array<Record<string, unknown>> | null = null;

    // Multi-product path. Fetch the referenced products once, build the
    // canonical line-items array (with resolved name/price/weight so
    // future renderers don't have to re-query), and sum into the deal
    // total. Overrides the single-product fields when present.
    if (opts.deal_line_items && opts.deal_line_items.length > 0) {
      // Drop rows that came in without a product_id — the validator
      // marks the field optional so a half-filled row can sneak through.
      const validLines = opts.deal_line_items.filter((l): l is { product_id: string; pieces?: number; volume_kg?: number; subtotal?: number } => !!l.product_id);
      const productIds = Array.from(new Set(validLines.map((l) => l.product_id)));
      const { data: products } = productIds.length
        ? await supabaseAdmin.from('crm_products')
            .select('id, name, price, weight_kg')
            .eq('org_id', org_id)
            .in('id', productIds)
        : { data: [] as any[] };
      const byId = new Map((products ?? []).map((p: any) => [p.id, p]));
      const computed = validLines.map((l) => {
        const p = byId.get(l.product_id) as any;
        const price = Number(p?.price ?? 0);
        const weightKg = Number(p?.weight_kg ?? 0);
        const pieces = Number(l.pieces ?? 0);
        // Prefer pieces → derive kg + subtotal so the math is identical
        // to what the frontend showed. Fall back to client-provided kg
        // when pieces isn't supplied (legacy callers).
        const kg = pieces > 0 ? pieces * weightKg : Number(l.volume_kg ?? 0);
        const subtotal = Number(l.subtotal ?? (pieces > 0 ? pieces * price : (weightKg > 0 ? (kg / weightKg) * price : 0)));
        return {
          product_id: l.product_id,
          product_name: p?.name ?? null,
          unit_price: price,
          unit_weight_kg: weightKg,
          pieces,
          volume_kg: Math.round(kg * 100) / 100,
          subtotal: Math.round(subtotal),
        };
      });
      const totalAmount = computed.reduce((s, r) => s + (r.subtotal || 0), 0);
      const totalKg     = computed.reduce((s, r) => s + (r.volume_kg || 0), 0);
      if (totalAmount > 0) amount = totalAmount;
      totalVolumeKg = Math.round(totalKg * 100) / 100;
      lineItemsForCustomFields = computed;
    } else if ((amount == null || amount === 0) && opts.deal_volume_kg && opts.deal_product_id) {
      const { data: product } = await supabaseAdmin.from('crm_products')
        .select('price, weight_kg').eq('id', opts.deal_product_id).eq('org_id', org_id).maybeSingle();
      if (product?.price && product?.weight_kg) {
        const ppk = Number(product.price) / Number(product.weight_kg);
        amount = Math.round(Number(opts.deal_volume_kg) * ppk);
      }
    }

    const dealInsert: Record<string, unknown> = {
      org_id, client_id: leadClientId, pipeline_id, stage_id,
      name: opts.deal_name || `${lead.company || lead.email || 'New deal'} — Opportunity`,
      account_id, primary_contact_id: contact_id, lead_id: id,
      amount, owner_id: lead.owner_id, source_id: lead.source_id,
      created_by: user_id ?? null,
    };
    if (lineItemsForCustomFields || totalVolumeKg != null) {
      dealInsert.custom_fields = {
        ...(lineItemsForCustomFields ? { line_items: lineItemsForCustomFields } : {}),
        ...(totalVolumeKg != null ? { volume_kg: totalVolumeKg } : {}),
      };
    }
    const { data: deal, error: dErr } = await supabaseAdmin.from('crm_deals').insert(dealInsert)
      .select('id').single();
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

/**
 * Pick the right pipeline for a lead conversion. Tenants can have
 * a client-specific default (`client_id = X AND is_default=true`)
 * AND an org-wide default (`client_id IS NULL AND is_default=true`)
 * at the same time. Old impl was a `.maybeSingle()` over
 * `is_default=true` which returned NULL when both existed and
 * threw "No default pipeline configured" — exactly the bug that
 * blocked conversions on Tata Tiscon.
 *
 * Resolution order (matches deals.service.ts:resolveDefaultPipeline):
 *   1. If client_id given, look for the client's own default
 *   2. Otherwise the org-wide default (client_id IS NULL, is_default)
 *   3. Otherwise the first active pipeline in the client/org scope
 *
 * Throws only when NO pipelines exist at all — that's a real
 * configuration error, not a resolution ambiguity.
 */
async function getDefaultPipelineId(org_id: string, client_id: string | null = null): Promise<string> {
  let q = supabaseAdmin.from('crm_pipelines')
    .select('id, is_default, client_id, created_at')
    .eq('org_id', org_id).eq('is_active', true).is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (client_id) {
    q = q.or(`client_id.is.null,client_id.eq.${client_id}`);
  } else {
    q = q.is('client_id', null);
  }
  const { data } = await q;
  const list = (data ?? []) as Array<{ id: string; is_default: boolean; client_id: string | null }>;
  if (list.length === 0) {
    throw new AppError(400, 'No pipeline configured for this org/client. Create one under CRM › Settings › Pipelines first.', 'NO_PIPELINE');
  }
  // Client-pinned default > org-wide default > first pipeline.
  const winner =
    list.find((p) => p.is_default && p.client_id)
    ?? list.find((p) => p.is_default)
    ?? list[0];
  return winner.id;
}

async function getFirstOpenStageId(pipeline_id: string): Promise<string> {
  // Prefer the lowest-position stage explicitly tagged stage_type='open'.
  // Fall back to the lowest-position stage of any type if no 'open'
  // exists (some legacy pipelines were imported without stage_type).
  const { data: openStage } = await supabaseAdmin.from('crm_deal_stages').select('id')
    .eq('pipeline_id', pipeline_id).eq('stage_type', 'open').order('position').limit(1).maybeSingle();
  if (openStage?.id) return openStage.id;
  const { data: anyStage } = await supabaseAdmin.from('crm_deal_stages').select('id')
    .eq('pipeline_id', pipeline_id).order('position').limit(1).maybeSingle();
  if (anyStage?.id) return anyStage.id;
  throw new AppError(400, 'Selected pipeline has no stages. Add at least one stage under CRM › Settings › Pipelines.', 'NO_STAGE');
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

export interface BulkCoordinateRow {
  id?: string | null;
  email?: string | null;
  phone?: string | null;
  latitude: number;
  longitude: number;
}

/**
 * Backfill lat/long on existing leads in one shot. Each row is matched to a
 * lead by id (preferred), then email, then phone — all scoped to org_id so a
 * row can never touch another tenant's lead. Returns per-row outcome counts
 * so the dashboard uploader can show "geotagged 412, skipped 8".
 */
export async function bulkUpdateCoordinates(
  org_id: string,
  rows: BulkCoordinateRow[],
  user_id?: string,
): Promise<{ updated: number; skipped: number; errors: Array<{ row: number; reason: string }> }> {
  const errors: Array<{ row: number; reason: string }> = [];

  // Resolve id + email matches in bulk to keep round trips low; phone-only
  // rows (the rare fallback) are resolved individually via the dedup helper
  // so its last-10-digits normalisation applies.
  const idRows    = rows.filter((r) => r.id);
  const emailRows = rows.filter((r) => !r.id && r.email);

  const validIds = new Set<string>();
  if (idRows.length) {
    const ids = [...new Set(idRows.map((r) => r.id as string))];
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await supabaseAdmin.from('crm_leads')
        .select('id').eq('org_id', org_id).is('deleted_at', null).in('id', ids.slice(i, i + 500));
      for (const r of data ?? []) validIds.add(r.id as string);
    }
  }

  const emailToId = new Map<string, string>();
  if (emailRows.length) {
    const emails = [...new Set(emailRows.map((r) => (r.email as string).toLowerCase()))];
    for (let i = 0; i < emails.length; i += 500) {
      const { data } = await supabaseAdmin.from('crm_leads')
        .select('id, email').eq('org_id', org_id).is('deleted_at', null).in('email', emails.slice(i, i + 500));
      for (const r of data ?? []) {
        const key = String(r.email ?? '').toLowerCase();
        if (key && !emailToId.has(key)) emailToId.set(key, r.id as string);
      }
    }
  }

  // Resolve every row to a target lead id.
  const targets: Array<{ index: number; id: string; latitude: number; longitude: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let id: string | null = null;
    if (r.id) {
      if (validIds.has(r.id)) id = r.id;
      else { errors.push({ row: i + 1, reason: `No lead with id ${r.id} in this org` }); continue; }
    } else if (r.email) {
      id = emailToId.get(r.email.toLowerCase()) ?? null;
      if (!id) { errors.push({ row: i + 1, reason: `No lead matched email ${r.email}` }); continue; }
    } else if (r.phone) {
      const dup = await dedup.findLeadByPhone(org_id, r.phone);
      if (!dup) { errors.push({ row: i + 1, reason: `No lead matched phone ${r.phone}` }); continue; }
      id = dup.id as string;
    } else {
      errors.push({ row: i + 1, reason: 'Row has no id, email, or phone' });
      continue;
    }
    targets.push({ index: i, id, latitude: r.latitude, longitude: r.longitude });
  }

  // Apply updates with bounded concurrency so a large backfill doesn't open
  // thousands of simultaneous connections.
  let updated = 0;
  const nowIso = new Date().toISOString();
  const CONCURRENCY = 20;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (t) => {
      const { error } = await supabaseAdmin.from('crm_leads')
        .update({ latitude: t.latitude, longitude: t.longitude, updated_by: user_id ?? null, updated_at: nowIso })
        .eq('org_id', org_id).eq('id', t.id);
      return error ? { ok: false as const, index: t.index, msg: error.message } : { ok: true as const };
    }));
    for (const res of results) {
      if (res.ok) updated++;
      else errors.push({ row: res.index + 1, reason: res.msg });
    }
  }

  return { updated, skipped: rows.length - updated, errors };
}
