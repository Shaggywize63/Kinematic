// Multi-company selling: a user may be allowed several companies (clients). The
// app picks one per request with X-Client-Id; only a listed company is honoured,
// anything else leaves the user's own client untouched.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CompanyUser { client_id?: string | null; company_client_ids?: string[] }

export function pickCompany<T extends CompanyUser>(user: T, header: string | string[] | undefined): T {
  const allowed = Array.isArray(user?.company_client_ids) ? user.company_client_ids : [];
  if (allowed.length === 0) return user;
  const raw = Array.isArray(header) ? header[0] : header;
  const wanted = String(raw ?? '').trim().toLowerCase();
  if (!UUID_RE.test(wanted)) return user;
  const hit = allowed.find((c) => c.toLowerCase() === wanted);
  if (!hit || hit === user.client_id) return user;
  return { ...user, client_id: hit };
}
