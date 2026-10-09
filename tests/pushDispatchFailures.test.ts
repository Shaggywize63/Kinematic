/**
 * Why Android push was silently dead: the server's Firebase key was rejected by Google
 * (`app/invalid-credential`) while startup still logged "initialized successfully", and every failed
 * row was stamped sent. These pin the behaviour around that failure:
 *   - a rejected SERVER credential is reported at error level and flagged in the result;
 *   - it never clears a user's push token (the token is fine — the server is not);
 *   - a genuinely dead token (app uninstalled) is still cleared, as before;
 *   - Android pushes are data-only (title/body in data, no visible-notification block).
 */
const send = jest.fn();

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/lib/firebase', () => ({ messaging: { send: (...a: unknown[]) => send(...a) }, default: {} }));
jest.mock('../src/lib/apns', () => ({ apnsEnabled: false, sendApns: jest.fn() }));

import { dispatchPendingPushes } from '../src/services/notifications.service';
import { logger } from '../src/lib/logger';

const supa = () => (global as any).__supa;
const row = (id: string) => ({ id, user_id: 'u1', title: 'Reminder: Call Asha', body: 'is due in 20 min', type: 'crm_activity_due', data: { kind: 'crm_task_overdue', activity_id: 'a1' } });
const fcmError = (code: string) => Object.assign(new Error(`${code} (test)`), { errorInfo: { code } });
const tokenClears = () => supa().chainsFor('users')
  .flatMap((c: any) => c.ops.filter((o: any) => o.method === 'update'))
  .filter((o: any) => o.args[0] && Object.prototype.hasOwnProperty.call(o.args[0], 'fcm_token') && o.args[0].fcm_token === null);

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  supa().reset();
  send.mockReset();
  errorSpy = jest.spyOn(logger, 'error').mockImplementation((() => logger) as any);
  jest.spyOn(logger, 'warn').mockImplementation((() => logger) as any);
  supa().setDefault('notifications', { data: [row('n1'), row('n2')] });
  supa().setDefault('users', { data: [{ id: 'u1', fcm_token: 'valid-device-token-1234567890', apns_token: null }] });
});
afterEach(() => jest.restoreAllMocks());

describe('push dispatch when Firebase rejects the server credential', () => {
  it('flags it, logs ONE error line for the run, and keeps the user token', async () => {
    send.mockRejectedValue(fcmError('app/invalid-credential'));
    const r = await dispatchPendingPushes();
    expect(r).toMatchObject({ scanned: 2, sent: 0, failed: 2, credential_error: true });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/Firebase service-account credential/);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/FIREBASE_SERVICE_ACCOUNT/);
    expect(tokenClears()).toHaveLength(0); // the device token is not at fault
  });

  it('a healthy run raises no credential alarm', async () => {
    send.mockResolvedValue('projects/p/messages/1');
    const r = await dispatchPendingPushes();
    expect(r).toMatchObject({ sent: 2, failed: 0, credential_error: false });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('a dead device token', () => {
  it('is still cleared so the user stops being counted as reachable', async () => {
    send.mockRejectedValue(fcmError('messaging/registration-token-not-registered'));
    const r = await dispatchPendingPushes();
    expect(r).toMatchObject({ failed: 2, credential_error: false });
    expect(tokenClears().length).toBeGreaterThan(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('failures that say nothing about the user token', () => {
  const failures: Array<[string, Error]> = [
    ['a sender-id mismatch (token from another Firebase project / wrong server key)', fcmError('messaging/mismatched-credential')],
    ['a rejected message (invalid-argument about the payload)', Object.assign(new Error('Android message is too big'), { errorInfo: { code: 'messaging/invalid-argument', message: 'Android message is too big' } })],
    ['not-found', fcmError('messaging/not-found')],
    ['an outage', fcmError('messaging/server-unavailable')],
  ];
  it.each(failures)('keeps the token on %s', async (_label, e) => {
    send.mockRejectedValue(e);
    await dispatchPendingPushes();
    expect(tokenClears()).toHaveLength(0);
  });

  it('a sender-id mismatch is reported as a credential problem, not silently swallowed', async () => {
    send.mockRejectedValue(fcmError('messaging/mismatched-credential'));
    const r = await dispatchPendingPushes();
    expect(r).toMatchObject({ failed: 2, credential_error: true });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('a malformed token (invalid-argument that names the token) IS cleared', async () => {
    send.mockRejectedValue(Object.assign(new Error('x'), { errorInfo: { code: 'messaging/invalid-argument', message: 'The registration token is not a valid FCM registration token' } }));
    await dispatchPendingPushes();
    expect(tokenClears().length).toBeGreaterThan(0);
  });
});

describe('push payload', () => {
  it('is data-only: no visible-notification block, title/body inside data, high priority', async () => {
    send.mockResolvedValue('projects/p/messages/1');
    await dispatchPendingPushes();
    const msg = send.mock.calls[0][0];
    expect(msg.notification).toBeUndefined();          // the app builds the alert, not the system tray
    expect(msg.apns).toBeUndefined();
    expect(msg.android).toEqual({ priority: 'high' }); // and no android.notification either (that would make it a notification message)
    expect(msg.data).toMatchObject({
      notification_id: 'n1', kind: 'crm_task_overdue', activity_id: 'a1',
      title: 'Reminder: Call Asha', body: 'is due in 20 min',
    });
    for (const v of Object.values(msg.data)) expect(typeof v).toBe('string'); // FCM data is string -> string
  });

  it('the row\'s own title/body win over same-named keys in its data', async () => {
    supa().setDefault('notifications', { data: [{ ...row('n9'), data: { kind: 'x', title: 'spoofed', body: 'spoofed' } }] });
    send.mockResolvedValue('projects/p/messages/1');
    await dispatchPendingPushes();
    expect(send.mock.calls[0][0].data).toMatchObject({ title: 'Reminder: Call Asha', body: 'is due in 20 min' });
  });

  it('caps long text so FCM never rejects it as oversized (which would clear the token)', async () => {
    supa().setDefault('notifications', { data: [{ ...row('n10'), title: 'T'.repeat(500), body: 'B'.repeat(5000) }] });
    send.mockResolvedValue('projects/p/messages/1');
    await dispatchPendingPushes();
    const d = send.mock.calls[0][0].data;
    expect(d.title.length).toBeLessThanOrEqual(200);
    expect(d.body.length).toBeLessThanOrEqual(1000);
    expect(d.body.endsWith('…')).toBe(true);
  });
});
