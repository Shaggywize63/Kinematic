/**
 * What a failed FCM send means for the recipient's stored push token.
 *
 * A user's `fcm_token` is the only way to reach their Android phone (including the silent push that restarts
 * live tracking), and the phone only re-sends it on login, a cold start or when Firebase rotates it. So
 * clearing it by mistake silences that phone until the user happens to relaunch the app. Clearing is only
 * right when Firebase says the TOKEN is dead; anything wrong with the message or with our own credential says
 * nothing about the token.
 *
 *   - credential : our service-account key is unusable, or the token belongs to a different Firebase project
 *                  than that key (sender-id mismatch). The token is not at fault; never clear. Reported loudly.
 *   - dead-token : the app was uninstalled / the token was replaced or is malformed. Clear it.
 *   - other      : a bad payload (`invalid-argument` about the message, e.g. oversize), not-found, quota,
 *                  outage… Keep the token.
 */
export type FcmFailure = 'credential' | 'dead-token' | 'other';

const CREDENTIAL_CODES = [
  'app/invalid-credential',
  'messaging/authentication-error',
  'messaging/third-party-auth-error',
  'messaging/mismatched-credential',
];

function codeAndText(err: unknown): { code: string; text: string } {
  const e = err as { errorInfo?: { code?: unknown; message?: unknown }; code?: unknown; message?: unknown } | null | undefined;
  const code = String(e?.errorInfo?.code ?? e?.code ?? '');
  const text = String(e?.errorInfo?.message ?? e?.message ?? '');
  return { code, text };
}

export function classifyFcmError(err: unknown): FcmFailure {
  const { code, text } = codeAndText(err);
  const haystack = `${code} ${text}`;
  if (CREDENTIAL_CODES.some((c) => haystack.includes(c))) return 'credential';
  if (haystack.includes('registration-token-not-registered') || haystack.includes('invalid-registration-token')) return 'dead-token';
  // Firebase reports a malformed token as plain `invalid-argument` with a message that names the token; the
  // same code also comes back for a bad message (too big, bad data), which must NOT clear anything.
  if (code.includes('invalid-argument') && /registration token/i.test(text)) return 'dead-token';
  return 'other';
}
