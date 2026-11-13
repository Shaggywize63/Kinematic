import { AppError } from '../../../utils';
import { db, fail, HrmsScope, isUniqueViolation, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, newId, notFound, refuse } from '../payroll/common';
import { CLAIM_NEXT } from './engine';
import type { ClaimStatus } from './engine';
import { claimOut } from './mapping';

// Insurance claims and their append-only status trail. The rules are the dashboard rewards/store.ts registerClaim /
// moveClaim, with their exact plain words. Register and move go through the atomic plpgsql functions
// (migration_hrms_benefits.sql) so the ref assignment, the trail and the status never diverge, and of two concurrent
// moves of one claim exactly one wins.
//
//   registerClaim: only an enrolled employee can claim; the patient must be covered; the server assigns the TPA ref.
//   moveClaim: the CLAIM_NEXT state machine; approved needs an amount in range; a rejection needs a reason; reopening a
//              rejected claim needs a note (the employee's reply).

const T = 'hrms_benefit_claims';
const today = (): string => new Date().toISOString().slice(0, 10);

const find = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

const enrolmentOfEmployee = async (s: HrmsScope, employeeId: string): Promise<Row | null> =>
  must(await scoped(db().from('hrms_benefit_enrolments').select('status,dependants'), s).eq('employee_id', employeeId).maybeSingle()) as Row | null;

const readable = (s: string): string => s.replace('_', ' ');

export interface NewClaimInput {
  id?: string; employee_id: string; patient: string; relation: 'self' | 'spouse' | 'child' | 'parent';
  kind: 'cashless' | 'reimbursement'; hospital: string; claimed: number;
}

export async function registerClaim(s: HrmsScope, i: NewClaimInput): Promise<Row> {
  const en = await enrolmentOfEmployee(s, i.employee_id);
  if (!en || en.status !== 'enrolled') throw invalid('Only an enrolled employee can claim.');
  if (!String(i.hospital ?? '').trim()) throw invalid('Enter the hospital or clinic.');
  if (!(i.claimed > 0)) throw invalid('Enter the amount claimed.');
  const dependants = (Array.isArray(en.dependants) ? en.dependants : []) as Array<{ name: string; relation: string }>;
  const covered = i.relation === 'self' || dependants.some((x) => x.name === i.patient && x.relation === i.relation);
  if (!covered) throw invalid('The patient is not covered under this enrolment.');

  const id = (i.id as string | undefined) ?? newId();
  if (i.id) { const existing = await find(s, id); if (existing) return claimOut(existing); }

  const patient = i.relation === 'self' ? 'Self' : String(i.patient ?? '').trim();
  const hospital = String(i.hospital).trim();
  const claimed = Math.round(i.claimed);

  // The unique(org, ref) index is the race-safe backstop: a raced ref (two registers that read the same count) is a
  // 23505, and we recompute (the function re-counts) and retry.
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await db().rpc('hrms_benefit_register_claim', {
      p_org: s.org_id, p_claim: id, p_employee: i.employee_id, p_patient: patient, p_relation: i.relation,
      p_kind: i.kind, p_hospital: hospital, p_claimed: claimed, p_on: today(), p_by: s.actor,
    });
    if (!error) { const row = await find(s, String(data)); if (row) return claimOut(row); return claimOut({ id }); }
    if (isUniqueViolation(error, 'hrms_benefit_claims_org_ref_uq')) continue;
    if (i.id && isUniqueViolation(error, 'pkey')) { const mine = await find(s, id); if (mine) return claimOut(mine); throw refuse(409, 'This id is already in use', 'ID_IN_USE'); }
    throw fail(error);
  }
  throw refuse(409, 'Could not assign a claim reference. Try again.', 'CLAIM_REF');
}

export interface MoveClaimInput { to: ClaimStatus; note?: string | null; approved?: number | null; reason?: string | null }

export async function moveClaim(s: HrmsScope, id: string, o: MoveClaimInput): Promise<{ claim: Row }> {
  const c = await find(s, id);
  if (!c) throw notFound('That claim is not in the tracker.');
  const from = String(c.status) as ClaimStatus;
  const to = o.to;
  if (!CLAIM_NEXT[from]?.includes(to)) throw refuse(409, `A claim that is ${readable(from)} cannot move to ${readable(to)}.`, 'CLAIM_STATE');
  const approved = o.approved;
  if (to === 'approved' && !(approved != null && approved > 0 && approved <= Number(c.claimed))) throw invalid('Enter an approved amount that is more than 0 and not more than the amount claimed.');
  if (to === 'rejected' && !String(o.reason ?? '').trim()) throw invalid('A rejection needs a reason, so the employee can reply.');
  if (from === 'rejected' && !String(o.note ?? '').trim()) throw invalid("Write the employee's reply or the reason for the review.");

  const { data, error } = await db().rpc('hrms_benefit_move_claim', {
    p_org: s.org_id, p_claim: id, p_to: to, p_on: today(),
    p_approved: to === 'approved' ? Math.round(approved!) : null,
    p_reason: o.reason ?? null, p_note: o.note ?? null, p_by: s.actor,
  });
  if (error) throw await moveError(s, id, to, error);
  const row = await find(s, String(data));
  return { claim: row ? claimOut(row) : claimOut(c) };
}

/** Map a failure of hrms_benefit_move_claim (token as the message, SQLSTATE P0001) to the dashboard's plain refusal. */
async function moveError(s: HrmsScope, id: string, to: ClaimStatus, error: { code?: string; message?: string }): Promise<AppError> {
  switch ((error.message ?? '').trim()) {
    case 'CLAIM_NOT_FOUND': return notFound('That claim is not in the tracker.');
    case 'CLAIM_STATE': {
      const fresh = await find(s, id);
      const from = fresh ? (String(fresh.status) as ClaimStatus) : null;
      return from ? refuse(409, `A claim that is ${readable(from)} cannot move to ${readable(to)}.`, 'CLAIM_STATE') : notFound('That claim is not in the tracker.');
    }
    default: return fail(error);
  }
}
