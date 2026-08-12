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
import { getAccess, getStoredAccess } from '../integrations/googleCalendar.service';
import { findOrCreateLead, type NormalizedLead } from './integrations/dedup.orchestrator';

const PEOPLE_CONNECTIONS = 'https://people.googleapis.com/v1/people/me/connections';
// "Other contacts" = addresses Google auto-collected from the user's mail (i.e.
// everyone they've emailed). This is where the bulk of a real address book lives
// when the user hasn't manually SAVED contacts; it needs its own scope.
const OTHER_CONTACTS = 'https://people.googleapis.com/v1/otherContacts';
const MAX_CONTACTS = 5000;             // safety cap per sync
const PAGE_SIZE = 500;
const SOURCE_NAME = 'Google Contacts';

export interface Scope { orgId: string; clientId: string | null; userId?: string | null; }

interface GPerson {
  names?: Array<{ givenName?: string; familyName?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  phoneNumbers?: Array<{ value?: string }>;
}

// Manually-saved contacts scope (people/me/connections). Matches `contacts` or
// `contacts.readonly` but NOT `contacts.other.readonly`.
const hasSavedContactsScope = (scopes: string) => /\/auth\/contacts(?:\.readonly)?(?:\s|$)/.test(scopes);
// "Other contacts" scope (otherContacts — auto-collected from email). This is
// the one that actually surfaces "people I've emailed", so the Import button is
// gated on it: without it the import only ever sees manually-saved contacts.
const hasOtherContactsScope = (scopes: string) => scopes.includes('/auth/contacts.other');

/** Connection status for the "Connect Google" button: connected? which email?
 *  and did they grant the Contacts scope (vs only calendar from an old connect)? */
export async function getConnectionStatus(userId?: string | null) {
  if (!userId) return { connected: false, has_contacts_scope: false };
  try {
    // Read the stored row directly (no token refresh) — a status poll must not
    // flip to "disconnected" just because the access token needs refreshing.
    const acc = await getStoredAccess(userId);
    if (!acc) return { connected: false, has_contacts_scope: false };
    // Gate the Import button on the "other contacts" scope — that's the grant
    // that actually surfaces the people the rep has emailed. A connection that
    // only has the older calendar/saved-contacts grant reports false here, so
    // the UI shows "Reconnect Google" and prompts the new permission.
    return { connected: true, email: acc.email, has_contacts_scope: hasOtherContactsScope(acc.scopes || '') };
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

/** Pull the user's Google contacts — both manually-saved contacts AND the
 *  "other contacts" Google auto-collects from their mail — and upsert each one
 *  with an email as a lead. Also seeds the Email Alerts saved-recipient book so
 *  imported people are one-click available in the compose picker too. */
export async function syncContacts(scope: Scope): Promise<{ imported: number; merged: number; skipped: number; total: number }> {
  if (!scope.userId) throw new AppError(400, 'No user context', 'BAD_REQUEST');
  const acc = await getAccess(scope.userId);
  if (!acc) throw new AppError(400, 'Connect your Google account first, then import.', 'NOT_CONNECTED');
  const canSaved = hasSavedContactsScope(acc.scopes || '');
  const canOther = hasOtherContactsScope(acc.scopes || '');
  if (!canSaved && !canOther) {
    throw new AppError(400, 'Reconnect Google and grant the Contacts permission to import your address book.', 'MISSING_SCOPE');
  }

  const source_id = await getOrCreateSource(scope.orgId, scope.clientId, scope.userId ?? null);
  const counters = { imported: 0, merged: 0, skipped: 0, total: 0 };
  const seen = new Set<string>();
  const importedEmails: string[] = [];

  const handlePerson = async (p: GPerson) => {
    if (counters.total >= MAX_CONTACTS) return;
    counters.total++;
    const email = (p.emailAddresses?.[0]?.value || '').trim().toLowerCase();
    if (!email || !email.includes('@')) { counters.skipped++; return; }
    if (seen.has(email)) return;          // dedupe across the two sources
    seen.add(email);
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
      if (res.was_new) counters.imported++; else counters.merged++;
      importedEmails.push(email);
    } catch (e) {
      counters.skipped++;
      logger.warn(`[google-contacts] upsert failed for ${email}: ${(e as Error).message}`);
    }
  };

  // 1. Manually-saved contacts (people/me/connections).
  if (canSaved) {
    await pageContacts(PEOPLE_CONNECTIONS, 'connections', 'personFields', acc.token, counters, handlePerson);
  }
  // 2. Auto-collected "other contacts" — where everyone the user has emailed
  //    lives. This is the source that fixes an otherwise-empty import.
  if (canOther) {
    await pageContacts(OTHER_CONTACTS, 'otherContacts', 'readMask', acc.token, counters, handlePerson);
  }

  // Seed the Email Alerts saved-recipient book with the imported addresses so
  // the compose picker fills with the same people. On-conflict-do-nothing keeps
  // real send stats (times_sent/last_sent_at) untouched; never fails the import.
  if (importedEmails.length > 0) {
    try {
      const rows = importedEmails.map((email) => ({ org_id: scope.orgId, client_id: scope.clientId ?? null, email }));
      await supabaseAdmin.from('crm_email_recipients').upsert(rows, { onConflict: 'org_id,email', ignoreDuplicates: true });
    } catch (e) {
      logger.warn(`[google-contacts] recipient seed failed: ${(e as Error).message}`);
    }
  }

  return counters;
}

/** Page one People API list endpoint, invoking `onPerson` for each entry.
 *  `arrayKey` is the response array field ('connections' | 'otherContacts');
 *  `fieldParam` is 'personFields' (connections) or 'readMask' (otherContacts) —
 *  both accept the same names,emailAddresses,phoneNumbers field set. */
async function pageContacts(
  baseUrl: string,
  arrayKey: 'connections' | 'otherContacts',
  fieldParam: 'personFields' | 'readMask',
  token: string,
  counters: { total: number },
  onPerson: (p: GPerson) => Promise<void>,
): Promise<void> {
  let pageToken = '';
  do {
    const url = new URL(baseUrl);
    url.searchParams.set(fieldParam, 'names,emailAddresses,phoneNumbers');
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (arrayKey === 'connections') url.searchParams.set('sortOrder', 'LAST_MODIFIED_DESCENDING');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      if (r.status === 403) throw new AppError(403, 'Google denied Contacts access. Reconnect and grant the Contacts permission.', 'GOOGLE_FORBIDDEN');
      throw new AppError(502, `Google People API error (${r.status}): ${text.slice(0, 200)}`, 'GOOGLE_ERROR');
    }
    const j = await r.json() as Record<string, unknown>;
    const people = (j[arrayKey] as GPerson[] | undefined) || [];
    for (const p of people) {
      if (counters.total >= MAX_CONTACTS) break;
      await onPerson(p);
    }
    pageToken = (j.nextPageToken as string) || '';
  } while (pageToken && counters.total < MAX_CONTACTS);
}
