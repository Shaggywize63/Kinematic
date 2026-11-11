import { db, fail, HrmsScope, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, notFound, now } from '../payroll/common';
import { balanceOut } from './mapping';

// Leave balances (one per employee and leave type). Upserted by PUT /time/balances/:employeeId/:leaveTypeId with the five numbers;
// each must be non-negative, and both the employee and the leave type must belong to the org.

const T = 'hrms_leave_balances';
const FIELDS = ['opening', 'accrued', 'taken', 'encashed', 'lapsed'] as const;
const LABELS: Record<(typeof FIELDS)[number], string> = { opening: 'Opening', accrued: 'Accrued', taken: 'Taken', encashed: 'Encashed', lapsed: 'Lapsed' };

const liveEmployee = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from('hrms_employees').select('id'), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;
const leaveType = async (s: HrmsScope, id: string): Promise<Row | null> =>
  must(await scoped(db().from('hrms_leave_types').select('id'), s).eq('id', id).maybeSingle()) as Row | null;
const existing = async (s: HrmsScope, employeeId: string, leaveTypeId: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('employee_id', employeeId).eq('leave_type_id', leaveTypeId).maybeSingle()) as Row | null;

export async function putBalance(s: HrmsScope, employeeId: string, leaveTypeId: string, body: Row): Promise<Row> {
  if (!(await liveEmployee(s, employeeId))) throw notFound('Employee not found');
  if (!(await leaveType(s, leaveTypeId))) throw notFound('Leave type not found');
  const current = await existing(s, employeeId, leaveTypeId);
  const numbers: Row = {};
  for (const f of FIELDS) {
    const v = body[f] !== undefined ? Number(body[f]) : (current ? Number(current[f]) : 0);
    if (!(v >= 0)) throw invalid(`${LABELS[f]} cannot be negative`);
    numbers[f] = v;
  }
  const res = await db().from(T).upsert(
    { ...scopeCols(s), employee_id: employeeId, leave_type_id: leaveTypeId, ...numbers, updated_at: now() },
    { onConflict: 'org_id,employee_id,leave_type_id' },
  ).select('*').single();
  if (res.error) throw fail(res.error);
  return balanceOut(res.data as Row);
}
