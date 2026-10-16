/**
 * Rows for a new user's module permissions and city assignments.
 *
 * `user_module_permissions` and `user_city_assignments` have only (user_id, module_id | city_id)
 * with a primary key on the pair — no org_id column. Ids are trimmed, blanks dropped and
 * de-duplicated (a repeated id would violate the primary key and fail the whole insert).
 */
const ids = (v: unknown): string[] =>
  Array.isArray(v)
    ? Array.from(new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)))
    : [];

/**
 * The module list a NEW user starts with.
 *
 * Why this exists: the dashboard reads "no module list at all" as "everything the client is entitled to",
 * and a client's entitlement is its granted modules PLUS every always-on universal module (Settings, HR,
 * Leave, Warehouse, SKUs, Assets…). A user created under a client with neither a designation nor a module
 * list therefore saw that whole long menu, while the client's admin — whose list was mirrored from the
 * client's grants (client.controller syncClientUserModulePermissions) — saw only what was assigned.
 * Users created AFTER the client's modules were assigned never got that mirror.
 *
 * So, in order:
 *   1. modules the admin picked while creating the user always win;
 *   2. a hierarchy role (org_role_id) carries its own modules — leave it alone;
 *   3. otherwise start the user on the client's own granted modules, which is what the admin assigned;
 *   4. a user with no client, or a client with no grants (legacy), is left exactly as before.
 */
export function modulePermissionsForNewUser(
  explicit: unknown,
  opts: { hasOrgRole: boolean; clientGrants: readonly string[] },
): unknown {
  if (ids(explicit).length > 0) return explicit;
  if (opts.hasOrgRole) return explicit;
  return opts.clientGrants.length > 0 ? [...opts.clientGrants] : explicit;
}

export function userAccessRows(userId: string, permissions: unknown, assignedCities: unknown) {
  return {
    permissionRows: ids(permissions).map((module_id) => ({ user_id: userId, module_id })),
    cityRows: ids(assignedCities).map((city_id) => ({ user_id: userId, city_id })),
  };
}
