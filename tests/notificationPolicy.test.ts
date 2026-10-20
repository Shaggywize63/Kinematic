const send = jest.fn(async () => 'fcm-message-id');
const sendApns = jest.fn(async () => ({ ok: true, unregistered: false, status: 200 }));

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/lib/firebase', () => ({ messaging: { send: (...a: unknown[]) => (send as any)(...a) }, default: {} }));
jest.mock('../src/lib/apns', () => ({ apnsEnabled: true, sendApns: (...a: unknown[]) => (sendApns as any)(...a) }));

import {
  allowedFlags, isNotificationEnabled, policyActive, isProjectDisabled, readOrgSettings, writeOrgSettings,
  toEnabled, _resetPolicyCache,
} from '../src/services/notificationPolicy';
import { dispatchPendingPushes } from '../src/services/notifications.service';
import { notify, notifyUsers } from '../src/services/notify';
import { getNotifications } from '../src/controllers/misc.controller';

const supa = () => (global as any).__supa;
const env = { ...process.env };

/** org_settings rows by org: { o1: ['sos'], o2: ['*'] }. Answers the batched `.in('org_id', …)` read. */
const settings = (byOrg: Record<string, unknown>) =>
  supa().setDefault('org_settings', (chain: any) => {
    const wanted: string[] = chain.ops.find((o: any) => o.method === 'in')?.args[1] ?? [];
    return { data: wanted.filter((o) => o in byOrg).map((o) => ({ org_id: o, value: byOrg[o] })) };
  });

beforeEach(() => {
  supa().reset();
  _resetPolicyCache();
  send.mockClear(); sendApns.mockClear();
  process.env.NOTIFICATION_POLICY = 'on';
  process.env.NOTIFICATIONS_DISABLED_PROJECTS = ''; // lift the Tata switch unless a test sets it
});
afterAll(() => { process.env = env; });

describe('policy switches', () => {
  it('is off under test unless asked, and NOTIFICATION_POLICY=off is the rollback', () => {
    delete process.env.NOTIFICATION_POLICY;
    expect(policyActive()).toBe(false);
    process.env.NOTIFICATION_POLICY = 'on';
    expect(policyActive()).toBe(true);
    process.env.NOTIFICATION_POLICY = 'off';
    expect(policyActive()).toBe(false);
  });

  it('the Tata (default) project is switched off by default and the switch can be lifted or extended', () => {
    delete process.env.NOTIFICATIONS_DISABLED_PROJECTS;
    expect(isProjectDisabled('default')).toBe(true);
    expect(isProjectDisabled('kinematic')).toBe(false);
    process.env.NOTIFICATIONS_DISABLED_PROJECTS = 'kinematic, default';
    expect(isProjectDisabled('kinematic')).toBe(true);
    process.env.NOTIFICATIONS_DISABLED_PROJECTS = '';
    expect(isProjectDisabled('default')).toBe(false);
    process.env.NOTIFICATION_POLICY = 'off';
    process.env.NOTIFICATIONS_DISABLED_PROJECTS = 'default';
    expect(isProjectDisabled('default')).toBe(false);
  });
});

describe('allowedFlags', () => {
  it('delivers everything while the policy is inactive, without reading settings', async () => {
    process.env.NOTIFICATION_POLICY = 'off';
    expect(await allowedFlags([{ orgId: 'o1', kind: 'sos' }, { orgId: null, kind: 'x' }])).toEqual([true, true]);
    expect(supa().chainsFor('org_settings')).toHaveLength(0);
  });

  it('delivers nothing for a disabled project, without reading settings', async () => {
    delete process.env.NOTIFICATIONS_DISABLED_PROJECTS; // default → Tata
    settings({ o1: ['*'] });
    expect(await allowedFlags([{ orgId: 'o1', kind: 'sos' }])).toEqual([false]);
    expect(supa().chainsFor('org_settings')).toHaveLength(0);
  });

  it('a client with no setting has every notification off (the default)', async () => {
    settings({});
    expect(await allowedFlags([{ orgId: 'o1', kind: 'sos' }, { orgId: 'o1', kind: 'lead_assigned' }])).toEqual([false, false]);
  });

  it('honours the enabled kinds per org, including aliases and the wildcard', async () => {
    settings({ o1: ['sos', 'crm_home'], o2: ['*'] });
    const r = await allowedFlags([
      { orgId: 'o1', kind: 'sos' },
      { orgId: 'o1', kind: 'daily_briefing' }, // alias of crm_home
      { orgId: 'o1', kind: 'lead_assigned' },
      { orgId: 'o2', kind: 'lead_assigned' },
      { orgId: 'o2', kind: 'something_unlisted' },
      { orgId: 'o3', kind: 'sos' },            // no row → off
      { orgId: null, kind: 'sos' },            // no org → held back
    ]);
    expect(r).toEqual([true, true, false, true, true, false, false]);
  });

  it('reads each org once for the whole batch, then from cache', async () => {
    settings({ o1: ['sos'] });
    await allowedFlags([{ orgId: 'o1', kind: 'sos' }, { orgId: 'o1', kind: 'broadcast' }, { orgId: 'o2', kind: 'sos' }]);
    await allowedFlags([{ orgId: 'o1', kind: 'sos' }]);
    const reads = supa().chainsFor('org_settings');
    expect(reads).toHaveLength(1);
    expect(reads[0].eqs).toMatchObject({ key: 'notifications.enabled_kinds' });
  });

  it('delivers rather than drops when the settings cannot be read', async () => {
    supa().setDefault('org_settings', { data: null, error: { message: 'boom' } });
    expect(await allowedFlags([{ orgId: 'o1', kind: 'sos' }])).toEqual([true]);
  });

  it('toEnabled accepts a list, a {kinds} object and treats anything else as nothing on', () => {
    expect(toEnabled(['*']).all).toBe(true);
    expect([...toEnabled({ kinds: ['sos', 'daily_briefing'] }).kinds]).toEqual(['sos', 'crm_home']);
    expect(toEnabled('sos')).toEqual({ all: false, kinds: new Set() });
    expect(toEnabled(null)).toEqual({ all: false, kinds: new Set() });
  });
});

describe('dispatcher', () => {
  const rows = [
    { id: 'n1', user_id: 'u1', title: 'SOS', body: 'help', type: 'sos', data: { sos_id: 'S1' } },
    { id: 'n2', user_id: 'u1', title: 'Lead', body: 'x', type: 'general', data: { kind: 'lead_assigned' } },
    { id: 'n3', user_id: 'u2', title: 'Lead', body: 'x', type: 'general', data: { kind: 'lead_assigned' } },
  ];
  beforeEach(() => {
    supa().setDefault('notifications', { data: rows });
    supa().setDefault('users', { data: [
      { id: 'u1', org_id: 'o1', fcm_token: 'fcm-token-1234567890', apns_token: null },
      { id: 'u2', org_id: 'o2', fcm_token: 'fcm-token-abcdefghij', apns_token: null },
    ] });
  });
  const stamped = () => supa().chainsFor('notifications')
    .filter((c: any) => c.ops.some((o: any) => o.method === 'update'))
    .map((c: any) => c.eqs.id);

  it('sends only what the recipient\'s client has switched on, and marks the rest handled', async () => {
    settings({ o1: ['sos'], o2: [] });
    const r = await dispatchPendingPushes();
    expect(r).toMatchObject({ scanned: 3, sent: 1, suppressed: 2, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as any[])[0].data).toMatchObject({ notification_id: 'n1', kind: 'sos' });
    expect(stamped()).toEqual(expect.arrayContaining(['n2', 'n3']));
  });

  it('sends nothing for the Tata project but still stamps the rows so they do not pile up', async () => {
    delete process.env.NOTIFICATIONS_DISABLED_PROJECTS;
    settings({ o1: ['*'], o2: ['*'] });
    const r = await dispatchPendingPushes();
    expect(r).toMatchObject({ scanned: 3, sent: 0, suppressed: 3 });
    expect(send).not.toHaveBeenCalled();
    expect(stamped()).toEqual(expect.arrayContaining(['n1', 'n2', 'n3']));
  });

  it('with the policy off, behaves as before', async () => {
    process.env.NOTIFICATION_POLICY = 'off';
    const r = await dispatchPendingPushes();
    expect(r).toMatchObject({ scanned: 3, sent: 3, suppressed: 0 });
  });
});

describe('notify helpers', () => {
  it('do not create a row for a kind the client has off', async () => {
    settings({ o1: ['sos'] });
    await notify({ orgId: 'o1', userId: 'u1', kind: 'lead_assigned', title: 't', body: 'b' } as any);
    await notifyUsers({ orgId: 'o1', kind: 'deal_won', title: 't', body: 'b' } as any, ['u1', 'u2']);
    expect(supa().chainsFor('notifications')).toHaveLength(0);
  });
  it('create it for a kind the client has on', async () => {
    settings({ o1: ['lead_assigned'] });
    await notify({ orgId: 'o1', userId: 'u1', kind: 'lead_assigned', title: 't', body: 'b' } as any);
    expect(supa().chainsFor('notifications')).toHaveLength(1);
  });
});

describe('bell (GET /notifications)', () => {
  const callList = () => new Promise<any>((resolve, reject) => {
    const res: any = { status: () => res, json: (b: unknown) => { resolve(b); return res; } };
    (getNotifications as any)({ user: { id: 'u1', org_id: 'o1' }, query: {} }, res, (e: unknown) => reject(e));
  });
  beforeEach(() => supa().setDefault('notifications', {
    data: [
      { id: 'a', title: 'SOS', type: 'sos', data: { sos_id: 'S1' }, is_read: false },
      { id: 'b', title: 'Lead', type: 'general', data: { kind: 'lead_assigned' }, is_read: false },
    ],
    count: 2,
  }));

  it('lists only the kinds the client has on', async () => {
    settings({ o1: ['sos'] });
    const body = await callList();
    expect(body.data.map((n: any) => n.id)).toEqual(['a']);
  });
  it('is empty for a disabled project', async () => {
    delete process.env.NOTIFICATIONS_DISABLED_PROJECTS;
    const body = await callList();
    expect(body.data).toEqual([]);
    expect(body.pagination).toMatchObject({ total: 0 });
  });
});

describe('management (Client Management → Notifications)', () => {
  it('reads a client\'s catalogue with what is on', async () => {
    supa().setDefault('org_settings', { data: { value: ['sos', 'daily_briefing'] } });
    const s = await readOrgSettings('o1');
    expect(s.enabled_kinds.sort()).toEqual(['crm_home', 'sos']);
    expect(s.catalog.find((c) => c.kind === 'sos')).toMatchObject({ enabled: true, recommended: true });
    expect(s.catalog.find((c) => c.kind === 'crm_home')?.enabled).toBe(true);
    expect(s.catalog.find((c) => c.kind === 'lead_assigned')?.enabled).toBe(false);
  });

  it('a client with no row has everything off', async () => {
    supa().setDefault('org_settings', { data: null });
    const s = await readOrgSettings('o1');
    expect(s.enabled_kinds).toEqual([]);
    expect(s.catalog.every((c) => !c.enabled)).toBe(true);
  });

  it('saves the normalised list, replacing the previous one, and takes effect at once', async () => {
    settings({ o1: [] });
    expect(await allowedFlags([{ orgId: 'o1', kind: 'sos' }])).toEqual([false]);
    const saved = await writeOrgSettings('o1', ['sos', 'daily_briefing'], 'admin-1');
    expect(saved).toEqual(['sos', 'crm_home']);
    const writes = supa().chainsFor('org_settings');
    const ins = writes.find((c: any) => c.ops.some((o: any) => o.method === 'insert'));
    expect(ins.ops.find((o: any) => o.method === 'insert').args[0]).toMatchObject({
      org_id: 'o1', key: 'notifications.enabled_kinds', value: ['sos', 'crm_home'], updated_by: 'admin-1',
    });
    expect(writes.some((c: any) => c.ops.some((o: any) => o.method === 'delete'))).toBe(true);
    settings({ o1: ['sos'] });
    expect(await isNotificationEnabled('o1', 'sos')).toBe(true);
  });

  it('refuses an unknown kind without touching the stored setting', async () => {
    await expect(writeOrgSettings('o1', ['nope'], null)).rejects.toThrow(/Unknown notification kind/);
    expect(supa().chainsFor('org_settings')).toHaveLength(0);
  });
});
