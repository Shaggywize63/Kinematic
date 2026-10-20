jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { getClientNotifications, setClientNotifications } from '../src/controllers/client.controller';
import { _resetPolicyCache } from '../src/services/notificationPolicy';

const supa = () => (global as any).__supa;
const CLIENT = '11111111-1111-4111-8111-111111111111';

const call = (handler: any, req: any) => new Promise<{ status: number; body: any }>((resolve, reject) => {
  let status = 200;
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: unknown) => { resolve({ status, body: b }); return res; } };
  handler({ params: { id: CLIENT }, body: {}, query: {}, ...req }, res, (e: unknown) => reject(e));
});

const operator = { id: 'u-admin', org_id: 'org-parent', role: 'admin', email: 'ops@kinematicapp.com' };

beforeEach(() => {
  supa().reset();
  _resetPolicyCache();
  process.env.NOTIFICATION_POLICY = 'on';
  process.env.NOTIFICATIONS_DISABLED_PROJECTS = '';
  supa().setDefault('clients', { data: { id: CLIENT, org_id: 'org-client' } });
});

describe('GET /clients/:id/notifications', () => {
  it('returns the catalogue, all off, for a client with no setting', async () => {
    supa().setDefault('org_settings', { data: null });
    const { body } = await call(getClientNotifications, { user: operator });
    expect(body.success).toBe(true);
    expect(body.data.enabled_kinds).toEqual([]);
    expect(body.data.catalog.length).toBeGreaterThan(30);
    expect(body.data.catalog.every((c: any) => c.enabled === false)).toBe(true);
    // The setting is read from the client's own org, not the caller's.
    expect(supa().chainsFor('org_settings')[0].eqs).toMatchObject({ org_id: 'org-client', key: 'notifications.enabled_kinds' });
  });

  it('only reaches clients the caller\'s org owns', async () => {
    await call(getClientNotifications, { user: operator });
    expect(supa().chainsFor('clients')[0].eqs).toMatchObject({ id: CLIENT, owner_org_id: 'org-parent' });
  });

  it('404s for a client outside the caller\'s reach and for a malformed id', async () => {
    supa().setDefault('clients', { data: null });
    expect((await call(getClientNotifications, { user: operator })).status).toBe(404);
    expect((await call(getClientNotifications, { user: operator, params: { id: 'nope' } })).status).toBe(404);
  });
});

describe('PUT /clients/:id/notifications', () => {
  it('stores the chosen kinds on the client\'s org and returns the new state', async () => {
    supa().setDefault('org_settings', { data: { value: ['sos', 'crm_home'] } });
    const { status, body } = await call(setClientNotifications, { user: operator, body: { enabled_kinds: ['sos', 'daily_briefing'] } });
    expect(status).toBe(200);
    const ins = supa().chainsFor('org_settings').find((c: any) => c.ops.some((o: any) => o.method === 'insert'));
    expect(ins.ops.find((o: any) => o.method === 'insert').args[0]).toMatchObject({
      org_id: 'org-client', key: 'notifications.enabled_kinds', value: ['sos', 'crm_home'], updated_by: 'u-admin',
    });
    expect(body.data.enabled_kinds.sort()).toEqual(['crm_home', 'sos']);
  });

  it('400s on an unknown kind or a body that is not a list, and writes nothing', async () => {
    for (const enabled_kinds of [['sos', 'nope'], 'sos', undefined]) {
      const { status } = await call(setClientNotifications, { user: operator, body: { enabled_kinds } });
      expect(status).toBe(400);
    }
    expect(supa().chainsFor('org_settings')).toHaveLength(0);
  });
});
