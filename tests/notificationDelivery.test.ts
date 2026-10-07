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
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { dispatchPendingPushes } from '../src/services/notifications.service';
import { getNotifications } from '../src/controllers/misc.controller';

const supa = () => (global as any).__supa;

/**
 * Both delivery paths — the push payload and the in-app list — must hand the
 * phone ONE `kind`, however the row was written, so a tap opens the right screen.
 */
describe('push payload carries a routable kind', () => {
  beforeEach(() => { supa().reset(); send.mockClear(); sendApns.mockClear(); });

  it('FCM: kind is derived for rows written without one, and existing keys are kept', async () => {
    supa().setDefault('notifications', {
      data: [
        { id: 'n1', user_id: 'u1', title: 'SOS', body: 'help', type: 'sos', data: { sos_id: 'S1', exec_id: 'U9', lat: 12.9 } },
        { id: 'n2', user_id: 'u1', title: 'Leave', body: 'x', type: 'leave', data: { type: 'leave_request', request_id: 'R1' } },
        { id: 'n3', user_id: 'u1', title: 'Lead', body: 'x', type: 'general', data: { kind: 'lead_assigned', lead_id: 'L1' } },
        { id: 'n4', user_id: 'u1', title: 'Broadcast', body: 'x', type: 'broadcast', data: null },
      ],
    });
    supa().setDefault('users', { data: [{ id: 'u1', fcm_token: 'fcm-token-1234567890', apns_token: null }] });

    const r = await dispatchPendingPushes();
    expect(r).toMatchObject({ scanned: 4, sent: 4, failed: 0 });

    const payloads = send.mock.calls.map((c: any[]) => c[0].data);
    expect(payloads[0]).toMatchObject({ notification_id: 'n1', kind: 'sos', sos_id: 'S1', exec_id: 'U9', lat: '12.9' });
    expect(payloads[1]).toMatchObject({ notification_id: 'n2', kind: 'leave_request', request_id: 'R1' });
    expect(payloads[2]).toMatchObject({ notification_id: 'n3', kind: 'lead_assigned', lead_id: 'L1' });
    expect(payloads[3]).toMatchObject({ notification_id: 'n4', kind: 'broadcast' });
    // FCM data is string -> string only.
    for (const p of payloads) for (const v of Object.values(p)) expect(typeof v).toBe('string');
  });

  it('APNs: the same kind reaches iOS', async () => {
    supa().setDefault('notifications', {
      data: [{ id: 'n5', user_id: 'u2', title: 'Msg', body: 'hi', type: 'message', data: { thread_id: 'TH1', message_id: 'M1' } }],
    });
    supa().setDefault('users', { data: [{ id: 'u2', fcm_token: null, apns_token: 'apns-token-abc' }] });

    await dispatchPendingPushes();
    expect(send).not.toHaveBeenCalled();
    expect(sendApns).toHaveBeenCalledTimes(1);
    const [, msg] = sendApns.mock.calls[0] as unknown as [string, { data: Record<string, string> }];
    expect(msg.data).toMatchObject({ notification_id: 'n5', kind: 'message', thread_id: 'TH1' });
  });
});

describe('GET /api/v1/notifications (handler)', () => {
  beforeEach(() => supa().reset());

  // Called directly: the app-level demo layer answers demo tokens before the controller runs.
  const callList = () => new Promise<any>((resolve, reject) => {
    // asyncHandler doesn't return its promise, so wait for the response itself.
    const res: any = { status: () => res, json: (b: unknown) => { resolve(b); return res; } };
    (getNotifications as any)({ user: { id: 'u1', org_id: 'o1' }, query: {} }, res, (e: unknown) => reject(e));
  });

  it('every row carries data.kind, including rows stored without one', async () => {
    supa().setDefault('notifications', {
      data: [
        { id: 'a', title: 'SOS', type: 'sos', data: { sos_id: 'S1' }, is_read: false },
        { id: 'b', title: 'Leave', type: 'leave', data: { type: 'leave_decision', request_id: 'R1', decision: 'approved' }, is_read: false },
        { id: 'c', title: 'Plain', type: 'general', data: null, is_read: true },
      ],
      count: 3,
    });
    const body = await callList();
    expect(body.success).toBe(true);
    const rows = body.data as Array<{ id: string; title: string; data: Record<string, unknown> }>;
    expect(rows.map((n) => n.data.kind)).toEqual(['sos', 'leave_decision', 'general']);
    // original keys and the rest of the row survive
    expect(rows[1].data).toMatchObject({ request_id: 'R1', decision: 'approved' });
    expect(rows[0].data.sos_id).toBe('S1');
    expect(rows.map((n) => n.title)).toEqual(['SOS', 'Leave', 'Plain']);
    expect(body.pagination).toMatchObject({ total: 3 });
  });

  it('only reads the signed-in user\'s notifications', async () => {
    supa().setDefault('notifications', { data: [], count: 0 });
    await callList();
    expect(supa().chainsFor('notifications')[0].eqs).toMatchObject({ user_id: 'u1' });
  });
});

describe('mention notifications carry what a tap needs', () => {
  beforeEach(() => supa().reset());
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { persistMentions } = require('../src/services/crm/messaging.service');
  const req = { user: { id: 'u1', org_id: 'o1', role: 'super_admin', name: 'Asha' } };

  it('a chat mention includes the thread so the app can open the conversation', async () => {
    await persistMentions(req, 'message', 'M1', ['u2'], { thread_id: 'TH1' });
    const insert = supa().chainsFor('notifications')[0].ops.find((o: any) => o.method === 'insert');
    expect(insert.args[0][0]).toMatchObject({
      user_id: 'u2', type: 'mention',
      data: { source_kind: 'message', source_id: 'M1', mentioner_id: 'u1', thread_id: 'TH1' },
    });
  });

  it('a lead-update mention includes the lead so the app can open it', async () => {
    await persistMentions(req, 'lead_update', 'LU1', ['u2'], { lead_id: 'L9' });
    const insert = supa().chainsFor('notifications')[0].ops.find((o: any) => o.method === 'insert');
    expect(insert.args[0][0].data).toEqual({ source_kind: 'lead_update', source_id: 'LU1', mentioner_id: 'u1', lead_id: 'L9' });
  });

  it('without extra keys the payload is unchanged', async () => {
    await persistMentions(req, 'lead_update', 'LU1', ['u2']);
    const insert = supa().chainsFor('notifications')[0].ops.find((o: any) => o.method === 'insert');
    expect(insert.args[0][0].data).toEqual({ source_kind: 'lead_update', source_id: 'LU1', mentioner_id: 'u1' });
  });
});
