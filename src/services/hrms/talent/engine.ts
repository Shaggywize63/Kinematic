// Talent rules that run on the server with the same words as the dashboard's talentEngine.ts / talentActions.ts.
// Pure functions, no database access.

export { todayIst } from '../timesheets/engine';

export type Readiness = 'now' | '1-2y' | '3y+';
export const READINESS: ReadonlySet<Readiness> = new Set<Readiness>(['now', '1-2y', '3y+']);
export const READINESS_LABEL: Record<Readiness, string> = { now: 'Ready now', '1-2y': 'Ready in 1 to 2 years', '3y+': 'Ready in 3+ years' };

export type ChangeKind = 'added' | 'removed' | 'readiness';

export type NineLevel = 1 | 2 | 3;
export const isNineLevel = (n: unknown): n is NineLevel => n === 1 || n === 2 || n === 3;

/** The skill-level labels used in the activity log (the dashboard's LEVEL_LABEL). */
export const LEVEL_LABEL: Record<number, string> = { 0: 'Not assessed', 1: 'Aware', 2: 'Working', 3: 'Proficient', 4: 'Expert' };

/** The ratings map key — the dashboard's ratingKey (`${employeeId}|${skillId}`). */
export const ratingKey = (employeeId: string, skillId: string): string => `${employeeId}|${skillId}`;

/** A rating of 3 or 4 is a claim that needs evidence. The dashboard's validateRating, same words. */
export function validateRating(level: number, note: string): string | null {
  if (!Number.isInteger(level) || level < 0 || level > 4) return 'Pick a level from 0 to 4.';
  if (level >= 3 && note.trim().length < 8) return 'Level 3 and 4 need an evidence note: what did the assessor see?';
  return null;
}

/** The succession "give a reason" guard, the dashboard's needReason, same words. */
export const needReason = (reason: string): string | null =>
  (reason.trim().length < 5 ? 'Give a short reason (at least 5 characters). It is kept in the log.' : null);
