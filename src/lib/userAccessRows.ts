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

export function userAccessRows(userId: string, permissions: unknown, assignedCities: unknown) {
  return {
    permissionRows: ids(permissions).map((module_id) => ({ user_id: userId, module_id })),
    cityRows: ids(assignedCities).map((city_id) => ({ user_id: userId, city_id })),
  };
}
