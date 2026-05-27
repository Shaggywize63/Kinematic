/**
 * Salesforce provider — webhook-mode.
 *
 * Salesforce admins wire a Flow → HTTP Callout (or the older
 * Outbound Message + workflow) to POST a JSON body to our webhook
 * URL whenever a Lead is created / updated. JSON-shape Outbound
 * Messages tend to use Salesforce's standard field names
 * (FirstName, LastName, Email, Phone, Company…) so we map those
 * verbatim before delegating to genericWebhook for the rest.
 */
import type { Request } from 'express';
import type { IntegrationProvider, IntegrationRow, NormalizedLead } from './types';
import { genericWebhookProvider } from './genericWebhook';

const SALESFORCE_FIELD_MAP: Record<string, string> = {
  'FirstName':       'first_name',
  'LastName':        'last_name',
  'Email':           'email',
  'Phone':           'phone',
  'MobilePhone':     'phone',
  'Company':         'company',
  'AccountName':     'company',
  'Title':           'title',
  'Industry':        'industry',
  'City':            'city',
  'State':           'state',
  'Country':         'country',
  'LeadSource':      'utm_source',
  'Description':     'notes',
};

export const salesforceProvider: IntegrationProvider = {
  id: 'salesforce',

  async verifyWebhook(req: Request, integration: IntegrationRow): Promise<boolean> {
    return genericWebhookProvider.verifyWebhook!(req, integration);
  },

  normalize(raw: unknown, integration: IntegrationRow): NormalizedLead {
    const augmented = {
      ...integration,
      config: {
        ...(integration.config || {}),
        field_map: {
          ...SALESFORCE_FIELD_MAP,
          ...((integration.config?.field_map as Record<string, string> | undefined) || {}),
        },
      },
    };
    const out = genericWebhookProvider.normalize(raw, augmented) as NormalizedLead | NormalizedLead[];
    return Array.isArray(out) ? out[0] : out;
  },
};
