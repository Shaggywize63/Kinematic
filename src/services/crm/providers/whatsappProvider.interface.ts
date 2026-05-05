/**
 * WhatsApp provider abstraction. Stub today; Meta WhatsApp Business API
 * (or 360dialog / Twilio / Gupshup) plugs in by implementing this interface
 * and swapping the import in whatsapp.service.ts.
 */
export interface WhatsappSendInput {
  to: string;
  body_text?: string;
  template_name?: string;
  template_language?: string;
  template_variables?: Record<string, string>;
  media_url?: string;
  media_type?: 'image' | 'document' | 'audio' | 'video' | 'sticker';
}

export interface WhatsappSendResult {
  message_id?: string;
}

export interface WhatsappProvider {
  name: string;
  send(input: WhatsappSendInput): Promise<WhatsappSendResult>;
}
