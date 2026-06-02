import { Request } from 'express';
export type UserRole = 'super_admin' | 'admin' | 'main_admin' | 'sub_admin' | 'city_manager' | 'supervisor' | 'executive' | 'field_executive' | 'hr' | 'client';

export interface AuthUser {
  id: string;
  org_id: string;
  name: string;
  mobile: string;
  email: string;
  role: UserRole;
  zone_id?: string;
  supervisor_id?: string;
  fcm_token?: string;
  is_active: boolean;
  client_id?: string;             // client enterprise ID
  permissions?: string[];       // legacy per-user grants from user_module_permissions
  assigned_cities?: string[];    // IDs of assigned cities
  // City NAMES resolved from user_city_assignments → cities.name. Used by
  // city-scope enforcement because crm_leads.city / crm_contacts.city are
  // stored as text (names), not UUIDs.
  assigned_city_names?: string[];
  // Cities the user's hierarchy role permits, as NAMES (org_roles.assigned_cities
  // is a text[] of names). Treated as an upper cap — user-level can only
  // narrow within this list.
  org_role_id?: string;
  role_assigned_cities?: string[];
  // Per-designation data visibility. Drives activity scoping (see
  // activityVisibilityScope in crm.routes.ts). 'own' = user sees only
  // rows they own / are assigned to; 'team' = reserved for future
  // supervisor-of-direct-reports pattern (treated as 'all' today);
  // 'all' = visibility within the org/client tenant scope.
  org_role_data_scope?: 'own' | 'team' | 'all';
  // Granular module grants resolved from the user's org_role (org_roles.permissions
  // / permissions_write). These are the source of truth the Roles UI configures —
  // `permissions` above (user_module_permissions) is the legacy per-user fallback
  // used only when the user has no org_role attached. requireModuleAccess() reads
  // these to gate reads (GET) vs writes (POST/PATCH/DELETE) per module.
  role_permissions?: string[];
  role_permissions_write?: string[];
  enabled_modules?: string[];   // module IDs enabled for this user's client (entitlement)
  enabled_packages?: string[];  // package SKUs enabled for this user's client
  // Single-device login enforcement. Set by /auth/login on mobile platforms;
  // middleware compares X-Session-Id header against this. NULL = legacy or
  // dashboard session, enforcement is skipped.
  active_session_id?: string;
  active_session_device?: string;
}

export type AuthRequest = Request & {
  user?: AuthUser;
  accessToken?: string;
};

export type ApiResponse<T = unknown> = {
  success: true;
  data: T;
  message?: string;
} | {
  success: false;
  error: string;
  details?: unknown;
};

export interface PaginationQuery {
  page?: string;
  limit?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
