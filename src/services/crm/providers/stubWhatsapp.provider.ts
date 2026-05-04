/**
 * No-op WhatsApp provider. Returns a synthetic message id; the service
 * layer still records the message in crm_whatsapp_logs so the UI sees the
 * sent state. Replace by setting WHATSAPP_PROVIDER=meta|gupshup|... and
 * implementing the interface against the real API.
 */
import type { WhatsappProvider } from './whatsappProvider.interface';

export const stubWhatsappProvider: WhatsappProvider = {
  name: 'stub',
  async send() {
    return { message_id: `stub-wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  },
};
