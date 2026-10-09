/**
 * A user's stored push token is the only way to reach their Android phone (and to restart its live tracking),
 * and the phone only re-sends it on login / cold start / rotation. These pin when a failed FCM send is allowed
 * to say "this token is dead" — and, just as important, when it is not.
 */
import { classifyFcmError } from '../src/lib/fcmErrors';

const err = (code: string, message = `${code} (test)`) => Object.assign(new Error(message), { errorInfo: { code, message } });

describe('classifyFcmError', () => {
  it('a token Firebase says is unregistered or invalid is dead', () => {
    expect(classifyFcmError(err('messaging/registration-token-not-registered'))).toBe('dead-token');
    expect(classifyFcmError(err('messaging/invalid-registration-token'))).toBe('dead-token');
  });

  it('a malformed token (invalid-argument that names the token) is dead', () => {
    expect(classifyFcmError(err('messaging/invalid-argument', 'The registration token is not a valid FCM registration token'))).toBe('dead-token');
  });

  it('an invalid-argument about the MESSAGE (oversize, bad data) says nothing about the token', () => {
    expect(classifyFcmError(err('messaging/invalid-argument', 'Android message is too big'))).toBe('other');
    expect(classifyFcmError(err('messaging/invalid-argument', 'Invalid JSON payload received. Unknown name "x"'))).toBe('other');
  });

  it('our own credential problems, including a sender-id mismatch, never point at the token', () => {
    for (const c of ['app/invalid-credential', 'messaging/authentication-error', 'messaging/third-party-auth-error', 'messaging/mismatched-credential']) {
      expect(classifyFcmError(err(c))).toBe('credential');
    }
  });

  it('not-found, quota, outages and unknown shapes keep the token', () => {
    for (const c of ['messaging/not-found', 'messaging/server-unavailable', 'messaging/internal-error', 'messaging/message-rate-exceeded', 'messaging/device-message-rate-exceeded']) {
      expect(classifyFcmError(err(c))).toBe('other');
    }
    expect(classifyFcmError(new Error('socket hang up'))).toBe('other');
    expect(classifyFcmError(undefined)).toBe('other');
    expect(classifyFcmError('boom')).toBe('other');
  });

  it('reads the code from the error itself when there is no errorInfo', () => {
    expect(classifyFcmError(Object.assign(new Error('x'), { code: 'messaging/registration-token-not-registered' }))).toBe('dead-token');
  });
});
