/**
 * Google Contacts → CRM leads sync. Reuses the per-user Google OAuth already
 * wired for Calendar (googleCalendar.service): once a rep connects Google (with
 * the contacts.readonly scope), we page their address book via the People API
 * and upsert each contact that has an email as a lead — through the same
 * findOrCreateLead dedup orchestrator the CSV import uses, so no duplicates.
 *
 * Purpose: populate the directory so email campaigns can target real contacts.
 * The contacts.readonly scope is a Google "sensitive" scope — the OAuth app must
 * be verified (or the user added as a test user) for this to work in production.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { getAccess } from '../integrations/googleCalendar.service';
import { findOrCreateLead, type NormalizedLead } from './integrations/dedup.orchestrator';

const PEOPLE_CONNECTIONS = 'https://people.googleapis.com/v1/people/me/connections';
const MAX_CONTACTS = 5000;             // safety cap per sync
const PAGE_SIZE = 500;
const SOURCE_NAME = 'Google Contacts';

export interface Scope { orgId: string; clientId: string | null; userId?: string | null; }

const hasContactsScope = (scopes: string) => /(?:^|\s|\/)contacts(?:\.readonly)?(?:\s|$)/.test(scopes) || scopes.includes('/auth/contacts');

/** Connection status for the "Connect Google" button: connected? which email?
 *  and did they grant the Contacts scope (vs only calendar from an old connect)? */
export async function getConnectionStatus(userId?: string | null) {
  if (!userId) return { connected: false, has_contacts_scope: false };
  try {
    const acc = await getAccess(userId);
    if (!acc) return { connected: false, has_contacts_scope: false };
    return { connected: true, email: acc.email, has_contacts_scope: hasContactsScope(acc.scopes || '') };
  } catch (e) {
    logger.warn(`[google-contacts] status failed: ${(e as Error).message}`);
    return { connected: false, has_contacts_scope: false };
  }
}

async function getOrCreateSource(orgId: string, clientId: string | null, userId: string | null): Promise<string> {
  let q = supabaseAdmin.from('crm_lead_sources').select('id').eq('org_id', orgId).eq('name', SOURCE_NAME);
  q = clientId ? q.eq('client_id', clientId) : q.is('client_id', null);
  const { data: existing } = await q.maybeSingle();
  if (existing?.id) return existing.id as string;
  const { data: created, error } = await supabaseAdmin.from('crm_lead_sources')
    .insert({ org_id: orgId, name: SOURCE_NAME, created_by: userId, client_id: clientId })
    .select('id').single();
  if (created?.id) return created.id as string;
  // Lost a race / unique clash — re-fetch.
  let again = supabaseAdmin.from('crm_lead_sources').select('id').eq('org_id', orgId).eq('name', SOURCE_NAME);
  again = clientId ? again.eq('client_id', clientId) : again.is('client_id', null);
  const { data: row } = await again.maybeSingle();
  if (row?.id) return row.id as string;
  throw new AppError(500, `Could not create the "${SOURCE_NAME}" lead source: ${error?.message ?? 'unknown'}`, 'DB_ERROR');
}

/** Pull the user's Google contacts and upsert them as leads. */
export async function syncContacts(scope: Scope): Promise<{ imported: number; merged: number; skipped: number; total: number }> {
  if (!scope.userId) throw new AppError(400, 'No user context', 'BAD_REQUEST');
  const acc = await getAccess(scope.userId);
  if (!acc) throw new AppError(400, 'Connect your Google account first, then import.', 'NOT_CONNECTED');
  if (!hasContactsScope(acc.scopes || '')) {
    throw new AppError(400, 'Reconnect Google and grant the Contacts permission to import your address book.', 'MISSING_SCOPE');
  }

  const source_id = await getOrCreateSource(scope.orgId, scope.clientId, scope.userId ?? null);
  let pageToken = '';
  let imported = 0, merged = 0, skipped = 0, total = 0;

  do {
    const url = new URL(PEOPLE_CONNECTIONS);
    url.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers');
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    url.searchParams.set('sortOrder', 'LAST_MODIFIED_DESCENDING');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${acc.token}` } });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      if (r.status === 403) throw new AppError(403, 'Google denied Contacts access. Reconnect and grant the Contacts permission.', 'GOOGLE_FORBIDDEN');
      throw new AppError(502, `Google People API error (${r.status}): ${text.slice(0, 200)}`, 'GOOGLE_ERROR');
    }
    const j = await r.json() as {
      connections?: Array<{
        names?: Array<{ givenName?: string; familyName?: string }>;
        emailAddresses?: Array<{ value?: string }>;
        phoneNumbers?: Array<{ value?: string }>;
      }>;
      nextPageToken?: string;
    };

    for (const p of j.connections || []) {
      if (total >= MAX_CONTACTS) break;
      total++;
      const email = (p.emailAddresses?.[0]?.value || '').trim();
      if (!email || !email.includes('@')) { skipped++; continue; }
      const nm = p.names?.[0] || {};
      const normalized: NormalizedLead = {
        first_name: nm.givenName?.trim() || null,
        last_name: nm.familyName?.trim() || null,
        email,
        phone: (p.phoneNumbers?.[0]?.value || '').trim() || null,
      };
      try {
        const res = await findOrCreateLead({
          org_id: scope.orgId, source_id, normalized,
          owner_id: null, integration_id: null, raw_event_id: null,
          user_id: scope.userId ?? null, client_id: scope.clientId ?? undefined,
        });
        if (res.was_new) imported++; else merged++;
      } catch (e) {
        skipped++;
        logger.warn(`[google-contacts] upsert failed for ${email}: ${(e as Error).message}`);
      }
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken && total < MAX_CONTACTS);

  return { imported, merged, skipped, total };
}
