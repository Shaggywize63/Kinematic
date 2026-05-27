/**
 * IntegrationProvider — the shape every lead-source provider implements.
 *
 * Webhook providers implement `verifyWebhook` + `normalize`.
 * Pull providers implement `normalize` + `syncIncremental` (the latter
 * is called by the periodic cron edge function).
 *
 * Keep providers pure: no DB writes here. The orchestrator owns
 * persistence (event log, dedup, attribution). Providers only:
 *   1. Verify the request is legitimate.
 *   2. Translate provider-specific shapes into NormalizedLead.
 */
import type { Request } from 'express';
import type { NormalizedLead } from '../dedup.orchestrator';
export type { NormalizedLead };

export type ProviderId = 'web_form' | 'generic_webhook' | 'meta_lead_ads' | 'google_ads' | 'zoho' | 'salesforce';

export interface IntegrationRow {
  id: string;
  org_id: string;
  provider: ProviderId;
  label: string;
  source_id: string | null;
  status: 'pending' | 'active' | 'error' | 'disabled';
  config: Record<string, unknown>;
  webhook_secret: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  last_event_count: number;
}

export interface IntegrationProvider {
  id: ProviderId;

  /** Inbound providers — confirm the request came from the real source. */
  verifyWebhook?(req: Request, integration: IntegrationRow): Promise<boolean>;

  /**
   * Map a provider payload (or one row from a paged pull) to a
   * NormalizedLead. May be sync OR async — Meta's normalize fetches the
   * lead's actual field_data from the Graph API using the leadgen_id
   * delivered in the webhook, so its implementation has to be async.
   */
  normalize(
    raw: unknown,
    integration: IntegrationRow,
  ): NormalizedLead | NormalizedLead[] | Promise<NormalizedLead | NormalizedLead[]>;

  /** Pull providers only — fetch leads modified since `since`. */
  syncIncremental?(integration: IntegrationRow, since: Date | null): Promise<NormalizedLead[]>;
}
