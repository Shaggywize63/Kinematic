/**
 * Home "Recent activity" card titles — PURE logic, no I/O.
 *
 * An ad-hoc form submit from the mobile apps arrives with `form_submissions.outlet_name` NULL, so
 * every card on the Home feed used to read "Unknown Store". The customer the rep actually visited is
 * usually one of the form's own answers (a question labelled "Customer name", "Shop name", …), stored
 * as a `form_responses` row whose question label lives in `builder_questions.label`.
 *
 * This module picks that answer and builds the card title/subtitle. The DB read lives in the
 * controller (analytics.controller.ts -> getActivityFeed) and is best-effort: if it fails the feed is
 * returned without these fields, exactly as before.
 */

/** What the legacy `outlet_name` field falls back to (kept for old app builds). */
export const UNKNOWN_STORE_FALLBACK = 'Unknown Store';

/** Last-resort card title when there is no customer, no real outlet name and no form title. */
export const FEED_TITLE_FALLBACK = 'Form submission';

/**
 * Question labels that identify the customer, best match FIRST. Compared case-insensitively on the
 * trimmed label (inner whitespace runs collapsed). An answer to an earlier entry beats an answer to a
 * later one, whatever order the rows come back in.
 */
export const CUSTOMER_NAME_LABELS: readonly string[] = [
  'customer name',
  'customer_name',
  'customer',
  'client name',
  'party name',
  'shop name',
  'outlet name',
];

/** One answered question, as read from `form_responses` joined to `builder_questions(label)`. */
export interface FeedAnswer {
  label: string | null | undefined;
  value_text: string | null | undefined;
}

/** Lower-cased, trimmed, inner whitespace collapsed; '' for anything that is not a string. */
export function normaliseLabel(label: unknown): string {
  return typeof label === 'string' ? label.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

/** A trimmed non-empty string, else null. */
function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

/**
 * The customer name out of one submission's answers: the trimmed, non-empty `value_text` of the
 * best-matching question (see CUSTOMER_NAME_LABELS for the priority). A matching question whose
 * answer is blank is skipped, so the next-best labelled question with an answer wins. When the same
 * label appears twice, the first answered one (in input order) wins. null when nothing matches.
 */
export function pickCustomerName(
  answers: ReadonlyArray<FeedAnswer> | null | undefined,
  priority: readonly string[] = CUSTOMER_NAME_LABELS,
): string | null {
  if (!answers || !answers.length) return null;
  let bestRank = Infinity;
  let best: string | null = null;
  for (const a of answers) {
    if (!a) continue;
    const rank = priority.indexOf(normaliseLabel(a.label));
    if (rank < 0 || rank >= bestRank) continue;
    const text = cleanText(a.value_text);
    if (text === null) continue;
    bestRank = rank;
    best = text;
  }
  return best;
}

/** True when `outlet_name` is a real name, not blank and not the legacy 'Unknown Store' placeholder. */
export function isRealOutletName(outletName: unknown): boolean {
  const t = cleanText(outletName);
  return t !== null && t.toLowerCase() !== UNKNOWN_STORE_FALLBACK.toLowerCase();
}

export interface FeedTitle {
  title: string;
  subtitle: string | null;
}

/**
 * Card title + subtitle.
 *   title    = customer name || real outlet name || form title || 'Form submission'
 *   subtitle = the form title when the title came from the customer / outlet (and a form title
 *              exists), else null (the form title is already the title, or there is nothing to say).
 * `formName` is the form's REAL title (null when the form has none), not the feed's 'General Form'
 * display fallback.
 */
export function buildFeedTitle(input: {
  customerName: string | null | undefined;
  outletName: string | null | undefined;
  formName: string | null | undefined;
}): FeedTitle {
  const customer = cleanText(input.customerName);
  const outlet = isRealOutletName(input.outletName) ? cleanText(input.outletName) : null;
  const form = cleanText(input.formName);
  if (customer) return { title: customer, subtitle: form };
  if (outlet) return { title: outlet, subtitle: form };
  return { title: form ?? FEED_TITLE_FALLBACK, subtitle: null };
}

/**
 * Group the extra query's rows (`submission_id`, `value_text`, `builder_questions: { label }`) by
 * submission and pick each one's customer name. `builder_questions` may come back as an object or a
 * one-element array depending on how PostgREST resolved the relationship; both are handled. Returns a
 * map holding an entry (possibly null) for every submission id that had at least one row.
 */
export function customerNamesBySubmission(rows: ReadonlyArray<any> | null | undefined): Map<string, string | null> {
  const grouped = new Map<string, FeedAnswer[]>();
  for (const r of rows || []) {
    const sid = r && typeof r.submission_id === 'string' ? r.submission_id : null;
    if (!sid) continue;
    const q = Array.isArray(r.builder_questions) ? r.builder_questions[0] : r.builder_questions;
    const list = grouped.get(sid) ?? [];
    list.push({ label: q?.label, value_text: r.value_text });
    grouped.set(sid, list);
  }
  const out = new Map<string, string | null>();
  for (const [sid, answers] of grouped) out.set(sid, pickCustomerName(answers));
  return out;
}
