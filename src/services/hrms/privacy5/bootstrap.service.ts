import { db, fetchAll, HrmsScope, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { complianceOut, consentOut, retentionOut } from './mapping';

// Everything the Privacy/DPDP + Compliance page needs for the org in one call: compliance tasks, consent records and retention rules.
// All three are simple records (no server commands), so this is a plain multi-select, like the Time / Lifecycle bootstraps. The access
// log is NOT included here -- it is read through the existing GET /hrms/access-log (phase 1).

export async function privacyBootstrap(s: HrmsScope) {
  const list = (table: string, orders: string[]) =>
    fetchAll<Row>((from, to) => {
      let q = scoped(db().from(table).select('*'), s);
      for (const o of orders) q = q.order(o, { ascending: true });
      return q.range(from, to);
    });
  const [compliance, consents, retention] = await Promise.all([
    list('hrms_compliance_tasks', ['due_on', 'name', 'id']),
    list('hrms_consents', ['granted_at', 'employee_id', 'id']),
    list('hrms_retention_rules', ['dataset', 'id']),
  ]);
  return {
    compliance_tasks: compliance.map(complianceOut),
    consents: consents.map(consentOut),
    retention_rules: retention.map(retentionOut),
    server_time: new Date().toISOString(),
  };
}
