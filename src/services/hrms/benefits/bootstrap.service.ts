import { db, fetchAll, HrmsScope, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { addDays } from '../payroll/engine';
import { claimOut, enrolmentOut, planOut, remindersOut, sentOut, windowOut } from './mapping';
import { loadConfig } from './config.service';

// Everything Benefits needs for the org in one call: the plan catalogue, the enrolments, the claims (with their trail),
// the enrolment window (+ extensions), the reminders map and the sent map. The window / reminders / sent come from the
// config singleton; a brand-new org that has never written a config gets the today..today+14 default window and empty
// maps, so Live mode can render the Benefits page from empty.

const today = (): string => new Date().toISOString().slice(0, 10);

export async function benefitsBootstrap(s: HrmsScope) {
  const list = (table: string, orders: string[]) =>
    fetchAll<Row>((from, to) => {
      let q = scoped(db().from(table).select('*'), s);
      for (const o of orders) q = q.order(o, { ascending: true });
      return q.range(from, to);
    });
  const [plans, enrolments, claims, config] = await Promise.all([
    list('hrms_benefit_plans', ['created_at', 'id']),
    list('hrms_benefit_enrolments', ['created_at', 'id']),
    list('hrms_benefit_claims', ['created_at', 'id']),
    loadConfig(s),
  ]);
  const window = config ? windowOut(config) : { opens_on: today(), closes_on: addDays(today(), 14), extensions: [] as Row[] };
  return {
    plans: plans.map(planOut),
    enrolments: enrolments.map(enrolmentOut),
    claims: claims.map(claimOut),
    window,
    reminders: remindersOut(config),
    sent: sentOut(config),
    server_time: new Date().toISOString(),
  };
}
