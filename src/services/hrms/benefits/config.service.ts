import { db, fail, HrmsScope, isUniqueViolation, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, now } from '../payroll/common';
import { addDays } from '../payroll/engine';
import type { BenefitsWindow } from './engine';
import { remindersOut, windowOut } from './mapping';

// The benefits config is a SINGLETON per org (unique org_id): the enrolment window (opens/closes + its extensions), the
// reminders map (employeeId -> date a reminder was logged) and the sent map (month -> send record). The window and
// reminders are read-modify-write here (load the singleton, change one aspect, upsert the whole row); the sent map is
// merged atomically by hrms_benefit_send_to_payroll (payroll.service.ts), so a send never clobbers a window change.
//
// extendWindow / logReminders reproduce the dashboard's rewards/store.ts words:
//   - "Extend by 1 to 30 days." / "Write a short reason for the extension."
//   - "Nobody is waiting to enrol."
// PUT /window (set opens/closes) has no dashboard action; it is a plain setter with date validation only.

const T = 'hrms_benefit_config';

const today = (): string => new Date().toISOString().slice(0, 10);

/** The stored singleton for the org, or null when the org has never written one. */
export async function loadConfig(s: HrmsScope): Promise<Row | null> {
  return must(await scoped(db().from(T).select('*'), s).maybeSingle()) as Row | null;
}

/** The window the org would start with (today .. today+14), used until a window is stored. */
function defaultConfigRow(): Row {
  const open = today();
  return { opens_on: open, closes_on: addDays(open, 14), extensions: [], reminders: {}, sent: {} };
}

/** The stored singleton, or an unsaved default when none exists yet. */
async function currentOrDefault(s: HrmsScope): Promise<Row> {
  return (await loadConfig(s)) ?? defaultConfigRow();
}

/** The enrolment window in the engine's camelCase shape (the stored one, or the today..today+14 default). */
export async function loadBenefitsWindow(s: HrmsScope): Promise<BenefitsWindow> {
  const cfg = await currentOrDefault(s);
  return {
    opensOn: String(cfg.opens_on),
    closesOn: String(cfg.closes_on),
    extensions: Array.isArray(cfg.extensions) ? (cfg.extensions as BenefitsWindow['extensions']) : [],
  };
}

/** Upsert the whole singleton (the unique org_id is the conflict target), returning the stored row. */
async function saveConfig(s: HrmsScope, cfg: Row): Promise<Row> {
  const res = await db().from(T)
    .upsert({ ...scopeCols(s), opens_on: cfg.opens_on, closes_on: cfg.closes_on, extensions: cfg.extensions ?? [], reminders: cfg.reminders ?? {}, sent: cfg.sent ?? {}, updated_at: now() }, { onConflict: 'org_id' })
    .select('*').single();
  if (res.error) throw fail(res.error);
  return res.data as Row;
}

/** Make sure the singleton exists (so a send-to-payroll sent-map update has a row to land on). Idempotent, race-safe. */
export async function ensureConfig(s: HrmsScope): Promise<Row> {
  const existing = await loadConfig(s);
  if (existing) return existing;
  const res = await db().from(T).insert({ ...scopeCols(s), ...defaultConfigRow() }).select('*').single();
  if (res.error) {
    if (isUniqueViolation(res.error)) { const again = await loadConfig(s); if (again) return again; }
    throw fail(res.error);
  }
  return res.data as Row;
}

// ── window ──────────────────────────────────────────────────────────────────
export async function setWindow(s: HrmsScope, input: { opens_on: string; closes_on: string }): Promise<{ window: Row }> {
  const cur = await currentOrDefault(s);
  const saved = await saveConfig(s, { ...cur, opens_on: input.opens_on, closes_on: input.closes_on });
  return { window: windowOut(saved) };
}

/** extendWindow: add 1..30 days to the window (from the later of today and the current close), logging the extension. */
export async function extendWindow(s: HrmsScope, input: { days: number; reason: string }): Promise<{ window: Row }> {
  const days = input.days;
  if (!Number.isInteger(days) || days < 1 || days > 30) throw invalid('Extend by 1 to 30 days.');
  const reason = String(input.reason ?? '').trim();
  if (!reason) throw invalid('Write a short reason for the extension.');
  const cur = await currentOrDefault(s);
  const t = today();
  const base = String(cur.closes_on) > t ? String(cur.closes_on) : t;
  const closesOn = addDays(base, days);
  const extensions = [...(Array.isArray(cur.extensions) ? cur.extensions : []), { on: t, days, reason, by: s.actor }];
  const saved = await saveConfig(s, { ...cur, closes_on: closesOn, extensions });
  return { window: windowOut(saved) };
}

// ── reminders ─────────────────────────────────────────────────────────────────
/** logReminders: record today's date per employee in the reminders map (a simulation; nothing is sent). */
export async function logReminders(s: HrmsScope, employeeIds: string[]): Promise<{ reminders: Record<string, string>; count: number }> {
  const ids = Array.isArray(employeeIds) ? employeeIds : [];
  if (!ids.length) throw invalid('Nobody is waiting to enrol.');
  const cur = await currentOrDefault(s);
  const reminders: Record<string, string> = { ...(cur.reminders && typeof cur.reminders === 'object' ? cur.reminders : {}) };
  const t = today();
  for (const id of ids) reminders[id] = t;
  const saved = await saveConfig(s, { ...cur, reminders });
  return { reminders: remindersOut(saved), count: ids.length };
}

/** submitEnrolment clears any pending reminder for the person. No-op when there is no stored config or no reminder. */
export async function clearReminder(s: HrmsScope, employeeId: string): Promise<void> {
  const cur = await loadConfig(s);
  if (!cur || !cur.reminders || typeof cur.reminders !== 'object' || !(employeeId in (cur.reminders as Row))) return;
  const reminders: Record<string, string> = { ...(cur.reminders as Record<string, string>) };
  delete reminders[employeeId];
  await saveConfig(s, { ...cur, reminders });
}
