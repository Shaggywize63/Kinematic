jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/crm/whatsapp.service', () => ({
  sendWhatsapp: jest.fn(async () => ({ id: 'log-1', provider_message_id: 'wamid.1', status: 'sent', error: null })),
}));

import {
  computeSummary, formatSummary, inr, isEmptyDay, runDailySummaries, buildDailySummary, type SummaryInput,
} from '../src/services/clientDailySummary.service';
import { testClientWhatsappAlerts } from '../src/controllers/client.controller';
import { _resetAlertState, WA_SETTING_KEY } from '../src/services/clientWhatsappAlerts.service';
import { sendWhatsapp } from '../src/services/crm/whatsapp.service';
import type { Stop } from '../src/controllers/analytics/ffm-plus.compute';

const supa = () => (global as any).__supa;
const sendMock = sendWhatsapp as jest.Mock;
const DAY = '2026-11-18';
const TPL = '22222222-2222-4222-8222-222222222222';
const CLIENT = '11111111-1111-4111-8111-111111111111';

const reps = [
  { id: 'r1', name: 'Ravi', supervisor_id: null },
  { id: 'r2', name: 'Asha', supervisor_id: null },
  { id: 'r3', name: 'Mohan', supervisor_id: null },
  { id: 'r4', name: 'Imran', supervisor_id: null },
  { id: 'r5', name: 'Suresh', supervisor_id: null },
];
const stop = (user_id: string, store_id: string, visited: boolean, extra: Partial<Stop> = {}): Stop => ({
  plan_id: `p-${user_id}`, user_id, plan_date: DAY, territory_label: null, store_id, status: visited ? 'visited' : 'pending',
  planned_duration_min: null, checkin_at: null, checkout_at: null, checkin_distance_m: null, geofence_radius_m: null, ...extra,
});
const input = (over: Partial<SummaryInput> = {}): SummaryInput => ({
  date: DAY,
  reps,
  attendance: [
    { user_id: 'r1', status: 'checked_out', checkin_at: `${DAY}T03:30:00Z` },
    { user_id: 'r2', status: 'checked_in', checkin_at: `${DAY}T03:40:00Z` },
    { user_id: 'r3', status: 'checked_in', checkin_at: `${DAY}T04:00:00Z`, checkin_is_mock: true },
    { user_id: 'r4', status: 'on_leave', checkin_at: null },
  ],
  stops: [
    stop('r1', 's1', true), stop('r1', 's2', true), stop('r1', 's3', false),
    // The mobile mirror sets checkin_at but leaves status pending: still a visit. 400 m away = off-route.
    stop('r2', 's4', false, { checkin_at: `${DAY}T05:00:00Z`, checkin_distance_m: 400 }),
    stop('r3', 's5', false), stop('r3', 's6', false),
  ],
  orders: { count: 7, value: 324500 },
  newLeads: 3,
  teleports: new Map([['r2', 2]]),
  mockAlerts: new Map(),
  ...over,
});

beforeEach(() => {
  supa().reset();
  _resetAlertState();
  sendMock.mockClear();
  process.env.CLIENT_WHATSAPP_ALERTS = 'on';
  process.env.NOTIFICATION_POLICY = 'on';
  process.env.NOTIFICATIONS_DISABLED_PROJECTS = '';
});

describe('computeSummary', () => {
  it('counts attendance, visits, top reps, reps with no visits and suspicious check-ins', () => {
    const s = computeSummary(input());
    expect(s.attendance).toEqual({ present: 3, on_leave: 1, absent: 1 });
    expect(s.visits).toEqual({ planned: 6, done: 3, pct: 50, off_route: 1 });
    expect(s.top).toEqual([{ name: 'Ravi', visits: 2 }, { name: 'Asha', visits: 1 }]);
    expect(s.no_visits).toEqual(['Mohan']);
    expect(s.suspicious).toEqual(['Asha', 'Mohan']); // teleport pings, mock GPS at check-in
    expect(s.orders).toEqual({ count: 7, value: 324500 });
    expect(s.new_leads).toBe(3);
  });

  it('flags a failed face match, and ignores rows for people who are not active reps', () => {
    const s = computeSummary(input({
      attendance: [
        { user_id: 'r1', status: 'checked_in', checkin_at: `${DAY}T03:30:00Z`, checkin_face_verified: false },
        { user_id: 'ghost', status: 'checked_in', checkin_at: `${DAY}T03:30:00Z`, checkin_is_mock: true },
      ],
      teleports: null,
    }));
    expect(s.attendance).toEqual({ present: 1, on_leave: 0, absent: 4 });
    expect(s.suspicious).toEqual(['Ravi']);
  });

  it('leaves out a section whose data could not be read', () => {
    const s = computeSummary(input({ stops: null, orders: null, newLeads: null }));
    expect(s.visits).toBeNull();
    const { body } = formatSummary(s);
    expect(body).not.toMatch(/Visits|Orders|New leads/);
    expect(body).toMatch(/^Attendance 3\/5 present, 1 on leave, 1 absent/);
  });
});

describe('formatSummary', () => {
  it('writes one line, most important first, with Indian money units', () => {
    const { title, body } = formatSummary(computeSummary(input()));
    expect(title).toBe('Daily summary, Wed 18 Nov');
    expect(body).toBe(
      'Attendance 3/5 present, 1 on leave, 1 absent · Visits 3/6 done (50%) · Orders 7 worth ₹3.2L · New leads 3 · ' +
      'Top: Ravi 2, Asha 1 · No visits yet: Mohan · Check: suspicious check-ins by Asha, Mohan, 1 off-route visit',
    );
    expect(body).not.toMatch(/\n/);
  });

  it('formats money and long name lists', () => {
    expect(inr(45200)).toBe('₹45,200');
    expect(inr(324500)).toBe('₹3.2L');
    expect(inr(14000000)).toBe('₹1.4Cr');
    const many = computeSummary(input({ teleports: new Map(reps.map((r) => [r.id, 1])) }));
    expect(formatSummary(many).body).toContain('suspicious check-ins by Asha, Imran, Mohan +2 more');
  });

  it('treats a day with no team, orders or leads as empty', () => {
    expect(isEmptyDay(computeSummary(input({ reps: [], attendance: [], stops: [], orders: { count: 0, value: 0 }, newLeads: 0 })))).toBe(true);
    expect(isEmptyDay(computeSummary(input()))).toBe(false);
  });
});

const settings = { enabled: true, template_id: TPL, recipients: [{ name: 'Asha', phone: '919811112222' }], kinds: [], daily_summary: true };
const seedDay = () => {
  supa().setDefault('users', { data: reps.map((r) => ({ id: r.id, name: r.name, supervisor_id: null })) });
  supa().setDefault('attendance', { data: input().attendance });
  supa().setDefault('route_plans', { data: [] });
  supa().setDefault('orders', { data: [{ grand_total: '1200.50' }, { grand_total: 800 }] });
  supa().setDefault('crm_leads', { data: null, count: 4 });
  supa().setDefault('work_activity', { data: [] });
  supa().setDefault('security_alerts', { data: [] });
  supa().setDefault('crm_whatsapp_templates', { data: [{ id: TPL, meta_template_name: 'kinematic_alert', status: 'APPROVED', body_text: '{{1}} {{2}}' }] });
};

describe('buildDailySummary', () => {
  it('reads today\'s figures for the org, with IST day bounds', async () => {
    seedDay();
    const s = await buildDailySummary('org-client', DAY);
    expect(s.orders).toEqual({ count: 2, value: 2000.5 });
    expect(s.new_leads).toBe(4);
    expect(s.attendance).toEqual({ present: 3, on_leave: 1, absent: 1 });
    const orders = supa().chainsFor('orders')[0];
    expect(orders.eqs).toMatchObject({ org_id: 'org-client' });
    expect(orders.ops.find((o: any) => o.method === 'gte').args).toEqual(['placed_at', `${DAY}T00:00:00+05:30`]);
    expect(supa().chainsFor('attendance')[0].eqs).toMatchObject({ org_id: 'org-client', date: DAY });
  });
});

describe('runDailySummaries', () => {
  it('claims the day, then sends one summary per opted-in client', async () => {
    seedDay();
    supa().setDefault('org_settings', { data: [
      { org_id: 'org-on', value: settings },
      { org_id: 'org-alerts-only', value: { ...settings, daily_summary: false, kinds: ['sos'] } },
      { org_id: 'org-off', value: { ...settings, enabled: false } },
    ] });
    supa().setDefault('client_daily_summary_log', { data: null, error: null });
    const r = await runDailySummaries(DAY);
    expect(r).toMatchObject({ clients: 1, sent: 1, skipped_already_sent: 0 });
    const claim = supa().chainsFor('client_daily_summary_log')[0];
    expect(claim.ops.find((o: any) => o.method === 'insert').args[0]).toEqual({ org_id: 'org-on', summary_date: DAY });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ org_id: 'org-on', to: '919811112222', template_id: TPL });
    expect(sendMock.mock.calls[0][0].template_variables['1']).toBe('Daily summary, Wed 18 Nov');
    expect(sendMock.mock.calls[0][0].template_variables['2']).toMatch(/^Attendance 3\/5 present/);
  });

  it('sends nothing when another run already claimed the day (or the log table is missing)', async () => {
    seedDay();
    supa().setDefault('org_settings', { data: [{ org_id: 'org-on', value: settings }] });
    supa().setDefault('client_daily_summary_log', { data: null, error: { code: '23505', message: 'duplicate key' } });
    expect(await runDailySummaries(DAY)).toMatchObject({ clients: 1, sent: 0, skipped_already_sent: 1 });
    supa().setDefault('client_daily_summary_log', { data: null, error: { code: '42P01', message: 'relation does not exist' } });
    expect(await runDailySummaries(DAY)).toMatchObject({ sent: 0, skipped_already_sent: 1 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing in a project with notifications switched off (Tata by default)', async () => {
    process.env.NOTIFICATIONS_DISABLED_PROJECTS = 'default';
    expect(await runDailySummaries(DAY)).toMatchObject({ clients: 0, sent: 0 });
    expect(supa().chainsFor('org_settings')).toHaveLength(0);
  });
});

describe('POST /clients/:id/whatsapp-alerts/test { type: daily_summary }', () => {
  const operator = { id: 'u-admin', org_id: 'org-parent', role: 'admin', email: 'ops@kinematicapp.com' };
  it('sends today\'s summary so far to the saved people', async () => {
    seedDay();
    supa().setDefault('clients', { data: { id: CLIENT, org_id: 'org-client' } });
    supa().setDefault('org_settings', { data: { value: settings } });
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      let status = 200;
      const r: any = { status: (s: number) => { status = s; return r; }, json: (b: unknown) => { resolve({ status, body: b }); return r; } };
      testClientWhatsappAlerts({ params: { id: CLIENT }, body: { type: 'daily_summary' }, query: {}, user: operator } as any, r, reject);
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ sent: 1, failed: 0 });
    expect(sendMock.mock.calls[0][0].template_variables['1']).toMatch(/^Daily summary, /);
    expect(supa().chainsFor('client_daily_summary_log')).toHaveLength(0); // a manual send never uses up the day
  });
});

it('stores the daily summary switch with the alert settings', async () => {
  const { parseSettingsInput } = await import('../src/services/clientWhatsappAlerts.service');
  // A summary on its own is enough to switch alerts on.
  expect(parseSettingsInput({ enabled: true, template_id: TPL, recipients: [{ phone: '9811112222' }], daily_summary: true }).daily_summary).toBe(true);
  expect(() => parseSettingsInput({ enabled: true, template_id: TPL, recipients: [{ phone: '9811112222' }] })).toThrow(/daily summary/);
  expect(WA_SETTING_KEY).toBe('notifications.whatsapp');
});
