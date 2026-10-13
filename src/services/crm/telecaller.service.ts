import { AuthRequest } from '../../types';

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
