/**
 * Notification routing contract — what lets a tap open the exact screen.
 *
 * Notification rows grew four different "what is this?" conventions:
 *   - `data.kind`        lead / deal / expense / activity / scan alerts
 *   - `data.type`        leave, attendance regularization, route deviation,
 *                        call-analysis ("leave_request", "att_reg_decision", …)
 *   - `data.nudge_kind`  the KINI nudges ("reminder", "cold_deals", "no_checkin")
 *   - nothing at all     SOS, security alert, mention, chat message, broadcast
 *                        (only the row's `type` column says what they are)
 * and the dispatcher never sent the row `type`, so a phone could not tell a
 * leave request from an SOS without guessing from which id keys happened to be
 * present.
 *
 * `notificationKind` collapses all four into ONE `kind` string, and
 * `routedData` returns a row's `data` with that `kind` always present. It is
 * applied where rows leave the server (the push payload and the inbox list), so
 * existing rows and every existing writer keep working and older app builds see
 * only an extra key. The apps map `kind` + the entity ids to a screen; the table
 * lives in docs/NOTIFICATIONS.md.
 */

type Json = Record<string, unknown>;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The single discriminator for a notification, whatever convention wrote it. */
export function notificationKind(type: string | null | undefined, data: unknown): string {
  const d: Json = data && typeof data === 'object' && !Array.isArray(data) ? (data as Json) : {};
  const kind = text(d.kind);
  if (kind) return kind;
  const t = text(d.type);
  if (t) return t;
  const nudge = text(d.nudge_kind);
  if (nudge) return `kini_${nudge}`;
  return text(type) ?? 'general';
}

/** A row's `data` with `kind` guaranteed; the stored row is left untouched. */
export function routedData(row: { type?: string | null; data?: unknown }): Json {
  const d: Json = row.data && typeof row.data === 'object' && !Array.isArray(row.data)
    ? { ...(row.data as Json) }
    : {};
  d.kind = notificationKind(row.type, d);
  return d;
}
