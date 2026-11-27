import { CAPTURED_AT_MAX_AGE_MS, CAPTURED_AT_MAX_FUTURE_MS } from '../services/attendanceRules.service';

/**
 * Resolve the capture time of a live-tracking heartbeat (`POST/PATCH /users/status`).
 *
 * A client flushing its OFFLINE PING QUEUE (a rep who went through a no-signal zone) replays each
 * dropped fix with its original `captured_at`; a normal live heartbeat omits it. This decides what the
 * server does with that field, with three outcomes — because a location ping is not an attendance punch:
 *
 *  - `live`     — no / malformed / future / near-now `captured_at`: stamp the row at server now and let
 *                 the heartbeat update the user's live position + "last seen" as it always has.
 *  - `backfill` — a valid `captured_at` meaningfully older than now (a flushed offline fix): stamp the
 *                 row at that original time so it slots into the trail at the right place, but the caller
 *                 must treat it as HISTORY ONLY — it must not move the user's live position or last-seen
 *                 (that would make the live map jump backwards to a stale point).
 *  - `drop`     — a valid `captured_at` older than the honoured window (36h, shared with attendance): the
 *                 fix is too stale to be worth a trail row, and stamping it at `now` would corrupt the
 *                 live position, so it is neither stored nor honoured. The caller still ACKs so the client
 *                 dequeues it.
 *
 * Unlike attendance's `decideCapturedAt`, there is no idempotency-key or offline-allowed gate: a location
 * ping carries no body hash and offline capture is always safe to backfill. A malformed value can never
 * park a row in the past or future — it falls back to `live` (server now).
 */
export const PING_BACKFILL_THRESHOLD_MS = 2 * 60_000;

const ISO_WITH_ZONE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export type PingTime =
  | { kind: 'live'; iso: string; ms: number }
  | { kind: 'backfill'; iso: string; ms: number }
  | { kind: 'drop' };

export function resolvePingCapturedAt(raw: unknown, nowMs: number): PingTime {
  const live = (): PingTime => ({ kind: 'live', iso: new Date(nowMs).toISOString(), ms: nowMs });

  if (typeof raw !== 'string') return live();
  const s = raw.trim();
  if (s === '' || !ISO_WITH_ZONE_RE.test(s)) return live();

  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return live();

  // Beyond clock-skew into the future → don't trust it; treat as a live ping stamped now.
  if (ms - nowMs > CAPTURED_AT_MAX_FUTURE_MS) return live();

  const age = nowMs - ms;
  if (age > CAPTURED_AT_MAX_AGE_MS) return { kind: 'drop' };
  if (age > PING_BACKFILL_THRESHOLD_MS) return { kind: 'backfill', iso: new Date(ms).toISOString(), ms };
  return live();
}
