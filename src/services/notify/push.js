// Push channel — Firebase Cloud Messaging for the Farmer App (PRD §10, §12).
// firebase-admin is dynamically imported and only initialised when a service
// account is configured, so the server boots fine without FCM credentials.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../../config/env.js';

// Credentials come from either a service-account JSON file (FIREBASE_SERVICE_ACCOUNT,
// recommended) or the individual FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY vars.
function loadCredential() {
  if (env.fcm.serviceAccountFile) {
    const p = resolve(process.cwd(), env.fcm.serviceAccountFile);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8'));
      } catch {
        /* malformed file → fall through to env vars */
      }
    }
  }
  if (env.fcm.projectId && env.fcm.clientEmail && env.fcm.privateKey) {
    return { projectId: env.fcm.projectId, clientEmail: env.fcm.clientEmail, privateKey: env.fcm.privateKey };
  }
  return null;
}

const credential = loadCredential();
export const pushConfigured = Boolean(credential);

let messaging = null;
async function getMessaging() {
  if (messaging) return messaging;
  if (!credential) return null;
  const admin = (await import('firebase-admin')).default;
  if (!admin.apps.length) {
    // cert() accepts a parsed service-account JSON (snake_case) or a {projectId,...} object.
    admin.initializeApp({ credential: admin.credential.cert(credential) });
  }
  messaging = admin.messaging();
  return messaging;
}

/** Send a push notification to many device tokens. Returns a dispatch summary. */
export async function sendPush(tokens, title, body) {
  const list = [...new Set((tokens || []).filter(Boolean))];
  if (!list.length) return { channel: 'PUSH', sent: 0, note: 'no device tokens' };
  const m = await getMessaging();
  if (!m) return { channel: 'PUSH', sent: 0, skipped: true, note: 'FCM not configured' };
  const res = await m.sendEachForMulticast({
    tokens: list,
    notification: { title, body },
    // Mirror into data so the Farmer App's foreground onMessage handler fires
    // (a notification-only payload is swallowed by the OS on some Android OEMs).
    data: { title: String(title ?? ''), body: String(body ?? '') },
  });
  return { channel: 'PUSH', sent: res.successCount, failed: res.failureCount };
}
