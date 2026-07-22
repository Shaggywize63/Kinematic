// OAuth scope catalogue — the bridge between what a user consents to and the
// RBAC modules the backend already enforces. A granted scope NEVER widens a
// user's real permissions: every MCP tool still runs through requireModuleAccess
// (role permissions) + readOnlyGuard (is_read_only) + org/client scoping. The
// effective capability is the INTERSECTION of (granted scope ∩ user's role).

export type OAuthScope =
  | 'crm:read'
  | 'leads:write'
  | 'deals:write'
  | 'activities:write'
  | 'contacts:write';

interface ScopeDef {
  /** Human-readable line shown on the consent screen. */
  label: string;
  /** CRM modules this scope lets the assistant READ (GET). */
  readModules?: string[];
  /** CRM modules this scope lets the assistant WRITE (POST/PATCH). */
  writeModules?: string[];
}

export const OAUTH_SCOPES: Record<OAuthScope, ScopeDef> = {
  'crm:read': {
    label: 'Read your CRM data — leads, deals, contacts, accounts, activities',
    readModules: ['crm_leads', 'crm_deals', 'crm_contacts', 'crm_accounts', 'crm_activities', 'crm_tasks'],
  },
  'leads:write': {
    label: 'Create and update leads (name, status, owner, next action)',
    writeModules: ['crm_leads'],
  },
  'deals:write': {
    label: 'Update deals and move pipeline stages',
    writeModules: ['crm_deals'],
  },
  'activities:write': {
    label: 'Log activities and notes',
    writeModules: ['crm_activities'],
  },
  'contacts:write': {
    label: 'Create and update contacts',
    writeModules: ['crm_contacts'],
  },
};

export const ALL_SCOPES = Object.keys(OAUTH_SCOPES) as OAuthScope[];

export function isValidScope(s: string): s is OAuthScope {
  return Object.prototype.hasOwnProperty.call(OAUTH_SCOPES, s);
}

/** Parse a space/comma-delimited scope string, dropping anything unknown. */
export function parseScopes(raw?: string | null): OAuthScope[] {
  if (!raw) return [];
  const seen = new Set<OAuthScope>();
  for (const part of raw.split(/[\s,]+/)) {
    if (part && isValidScope(part)) seen.add(part);
  }
  return Array.from(seen);
}

export function scopeLabels(scopes: OAuthScope[]): string[] {
  return scopes.map((s) => OAUTH_SCOPES[s].label);
}

/** The module a WRITE to `entity` requires, keyed by the scope that permits it. */
export function writeScopeForEntity(entity: 'lead' | 'deal' | 'activity' | 'contact'): OAuthScope {
  switch (entity) {
    case 'lead': return 'leads:write';
    case 'deal': return 'deals:write';
    case 'activity': return 'activities:write';
    case 'contact': return 'contacts:write';
  }
}

/** True if the granted scope set permits reading CRM data at all. */
export function grantsRead(scopes: OAuthScope[]): boolean {
  return scopes.some((s) => (OAUTH_SCOPES[s].readModules?.length ?? 0) > 0);
}
