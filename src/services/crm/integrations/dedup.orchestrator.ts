/**
 * Dedup orchestrator — the single entry point both the lead-source integration
 * webhooks AND the bulk import controller call when ingesting a normalised
 * lead from outside the manual-create flow.
 *
 * Behaviour:
 *   1. Hash phone + email (same formula as the GENERATED columns on crm_leads).
 *   2. Look the existing lead up by either hash via the partial indexes.
 *   3a. MATCH  → insert a row in `crm_lead_attribution` (junction; one lead
 *                may have many sources). Bump `crm_leads.updated_at`.
 *                Returns `{ lead_id: existing, was_new: false,
 *                merged_into: existing }`.
 *   3b. NO MATCH → call `leads.service.createLead({ skipDedup: true })` so we
 *                  inherit owner assignment, lead-scoring, edge-fn rescore,
 *                  and the `lead_created` automation trigger for free.
 *                  Then insert the FIRST attribution row tying the new
 *                  lead to the source. Returns `{ lead_id: new,
 *                  was_new: true }`.
 *
 * `skipDedup: true` on createLead is intentional — the orchestrator owns the
 * decision (it considered both phone AND email, the createLead path throws
 * 409 on either). We've already cleared that path before reaching here.
 *
 * Lives in its own file (not inside dedup.service.ts) to avoid a circular
 * dependency — leads.service.ts already imports dedup.service.ts.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { hashPhone, hashEmail, findByHashes } from '../dedup.service';
import { createLead } from '../leads.service';
import type { Lead } from '../../../types/crm.types';

export interface NormalizedLead {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  title?: string | null;
  industry?: string | null;
  country?: string | null;
  city?: string | null;
  state?: string | null;
  notes?: string | null;
  tags?: string[];
  custom_fields?: Record<string, unknown>;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;
  referrer_url?: string | null;
  landing_page?: string | null;
  /** Provider's id for this lead, e.g. Meta `leadgen_id` — kept on the
   *  attribution row for replay/debug, not on the lead itself. */
  external_id?: string | null;
}

export interface FindOrCreateInput {
  org_id: string;
  source_id: string;                  // crm_lead_sources.id (auto-created on integration setup)
  normalized: NormalizedLead;
  integration_id?: string | null;     // crm_lead_source_integrations.id (null when called by Excel import)
  raw_event_id?: string | null;       // crm_lead_inbound_events.id  (null for import path)
  user_id?: string | null;            // created_by when a new lead is inserted
  /** Resolved owner for a newly-inserted lead. The bulk-import path resolves
   *  the CSV's `owner_email` column to a user id and passes it here so the
   *  lead is assigned to its real owner instead of falling through to the
   *  "creator becomes owner" assignment fallback (which would assign every
   *  imported lead to the person running the import). NULL/undefined keeps
   *  the existing assignment-rule → creator → default-owner chain. */
  owner_id?: string | null;
  /** Client scope stamped onto the lead so reps with a pinned X-Client-Id
   *  see it. The webhook router fetches this from the integration row
   *  (which captured it at integration-create time). NULL = org-wide. */
  client_id?: string | null;
}

export interface FindOrCreateResult {
  lead_id: string;
  was_new: boolean;
  /** When was_new=false, the id of the existing lead the new source was attached to. */
  merged_into?: string;
}

export async function findOrCreateLead(input: FindOrCreateInput): Promise<FindOrCreateResult> {
  const { org_id, source_id, normalized, integration_id, raw_event_id, user_id, owner_id, client_id } = input;

  const phone_hash = hashPhone(normalized.phone);
  const email_hash = hashEmail(normalized.email);

  // 1. Try to find an existing lead by either hash. If both are null we
  // can't dedup — fall straight through to insert.
  const existing = (phone_hash || email_hash)
    ? await findByHashes(org_id, phone_hash, email_hash)
    : null;

  if (existing?.id) {
    // 2a. Merge: append attribution + bump updated_at on the lead so SLA /
    //     "leads with recent activity" reports surface the new touch.
    await supabaseAdmin.from('crm_lead_attribution').insert({
      lead_id:        existing.id,
      source_id,
      integration_id: integration_id ?? null,
      external_id:    normalized.external_id ?? null,
      raw_payload_id: raw_event_id ?? null,
    });
    await supabaseAdmin.from('crm_leads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', existing.id).eq('org_id', org_id);

    return { lead_id: existing.id, was_new: false, merged_into: existing.id };
  }

  // 2b. Insert: hand off to the canonical createLead so all side effects
  //     (assignment, scoring, edge-fn rescore, lead_created automation) fire.
  //     skipDedup=true because we've already done that decision above.
  const payload: Partial<Lead> = {
    first_name:    normalized.first_name   ?? null,
    last_name:     normalized.last_name    ?? null,
    email:         normalized.email        ?? null,
    phone:         normalized.phone        ?? null,
    company:       normalized.company      ?? null,
    title:         normalized.title        ?? null,
    industry:      normalized.industry     ?? null,
    country:       normalized.country      ?? null,
    // Inbound webhooks (web forms, Meta, Google Ads, Zapier…) and Excel
    // imports often don't carry a city. Leave it NULL rather than stamping
    // a synthetic placeholder — the leads list now shows a lead to its
    // owner regardless of city scope, and surfaces city-less leads to
    // tenant-wide (data_scope='all') admins, so a real geo value is no
    // longer required for visibility. Org admins can set a real city on
    // triage. (Previously this defaulted to the literal 'Online', which
    // sat outside every rep's and city-capped admin's scope and so hid
    // the lead from everyone but platform super-admins.)
    city:          (normalized.city && normalized.city.trim()) || null,
    notes:         normalized.notes        ?? null,
    tags:          normalized.tags         ?? [],
    custom_fields: normalized.custom_fields ?? {},
    source_id,
    // Explicit owner from the caller (e.g. bulk import resolving
    // owner_email → user id) wins over the assignment fallback. Omitted
    // when null/undefined so webhook leads keep the rule → creator →
    // default-owner chain in createLead.
    ...(owner_id ? { owner_id } : {}),
    // Auto-inherit client scope from the integration so reps pinned to
    // that client (X-Client-Id strict mode) see the lead immediately.
    ...(client_id ? { client_id } : {}),
  } as Partial<Lead> & { client_id?: string };

  // UTM + landing-page attribution lives on crm_leads but isn't on the
  // Lead type today — pass through via the same as-Record cast createLead
  // uses internally so we don't lose campaign signal.
  const extras: Record<string, unknown> = {};
  if (normalized.utm_source)   extras.utm_source   = normalized.utm_source;
  if (normalized.utm_medium)   extras.utm_medium   = normalized.utm_medium;
  if (normalized.utm_campaign) extras.utm_campaign = normalized.utm_campaign;
  if (normalized.utm_term)     extras.utm_term     = normalized.utm_term;
  if (normalized.utm_content)  extras.utm_content  = normalized.utm_content;
  if (normalized.referrer_url) extras.referrer_url = normalized.referrer_url;
  if (normalized.landing_page) extras.landing_page = normalized.landing_page;
  if (normalized.state)        extras.state        = normalized.state;

  const lead = await createLead({
    org_id,
    user_id: user_id ?? undefined,
    payload: { ...payload, ...extras } as Partial<Lead>,
    skipDedup: true,
  });

  await supabaseAdmin.from('crm_lead_attribution').insert({
    lead_id:        lead.id,
    source_id,
    integration_id: integration_id ?? null,
    external_id:    normalized.external_id ?? null,
    raw_payload_id: raw_event_id ?? null,
  });

  return { lead_id: lead.id, was_new: true };
}
