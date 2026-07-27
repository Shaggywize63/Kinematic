/**
 * Generic BSP (Business Solution Provider) WhatsApp adapter for Cloud-API-
 * compatible providers — e.g. 360dialog and any BSP that proxies the Meta
 * Cloud API JSON shape. Posts to `${baseUrl}/messages` with the API key.
 *
 * BSPs with a bespoke wire format (Gupshup form-encoded, Interakt / WATI custom
 * JSON) get their own adapter when a client selects them; this covers the
 * Cloud-API-compatible majority. Built per-tenant from crm_whatsapp_connections.
 */
import type { WhatsappProvider, WhatsappSendInput, WhatsappSendResult } from './whatsappProvider.interface';
import { templateComponents, providerError } from './cloudApiWhatsapp.provider';

export interface BspConfig {
  baseUrl: string;   // e.g. https://waba-v2.360dialog.io
  apiKey: string;
  name?: string;
}

export function makeBspProvider(cfg: BspConfig): WhatsappProvider {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  return {
    name: cfg.name || 'whatsapp_bsp',
    async send(input: WhatsappSendInput): Promise<WhatsappSendResult> {
      const to = input.to.replace(/[^\d]/g, '');
      const body: Record<string, unknown> = input.template_name
        ? {
            messaging_product: 'whatsapp', to, type: 'template',
            template: {
              name: input.template_name,
              language: { code: input.template_language || 'en' },
              ...templateComponents(input.template_variables),
            },
          }
        : { messaging_product: 'whatsapp', to, type: 'text', text: { body: input.body_text || '' } };

      const res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Send both common auth headers — bearer (most BSPs) and 360dialog's key header.
          Authorization: `Bearer ${cfg.apiKey}`,
          'D360-API-KEY': cfg.apiKey,
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw providerError(json?.error?.message || json?.message || `WhatsApp BSP HTTP ${res.status}`, res, json?.error?.code);
      return { message_id: json?.messages?.[0]?.id || json?.id || json?.messageId };
    },
  };
}
