/**
 * Resend email provider. Wraps the Resend REST API (POST /emails) using
 * fetch — no SDK install needed. Configured via env:
 *
 *   EMAIL_PROVIDER=resend
 *   RESEND_API_KEY=re_xxxxxxxx
 *
 * Resend returns `{ id }` on success. We surface that as `message_id`
 * so crm_email_logs carries a real provider id, which downstream
 * webhook handlers (bounces, complaints) can correlate.
 */
import type { EmailProvider, EmailSendInput, EmailSendResult } from './emailProvider.interface';
import { logger } from '../../../lib/logger';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export const resendProvider: EmailProvider = {
  name: 'resend',
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is not set');

    // Resend accepts arrays for to/cc/bcc; we normalise to arrays so a
    // single comma-separated string never sneaks through.
    const body: Record<string, unknown> = {
      from: input.from,
      to: [input.to],
      cc:  (input.cc  && input.cc.length  > 0) ? input.cc  : undefined,
      bcc: (input.bcc && input.bcc.length > 0) ? input.bcc : undefined,
      subject: input.subject,
      html: input.html,
      text: input.text,
    };
    // Resend forwards any keys we set on `headers` straight onto the
    // outbound message. Used by emails.service to ship
    // List-Unsubscribe + List-Unsubscribe-Post (RFC 8058 one-click).
    if (input.headers && Object.keys(input.headers).length > 0) {
      body.headers = input.headers;
    }

    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // Resend errors look like { name, message, statusCode }. Forward
      // the message so the caller's catch block can log something useful
      // (and so crm_email_logs.error reads like English instead of "500").
      let detail = '';
      try {
        const j = await res.json();
        detail = (j as { message?: string }).message || JSON.stringify(j);
      } catch { /* response wasn't JSON */ }
      const msg = `resend send failed [${res.status}]: ${detail || res.statusText}`;
      logger.warn(`[resend] ${msg}`);
      throw new Error(msg);
    }

    const json = (await res.json()) as { id?: string };
    return { message_id: json.id };
  },
};
