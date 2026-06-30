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
import { extractSignalsFromUpdate } from './ai/competitorIntel.service';

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
    .select('id, name, email')
    .in('id', authorIds);
  // public.users carries `name`, not `full_name` — the wrong column name
  // would throw at PostgREST and silently empty the timeline.
  const byId = new Map<string, string>(
    (users || []).map((u: any) => [u.id, u.name || u.email || 'User']),
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
    .select('id, city, state, postal_code')
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

  // Hydrate the author's display name on the way out — listUpdates does
  // the same lookup for historic rows, but the FE prepends this single
  // row into its in-memory list without a refetch, so without this the
  // brand-new entry renders as "Unknown" until the user reloads.
  const { data: author } = await supabaseAdmin
    .from('users')
    .select('name, email')
    .eq('id', author_id)
    .maybeSingle();
  const author_name = (author as any)?.name || (author as any)?.email || null;

  // Fire-and-forget: mine this note for competitor / market signals that feed
  // the Market Intelligence dashboard. Best-effort — it never throws, so it
  // can't affect the update we just persisted.
  void extractSignalsFromUpdate({
    org_id,
    client_id,
    lead_id,
    update_id: (data as LeadUpdate).id,
    author_id,
    body: text,
    city: (lead as any)?.city ?? null,
    state: (lead as any)?.state ?? null,
    postal_code: (lead as any)?.postal_code ?? null,
  });

  return { ...(data as LeadUpdate), author_name };
}

// Roles allowed to delete an update they didn't author. Editing someone
// else's words is never allowed (even for admins); deleting a teammate's
// stray entry is an admin housekeeping action.
const ADMIN_ROLES = new Set(['super_admin', 'admin', 'org_admin']);

async function hydrateAuthorName(author_id: string): Promise<string | null> {
  const { data: author } = await supabaseAdmin
    .from('users')
    .select('name, email')
    .eq('id', author_id)
    .maybeSingle();
  return (author as any)?.name || (author as any)?.email || null;
}

/**
 * Re-denormalise crm_leads.{latest_update,…} from the newest remaining
 * update after an edit or delete. Clears the columns when no updates are
 * left. Also invalidates the NBA cache so the next recommendation reflects
 * the change. Always safe to call — it recomputes from scratch.
 */
async function resyncLatest(org_id: string, lead_id: string): Promise<void> {
  const { data: latest } = await supabaseAdmin
    .from('crm_lead_updates')
    .select('body, created_at, author_id')
    .eq('org_id', org_id)
    .eq('lead_id', lead_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  await supabaseAdmin
    .from('crm_leads')
    .update({
      latest_update: (latest as any)?.body ?? null,
      latest_update_at: (latest as any)?.created_at ?? null,
      latest_update_by: (latest as any)?.author_id ?? null,
      next_action_updated_at: null,
    })
    .eq('id', lead_id)
    .eq('org_id', org_id);
}

/**
 * Edit an update's body. Only the original author may edit — rewriting a
 * teammate's note would misattribute their words. Re-syncs the lead's
 * denormalised latest_update in case the edited row is the most recent.
 */
export async function updateUpdate(
  org_id: string,
  user_id: string,
  lead_id: string,
  update_id: string,
  body: string,
): Promise<LeadUpdate> {
  const text = (body || '').trim().slice(0, MAX_BODY_LEN);
  if (!text) throw new AppError(400, 'body is required', 'VALIDATION');

  const { data: existing } = await supabaseAdmin
    .from('crm_lead_updates')
    .select('id, author_id')
    .eq('org_id', org_id)
    .eq('lead_id', lead_id)
    .eq('id', update_id)
    .maybeSingle();
  if (!existing) throw new AppError(404, 'Update not found', 'NOT_FOUND');
  if ((existing as any).author_id !== user_id) {
    throw new AppError(403, 'You can only edit your own updates', 'FORBIDDEN');
  }

  const { data, error } = await supabaseAdmin
    .from('crm_lead_updates')
    .update({ body: text })
    .eq('id', update_id)
    .eq('org_id', org_id)
    .select('id, lead_id, org_id, client_id, author_id, body, created_at')
    .single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  await resyncLatest(org_id, lead_id);

  const author_name = await hydrateAuthorName((data as LeadUpdate).author_id);
  return { ...(data as LeadUpdate), author_name };
}

/**
 * Delete an update. The author can delete their own; an admin can delete
 * any (housekeeping). Re-syncs the lead's denormalised latest_update.
 */
export async function deleteUpdate(
  org_id: string,
  user_id: string,
  role: string | null | undefined,
  lead_id: string,
  update_id: string,
): Promise<void> {
  const { data: existing } = await supabaseAdmin
    .from('crm_lead_updates')
    .select('id, author_id')
    .eq('org_id', org_id)
    .eq('lead_id', lead_id)
    .eq('id', update_id)
    .maybeSingle();
  if (!existing) throw new AppError(404, 'Update not found', 'NOT_FOUND');

  const isAdmin = !!role && ADMIN_ROLES.has(role);
  if ((existing as any).author_id !== user_id && !isAdmin) {
    throw new AppError(403, 'You can only delete your own updates', 'FORBIDDEN');
  }

  const { error } = await supabaseAdmin
    .from('crm_lead_updates')
    .delete()
    .eq('id', update_id)
    .eq('org_id', org_id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  await resyncLatest(org_id, lead_id);
}
