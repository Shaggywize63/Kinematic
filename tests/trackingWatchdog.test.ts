/**
 * Tracking watchdog: wakes a checked-in rep's phone with a silent data-only push when its location has
 * gone stale, so tracking restarts without anyone changing a phone setting. It must be conservative: only
 * stale reps, only tenants that track, never spam, never a visible notification.
 */
const send = jest.fn();

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/lib/firebase', () => ({ messaging: { send: (...a: unknown[]) => send(...a) }, default: {} }));

import { runTrackingWatchdog, resetTrackingWatchdog, staleAfterMs, REWAKE_MS, WAKEUP_KIND } from '../src/services/trackingWatchdog.service';
import { clearClientFlagCache } from '../src/lib/clientFlags';
import { dbToday } from '../src/utils';

const supa = () => (global as any).__supa;
const NOW = Date.parse('2026-10-08T10:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const rep = (id: string, o: Record<string, unknown> = {}) => ({
  id, org_id: 'org-1', client_id: 'client-rk', fcm_token: `token-${id}-xxxxxxxxxxxx`, last_location_updated_at: minsAgo(185), ...o,
});
function seed(reps: Array<Record<string, any>>, opts: { cadence?: number; clientSettings?: Record<string, unknown> } = {}) {
  supa().setDefault('attendance', { data: reps.map((r) => ({ user_id: r.id })) });
  supa().setDefault('users', { data: reps });
  supa().setDefault('org_settings', { data: opts.cadence ? [{ org_id: 'org-1', value: opts.cadence }] : [] });
  supa().setDefault('clients', { data: { settings: opts.clientSettings ?? {} } });
}

beforeEach(() => {
  supa().reset(); send.mockReset(); send.mockResolvedValue('projects/p/messages/1');
  resetTrackingWatchdog(); clearClientFlagCache();
});

describe('tracking watchdog', () => {
  it('wakes a checked-in rep whose phone has been silent, with a silent data-only high-priority push', async () => {
    seed([rep('murthy')]); // silent for 185 min
    const r = await runTrackingWatchdog({ now: NOW });
    expect(r).toMatchObject({ checked: 1, stale: 1, sent: 1, failed: 0, credential_error: false });
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.token).toBe('token-murthy-xxxxxxxxxxxx');
    expect(msg.data).toEqual({ kind: WAKEUP_KIND });
    expect(msg.notification).toBeUndefined();               // nothing is shown to the user
    expect(msg.android).toMatchObject({ priority: 'high', collapseKey: WAKEUP_KIND });
    expect(msg.android.ttl).toBeLessThanOrEqual(15 * 60_000); // a late wake-up is pointless
  });

  it('only looks at reps checked in today and not checked out (IST date)', async () => {
    seed([rep('a')]);
    await runTrackingWatchdog({ now: NOW });
    const att = supa().chainsFor('attendance')[0];
    expect(att.eqs.date).toBe(dbToday());
    const has = (method: string, ...args: unknown[]) =>
      att.ops.some((o: any) => o.method === method && args.every((a, i) => o.args[i] === a));
    expect(has('not', 'checkin_at', 'is', null)).toBe(true);  // checked in
    expect(has('is', 'checkout_at', null)).toBe(true);        // not checked out
  });

  it('leaves a rep whose location is fresh alone', async () => {
    seed([rep('harisha', { last_location_updated_at: minsAgo(8) })]);
    const r = await runTrackingWatchdog({ now: NOW });
    expect(r).toMatchObject({ checked: 1, stale: 0, sent: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('wakes a rep who has never sent a fix', async () => {
    seed([rep('new', { last_location_updated_at: null })]);
    expect((await runTrackingWatchdog({ now: NOW })).sent).toBe(1);
  });

  it('respects a long configured cadence: stale is 2x the cadence, not a flat 30 min', async () => {
    seed([rep('slow', { last_location_updated_at: minsAgo(40) })], { cadence: 3600 }); // hourly pings: 40 min is normal
    expect((await runTrackingWatchdog({ now: NOW })).sent).toBe(0);
    resetTrackingWatchdog();
    seed([rep('slow', { last_location_updated_at: minsAgo(130) })], { cadence: 3600 }); // > 2 h: genuinely stale
    expect((await runTrackingWatchdog({ now: NOW })).sent).toBe(1);
  });

  it('never wakes the same rep twice inside the re-wake window, then wakes again after it', async () => {
    seed([rep('murthy')]);
    await runTrackingWatchdog({ now: NOW });
    await runTrackingWatchdog({ now: NOW + 5 * 60_000 });
    await runTrackingWatchdog({ now: NOW + REWAKE_MS - 1_000 });
    expect(send).toHaveBeenCalledTimes(1);
    await runTrackingWatchdog({ now: NOW + REWAKE_MS + 1_000 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('skips tenants that opted out of live tracking (data flag and the hardcoded Tata id)', async () => {
    seed([rep('p1', { client_id: 'client-pasa' })], { clientSettings: { disable_live_tracking: true } });
    expect((await runTrackingWatchdog({ now: NOW })).sent).toBe(0);
    seed([rep('t1', { client_id: 'a1f67468-526e-4734-be3a-2cb132cc2804' })]);
    expect((await runTrackingWatchdog({ now: NOW })).sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when nobody is checked in', async () => {
    supa().setDefault('attendance', { data: [] });
    const r = await runTrackingWatchdog({ now: NOW });
    expect(r).toMatchObject({ checked: 0, sent: 0 });
    expect(supa().chainsFor('users')).toHaveLength(0);
  });

  it('stops the whole run when Google rejects our credential (every send would fail)', async () => {
    seed([rep('a'), rep('b')]);
    send.mockRejectedValue(Object.assign(new Error('x'), { errorInfo: { code: 'app/invalid-credential' } }));
    const r = await runTrackingWatchdog({ now: NOW });
    expect(r).toMatchObject({ credential_error: true, failed: 1, sent: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('clears the token of a phone that has uninstalled the app', async () => {
    seed([rep('gone')]);
    send.mockRejectedValue(Object.assign(new Error('x'), { errorInfo: { code: 'messaging/registration-token-not-registered' } }));
    await runTrackingWatchdog({ now: NOW });
    const clears = supa().chainsFor('users').flatMap((c: any) => c.ops.filter((o: any) => o.method === 'update' && o.args[0]?.fcm_token === null));
    expect(clears).toHaveLength(1);
  });

  it('stale threshold is max(30 min, 2x cadence)', () => {
    expect(staleAfterMs(600)).toBe(30 * 60_000);
    expect(staleAfterMs(900)).toBe(30 * 60_000);
    expect(staleAfterMs(3600)).toBe(2 * 3600_000);
  });
});
