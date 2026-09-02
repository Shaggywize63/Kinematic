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
  /**
   * Optional extra RFC 5322 headers. Used to ship
   * `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058 one-click)
   * with every send so Gmail/Yahoo bulk-sender policy is satisfied.
   * Providers that don't surface arbitrary headers may ignore this.
   */
  headers?: Record<string, string>;
  /**
   * Optional file attachments. Each entry supplies either a `path`
   * (a URL the provider fetches — e.g. a signed Storage URL) or an
   * inline base64 `content`. Used to attach a generated proposal PDF.
   * Providers that don't support attachments may ignore this.
   */
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  /** A URL the provider will fetch and attach (mutually exclusive with content). */
  path?: string;
  /** Base64-encoded file contents (mutually exclusive with path). */
  content?: string;
  content_type?: string;
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
