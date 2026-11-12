import type { Row } from '../payroll/common';

// Rows -> the wire. Pure functions, no database access. Top-level keys snake_case, null for "nothing"; the nested arrays (tasks,
// clearance, assets) are rebuilt in the dashboard's documented camelCase key order so jsonb's key-length sorting never scrambles them,
// exactly as the payroll and time mappings do for payslip lines and leave accrual.

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown): boolean => !!v;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

// ── onboarding cases ──────────────────────────────────────────────────────────
// task: { id, label, owner, done, dueOn? } — dueOn is omitted entirely when absent (the dashboard treats it as optional).
const taskOut = (t: Row): Row => {
  const o: Row = { id: str(t.id), label: str(t.label), owner: str(t.owner), done: bool(t.done) };
  if (t.dueOn !== null && t.dueOn !== undefined && t.dueOn !== '') o.dueOn = String(t.dueOn);
  return o;
};
export const onboardingOut = (r: Row): Row => ({
  id: r.id, employee_id: r.employee_id ?? null, name: r.name, role: r.role, join_date: iso(r.join_date), stage: r.stage,
  tasks: Array.isArray(r.tasks) ? r.tasks.map(taskOut) : [],
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

// ── exit cases ────────────────────────────────────────────────────────────────
// clearance: { id, department, owner, done, remarks? }; remarks omitted when absent. asset: { id, name, returned }.
const clearanceOut = (c: Row): Row => {
  const o: Row = { id: str(c.id), department: str(c.department), owner: str(c.owner), done: bool(c.done) };
  if (c.remarks !== null && c.remarks !== undefined && c.remarks !== '') o.remarks = String(c.remarks);
  return o;
};
const assetOut = (a: Row): Row => ({ id: str(a.id), name: str(a.name), returned: bool(a.returned) });
export const exitOut = (r: Row): Row => ({
  id: r.id, employee_id: r.employee_id, reason: r.reason, resignation_date: iso(r.resignation_date), last_working_date: iso(r.last_working_date),
  notice_waived: bool(r.notice_waived), stage: r.stage,
  clearance: Array.isArray(r.clearance) ? r.clearance.map(clearanceOut) : [],
  assets: Array.isArray(r.assets) ? r.assets.map(assetOut) : [],
  interview_done: bool(r.interview_done),
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

// ── letter templates ──────────────────────────────────────────────────────────
export const letterTemplateOut = (r: Row): Row => ({
  id: r.id, type: r.type, name: r.name, body: str(r.body),
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

// ── issued letters ────────────────────────────────────────────────────────────
export const issuedLetterOut = (r: Row): Row => ({
  id: r.id, employee_id: r.employee_id, template_id: r.template_id ?? null, type: r.type, issued_on: iso(r.issued_on),
  body: str(r.body), signed: bool(r.signed),
  created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});
