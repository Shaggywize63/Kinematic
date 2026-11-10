import { AppError } from '../../../utils';
import { db, fail, HrmsScope, must, scopeCols, scoped } from '../scope';
import { LABOUR_CODES } from './engine';
import type { OvertimeRule } from './engine';
import { DEFAULT_OVERTIME_RULE } from './mapping';

// Payroll settings live in hrms_settings under the key `payroll`: { overtime_rule }. An org that never saved one gets the dashboard's seed
// rule (ot_std). The overtime rule is the only payroll setting today.

export const PAYROLL_KEY = 'payroll';

const isRule = (v: unknown): v is OvertimeRule =>
  !!v && typeof v === 'object' && typeof (v as OvertimeRule).rateMultiplier === 'number' && Array.isArray((v as OvertimeRule).appliesTo);

export async function getOvertimeRule(s: HrmsScope): Promise<OvertimeRule> {
  const row = must(await scoped(db().from('hrms_settings').select('value'), s).eq('key', PAYROLL_KEY).maybeSingle()) as { value?: { overtime_rule?: unknown } } | null;
  const rule = row?.value?.overtime_rule;
  return isRule(rule) ? { ...DEFAULT_OVERTIME_RULE, ...rule } : { ...DEFAULT_OVERTIME_RULE };
}

export async function getPayrollSettings(s: HrmsScope): Promise<{ payroll: { overtime_rule: OvertimeRule } }> {
  return { payroll: { overtime_rule: await getOvertimeRule(s) } };
}

/**
 * The rules of the Overtime tab (kinematic-dashboard components/hrms/time/timeLogic.ts validateOvertime), with its words. The 144 hour
 * quarterly cap is only a warning there ("you can save it"), so it does not block here either.
 */
export function validateOvertimeRule(r: OvertimeRule): string | null {
  if (!r.name.trim()) return 'Rule name is required';
  if (r.rateMultiplier < LABOUR_CODES.overtimeMultiplier) return `Overtime cannot pay less than ${LABOUR_CODES.overtimeMultiplier}x the ordinary rate under the Labour Codes`;
  if (!(r.quarterlyCapHours > 0)) return 'Enter the quarterly cap in hours';
  if (!Number.isInteger(r.minMinutes) || r.minMinutes < 0 || r.minMinutes > 240) return 'Minimum is 0 to 240 whole minutes';
  if (r.appliesTo.length === 0) return 'Choose at least one employment type';
  return null;
}

export async function setPayrollSettings(s: HrmsScope, input: OvertimeRule): Promise<{ payroll: { overtime_rule: OvertimeRule } }> {
  const rule: OvertimeRule = {
    id: input.id ?? DEFAULT_OVERTIME_RULE.id, name: input.name.trim(), rateMultiplier: input.rateMultiplier, quarterlyCapHours: input.quarterlyCapHours,
    requiresConsent: input.requiresConsent, minMinutes: input.minMinutes, rateDivisor: input.rateDivisor, womenNightConsent: input.womenNightConsent,
    appliesTo: Array.from(new Set(input.appliesTo)),
  };
  const problem = validateOvertimeRule(rule);
  if (problem) throw new AppError(400, problem, 'VALIDATION');
  const { error } = await db().from('hrms_settings').upsert(
    { ...scopeCols(s), key: PAYROLL_KEY, value: { overtime_rule: rule }, updated_at: new Date().toISOString() },
    { onConflict: 'org_id,key' },
  );
  if (error) throw fail(error);
  return getPayrollSettings(s);
}
