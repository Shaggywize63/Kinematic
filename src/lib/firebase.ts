import * as admin from 'firebase-admin';
import { logger } from './logger';

const firebaseConfig = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!firebaseConfig) {
  logger.warn('FIREBASE_SERVICE_ACCOUNT not found in environment. Push notifications will be disabled.');
}

try {
  if (firebaseConfig && admin.apps.length === 0) {
    const serviceAccount = JSON.parse(
      firebaseConfig.startsWith('{') ? firebaseConfig : Buffer.from(firebaseConfig, 'base64').toString()
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    logger.info('Firebase Admin SDK initialized successfully');
  }
} catch (error: any) {
  logger.error('Firebase initialization failed: ' + error.message);
}

export const messaging = admin.apps.length > 0 ? admin.messaging() : null;

/**
 * Ask Google for an access token with the configured service account.
 *
 * `initializeApp()` above never validates the key, so a revoked, rotated or wrong-project key logs
 * "initialized successfully" and then fails every push with `app/invalid-credential`. This turns that
 * into a startup-time answer. It never throws.
 */
export async function probeFirebaseCredential(): Promise<{ ok: boolean; reason?: string }> {
  if (admin.apps.length === 0) {
    return { ok: false, reason: 'FIREBASE_SERVICE_ACCOUNT is missing or could not be parsed' };
  }
  try {
    const credential = admin.app().options.credential as { getAccessToken?: () => Promise<unknown> } | undefined;
    if (!credential?.getAccessToken) return { ok: false, reason: 'no credential on the Firebase app' };
    await credential.getAccessToken();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e).slice(0, 300) };
  }
}

export default admin;
