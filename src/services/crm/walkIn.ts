/**
 * Walk-in "Not Purchased" quick-capture detection.
 *
 * The marketing / reception walk-in form (Android + web dashboard) is a
 * deliberately minimal lead intake: it collects only name / phone / visit
 * details, NOT the full sales-lead field set. Both clients tag the lead with a
 * shared `custom_fields` contract — `campaign: 'Walk-in'` and
 * `purchase_status: 'not_purchased'`.
 *
 * The lead-create route uses this to skip required-*custom*-field enforcement
 * for walk-in captures (a client admin may mark fields like "Approx. Budget" /
 * "Area" required for the MAIN lead form; enforcing them on the minimal walk-in
 * form would 400 every save). Built-in required fields (name / phone) are still
 * enforced, and custom-field type coercion still runs.
 */
export function isWalkInCapture(customFields: unknown): boolean {
  if (!customFields || typeof customFields !== 'object') return false;
  const cf = customFields as Record<string, unknown>;
  return cf.campaign === 'Walk-in' || cf.purchase_status === 'not_purchased';
}
