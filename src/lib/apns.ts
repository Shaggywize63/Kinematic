/**
 * Native APNs (Apple Push Notification service) sender.
 *
 * iOS devices register a raw APNs device token (not an FCM token), so they
 * can't go through firebase-admin. This module talks to APNs directly over
 * HTTP/2 using a token-based (.p8) auth key signed with ES256 — the same
 * JWT scheme Apple documents — reusing the `jose` library already in the
 * dependency tree (no new npm package).
 *
 * Config (all via env; inert until set, like the WhatsApp provider):
 *   APNS_AUTH_KEY_P8  — the .p8 private key, raw PEM or base64 of the PEM
 *   APNS_KEY_ID       — the 10-char Key ID from the Apple Developer portal
 *   APNS_TEAM_ID      — the 10-char Apple Team ID
 *   APNS_BUNDLE_ID    — the app bundle id (apns-topic), e.g. com.kinematic.app
 *   APNS_PRODUCTION   — "true" → api.push.apple.com, else sandbox host
 *
 * The provider JWT is cached for ~50 min (Apple requires a fresh token at
 * least every 60 min and rejects tokens refreshed more than once every 20).
 */
import http2 from 'node:http2';
import { SignJWT, importPKCS8 } from 'jose';
import { logger } from './logger';

const KEY_P8 = process.env.APNS_AUTH_KEY_P8 || '';
const KEY_ID = process.env.APNS_KEY_ID || '';
const TEAM_ID = process.env.APNS_TEAM_ID || '';
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || '';
const HOST = process.env.APNS_PRODUCTION === 'true'
  ? 'https://api.push.apple.com'
  : 'https://api.sandbox.push.apple.com';

/** True only when every required APNs setting is present. */
export const apnsEnabled: boolean = Boolean(KEY_P8 && KEY_ID && TEAM_ID && BUNDLE_ID);

if (!apnsEnabled) {
  logger.warn(
    'APNs not configured (APNS_AUTH_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID / APNS_BUNDLE_ID missing). iOS push is disabled until set.'
  );
}

export interface ApnsResult {
  ok: boolean;
  /** True when APNs says the token is gone for good (410 / Unregistered / BadDeviceToken). */
  unregistered: boolean;
  status: number;
  reason?: string;
}

// ── Provider-token cache ──────────────────────────────────────────────────
let cachedJwt: string | null = null;
let cachedAt = 0;
const JWT_TTL_MS = 50 * 60 * 1000;

/**
 * Normalize whatever form the .p8 key was stored in into a PKCS#8 PEM string.
 * Handles, in order:
 *   1. A real PEM (already contains "BEGIN") — used as-is (escaped \n unescaped).
 *   2. base64 of the full PEM (decodes to a string containing "BEGIN").
 *   3. The BARE base64 key body with no armor/newlines — the form a .p8 lands
 *      in when only the base64 between the BEGIN/END lines is pasted into a
 *      one-line env var / secret. We re-wrap it in PKCS#8 PEM armor.
 * Without (3), a bare body was base64-decoded to raw DER and handed to
 * importPKCS8 as a garbage string → every iOS push failed at JWT signing.
 */
function toPem(raw: string): string {
  const v = raw.trim().replace(/\\n/g, '\n');
  if (v.includes('BEGIN')) return v;
  try {
    const decoded = Buffer.from(v, 'base64').toString('utf8');
    if (decoded.includes('BEGIN')) return decoded;
  } catch { /* not base64-of-PEM; fall through to armor the bare body */ }
  const body = v.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? v;
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

async function providerToken(): Promise<string> {
  const now = Date.now();
  if (cachedJwt && now - cachedAt < JWT_TTL_MS) return cachedJwt;

  const key = await importPKCS8(toPem(KEY_P8), 'ES256');

  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: KEY_ID })
    .setIssuer(TEAM_ID)
    .setIssuedAt()
    .sign(key);

  cachedJwt = jwt;
  cachedAt = now;
  return jwt;
}

/**
 * Send one alert push to a single iOS device token. Resolves with a result
 * describing whether the token should be retired. Never throws — transport
 * errors resolve as { ok:false } so callers can stamp the row and move on.
 */
export async function sendApns(
  deviceToken: string,
  msg: { title: string; body: string; data?: Record<string, string> }
): Promise<ApnsResult> {
  if (!apnsEnabled) return { ok: false, unregistered: false, status: 0, reason: 'apns-disabled' };

  let jwt: string;
  try {
    jwt = await providerToken();
  } catch (e: any) {
    logger.error(`[apns] failed to sign provider token: ${e?.message || e}`);
    return { ok: false, unregistered: false, status: 0, reason: 'jwt-sign-failed' };
  }

  const payload = JSON.stringify({
    aps: { alert: { title: msg.title, body: msg.body }, sound: 'default' },
    ...(msg.data || {}),
  });

  return new Promise<ApnsResult>((resolve) => {
    const client = http2.connect(HOST);
    let settled = false;
    const done = (r: ApnsResult) => {
      if (settled) return;
      settled = true;
      client.close();
      resolve(r);
    };

    client.on('error', (err: any) => done({ ok: false, unregistered: false, status: 0, reason: err?.message }));

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });

    let status = 0;
    let bodyStr = '';
    req.on('response', (headers) => { status = Number(headers[':status']) || 0; });
    req.setEncoding('utf8');
    req.on('data', (chunk) => { bodyStr += chunk; });
    req.on('end', () => {
      if (status === 200) return done({ ok: true, unregistered: false, status });
      // APNs returns a JSON body { reason: "BadDeviceToken" | "Unregistered" | ... }
      let reason = '';
      try { reason = JSON.parse(bodyStr || '{}').reason || ''; } catch { /* non-JSON */ }
      const unregistered =
        status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken';
      done({ ok: false, unregistered, status, reason });
    });
    req.on('error', (err: any) => done({ ok: false, unregistered: false, status: 0, reason: err?.message }));
    req.end(payload);
  });
}
