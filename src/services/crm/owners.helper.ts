/**
 * Decorates CRM rows with owner_name / assigned_to_name by looking up the
 * referenced user(s) in the platform's users table. Does it in a single
 * IN(...) query so this is O(1) extra round-trip regardless of how many rows
 * came back from the primary query.
 *
 * Reason this exists: the legacy CRM list services (leads, deals, contacts,
 * accounts, activities) just do `select('*')` from their own table, so the
 * frontend gets `owner_id` UUIDs but no display names. The dashboard tables
 * render `row.owner_name`, so without this stamping reassigning a row appears
 * to "do nothing" — the new owner_id lands in the DB but the UI keeps showing
 * "Unassigned".
 */
import { supabaseAdmin } from '../../lib/supabase';

type Row = {
  owner_id?: string | null;
  assigned_to?: string | null;
  owner_name?: string | null;
  assigned_to_name?: string | null;
};

export async function stampOwnerNames<T extends Row>(rows: T[]): Promise<T[]> {
  if (!rows || rows.length === 0) return rows;
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.owner_id) ids.add(r.owner_id);
    if (r.assigned_to) ids.add(r.assigned_to);
  }
  if (ids.size === 0) return rows;
  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, name, email')
    .in('id', Array.from(ids));
  const nameById = new Map<string, string>();
  for (const u of users ?? []) {
    nameById.set((u as any).id, ((u as any).name as string) || ((u as any).email as string) || '');
  }
  return rows.map((r) => ({
    ...r,
    owner_name: r.owner_id ? (nameById.get(r.owner_id) ?? r.owner_name ?? null) : (r.owner_name ?? null),
    assigned_to_name: r.assigned_to ? (nameById.get(r.assigned_to) ?? r.assigned_to_name ?? null) : (r.assigned_to_name ?? null),
  }));
}

export async function stampOwnerName<T extends Row>(row: T | null | undefined): Promise<T | null> {
  if (!row) return row ?? null;
  const [decorated] = await stampOwnerNames([row]);
  return decorated;
}
