/**
 * Contact rules for creating a user.
 *
 * A mobile number is OPTIONAL. A person still has to be able to sign in, so a new user needs at
 * least one of a mobile number or an email; when a mobile number is given it must be exactly
 * 10 digits (unchanged). Everything is pure so it is unit-tested without a database.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MOBILE_RE = /^\d{10}$/;

/** A trimmed mobile number, or null when none was given (undefined, null, '' and spaces all mean "none"). */
export function normalizeMobile(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** The first problem with a new user's contact details, or null when they are fine. */
export function newUserContactProblem(input: { mobile?: unknown; email?: unknown }): string | null {
  const mobile = normalizeMobile(input.mobile);
  const email = input.email === null || input.email === undefined ? '' : String(input.email).trim();
  if (!mobile && !email) return 'Provide a mobile number or an email so the user can sign in';
  if (mobile && !MOBILE_RE.test(mobile)) return 'Mobile number must be exactly 10 digits';
  if (email && !EMAIL_RE.test(email)) return 'Please provide a valid email address';
  return null;
}
