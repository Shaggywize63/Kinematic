/**
 * Consent service — DPDP §6 (consent), §7 (legitimate uses), §9 (parental).
 *
 * A thin, tenant-scoped API over the crm_consents ledger. Every consent event is
 * itemised by purpose, records who/when/how, and is withdrawable (§6(4)-(6)) by
 * stamping withdrawn_at rather than deleting — so the ledger stays auditable.
 *
 * This generalises the call-recording consent pattern
 * (conversation_recordings.consent_*) to every collection purpose, and gives the
 * lead/GPS/selfie flows a demonstrable consent record the bare
 * marketing_consent/whatsapp_consent booleans never provided.
 */
import { supabaseAdmin } from '../../lib/supabase';

export type ConsentSubjectType = 'lead' | 'contact' | 'employee';
export type ConsentMethod = 'in_app' | 'web_form' | 'verbal' | 'imported' | 'api';

export interface ConsentScope {
  orgId: string;
  clientId: string | null;
}

export interface RecordConsentInput {
  subjectType: ConsentSubjectType;
  subjectId?: string | null;
  purpose: string;
  consented?: boolean;
  method: ConsentMethod;
  source?: string | null;
  noticeVersion?: string | null;
  notes?: string | null;
  actorUserId?: string | null;
}

export interface WithdrawConsentInput {
  id?: string | null;
  subjectType?: ConsentSubjectType | null;
  subjectId?: string | null;
  purpose?: string | null;
  actorUserId?: string | null;
}

/** Record a consent (or explicit refusal, when consented=false) event. */
export async function recordConsent(scope: ConsentScope, input: RecordConsentInput): Promise<any> {
  const row = {
    org_id: scope.orgId,
    client_id: scope.clientId,
    subject_type: input.subjectType,
    subject_id: input.subjectId ?? null,
    purpose: input.purpose,
    consented: input.consented ?? true,
    method: input.method,
    source: input.source ?? null,
    notice_version: input.noticeVersion ?? null,
    notes: input.notes ?? null,
    actor_user_id: input.actorUserId ?? null,
  };
  const { data, error } = await supabaseAdmin.from('crm_consents').insert(row).select('*').single();
  if (error) throw new Error(`recordConsent: ${error.message}`);
  return data;
}

/**
 * Withdraw consent (§6(4)-(6)). Either target one row by id, or withdraw every
 * currently-active row for a (subject_type, subject_id, purpose). Always
 * org-scoped so one tenant can never withdraw another's consent. Returns the
 * number of consent rows withdrawn.
 */
export async function withdrawConsent(scope: ConsentScope, input: WithdrawConsentInput): Promise<{ withdrawn: number }> {
  const nowIso = new Date().toISOString();
  const patch = { withdrawn_at: nowIso, withdrawn_by: input.actorUserId ?? null };

  let q = supabaseAdmin.from('crm_consents').update(patch, { count: 'exact' }).eq('org_id', scope.orgId).is('withdrawn_at', null);
  if (input.id) {
    q = q.eq('id', input.id);
  } else if (input.subjectType && input.subjectId && input.purpose) {
    q = q.eq('subject_type', input.subjectType).eq('subject_id', input.subjectId).eq('purpose', input.purpose);
  } else {
    throw new Error('withdrawConsent: provide id, or subject_type + subject_id + purpose');
  }
  const { count, error } = await q;
  if (error) throw new Error(`withdrawConsent: ${error.message}`);
  return { withdrawn: count ?? 0 };
}

/** List consent events for a subject (most recent first). */
export async function listConsents(
  scope: ConsentScope,
  filter: { subjectType?: ConsentSubjectType; subjectId?: string; purpose?: string },
): Promise<any[]> {
  let q = supabaseAdmin.from('crm_consents').select('*').eq('org_id', scope.orgId).order('created_at', { ascending: false });
  if (filter.subjectType) q = q.eq('subject_type', filter.subjectType);
  if (filter.subjectId) q = q.eq('subject_id', filter.subjectId);
  if (filter.purpose) q = q.eq('purpose', filter.purpose);
  const { data, error } = await q;
  if (error) throw new Error(`listConsents: ${error.message}`);
  return data ?? [];
}

/**
 * True when the subject has a current (non-withdrawn) affirmative consent for the
 * purpose. Use to gate processing at the point of use (e.g. before sending
 * marketing, before AI profiling, before recording).
 */
export async function hasActiveConsent(
  scope: ConsentScope,
  subjectType: ConsentSubjectType,
  subjectId: string,
  purpose: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('crm_consents')
    .select('id')
    .eq('org_id', scope.orgId)
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .eq('purpose', purpose)
    .eq('consented', true)
    .is('withdrawn_at', null)
    .limit(1);
  if (error) throw new Error(`hasActiveConsent: ${error.message}`);
  return (data?.length ?? 0) > 0;
}
