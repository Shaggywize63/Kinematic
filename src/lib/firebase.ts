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
export default admin;
