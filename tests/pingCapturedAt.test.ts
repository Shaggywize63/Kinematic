/**
 * resolvePingCapturedAt — the pure rule behind the offline PING QUEUE's server side. A client flushing
 * fixes it captured in a no-signal zone replays each with its original `captured_at`; `updateUserStatus`
 * uses this to decide: stamp now and update the live position (live), stamp at the original time as trail
 * history only (backfill), or ACK-and-drop a fix too stale to store (drop).
 */
import { resolvePingCapturedAt, PING_BACKFILL_THRESHOLD_MS } from '../src/lib/pingCapturedAt';
import { CAPTURED_AT_MAX_AGE_MS, CAPTURED_AT_MAX_FUTURE_MS } from '../src/services/attendanceRules.service';

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('resolvePingCapturedAt', () => {
  describe('live (stamp server now, update live position)', () => {
    it('treats an absent captured_at as a live ping at now', () => {
      const r = resolvePingCapturedAt(undefined, NOW);
      expect(r.kind).toBe('live');
      if (r.kind === 'live') expect(r.ms).toBe(NOW);
    });

    it('falls back to live for a non-string', () => {
      expect(resolvePingCapturedAt(12345, NOW).kind).toBe('live');
      expect(resolvePingCapturedAt({}, NOW).kind).toBe('live');
    });

    it('falls back to live for an empty or malformed timestamp (never parks a row)', () => {
      expect(resolvePingCapturedAt('', NOW).kind).toBe('live');
      expect(resolvePingCapturedAt('not-a-date', NOW).kind).toBe('live');
      expect(resolvePingCapturedAt('2026-11-25', NOW).kind).toBe('live'); // date only, no zone
      expect(resolvePingCapturedAt('2026-11-25T12:00:00', NOW).kind).toBe('live'); // no zone designator
    });

    it('treats a near-now valid timestamp (within the backfill threshold) as live', () => {
      const r = resolvePingCapturedAt(iso(NOW - (PING_BACKFILL_THRESHOLD_MS - 1_000)), NOW);
      expect(r.kind).toBe('live');
      // live always stamps server now, never the client's near-now value
      if (r.kind === 'live') expect(r.ms).toBe(NOW);
    });

    it('treats a future timestamp beyond clock-skew as live (does not trust it)', () => {
      const r = resolvePingCapturedAt(iso(NOW + CAPTURED_AT_MAX_FUTURE_MS + 60_000), NOW);
      expect(r.kind).toBe('live');
      if (r.kind === 'live') expect(r.ms).toBe(NOW);
    });

    it('accepts a slightly-future timestamp inside the skew window as live', () => {
      expect(resolvePingCapturedAt(iso(NOW + 30_000), NOW).kind).toBe('live');
    });
  });

  describe('backfill (stamp the original time, history only)', () => {
    it('honours a fix older than the threshold but within the 36h window', () => {
      const captured = NOW - 30 * 60_000; // 30 min ago
      const r = resolvePingCapturedAt(iso(captured), NOW);
      expect(r.kind).toBe('backfill');
      if (r.kind === 'backfill') {
        expect(r.ms).toBe(captured);
        expect(r.iso).toBe(iso(captured));
      }
    });

    it('honours a fix just inside the 36h window', () => {
      const captured = NOW - (CAPTURED_AT_MAX_AGE_MS - 60_000);
      expect(resolvePingCapturedAt(iso(captured), NOW).kind).toBe('backfill');
    });

    it('accepts a +05:30 offset timestamp, not only Z', () => {
      // 2026-11-25T16:30:00+05:30 == 11:00:00Z, i.e. 1h before NOW → backfill.
      const r = resolvePingCapturedAt('2026-11-25T16:30:00+05:30', NOW);
      expect(r.kind).toBe('backfill');
      if (r.kind === 'backfill') expect(r.ms).toBe(Date.parse('2026-11-25T11:00:00Z'));
    });
  });

  describe('drop (too stale to store)', () => {
    it('drops a fix older than the 36h window', () => {
      const captured = NOW - (CAPTURED_AT_MAX_AGE_MS + 60_000);
      expect(resolvePingCapturedAt(iso(captured), NOW).kind).toBe('drop');
    });
  });
});
