/**
 * Tracking-paused manager alert. A rep CHECKED IN today whose phone has stopped sending fixes (battery
 * saver / app closed / no signal — not location switched off) should raise a `tracking_paused` notification
 * to that client's own admins/managers, de-duped so it re-alerts at most once per window while they stay
 * paused. Driven entirely through the supabase mock — no database.
 */
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { runTrackingPausedScan, fmtSilence } from '../src/services/alertScans.service';
import { clearClientFlagCache } from '../src/lib/clientFlags';
import { dbToday } from '../src/utils';

const supa = () => (global as any).__supa;
const NOW = Date.parse('2026-10-08T10:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const rep = (id: string, o: Record<string, unknown> = {}) => ({
  id, name: `Rep ${id}`, org_id: 'org-1', client_id: 'client-rk', supervisor_id: null,
  last_location_updated_at: minsAgo(90), location_status: 'on', ...o,
});
const mgr = (id: string, role = 'admin') => ({ id, role, client_id: 'client-rk' });

function seed(opts: {
  reps: Array<Record<string, any>>;
  managers?: Array<Record<string, any>>;
  cadence?: number;
  alreadyAlerted?: string[];
}) {
  supa().setDefault('attendance', { data: opts.reps.map((r) => ({ user_id: r.id })) });
  // `users` is read twice: the rep lookup uses `.in('id', …)`; resolveManagers uses `.eq('org_id', …)`.
  supa().setDefault('users', (chain: any) => ({
    data: chain.ops.some((o: any) => o.method === 'in') ? opts.reps : (opts.managers ?? [mgr('admin-1')]),
  }));
  supa().setDefault('org_settings', { data: opts.cadence ? [{ org_id: 'org-1', value: opts.cadence }] : [] });
  supa().setDefault('clients', { data: { settings: {} } });
  supa().setDefault('notifications', { data: (opts.alreadyAlerted ?? []).map((id) => ({ data: { kind: 'tracking_paused', rep_id: id } })) });
}

/** Every notification row inserted during the run. */
function inserted(): any[] {
  return supa().chainsFor('notifications')
    .flatMap((c: any) => c.ops.filter((o: any) => o.method === 'insert'))
    .flatMap((o: any) => (Array.isArray(o.args[0]) ? o.args[0] : [o.args[0]]));
}

beforeEach(() => { supa().reset(); clearClientFlagCache(); });

describe('fmtSilence (adaptive units)', () => {
  it('minutes under an hour, hours up to a day, then days', () => {
    expect(fmtSilence(45)).toBe('45 min');
    expect(fmtSilence(60)).toBe('1 h');
    expect(fmtSilence(68)).toBe('1 h 8 min');
    expect(fmtSilence(60 * 24 - 1)).toBe('23 h 59 min');
    expect(fmtSilence(60 * 24)).toBe('1 d');
    expect(fmtSilence(60 * 24 * 2 + 60 * 3)).toBe('2 d 3 h');
  });
});

describe('runTrackingPausedScan', () => {
  it('alerts the client\'s managers when a checked-in rep goes silent past the floor', async () => {
    seed({ reps: [rep('murthy')], managers: [mgr('admin-1')] });
    const r = await runTrackingPausedScan({ now: NOW });
    expect(r).toMatchObject({ checked: 1, paused: 1, alerted: 1 });
    const rows = inserted();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 'admin-1', data: { kind: 'tracking_paused', rep_id: 'murthy' } });
    expect(rows[0].body).toContain('1 h 30 min');          // adaptive duration in the message
  });

  it('only looks at reps checked in today and not checked out', async () => {
    seed({ reps: [rep('a')] });
    await runTrackingPausedScan({ now: NOW });
    const att = supa().chainsFor('attendance')[0];
    expect(att.eqs.date).toBe(dbToday());
    expect(att.ops.some((o: any) => o.method === 'not' && o.args[0] === 'checkin_at')).toBe(true);
    expect(att.ops.some((o: any) => o.method === 'is' && o.args[0] === 'checkout_at' && o.args[1] === null)).toBe(true);
  });

  it('leaves a rep whose location is fresh alone', async () => {
    seed({ reps: [rep('fresh', { last_location_updated_at: minsAgo(10) })] });
    const r = await runTrackingPausedScan({ now: NOW });
    expect(r).toMatchObject({ paused: 0, alerted: 0 });
    expect(inserted()).toHaveLength(0);
  });

  it('does NOT alert when location is explicitly OFF (that is the location_off alert\'s job)', async () => {
    for (const status of ['denied', 'services_off', 'restricted']) {
      supa().reset(); clearClientFlagCache();
      seed({ reps: [rep('off', { location_status: status })] });
      const r = await runTrackingPausedScan({ now: NOW });
      expect({ status, paused: r.paused, alerted: r.alerted }).toEqual({ status, paused: 0, alerted: 0 });
    }
  });

  it('skips a rep who never sent a fix today (not a "stopped reporting" case)', async () => {
    seed({ reps: [rep('new', { last_location_updated_at: null })] });
    expect((await runTrackingPausedScan({ now: NOW })).alerted).toBe(0);
  });

  it('re-alert dedup: a rep already alerted within the window is counted paused but not re-notified', async () => {
    seed({ reps: [rep('murthy')], alreadyAlerted: ['murthy'] });
    const r = await runTrackingPausedScan({ now: NOW });
    expect(r).toMatchObject({ paused: 1, alerted: 0 });
    expect(inserted()).toHaveLength(0);
  });

  it('respects a long configured cadence: 2x cadence, not a flat floor', async () => {
    // Hourly pings: 90 min silence is still within 2x cadence AND under the 45-min floor is irrelevant here.
    seed({ reps: [rep('slow', { last_location_updated_at: minsAgo(90) })], cadence: 3600 });
    expect((await runTrackingPausedScan({ now: NOW })).alerted).toBe(0);  // threshold = max(45m, 120m) = 120m
    supa().reset(); clearClientFlagCache();
    seed({ reps: [rep('slow', { last_location_updated_at: minsAgo(130) })], cadence: 3600 });
    expect((await runTrackingPausedScan({ now: NOW })).alerted).toBe(1);  // > 2 h
  });

  it('never notifies the rep about themselves', async () => {
    seed({ reps: [rep('murthy')], managers: [mgr('murthy'), mgr('admin-1')] });
    await runTrackingPausedScan({ now: NOW });
    const rows = inserted();
    expect(rows.map((r) => r.user_id)).toEqual(['admin-1']);   // the rep is excluded even if they'd resolve as a manager
  });
});
