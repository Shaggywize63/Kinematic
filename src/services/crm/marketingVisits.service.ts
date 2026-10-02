/**
 * Marketing / ad-hoc field visits — a GPS Start → End lifecycle tied to a CRM
 * lead.
 *
 * Deliberately modelled on top of `crm_activities` (no new table / no DDL): a
 * marketing visit is a `type:'meeting'` activity carrying
 * `metadata.kind='marketing_visit'` plus a `metadata.visit` block with start/
 * end coordinates and timestamps. This reuses the whole CRM activity stack
 * (tenant scoping, lead timeline, RBAC) and shows the visit on the lead's
 * history for free.
 *
 * Start creates the activity (status 'planned' = in progress) and, when no
 * existing lead is given, creates the lead first (stamped with GPS + the
 * client's "Marketing Visit" source). End completes the activity, records the
 * end GPS, and can move the lead's status / follow-up in one call.
 *
 * The capability is generic; the apps surface it per-client (currently
 * Rajkamal). A client that never calls these endpoints is unaffected.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import * as crud from './crud.service';
import { createLead, getLead, updateLead } from './leads.service';

const VISIT_KIND = 'marketing_visit';
// A proven-insertable activity type across every project (site_visit isn't
// present in all tenants' type CHECK); the marketing-visit marker lives in
// metadata.kind, so this stays robust.
const VISIT_ACTIVITY_TYPE = 'meeting';

interface VisitMeta {
  kind: string;
  visit: {
    phase: 'in_progress' | 'completed';
    started_at: string;
    start_lat?: number | null;
    start_lng?: number | null;
    ended_at?: string | null;
    end_lat?: number | null;
    end_lng?: number | null;
    purpose?: string | null;
    next_followup_at?: string | null;
  };
}

function leadName(lead: { first_name?: string | null; last_name?: string | null } | null | undefined): string {
  const n = `${lead?.first_name ?? ''} ${lead?.last_name ?? ''}`.trim();
  return n || 'Lead';
}

/** Resolve the client's "Marketing Visit" lead source id by name (nullable). */
async function resolveMarketingVisitSource(org_id: string, client_id: string | null): Promise<string | null> {
  let q = supabaseAdmin
    .from('crm_lead_sources')
    .select('id,name')
    .eq('org_id', org_id)
    .ilike('name', 'Marketing Visit')
    .limit(1);
  if (client_id) q = q.or(`client_id.is.null,client_id.eq.${client_id}`);
  const { data } = await q;
  return (data && data[0]?.id) || null;
}

export interface StartVisitInput {
  org_id: string;
  user_id?: string;
  client_id: string | null;
  lead_id?: string | null;
  /** New-lead fields (already validated by leadCreateSchema at the route). */
  lead?: Record<string, unknown> | null;
  latitude?: number | null;
  longitude?: number | null;
  purpose?: string | null;
}

export async function startMarketingVisit(input: StartVisitInput) {
  const { org_id, user_id, client_id } = input;
  const nowIso = new Date().toISOString();

  // Resolve (or create) the lead the visit is about.
  let lead: Record<string, unknown>;
  if (input.lead_id) {
    lead = await getLead(org_id, input.lead_id) as unknown as Record<string, unknown>;
  } else {
    const sourceId = await resolveMarketingVisitSource(org_id, client_id);
    const payload: Record<string, unknown> = {
      ...(input.lead || {}),
      client_id,
      latitude: input.latitude ?? (input.lead as Record<string, unknown>)?.latitude ?? null,
      longitude: input.longitude ?? (input.lead as Record<string, unknown>)?.longitude ?? null,
    };
    if (sourceId && payload.source_id == null) payload.source_id = sourceId;
    lead = await createLead({ org_id, user_id, payload, enforceRequired: false }) as unknown as Record<string, unknown>;
  }

  const meta: VisitMeta = {
    kind: VISIT_KIND,
    visit: {
      phase: 'in_progress',
      started_at: nowIso,
      start_lat: input.latitude ?? null,
      start_lng: input.longitude ?? null,
      purpose: input.purpose ?? null,
    },
  };

  const activity = await crud.create('crm_activities', org_id, {
    type: VISIT_ACTIVITY_TYPE,
    subject: `Marketing Visit — ${leadName(lead)}`,
    lead_id: lead.id,
    client_id: (lead.client_id as string | null) ?? client_id ?? null,
    status: 'planned',
    owner_id: user_id ?? null,
    assigned_to: user_id ?? null,
    due_at: nowIso,
    metadata: meta,
  }, user_id);

  return { visit: activity, lead };
}

export interface EndVisitInput {
  org_id: string;
  user_id?: string;
  client_id: string | null;
  id: string;
  latitude?: number | null;
  longitude?: number | null;
  outcome?: string | null;
  notes?: string | null;
  next_status?: string | null;
  next_followup_at?: string | null;
}

export async function endMarketingVisit(input: EndVisitInput) {
  const { org_id, user_id, client_id, id } = input;
  const nowIso = new Date().toISOString();

  const existing = await crud.get('crm_activities', org_id, id, false, client_id) as Record<string, unknown> | null;
  if (!existing) throw new AppError(404, 'Visit not found', 'NOT_FOUND');
  const existingMeta = (existing.metadata as VisitMeta | null) || null;
  if (!existingMeta || existingMeta.kind !== VISIT_KIND) {
    throw new AppError(400, 'Activity is not a marketing visit', 'NOT_A_VISIT');
  }

  const mergedMeta: VisitMeta = {
    ...existingMeta,
    visit: {
      ...existingMeta.visit,
      phase: 'completed',
      ended_at: nowIso,
      end_lat: input.latitude ?? null,
      end_lng: input.longitude ?? null,
      next_followup_at: input.next_followup_at ?? existingMeta.visit.next_followup_at ?? null,
    },
  };

  const patch: Record<string, unknown> = {
    status: 'completed',
    completed_at: nowIso,
    metadata: mergedMeta,
  };
  if (input.outcome != null) patch.outcome = input.outcome;
  if (input.notes != null) patch.body = input.notes;

  const visit = await crud.update('crm_activities', org_id, id, patch, user_id, client_id);

  // Optionally move the lead's status (validated against the client's set by
  // leads.service) in the same action.
  let lead: unknown = null;
  const leadId = existing.lead_id as string | null | undefined;
  if (leadId && input.next_status) {
    lead = await updateLead(org_id, leadId, { status: input.next_status } as never, user_id);
  } else if (leadId) {
    lead = await getLead(org_id, leadId).catch(() => null);
  }

  return { visit, lead };
}

export interface ListVisitsInput {
  org_id: string;
  client_id: string | null;
  strictClient?: boolean;
  user_id?: string | null;
  mine?: boolean;
  status?: string | null;
}

export async function listMarketingVisits(input: ListVisitsInput) {
  let q = supabaseAdmin
    .from('crm_activities')
    .select('*')
    .eq('org_id', input.org_id)
    .is('deleted_at', null)
    .filter('metadata->>kind', 'eq', VISIT_KIND);
  if (input.client_id) {
    q = input.strictClient
      ? q.eq('client_id', input.client_id)
      : q.or(`client_id.is.null,client_id.eq.${input.client_id}`);
  }
  if (input.mine && input.user_id) q = q.eq('assigned_to', input.user_id);
  if (input.status) q = q.eq('status', input.status);
  q = q.order('due_at', { ascending: false }).limit(200);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data ?? [];
}

export async function getActiveMarketingVisit(org_id: string, client_id: string | null, user_id: string | null) {
  if (!user_id) return null;
  let q = supabaseAdmin
    .from('crm_activities')
    .select('*')
    .eq('org_id', org_id)
    .is('deleted_at', null)
    .filter('metadata->>kind', 'eq', VISIT_KIND)
    .eq('assigned_to', user_id)
    .eq('status', 'planned');
  if (client_id) q = q.or(`client_id.is.null,client_id.eq.${client_id}`);
  q = q.order('due_at', { ascending: false }).limit(1);
  const { data } = await q;
  return (data && data[0]) || null;
}
