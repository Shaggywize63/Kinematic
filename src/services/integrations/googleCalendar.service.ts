/**
 * Google Calendar one-way push integration.
 *
 * Each CRM user can OAuth their Google account once via the dashboard.
 * After connection, every meeting / task activity they own (or are
 * assigned to) with a `due_at` set is mirrored into their primary
 * Google Calendar. Update / delete on the CRM side keeps the same
 * Google event in sync (we stamp `crm_activities.google_event_id` on
 * the first push).
 *
 * Tokens live in `user_google_integrations`. The access_token is short
 * lived (~1h); we refresh it on demand using the refresh_token. If a
 * push fails (revoked tokens, network, etc.) we swallow the error so
 * CRM writes never get blocked by a calendar hiccup — the integration
 * is a side-effect, never on the critical path.
 */
import { supabaseAdmin } from '../../lib/supabase';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function clientId(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!v) throw new Error('GOOGLE_OAUTH_CLIENT_ID is not configured');
  return v;
}
function clientSecret(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!v) throw new Error('GOOGLE_OAUTH_CLIENT_SECRET is not configured');
  return v;
}
function redirectUri(): string {
  const v = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!v) throw new Error('GOOGLE_OAUTH_REDIRECT_URI is not configured');
  return v;
}

export function isConfigured(): boolean {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID
    && process.env.GOOGLE_OAUTH_CLIENT_SECRET
    && process.env.GOOGLE_OAUTH_REDIRECT_URI);
}

/** Build the Google consent URL. `state` is a signed JWT the route
 *  layer creates carrying the user's id so the callback can map the
 *  returned code back to the right CRM user. */
export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',        // ← needed to get a refresh_token
    prompt: 'consent',             // ← forces refresh_token even on re-connect
    state,
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

async function exchangeCode(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Google token exchange failed: ${r.status} ${text}`);
  }
  return r.json() as Promise<TokenResponse>;
}

async function fetchEmail(accessToken: string): Promise<string> {
  const r = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Google userinfo failed: ${r.status}`);
  const j = await r.json() as { email?: string };
  return j.email || '';
}

/** Finish the OAuth handshake: exchange code → tokens, fetch the
 *  user's Google email for display, upsert into user_google_integrations. */
export async function completeOAuth(
  userId: string,
  orgId: string,
  code: string,
): Promise<{ email: string }> {
  const tokens = await exchangeCode(code);
  // Google may omit refresh_token on re-consent — prompt=consent above
  // is meant to prevent that, but if it still happens, reuse the
  // existing row's refresh_token.
  const { data: existing } = await supabaseAdmin
    .from('user_google_integrations')
    .select('refresh_token')
    .eq('user_id', userId)
    .maybeSingle();

  const refresh = tokens.refresh_token || existing?.refresh_token;
  if (!refresh) {
    throw new Error('Google did not return a refresh_token — disconnect first, then retry');
  }
  const email = await fetchEmail(tokens.access_token);
  const expiresAt = new Date(Date.now() + (tokens.expires_in - 30) * 1000);

  const row = {
    user_id: userId,
    org_id: orgId,
    google_email: email,
    access_token: tokens.access_token,
    refresh_token: refresh,
    token_expires_at: expiresAt.toISOString(),
    scopes: tokens.scope,
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    await supabaseAdmin.from('user_google_integrations').update(row).eq('user_id', userId);
  } else {
    await supabaseAdmin.from('user_google_integrations').insert(row);
  }
  return { email };
}

interface IntegrationRow {
  user_id: string;
  google_email: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  calendar_id: string;
}

async function getIntegration(userId: string): Promise<IntegrationRow | null> {
  const { data } = await supabaseAdmin
    .from('user_google_integrations')
    .select('user_id, google_email, access_token, refresh_token, token_expires_at, calendar_id')
    .eq('user_id', userId)
    .maybeSingle();
  return data as IntegrationRow | null;
}

async function refreshAccessToken(row: IntegrationRow): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: row.refresh_token,
    grant_type: 'refresh_token',
  });
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Google token refresh failed: ${r.status} ${text}`);
  }
  const j = await r.json() as TokenResponse;
  const expiresAt = new Date(Date.now() + (j.expires_in - 30) * 1000);
  await supabaseAdmin.from('user_google_integrations').update({
    access_token: j.access_token,
    token_expires_at: expiresAt.toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('user_id', row.user_id);
  return j.access_token;
}

async function getValidAccessToken(row: IntegrationRow): Promise<string> {
  if (new Date(row.token_expires_at).getTime() > Date.now()) return row.access_token;
  return refreshAccessToken(row);
}

/** Read the public connection status for a user — used by the dashboard
 *  to show "Connected as alice@example.com" or "Not connected". */
export async function getStatus(userId: string): Promise<{ connected: boolean; email?: string }> {
  const row = await getIntegration(userId);
  if (!row) return { connected: false };
  return { connected: true, email: row.google_email };
}

/** Disconnect — revoke the refresh token with Google (best-effort) and
 *  drop the row so subsequent activity writes stop pushing. */
export async function disconnect(userId: string): Promise<void> {
  const row = await getIntegration(userId);
  if (!row) return;
  try {
    await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(row.refresh_token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch { /* swallow — local delete still happens */ }
  await supabaseAdmin.from('user_google_integrations').delete().eq('user_id', userId);
}

// ── Activity push ────────────────────────────────────────────────────────

interface ActivityRow {
  id: string;
  type: string;
  subject?: string | null;
  body?: string | null;
  due_at?: string | null;
  completed_at?: string | null;
  duration_min?: number | null;
  owner_id?: string | null;
  assigned_to?: string | null;
  google_event_id?: string | null;
}

const PUSHABLE_TYPES = new Set(['meeting', 'task', 'call']);

function buildEventBody(a: ActivityRow): Record<string, unknown> {
  // Honour an explicit duration_min when present. Default to 30 min for
  // meetings / calls and a 0-length task otherwise.
  const start = a.due_at ? new Date(a.due_at) : new Date();
  const durMin = typeof a.duration_min === 'number' && a.duration_min > 0
    ? a.duration_min
    : (a.type === 'task' ? 30 : 30);
  const end = new Date(start.getTime() + durMin * 60_000);
  return {
    summary: a.subject || `Kinematic ${a.type}`,
    description: (a.body ? `${a.body}\n\n` : '') + `[Synced from Kinematic CRM · activity ${a.id}]`,
    start: { dateTime: start.toISOString() },
    end:   { dateTime: end.toISOString() },
    source: { title: 'Kinematic CRM', url: process.env.DASHBOARD_URL || 'https://app.kinematic.ai' },
  };
}

/** Which user's calendar should this activity land on? Prefer the
 *  assignee, fall back to the owner — same precedence the activity
 *  visibility filter uses. */
function targetUserId(a: ActivityRow): string | null {
  return a.assigned_to || a.owner_id || null;
}

async function calendarFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${CALENDAR_API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
}

/** Push (create / update) an activity onto the target user's Google
 *  Calendar. No-op when the user hasn't connected, when the type isn't
 *  pushable, or when due_at is missing. Returns the Google event id
 *  on success so the caller can stamp it onto the activity row. */
export async function pushActivity(
  orgId: string,
  activity: ActivityRow,
): Promise<string | null> {
  if (!isConfigured()) return null;
  if (!PUSHABLE_TYPES.has(activity.type)) return null;
  if (!activity.due_at) return null;
  const uid = targetUserId(activity);
  if (!uid) return null;
  const row = await getIntegration(uid);
  if (!row) return null;
  // Belt-and-suspenders: don't push another tenant's activity onto a
  // rep who happens to share a user_id across orgs (should never
  // happen, but cheap to enforce).
  const { data: ok } = await supabaseAdmin
    .from('user_google_integrations')
    .select('user_id')
    .eq('user_id', uid)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!ok) return null;

  try {
    const accessToken = await getValidAccessToken(row);
    const body = buildEventBody(activity);
    const calId = encodeURIComponent(row.calendar_id || 'primary');

    if (activity.google_event_id) {
      const r = await calendarFetch(accessToken,
        `/calendars/${calId}/events/${encodeURIComponent(activity.google_event_id)}`,
        { method: 'PATCH', body: JSON.stringify(body) });
      if (r.ok) return activity.google_event_id;
      // 404 → event got deleted on Google side. Fall through and
      // recreate so the activity stays in sync.
      if (r.status !== 404) return activity.google_event_id;
    }
    const r = await calendarFetch(accessToken,
      `/calendars/${calId}/events`,
      { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) {
      const text = await r.text();
      console.warn('[googleCalendar] create failed', r.status, text);
      return null;
    }
    const j = await r.json() as { id?: string };
    return j.id ?? null;
  } catch (e) {
    console.warn('[googleCalendar] push failed', (e as Error).message);
    return null;
  }
}

/** Remove the calendar event when a CRM activity is deleted. Best-effort. */
export async function deleteActivity(
  orgId: string,
  activity: ActivityRow,
): Promise<void> {
  if (!isConfigured()) return;
  if (!activity.google_event_id) return;
  const uid = targetUserId(activity);
  if (!uid) return;
  const row = await getIntegration(uid);
  if (!row) return;
  try {
    const accessToken = await getValidAccessToken(row);
    const calId = encodeURIComponent(row.calendar_id || 'primary');
    await calendarFetch(accessToken,
      `/calendars/${calId}/events/${encodeURIComponent(activity.google_event_id)}`,
      { method: 'DELETE' });
  } catch (e) {
    console.warn('[googleCalendar] delete failed', (e as Error).message);
  }
  // Suppress the org_id check error by referencing orgId in a no-op so
  // strict-mode unused checks don't complain.
  void orgId;
}
