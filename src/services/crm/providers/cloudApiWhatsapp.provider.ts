/**
 * Meta WhatsApp Cloud API provider. Built per-tenant from the org's
 * crm_whatsapp_connections row (see whatsappConnection.service). Covers the
 * "Direct Cloud API" and "connect an existing Cloud API WABA" options.
 */
import type { WhatsappProvider, WhatsappSendInput, WhatsappSendResult } from './whatsappProvider.interface';

export const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v20.0';

export interface CloudApiConfig {
  phoneNumberId: string;
  accessToken: string;
  name?: string;
}

export function makeCloudApiProvider(cfg: CloudApiConfig): WhatsappProvider {
  return {
    name: cfg.name || 'whatsapp_cloud',
    async send(input: WhatsappSendInput): Promise<WhatsappSendResult> {
      const to = input.to.replace(/[^\d]/g, ''); // Cloud API wants digits only, no '+'
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

      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cfg.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw providerError(json?.error?.message || `WhatsApp Cloud API HTTP ${res.status}`, res, json?.error?.code);
      return { message_id: json?.messages?.[0]?.id };
    },
  };
}

/**
 * Enrich a provider failure with the HTTP status, Meta error code, and any
 * Retry-After so the broadcast processor can classify transient (retry) vs
 * permanent (fail) and honour rate-limit backoff. Shared by the Cloud API + BSP
 * adapters.
 */
export interface ProviderError extends Error {
  httpStatus?: number;
  providerCode?: number;
  retryAfterSec?: number;
}
export function providerError(message: string, res: Response, code?: number): ProviderError {
  const err = new Error(message) as ProviderError;
  err.httpStatus = res.status;
  if (typeof code === 'number') err.providerCode = code;
  const ra = Number(res.headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) err.retryAfterSec = ra;
  return err;
}

/** Positional body variables ({{1}},{{2}}…) → a Cloud API BODY component. */
export function templateComponents(vars?: Record<string, string>): Record<string, unknown> {
  if (!vars) return {};
  const keys = Object.keys(vars).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
  if (!keys.length) return {};
  return { components: [{ type: 'body', parameters: keys.map((k) => ({ type: 'text', text: String(vars[k] ?? '') })) }] };
}
