/**
 * Stub email provider — no-ops the actual SMTP/HTTP send and returns
 * a synthetic message id. crm_email_logs still records the message.
 */
import crypto from 'crypto';
import type { EmailProvider, EmailSendInput, EmailSendResult } from './emailProvider.interface';

export const stubProvider: EmailProvider = {
  name: 'stub',
  async send(_input: EmailSendInput): Promise<EmailSendResult> {
    return { message_id: `stub-${crypto.randomUUID()}` };
  },
};
