/**
 * Age helpers for children's-data handling (DPDP §9).
 *
 * DPDP treats anyone under 18 as a child: their data may not be used for
 * behavioural tracking/monitoring or targeted advertising, and requires
 * verifiable parental/guardian consent. We derive age from the collected
 * date_of_birth so the scoring/profiling pipeline can exclude minors.
 */

/** India DPDP age of majority. */
export const DPDP_MINOR_AGE = 18;

/** Whole-years age from a YYYY-MM-DD (or ISO) date of birth, or null if unparseable/absent. */
export function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob || typeof dob !== 'string') return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  if (age < 0 || age > 150) return null; // guard against typo'd / future dates
  return age;
}

/**
 * True when the DOB indicates a child (< 18). Returns false when DOB is absent
 * or unparseable — we only special-case records we can positively identify as a
 * minor; a missing DOB is handled by consent/notice, not by silent assumption.
 */
export function isMinor(dob: string | null | undefined, threshold: number = DPDP_MINOR_AGE): boolean {
  const age = ageFromDob(dob);
  return age !== null && age < threshold;
}
