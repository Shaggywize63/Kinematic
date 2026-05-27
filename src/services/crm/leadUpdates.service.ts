/**
 * Append-only timeline of free-form updates on a lead.
 *
 * Reps use this to capture "what just happened" — outcomes of phone calls,
 * customer's stated objections, scheduling notes — without forcing the
 * input into a structured activity type.
 *
 * Persistence model: every entry goes into crm_lead_updates AND the latest
 * entry is denormalised onto crm_leads.{latest_update, latest_update_at,
 * latest_update_by} so the leads list view can render "latest update" as a
 * column without an N+1 lookup. Invalidates the lead's NBA cache so the
 * next NBA request reflects the new context.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

export interface LeadUpdate {
  id: string;
  lead_id: string;
  org_id: string;
  client_id: string | null;
  author_id: string;
  author_name?: string | null;
  body: string;
  created_at: string;
}

const MAX_BODY_LEN = 2000;

export async function listUpdates(
  org_id: string,
  lead_id: string,
  limit = 50,
): Promise<LeadUpdate[]> {
  const { data, error } = await supabaseAdmin
    .from('crm_lead_updates')
    .select('id, lead_id, org_id, client_id, author_id, body, created_at')
    .eq('org_id', org_id)
    .eq('lead_id', lead_id)
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 200));
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = (data || []) as LeadUpdate[];

  // Hydrate author names in one round-trip rather than N joins.
  const authorIds = Array.from(new Set(rows.map((r) => r.author_id))).filter(Boolean);
  if (authorIds.length === 0) return rows;
  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, full_name, email')
    .in('id', authorIds);
  const byId = new Map<string, string>(
    (users || []).map((u: any) => [u.id, u.full_name || u.email || 'User']),
  );
  return rows.map((r) => ({ ...r, author_name: byId.get(r.author_id) ?? null }));
}

export async function createUpdate(
  org_id: string,
  client_id: string | null,
  lead_id: string,
  author_id: string,
  body: string,
): Promise<LeadUpdate> {
  const text = (body || '').trim().slice(0, MAX_BODY_LEN);
  if (!text) throw new AppError(400, 'body is required', 'VALIDATION');

  // Verify the lead exists in this org's scope first — preserves the
  // org-scope contract used everywhere else in this codebase, and gives
  // a clean 404 instead of a foreign-key violation.
  const { data: lead, error: le } = await supabaseAdmin
    .from('crm_leads')
    .select('id')
    .eq('org_id', org_id)
    .eq('id', lead_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (le || !lead) throw new AppError(404, 'Lead not found', 'NOT_FOUND');

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('crm_lead_updates')
    .insert({ org_id, client_id, lead_id, author_id, body: text, created_at: now })
    .select('id, lead_id, org_id, client_id, author_id, body, created_at')
    .single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  // Denormalise the latest entry onto the parent lead so the leads list
  // column can render it without per-row lookups. Also invalidate the
  // NBA cache so the next NBA call sees this update.
  await supabaseAdmin
    .from('crm_leads')
    .update({
      latest_update: text,
      latest_update_at: now,
      latest_update_by: author_id,
      next_action_updated_at: null,
    })
    .eq('id', lead_id)
    .eq('org_id', org_id);

  return data as LeadUpdate;
}
