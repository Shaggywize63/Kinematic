/**
 * Zoho CRM provider — webhook-mode.
 *
 * Zoho's native "Workflow Rule → Webhook" can POST any module-record
 * change to an arbitrary URL with arbitrary JSON payload, so we don't
 * need OAuth + polling for the v1. The admin sets up a Lead-module
 * Workflow Rule with our integration's webhook URL and a JSON body
 * that uses Zoho's merge variables ${Leads.First_Name}, etc.
 *
 * The field aliases set up in genericWebhook already cover Zoho's
 * standard column names (First_Name, Last_Name, Email, Phone,
 * Company, Title, etc.) so normalize delegates to it.
 */
import type { Request } from 'express';
import type { IntegrationProvider, IntegrationRow, NormalizedLead } from './types';
import { genericWebhookProvider } from './genericWebhook';

const ZOHO_FIELD_MAP: Record<string, string> = {
  // Zoho's verbatim column names → our canonical keys.
  'First_Name':   'first_name',
  'Last_Name':    'last_name',
  'Email':        'email',
  'Phone':        'phone',
  'Mobile':       'phone',
  'Company':      'company',
  'Account_Name': 'company',
  'Title':        'title',
  'Designation':  'title',
  'Industry':     'industry',
  'City':         'city',
  'State':        'state',
  'Country':      'country',
  'Lead_Source':  'utm_source',
  'Description':  'notes',
};

export const zohoProvider: IntegrationProvider = {
  id: 'zoho',

  async verifyWebhook(req: Request, integration: IntegrationRow): Promise<boolean> {
    // Same shared-secret model as the generic webhook — the URL the
    // admin pasted into Zoho carries `?key=<secret>`.
    return genericWebhookProvider.verifyWebhook!(req, integration);
  },

  normalize(raw: unknown, integration: IntegrationRow): NormalizedLead {
    // Bake the Zoho field map into a synthetic integration config so the
    // generic-webhook normalizer applies it on top of its own conventions.
    const augmented = {
      ...integration,
      config: {
        ...(integration.config || {}),
        field_map: {
          ...ZOHO_FIELD_MAP,
          ...((integration.config?.field_map as Record<string, string> | undefined) || {}),
        },
      },
    };
    // genericWebhook.normalize is synchronous — narrow the union.
    const out = genericWebhookProvider.normalize(raw, augmented) as NormalizedLead | NormalizedLead[];
    return Array.isArray(out) ? out[0] : out;
  },
};
