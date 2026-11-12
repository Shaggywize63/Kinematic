import { db, fetchAll, HrmsScope, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { exitOut, issuedLetterOut, letterTemplateOut, onboardingOut } from './mapping';

// Everything Lifecycle + Letters needs for the org in one call: onboarding cases, exit cases, letter templates and the issued-letter
// register. All four are simple records (no server commands), so this is a plain multi-select, like the Time bootstrap.

export async function lifecycleBootstrap(s: HrmsScope) {
  const list = (table: string, orders: string[]) =>
    fetchAll<Row>((from, to) => {
      let q = scoped(db().from(table).select('*'), s);
      for (const o of orders) q = q.order(o, { ascending: true });
      return q.range(from, to);
    });
  const [onboarding, exits, templates, letters] = await Promise.all([
    list('hrms_onboarding_cases', ['join_date', 'name', 'id']),
    list('hrms_exit_cases', ['last_working_date', 'employee_id', 'id']),
    list('hrms_letter_templates', ['type', 'name', 'id']),
    list('hrms_issued_letters', ['issued_on', 'employee_id', 'id']),
  ]);
  return {
    onboarding_cases: onboarding.map(onboardingOut),
    exit_cases: exits.map(exitOut),
    letter_templates: templates.map(letterTemplateOut),
    issued_letters: letters.map(issuedLetterOut),
    server_time: new Date().toISOString(),
  };
}
