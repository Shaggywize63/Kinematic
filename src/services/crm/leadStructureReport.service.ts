/**
 * Lead-structure reporting (Spark & Ray). Answers "how many leads from Tata Steel
 * Limited?", "how many for MAC?", "how many units of PV12 quoted?" by rolling the
 * structured lead fields up along each dimension of the chain:
 *
 *   Group → Company → Plant → Make → Product
 *
 * Every dimension is a real column (group = account.parent_account_id, plant =
 * crm_leads.site_id, make/product = crm_lead_product_lines), so the counts are
 * exact. Optional filters drill in (e.g. group_id + make_id). Tenant-scoped by
 * (org_id, client_id) exactly like the rest of the B2B capture.
 */
import { supabaseAdmin } from '../../lib/supabase';

export interface ReportCtx { org_id: string; client_id: string | null; }

export interface ReportFilters {
  group_id?: string | null;
  account_id?: string | null;
  site_id?: string | null;
  make_id?: string | null;
  product_id?: string | null;
}

export interface CountRow { id: string | null; name: string; lead_count: number; qty_total?: number; }
export interface LeadStructureReport {
  total_leads: number;
  by_group: CountRow[];
  by_company: CountRow[];
  by_plant: CountRow[];
  by_make: CountRow[];
  by_product: CountRow[];
}

type LeadRow = { id: string; account_id: string | null; site_id: string | null };
type LineRow = { lead_id: string; make_id: string | null; make_name: string | null; product_id: string | null; product_name: string | null; qty: number | null };

const UNASSIGNED = '__none__';
const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** Fetch rows for a set of ids via chunked `.in()` (PostgREST caps list length). */
async function fetchByIds<T>(table: string, orgId: string, idCol: string, ids: string[], select: string): Promise<T[]> {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (uniq.length === 0) return [];
  const out: T[] = [];
  for (const part of chunk(uniq, 200)) {
    const { data } = await supabaseAdmin.from(table).select(select).eq('org_id', orgId).in(idCol, part);
    if (data) out.push(...(data as T[]));
  }
  return out;
}

/** Descending by lead_count, then name; caps the list so a dimension can't explode. */
function rank(map: Map<string, CountRow>): CountRow[] {
  return Array.from(map.values())
    .sort((a, b) => b.lead_count - a.lead_count || a.name.localeCompare(b.name))
    .slice(0, 200);
}

export interface ReportInput {
  leads: LeadRow[];
  accounts: Array<{ id: string; name: string | null; parent_account_id: string | null }>;
  groups: Array<{ id: string; name: string | null }>;
  sites: Array<{ id: string; name: string | null }>;
  lines: LineRow[];
}

export async function leadStructureReport(ctx: ReportCtx, filters: ReportFilters = {}): Promise<LeadStructureReport> {
  // 1. The tenant's leads (bounded; the structured report is per-client).
  let leadQ = supabaseAdmin.from('crm_leads').select('id, account_id, site_id')
    .eq('org_id', ctx.org_id).is('deleted_at', null);
  if (ctx.client_id) leadQ = leadQ.eq('client_id', ctx.client_id);
  if (filters.account_id) leadQ = leadQ.eq('account_id', filters.account_id);
  if (filters.site_id) leadQ = leadQ.eq('site_id', filters.site_id);
  const { data: leadData } = await leadQ.limit(5000);
  const leads = (leadData as LeadRow[]) ?? [];

  // 2. Accounts (for company + group names) and the parent-group names.
  const accounts = await fetchByIds<{ id: string; name: string | null; parent_account_id: string | null }>(
    'crm_accounts', ctx.org_id, 'id', leads.map((l) => l.account_id).filter((x): x is string => !!x),
    'id, name, parent_account_id');
  const groups = await fetchByIds<{ id: string; name: string | null }>(
    'crm_accounts', ctx.org_id, 'id', accounts.map((a) => a.parent_account_id).filter((x): x is string => !!x),
    'id, name');

  // 3. Sites (plant names).
  const sites = await fetchByIds<{ id: string; name: string | null }>(
    'crm_sites', ctx.org_id, 'id', leads.map((l) => l.site_id).filter((x): x is string => !!x), 'id, name');

  // 4. Product lines for these leads (make / product rollups).
  const lines: LineRow[] = [];
  for (const part of chunk(leads.map((l) => l.id), 200)) {
    const { data } = await supabaseAdmin.from('crm_lead_product_lines')
      .select('lead_id, make_id, make_name, product_id, product_name, qty')
      .eq('org_id', ctx.org_id).in('lead_id', part).is('deleted_at', null);
    if (data) lines.push(...(data as LineRow[]));
  }

  return computeLeadStructureReport({ leads, accounts, groups, sites, lines }, filters);
}

/** The pure roll-up: given the fetched rows and filters, compute the breakdowns. */
export function computeLeadStructureReport(input: ReportInput, filters: ReportFilters = {}): LeadStructureReport {
  const accById = new Map(input.accounts.map((a) => [a.id, a]));
  const groupNameById = new Map(input.groups.map((g) => [g.id, g.name ?? '']));
  const siteNameById = new Map(input.sites.map((s) => [s.id, s.name ?? '']));
  let leads = input.leads;
  let lines = input.lines;

  // group_id filter: keep leads whose account maps up to that group.
  if (filters.group_id) {
    leads = leads.filter((l) => l.account_id && accById.get(l.account_id)?.parent_account_id === filters.group_id);
  }
  // make_id / product_id filter: restrict leads (and the lines rolled up) to the
  // leads that carry a line for that make / product.
  if (filters.make_id || filters.product_id) {
    const keep = new Set(lines
      .filter((l) => (!filters.make_id || l.make_id === filters.make_id) && (!filters.product_id || l.product_id === filters.product_id))
      .map((l) => l.lead_id));
    leads = leads.filter((l) => keep.has(l.id));
    const leadSet = new Set(leads.map((l) => l.id));
    lines = lines.filter((l) => leadSet.has(l.lead_id));
  }

  // 5. Roll up each dimension.
  const byCompany = new Map<string, CountRow>();
  const byGroup = new Map<string, CountRow>();
  const byPlant = new Map<string, CountRow>();
  const bump = (map: Map<string, CountRow>, id: string | null, name: string) => {
    const key = id ?? UNASSIGNED;
    const row = map.get(key) ?? { id: id ?? null, name, lead_count: 0 };
    row.lead_count += 1;
    map.set(key, row);
  };
  for (const l of leads) {
    const acc = l.account_id ? accById.get(l.account_id) : null;
    bump(byCompany, l.account_id, acc?.name || 'Unassigned');
    const gId = acc?.parent_account_id ?? null;
    bump(byGroup, gId, gId ? (groupNameById.get(gId) || 'Group') : 'No group');
    bump(byPlant, l.site_id, l.site_id ? (siteNameById.get(l.site_id) || 'Plant') : 'No plant');
  }

  // Make / product: distinct leads + total quantity per make / product.
  const byMake = new Map<string, CountRow & { _leads: Set<string> }>();
  const byProduct = new Map<string, CountRow & { _leads: Set<string> }>();
  const bumpLine = (
    map: Map<string, CountRow & { _leads: Set<string> }>, id: string | null, name: string, leadId: string, qty: number | null,
  ) => {
    const key = id ?? (name || UNASSIGNED);
    const row = map.get(key) ?? { id: id ?? null, name: name || 'Unspecified', lead_count: 0, qty_total: 0, _leads: new Set<string>() };
    row._leads.add(leadId);
    row.lead_count = row._leads.size;
    row.qty_total = (row.qty_total ?? 0) + (Number(qty) || 0);
    map.set(key, row);
  };
  for (const ln of lines) {
    bumpLine(byMake, ln.make_id, ln.make_name || '', ln.lead_id, ln.qty);
    bumpLine(byProduct, ln.product_id, ln.product_name || '', ln.lead_id, ln.qty);
  }
  const stripLeads = (m: Map<string, CountRow & { _leads: Set<string> }>): Map<string, CountRow> =>
    new Map(Array.from(m.entries()).map(([k, v]) => [k, { id: v.id, name: v.name, lead_count: v.lead_count, qty_total: v.qty_total }]));

  return {
    total_leads: leads.length,
    by_group: rank(byGroup),
    by_company: rank(byCompany),
    by_plant: rank(byPlant),
    by_make: rank(stripLeads(byMake)),
    by_product: rank(stripLeads(byProduct)),
  };
}
