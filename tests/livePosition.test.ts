import { resolveLivePosition } from '../src/lib/livePosition';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const HOURS = 3_600_000;

describe('resolveLivePosition', () => {
  it('uses the latest heartbeat fix (source=live) when it is under 24h old', () => {
    const p = resolveLivePosition(
      { last_latitude: 12.97, last_longitude: 77.59, last_location_updated_at: minsAgo(3) },
      { checkin_lat: 1, checkin_lng: 2, checkin_at: minsAgo(300) },
      { meeting_lat: 9, meeting_lng: 9 },
      NOW,
    );
    expect(p).toEqual({ lat: 12.97, lng: 77.59, source: 'live', captured_at: minsAgo(3) });
  });

  it('falls back to the check-in point (source=checkin) when the heartbeat is older than 24h', () => {
    const p = resolveLivePosition(
      { last_latitude: 12.97, last_longitude: 77.59, last_location_updated_at: new Date(NOW - 25 * HOURS).toISOString() },
      { checkin_lat: 28.6, checkin_lng: 77.2, checkin_at: minsAgo(120) },
      { meeting_lat: 9, meeting_lng: 9 },
      NOW,
    );
    expect(p).toEqual({ lat: 28.6, lng: 77.2, source: 'checkin', captured_at: minsAgo(120) });
  });

  it('falls back to the zone meeting point (source=zone, no capture time) when there is no fix or check-in', () => {
    const p = resolveLivePosition({}, null, { meeting_lat: 19.07, meeting_lng: 72.87 }, NOW);
    expect(p).toEqual({ lat: 19.07, lng: 72.87, source: 'zone', captured_at: null });
  });

  it('reports no position at all as nulls', () => {
    expect(resolveLivePosition({}, null, null, NOW)).toEqual({ lat: null, lng: null, source: null, captured_at: null });
  });

  it('ignores a heartbeat with coordinates but no timestamp', () => {
    const p = resolveLivePosition({ last_latitude: 12.97, last_longitude: 77.59 }, { checkin_lat: 28.6, checkin_lng: 77.2 }, null, NOW);
    expect(p.source).toBe('checkin');
  });

  it('treats a zero coordinate as a real value, not as missing', () => {
    const p = resolveLivePosition({ last_latitude: 0, last_longitude: 0, last_location_updated_at: minsAgo(1) }, null, null, NOW);
    expect(p).toMatchObject({ lat: 0, lng: 0, source: 'live' });
  });
});
