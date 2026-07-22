/**
 * Nominee service — DPDP §14 (right to nominate).
 *
 * Records, lists and revokes a Data Principal's nominee (who may exercise the
 * principal's rights on death/incapacity). Tenant-scoped and staff-captured,
 * mirroring the consent ledger. Revocation stamps revoked_at rather than
 * deleting, preserving the record.
 */
import { supabaseAdmin } from '../../lib/supabase';

export type NomineeSubjectType = 'lead' | 'contact' | 'employee';

export interface NomineeScope {
  orgId: string;
  clientId: string | null;
}

export interface RecordNomineeInput {
  subjectType: NomineeSubjectType;
  subjectId: string;
  nomineeName: string;
  nomineeRelationship?: string | null;
  nomineeContact?: string | null;
  notes?: string | null;
  actorUserId?: string | null;
}

/** Record a nominee for a subject. */
export async function recordNominee(scope: NomineeScope, input: RecordNomineeInput): Promise<any> {
  const row = {
    org_id: scope.orgId,
    client_id: scope.clientId,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    nominee_name: input.nomineeName,
    nominee_relationship: input.nomineeRelationship ?? null,
    nominee_contact: input.nomineeContact ?? null,
    notes: input.notes ?? null,
    actor_user_id: input.actorUserId ?? null,
  };
  const { data, error } = await supabaseAdmin.from('crm_nominees').insert(row).select('*').single();
  if (error) throw new Error(`recordNominee: ${error.message}`);
  return data;
}

/** List a subject's nominees (most recent first). */
export async function listNominees(
  scope: NomineeScope,
  filter: { subjectType?: NomineeSubjectType; subjectId?: string },
): Promise<any[]> {
  let q = supabaseAdmin.from('crm_nominees').select('*').eq('org_id', scope.orgId).order('created_at', { ascending: false });
  if (filter.subjectType) q = q.eq('subject_type', filter.subjectType);
  if (filter.subjectId) q = q.eq('subject_id', filter.subjectId);
  const { data, error } = await q;
  if (error) throw new Error(`listNominees: ${error.message}`);
  return data ?? [];
}

/** Revoke a nominee by id (org-scoped). Returns rows revoked. */
export async function revokeNominee(scope: NomineeScope, id: string, actorUserId?: string | null): Promise<{ revoked: number }> {
  const { count, error } = await supabaseAdmin
    .from('crm_nominees')
    .update({ revoked_at: new Date().toISOString(), revoked_by: actorUserId ?? null }, { count: 'exact' })
    .eq('org_id', scope.orgId)
    .eq('id', id)
    .is('revoked_at', null);
  if (error) throw new Error(`revokeNominee: ${error.message}`);
  return { revoked: count ?? 0 };
}
