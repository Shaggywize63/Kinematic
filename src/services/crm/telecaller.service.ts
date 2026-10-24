import { AuthRequest } from '../../types';
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

// Telecaller role support.
//
// A telecaller is a PHONE-based CRM agent (no field visits / GPS). Admin
// ASSIGNS leads to the telecaller and they work only that queue — calling each
// lead, logging a disposition (crm_activities.outcome), moving the lead status,
// setting a follow-up (an activity with due_at) and optionally a scheme amount
// (crm_target_entries). They are strictly OWN-scoped: a telecaller sees only
// the leads whose owner_id is them, independent of whether the client opted
// into hierarchy RBAC — the phone queue is personal.
//
// Identity signal: the org-role designation named "Telecaller" (the tenant
// assigns the user an org_role whose name contains "telecaller"), mirroring how
// the apps/dashboard already key tenant designations off org_role_name
// (e.g. Consumer Champion). A legacy users.role === 'telecaller' is also
// honoured so the check works even before an org_role is attached. Matching is
// case-insensitive and substring-based so "Telecaller", "Tele Caller" and
// "Senior Telecaller" all resolve.

type TelecallerUser =
  | { role?: string | null; org_role_name?: string | null }
  | null
  | undefined;

export function isTelecaller(user: TelecallerUser): boolean {
  if (!user) return false;
  const role = (user.role ?? '').toLowerCase();
  if (role === 'telecaller') return true;
  const designation = (user.org_role_name ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  return designation.includes('telecaller');
}

export function reqIsTelecaller(req: AuthRequest): boolean {
  return isTelecaller(req.user);
}

// ── Telecaller directory ───────────────────────────────────────────────────
export interface Telecaller { id: string; name: string; email: string | null }

/** Every telecaller user in scope (org + client), for the marketing-assign and
 *  After-Sales assignment pickers. Telecaller identity = legacy role or an
 *  org-role designation containing "telecaller" (see isTelecaller). */
export async function listTelecallers(org_id: string, client_id: string | null): Promise<Telecaller[]> {
  let q = supabaseAdmin.from('users')
    .select('id, name, email, role, org_role:org_roles!org_role_id(name)')
    .eq('org_id', org_id).is('deleted_at', null);
  if (client_id) q = q.eq('client_id', client_id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? [])
    .filter((u: any) => isTelecaller({ role: u.role, org_role_name: u.org_role?.name }))
    .map((u: any) => ({ id: u.id as string, name: (u.name as string) ?? 'Telecaller', email: (u.email as string) ?? null }));
}

// ── Lead → telecaller assignment (marketing hand-off) ──────────────────────
// Canonical calling categories (mirror analytics.service.TELECALLER_CAMPAIGNS —
// duplicated here to avoid importing the heavy analytics module for one list).
const CAMPAIGN_ALIASES: Record<string, string> = {
  generalcalls: 'General Calls', general: 'General Calls',
  goldscheme: 'Gold Scheme', goldorder: 'Gold Order',
  'app&digigold': 'App & DigiGold', appdigigold: 'App & DigiGold',
  aftersales: 'After-Sales',
  walkin: 'Walk-in', walkincustomer: 'Walk-in',
};
function canonicalCampaign(raw?: string | null): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return CAMPAIGN_ALIASES[key] ?? null;
}

/**
 * Assign (or reassign) a lead to a telecaller and optionally set its calling
 * category. Used by the marketing hand-off on the apps. Deliberately NOT gated
 * by the generic admin-only owner rule: the operation is constrained to a
 * validated telecaller owner (+ a known campaign), which is exactly the
 * marketing→telecaller workflow the product calls for. Client scope is enforced
 * so a strict-scoped caller can only touch their own client's leads. Merges the
 * campaign into custom_fields (never clobbers other keys).
 */
export async function assignLeadToTelecaller(
  org_id: string,
  scope: { id: string | null; strict: boolean },
  lead_id: string,
  telecaller_id: string,
  campaign?: string | null,
  // Optional capture-time follow-up (YYYY-MM-DD). When set, a telecaller-owned
  // open call is created so the lead surfaces in that telecaller's Follow-ups
  // tab. Used by the walk-in "Not Purchased" capture flow.
  follow_up_date?: string | null,
): Promise<Record<string, unknown>> {
  const valid = new Set((await listTelecallers(org_id, scope.id)).map((t) => t.id));
  if (!valid.has(telecaller_id)) {
    throw new AppError(400, 'Selected user is not a telecaller in this client', 'NOT_A_TELECALLER');
  }
  const { data: lead, error: readErr } = await supabaseAdmin.from('crm_leads')
    .select('id, custom_fields, client_id').eq('org_id', org_id).eq('id', lead_id).is('deleted_at', null).maybeSingle();
  if (readErr) throw new AppError(500, readErr.message, 'DB_ERROR');
  if (!lead) throw new AppError(404, 'Lead not found', 'NOT_FOUND');
  if (scope.strict && scope.id && (lead as any).client_id && (lead as any).client_id !== scope.id) {
    throw new AppError(403, 'Lead is outside your client scope', 'FORBIDDEN');
  }
  const update: Record<string, unknown> = { owner_id: telecaller_id, updated_at: new Date().toISOString() };
  const canon = canonicalCampaign(campaign);
  if (campaign && !canon) throw new AppError(400, `Unknown category "${campaign}"`, 'BAD_CAMPAIGN');
  if (canon) {
    const cf = ((lead as any).custom_fields && typeof (lead as any).custom_fields === 'object')
      ? { ...(lead as any).custom_fields } : {};
    cf.campaign = canon;
    update.custom_fields = cf;
  }
  const { data, error } = await supabaseAdmin.from('crm_leads')
    .update(update).eq('org_id', org_id).eq('id', lead_id).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  // Optional capture-time follow-up → a telecaller-owned open call so the lead
  // shows in that telecaller's Follow-ups tab (owner_id OR assigned_to match).
  // Best-effort: a follow-up failure never fails the assignment itself.
  if (follow_up_date && /^\d{4}-\d{2}-\d{2}$/.test(follow_up_date)) {
    try {
      const dueIso = new Date(`${follow_up_date}T09:00:00+05:30`).toISOString(); // 9am IST
      if (!Number.isNaN(Date.parse(dueIso))) {
        await supabaseAdmin.from('crm_activities').insert({
          org_id,
          client_id: (lead as any).client_id ?? null,
          lead_id,
          type: 'call',
          status: 'open',
          subject: 'Walk-in follow-up',
          due_at: dueIso,
          owner_id: telecaller_id,
          assigned_to: telecaller_id,
        });
      }
    } catch { /* non-blocking */ }
  }
  return data as Record<string, unknown>;
}

// ── Pending follow-ups (the telecaller "Follow-ups" tab) ───────────────────
/** The caller's OPEN follow-up calls (type=call, status open/planned/in_progress,
 *  a due date set), soonest first. Owner-scoped to the telecaller (owner_id OR
 *  assigned_to). Returned rows carry lead_id so the app can open the profile;
 *  the route enriches them with lead_name / lead_phone. */
export async function listFollowupRows(org_id: string, user_id: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabaseAdmin.from('crm_activities')
    .select('*')
    .eq('org_id', org_id).is('deleted_at', null).eq('type', 'call')
    .in('status', ['open', 'planned', 'in_progress'])
    .not('due_at', 'is', null)
    .or(`owner_id.eq.${user_id},assigned_to.eq.${user_id}`)
    .order('due_at', { ascending: true })
    .limit(500);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []) as Record<string, unknown>[];
}
