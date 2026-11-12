// Write-time validation for Lifecycle + Letters, reproducing EXACTLY the rules and the plain messages the dashboard shows today
// (kinematic-dashboard/src/components/hrms/lifecycle/TemplateEditor.tsx save(), and lifecycleActions.ts exitChecks / closeExit). Only
// the blocking errors are enforced; the first failing check is the one returned, so the API answers with the dashboard's own words.
// Pure functions, no database access.

// ── letter templates (TemplateEditor.tsx save(), verbatim wording) ───────────
/** The first problem the template editor would flag for name + body, or null. The "unknown merge field" check is client-only (it needs
 *  the live merge-field analysis), so it is deliberately not enforced here; the contract asks only for type / name / body length. */
export function validateTemplate(name: string, body: string): string | null {
  const n = name.trim();
  if (n.length < 2) return 'Give the template a name';
  if (n.length > 80) return 'Keep the name under 80 characters';
  if (body.trim().length < 20) return 'The letter body is too short';
  return null;
}

// ── exit close-blocker (lifecycleActions.ts exitChecks, verbatim) ────────────
export interface ClearanceLike { department: string; done: boolean }
export interface FnfLike { status: string }

/** The pending-clearance blocker text, or null when every clearance item is done (exitChecks' clearance branch). */
export function clearanceBlocker(clearance: ClearanceLike[]): string | null {
  const pending = clearance.filter((i) => !i.done);
  if (pending.length === 0) return null;
  return `${pending.length} of ${clearance.length} clearances still pending: ${pending.map((i) => i.department).join(', ')}.`;
}

/** The full-and-final blocker text, or null when the case is paid (exitChecks' fnf branch). `fnf` is the employee's latest F&F case. */
export function fnfBlocker(fnf: FnfLike | null): string | null {
  if (!fnf) return 'No full and final case exists yet. Create and pay it on the payroll page.';
  if (fnf.status === 'paid') return null;
  return `The full and final case is ${fnf.status}, and it must be paid before the exit can close.`;
}

/** Every blocker that stops an exit from closing, in the dashboard's order (clearance, then F&F). closeExit() joins them with a space. */
export function closeBlockers(clearance: ClearanceLike[], fnf: FnfLike | null): string[] {
  return [clearanceBlocker(clearance), fnfBlocker(fnf)].filter((x): x is string => x !== null);
}
