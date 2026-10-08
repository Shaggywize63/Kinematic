/**
 * Admin broadcasts (POST /notifications/send) reach Android through FCM multicast. Like the per-user
 * dispatcher they must be DATA-ONLY (no visible-notification block): the app builds the alert itself, so
 * it looks and routes the same whether the app is open, backgrounded or closed.
 */
const sendEachForMulticast = jest.fn(async () => ({ successCount: 2, failureCount: 0 }));
const sendApns = jest.fn(async () => ({ ok: true, unregistered: false, status: 200 }));

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/lib/firebase', () => ({ messaging: { sendEachForMulticast: (...a: unknown[]) => (sendEachForMulticast as any)(...a) }, default: {} }));
jest.mock('../src/lib/apns', () => ({ apnsEnabled: true, sendApns: (...a: unknown[]) => (sendApns as any)(...a) }));

import { sendNotification } from '../src/controllers/notifications.controller';

const supa = () => (global as any).__supa;

const call = () => new Promise<any>((resolve, reject) => {
  // asyncHandler doesn't return its promise, so wait for the response itself.
  const res: any = { status: () => res, json: (b: unknown) => { resolve(b); return res; } };
  (sendNotification as any)(
    { user: { id: 'admin-1', org_id: 'org-1', role: 'admin' }, body: { title: 'Holiday', body: 'Office closed Friday', send_push: true, targeting: { user_ids: ['u1', 'u2', 'u3'] } } },
    res,
    (e: unknown) => reject(e),
  );
});

describe('broadcast push to Android', () => {
  beforeEach(() => { supa().reset(); sendEachForMulticast.mockClear(); sendApns.mockClear(); });

  it('is data-only: no notification block, title/body in data, high priority; iOS still gets its APNs push', async () => {
    supa().setDefault('users', { data: [
      { id: 'u1', org_id: 'org-1', fcm_token: 'android-token-aaaaaaaaaa', apns_token: null },
      { id: 'u2', org_id: 'org-1', fcm_token: 'android-token-bbbbbbbbbb', apns_token: null },
      { id: 'u3', org_id: 'org-1', fcm_token: null, apns_token: 'ios-apns-token-cccccc' },
    ] });
    supa().setDefault('notification_broadcasts', { data: { id: 'b1' } });

    await call();

    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    const msg = (sendEachForMulticast.mock.calls[0] as unknown[])[0] as any;
    expect(msg.notification).toBeUndefined();
    expect(msg.android).toEqual({ priority: 'high' });
    expect(msg.tokens).toEqual(['android-token-aaaaaaaaaa', 'android-token-bbbbbbbbbb']);
    expect(msg.data).toMatchObject({ title: 'Holiday', body: 'Office closed Friday', kind: 'broadcast', broadcast_id: 'b1' });

    expect(sendApns).toHaveBeenCalledTimes(1);
    expect((sendApns.mock.calls[0] as unknown[])[1]).toMatchObject({ title: 'Holiday', body: 'Office closed Friday' });
  });
});
