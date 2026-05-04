/**
 * EmailProvider interface — vendor-agnostic. Concrete providers
 * (SendGrid, Resend, SES, Mailgun) implement this and are selected via
 * EMAIL_PROVIDER env. Stub provider ships by default.
 */
export interface EmailSendInput {
  from: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  text?: string;
}

export interface EmailSendResult {
  message_id?: string;
}

export interface EmailProvider {
  name: string;
  send(input: EmailSendInput): Promise<EmailSendResult>;
  verifyWebhookSignature?(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): boolean;
  parseInbound?(rawBody: unknown): Promise<{ from: string; to: string; subject: string; text?: string; html?: string } | null>;
}
