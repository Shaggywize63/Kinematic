// Business Report — a flexible directors' report over CRM deals in a date range,
// grouped by ONE dimension (engineer | industry | brand | product | account) and
// optionally narrowed by the others. Pure aggregation over tables that already
// exist — there is NO migration. Every optional source degrades to 0 / null / []
// on error so a missing column or table can never 500 the report.
//
// It is the deal-level sibling of the Engineer Scorecard and reuses its data-model
// decisions so the two reports reconcile:
//   - a deal is WON when `crm_deals.status = 'won'` OR its stage has
//     `stage_type = 'won'` (crm_deal_stages);
//   - order value = the deal line roll-up `sum(custom_fields.order_value)`, falling
//     back to the deal `amount`;
//   - quoted value = the deal `amount` over deals active in range;
//   - owner = `owner_id`, falling back to `assigned_to` (CLAUDE.md);
//   - brands = distinct `custom_fields.brand_name` on the deal's lines;
//   - UUIDs are validated before use; `resolveRange()` (IST calendar month default)
//     is shared verbatim with the scorecard.
//
// Gated on `isB2bClient(clientId)` exactly like the scorecard: a non-B2B tenant gets
// `null` back and the route answers "not available". All reads are org + strict-client
// scoped.
//
// Grouping model (deal-centric): the report aggregates the set of deals that are
// WON-in-range OR ACTIVE-in-range (identical classification to the scorecard). Each
// in-scope deal is mapped to one-or-more groups for the chosen dimension and its
// metrics are folded in:
//   - engineer / account / industry are 1:1 (a deal lands in exactly one group, so
//     the group rows sum back to the totals);
//   - brand / product FAN OUT: a deal with two brands contributes its WHOLE value to
//     both brand rows, so summing brand/product rows can exceed the deal total. The
//     `totals` are always computed independently at the deal level (deduped), so they
//     stay the true sum regardless of fan-out.
// A deal that carries no value for the grouping dimension (no owner / no account / no
// industry / no brand line / no product line) lands in an "Unspecified" bucket so
// nothing is lost and the non-fan-out rows still sum to the totals.
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { isB2bClient } from '../../lib/b2bClients';
import { chunk } from '../../lib/chunk';
import { resolveRange } from './engineerScorecard.service';
import { supervisorSubtreeIds } from '../supervisor-scope.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IST_MIN = 330;
const pad = (n: number) => String(n).padStart(2, '0');
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Claim statuses that count as committed spend — mirrors expenseRollup's `spent_amount`. */
const SPENT_STATUSES = ['submitted', 'approved', 'reimbursed'];

/** The "Unspecified" bucket key (a deal with no value for the grouping dimension). */
const UNSPECIFIED = '__unspecified__';

export type GroupBy = 'engineer' | 'industry' | 'brand' | 'product' | 'account';
const GROUP_BYS: readonly GroupBy[] = ['engineer', 'industry', 'brand', 'product', 'account'];

export type Scope = 'own' | 'supervised' | 'all';
const SCOPES: readonly Scope[] = ['own', 'supervised', 'all'];

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-31). */
function isRealDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** Parse a number out of a jsonb value (string or number); null for anything else / non-finite / < 0. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The IST calendar date (YYYY-MM-DD) of a timestamp string. */
function istDateOf(ts: unknown): string | null {
  if (typeof ts !== 'string' || !ts) return null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + IST_MIN * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Owner of a CRM row: owner_id, falling back to assigned_to (CLAUDE.md). Only valid UUIDs. */
function ownerOf(row: Row): string | null {
  const o = typeof row.owner_id === 'string' && UUID_RE.test(row.owner_id) ? row.owner_id : null;
  if (o) return o;
  const a = typeof row.assigned_to === 'string' && UUID_RE.test(row.assigned_to) ? row.assigned_to : null;
  return a;
}

/** A trimmed non-empty string, else null. */
function str(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
}

type Row = Record<string, any>;

export interface BusinessReportRow {
  /** The group id: user_id (engineer), account_id (account), product key (product),
   *  or the literal industry / brand value. `__unspecified__` for the catch-all bucket. */
  key: string;
  /** Display name for the group. */
  label: string;
  /** Distinct leads linked (via deal.lead_id) to this group's in-range deals. */
  leads_count: number;
  /** Count of won-in-range deals in this group (fans out for brand / product). */
  orders_won: number;
  /** Sum of quoted value (deal amount) over active-in-range deals in this group. */
  quoted_value: number;
  /** Sum of order value (line roll-up, amount fallback) over won-in-range deals in this group. */
  order_value: number;
  /** Distinct brands on this group's deals. */
  brands: string[];
  /** Committed expense spend attributable to this group's deals / their leads.
   *  `null` when it cannot be attributed (brand / product dimensions) or the expense
   *  links are unreadable (migration not applied). */
  cost: number | null;
}

export interface BusinessReportTotals {
  /** Distinct leads across ALL in-range deals (deduped). */
  leads_count: number;
  orders_won: number;
  quoted_value: number;
  order_value: number;
  brands: string[];
  /** Deduped committed spend over all in-range deals; `null` when unreadable. */
  cost: number | null;
}

export interface BusinessReport {
  range: { from: string; to: string };
  group_by: GroupBy;
  scope: Scope;
  filters: {
    engineer_id: string | null;
    industry: string | null;
    brand: string | null;
    product_id: string | null;
    account_id: string | null;
  };
  rows: BusinessReportRow[];
  totals: BusinessReportTotals;
  /** True when expense links were read; false => every `cost` is null. */
  cost_available: boolean;
}

export interface BusinessReportParams {
  orgId: string;
  clientId: string | null;
  /** The requesting user (for scope=own/supervised). */
  requesterId?: string | null;
  from?: string | null;
  to?: string | null;
  group_by?: string | null;
  scope?: string | null;
  engineer_id?: string | null;
  industry?: string | null;
  brand?: string | null;
  product_id?: string | null;
  account_id?: string | null;
}

/** Normalise group_by (default engineer) and scope (default all). */
export function resolveGroupBy(v: unknown): GroupBy {
  const g = String(v ?? '').toLowerCase();
  return (GROUP_BYS as readonly string[]).includes(g) ? (g as GroupBy) : 'engineer';
}
export function resolveScope(v: unknown): Scope {
  const s = String(v ?? '').toLowerCase();
  return (SCOPES as readonly string[]).includes(s) ? (s as Scope) : 'all';
}

/** What a claim is worth for the cost roll-up: the approved amount once approved/reimbursed, else what was claimed. */
function claimAmount(c: Row): number {
  if ((c.status === 'approved' || c.status === 'reimbursed') && c.approved_amount != null) {
    const n = Number(c.approved_amount);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(c.total_amount);
  return Number.isFinite(n) ? n : 0;
}

/** Per-deal classification + computed value, after the explicit filters have been applied. */
interface DealInfo {
  id: string;
  owner: string | null;
  accountId: string | null;
  leadId: string | null;
  industry: string | null;
  wonInRange: boolean;
  activeInRange: boolean;
  orderValue: number;  // won ? (line roll-up ?? amount) : 0
  quotedValue: number; // active ? amount : 0
  brands: string[];    // distinct brand names on the deal's lines
  products: Array<{ key: string; label: string }>; // distinct products on the deal's lines
}

interface Acc {
  key: string;
  label: string;
  leadSet: Set<string>;
  orders_won: number;
  quoted_value: number;
  order_value: number;
  brandSet: Set<string>;
  cost: number;        // summed when attributable; ignored when costNull
  costNull: boolean;   // brand / product rows cannot attribute cost
}

/**
 * Build the Business Report for a connected-B2B client. Returns `null` when the client
 * is not B2B (the route then answers 404 / not-available). Never throws: any failed
 * optional read degrades that metric to 0 / null / [].
 */
export async function buildBusinessReport(params: BusinessReportParams): Promise<BusinessReport | null> {
  const { orgId, clientId } = params;
  if (!orgId || !isB2bClient(clientId) || !clientId) return null;

  const { from, to } = resolveRange({ from: params.from, to: params.to });
  const groupBy = resolveGroupBy(params.group_by);
  const scope = resolveScope(params.scope);

  // Validated explicit filters (UUIDs validated; strings trimmed, compared case-insensitively).
  const fEngineer = typeof params.engineer_id === 'string' && UUID_RE.test(params.engineer_id) ? params.engineer_id : null;
  const fAccount = typeof params.account_id === 'string' && UUID_RE.test(params.account_id) ? params.account_id : null;
  const fProduct = typeof params.product_id === 'string' && UUID_RE.test(params.product_id) ? params.product_id : null;
  const fIndustry = str(params.industry);
  const fBrand = str(params.brand);

  // ── scope=own / supervised: resolve the allowed owner set ─────────────────
  // own       → just the requester; supervised → the requester's reports (users.supervisor_id
  // subtree minus self); all → no owner restriction. A missing reporting-line field makes the
  // subtree only [self], so `supervised` resolves to an empty set (documented).
  let scopeOwnerIds: Set<string> | null = null; // null = no restriction
  const requesterId = typeof params.requesterId === 'string' && UUID_RE.test(params.requesterId) ? params.requesterId : null;
  if (scope === 'own') {
    scopeOwnerIds = new Set(requesterId ? [requesterId] : []);
  } else if (scope === 'supervised') {
    if (!requesterId) {
      scopeOwnerIds = new Set();
    } else {
      try {
        const subtree = await supervisorSubtreeIds(orgId, requesterId);
        scopeOwnerIds = new Set(subtree.filter((id) => id !== requesterId));
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'businessReport: supervisor subtree read failed — supervised scope empty');
        scopeOwnerIds = new Set();
      }
    }
  }

  // ── Stage-type map so a deal in a `won` stage counts even if `status` wasn't stamped ──
  const stageType = new Map<string, string>();
  try {
    const { data } = await supabaseAdmin
      .from('crm_deal_stages')
      .select('id, stage_type')
      .eq('org_id', orgId)
      .limit(5000);
    for (const s of (data ?? []) as Row[]) {
      if (typeof s.id === 'string') stageType.set(s.id, String(s.stage_type ?? '').toLowerCase());
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'businessReport: deal-stages read failed');
  }
  const isWon = (d: Row): boolean => {
    if (String(d.status ?? '').toLowerCase() === 'won') return true;
    const st = typeof d.stage_id === 'string' ? stageType.get(d.stage_id) : undefined;
    return st === 'won';
  };

  // ── Deals: classify won-in-range / active-in-range, apply owner + scope + simple filters ──
  const deals = new Map<string, DealInfo>();
  const accountIds = new Set<string>();
  const leadIds = new Set<string>();
  try {
    const PAGE = 1000;
    for (let fromRow = 0; ; fromRow += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('crm_deals')
        .select('id, owner_id, assigned_to, status, stage_id, amount, actual_close_date, created_at, account_id, lead_id')
        .eq('org_id', orgId)
        .eq('client_id', clientId)
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(fromRow, fromRow + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Row[];
      for (const d of rows) {
        const owner = ownerOf(d);
        const createdDay = istDateOf(d.created_at);
        const closeDay = isRealDate(d.actual_close_date) ? (d.actual_close_date as string) : null;
        const wonInRange = isWon(d) && !!closeDay && closeDay >= from && closeDay <= to;
        const existedByTo = !createdDay || createdDay <= to;
        const notClosedBefore = !closeDay || closeDay >= from;
        const activeInRange = existedByTo && notClosedBefore;
        if (!wonInRange && !activeInRange) continue; // not in scope for the range

        // scope=own/supervised restriction on the deal owner
        if (scopeOwnerIds && (!owner || !scopeOwnerIds.has(owner))) continue;
        // explicit engineer filter (owner)
        if (fEngineer && owner !== fEngineer) continue;
        // explicit account filter
        const accountId = typeof d.account_id === 'string' && UUID_RE.test(d.account_id) ? d.account_id : null;
        if (fAccount && accountId !== fAccount) continue;

        const leadId = typeof d.lead_id === 'string' && UUID_RE.test(d.lead_id) ? d.lead_id : null;
        const amount = numOrNull(d.amount) ?? 0;
        deals.set(d.id as string, {
          id: d.id as string,
          owner,
          accountId,
          leadId,
          industry: null, // resolved below
          wonInRange,
          activeInRange,
          orderValue: 0,   // resolved after line items
          quotedValue: activeInRange ? amount : 0,
          brands: [],
          products: [],
        });
        if (accountId) accountIds.add(accountId);
        if (leadId) leadIds.add(leadId);
      }
      if (rows.length < PAGE) break;
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'businessReport: deals read failed');
  }

  const dealAmount = new Map<string, number>(); // deal_id -> amount (for order-value fallback)
  for (const info of deals.values()) dealAmount.set(info.id, info.quotedValue || 0);

  // ── Line items: per-deal order_value roll-up + brand set + product set ─────
  const dealIds = Array.from(deals.keys());
  const lineOrder = new Map<string, number>();
  const lineHasOrder = new Set<string>();
  const productLabels = new Map<string, string>(); // product_id -> name (filled from crm_products)
  const productIdsSeen = new Set<string>();
  if (dealIds.length) {
    try {
      const PAGE = 1000;
      for (const part of chunk(dealIds, 200)) {
        for (let fromRow = 0; ; fromRow += PAGE) {
          const { data, error } = await supabaseAdmin
            .from('crm_deal_line_items')
            .select('deal_id, product_id, sku, name, custom_fields')
            .eq('org_id', orgId)
            .in('deal_id', part)
            .order('id', { ascending: true })
            .range(fromRow, fromRow + PAGE - 1);
          if (error) throw new Error(error.message);
          const rows = (data ?? []) as Row[];
          for (const l of rows) {
            const info = deals.get(String(l.deal_id));
            if (!info) continue;
            const cf: Row = l.custom_fields && typeof l.custom_fields === 'object' ? l.custom_fields : {};
            const ov = numOrNull(cf.order_value);
            if (ov !== null) {
              lineOrder.set(info.id, (lineOrder.get(info.id) ?? 0) + ov);
              lineHasOrder.add(info.id);
            }
            const brand = str(cf.brand_name);
            if (brand && !info.brands.includes(brand)) info.brands.push(brand);
            // Product: product_id (uuid) first; else sku; else line name. Lines with none contribute nothing.
            const pid = typeof l.product_id === 'string' && UUID_RE.test(l.product_id) ? l.product_id : null;
            const sku = str(l.sku);
            const name = str(l.name);
            let pkey: string | null = null;
            let plabel = 'Unknown Product';
            if (pid) { pkey = pid; plabel = name || sku || pid; productIdsSeen.add(pid); }
            else if (sku) { pkey = `sku:${sku.toLowerCase()}`; plabel = name || sku; }
            else if (name) { pkey = `name:${name.toLowerCase()}`; plabel = name; }
            if (pkey && !info.products.some((p) => p.key === pkey)) info.products.push({ key: pkey, label: plabel });
          }
          if (rows.length < PAGE) break;
        }
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'businessReport: deal line-items read failed');
    }
  }

  // Finalise each deal's order value (won deals: line roll-up, amount fallback).
  for (const info of deals.values()) {
    if (info.wonInRange) {
      info.orderValue = lineHasOrder.has(info.id) ? (lineOrder.get(info.id) ?? 0) : (dealAmount.get(info.id) ?? 0);
    }
  }

  // ── Product labels from crm_products (best-effort) ────────────────────────
  if (productIdsSeen.size) {
    try {
      for (const part of chunk(Array.from(productIdsSeen), 200)) {
        const { data, error } = await supabaseAdmin
          .from('crm_products')
          .select('id, name')
          .eq('org_id', orgId)
          .in('id', part)
          .limit(5000);
        if (error) throw new Error(error.message);
        for (const p of (data ?? []) as Row[]) {
          const nm = str(p.name);
          if (typeof p.id === 'string' && nm) productLabels.set(p.id, nm);
        }
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'businessReport: products read failed');
    }
    // Prefer the canonical product name over the line snapshot for UUID-keyed products.
    for (const info of deals.values()) {
      for (const p of info.products) {
        const nm = productLabels.get(p.key);
        if (nm) p.label = nm;
      }
    }
  }

  // ── Account names + industry (for account/industry grouping and labels) ───
  const accountName = new Map<string, string>();
  const accountIndustry = new Map<string, string>();
  if (accountIds.size) {
    try {
      for (const part of chunk(Array.from(accountIds), 200)) {
        const { data, error } = await supabaseAdmin
          .from('crm_accounts')
          .select('id, name, industry')
          .eq('org_id', orgId)
          .in('id', part)
          .limit(5000);
        if (error) throw new Error(error.message);
        for (const a of (data ?? []) as Row[]) {
          if (typeof a.id !== 'string') continue;
          const nm = str(a.name);
          if (nm) accountName.set(a.id, nm);
          const ind = str(a.industry);
          if (ind) accountIndustry.set(a.id, ind);
        }
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'businessReport: accounts read failed');
    }
  }

  // ── Lead industry (primary source) for industry grouping ──────────────────
  const leadIndustry = new Map<string, string>();
  if (leadIds.size) {
    try {
      for (const part of chunk(Array.from(leadIds), 200)) {
        const { data, error } = await supabaseAdmin
          .from('crm_leads')
          .select('id, industry')
          .eq('org_id', orgId)
          .in('id', part)
          .limit(5000);
        if (error) throw new Error(error.message);
        for (const l of (data ?? []) as Row[]) {
          const ind = str(l.industry);
          if (typeof l.id === 'string' && ind) leadIndustry.set(l.id, ind);
        }
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'businessReport: leads industry read failed');
    }
  }

  // Resolve each deal's industry: the linked lead's industry, falling back to the account's.
  for (const info of deals.values()) {
    info.industry = (info.leadId && leadIndustry.get(info.leadId))
      || (info.accountId && accountIndustry.get(info.accountId))
      || null;
  }

  // ── Line-derived explicit filters (brand / product / industry) ────────────
  // Applied only now because they need the line items + resolved industry. Each
  // narrows the deal set: a deal that doesn't carry the value is dropped entirely
  // (so a brand filter keeps whole deals that have that brand, value counted at the
  // deal level — documented).
  const fBrandLc = fBrand ? fBrand.toLowerCase() : null;
  const fIndustryLc = fIndustry ? fIndustry.toLowerCase() : null;
  if (fBrandLc || fIndustryLc || fProduct) {
    for (const [id, info] of Array.from(deals.entries())) {
      if (fBrandLc && !info.brands.some((b) => b.toLowerCase() === fBrandLc)) { deals.delete(id); continue; }
      if (fProduct && !info.products.some((p) => p.key === fProduct)) { deals.delete(id); continue; }
      if (fIndustryLc && (info.industry ?? '').toLowerCase() !== fIndustryLc) { deals.delete(id); continue; }
    }
  }

  // ── Expense cost per deal (committed spend on the deal + its lead) ─────────
  // Deal-keyed claims are summed on their deal; lead-only claims (deal_id null) are
  // attributed to the FIRST in-scope deal that shares the lead, so each claim is
  // counted exactly once (deterministic by deal-id sort). Resilient: a tenant without
  // the lead_id / deal_id columns makes cost unavailable (every cost null).
  const costByDeal = new Map<string, number>();
  let costAvailable = true;
  const costDealIds = Array.from(deals.keys());
  const costLeadIds = new Set<string>();
  for (const info of deals.values()) if (info.leadId) costLeadIds.add(info.leadId);
  const sortedDealIds = costDealIds.slice().sort();
  const dealsByLead = new Map<string, string>(); // lead_id -> first in-scope deal id
  for (const id of sortedDealIds) {
    const info = deals.get(id)!;
    if (info.leadId && !dealsByLead.has(info.leadId)) dealsByLead.set(info.leadId, id);
  }
  if (costDealIds.length || costLeadIds.size) {
    try {
      // (a) claims linked directly to the in-scope deals
      if (costDealIds.length) {
        const PAGE = 1000;
        for (const part of chunk(costDealIds, 200)) {
          for (let fromRow = 0; ; fromRow += PAGE) {
            const { data, error } = await supabaseAdmin
              .from('expense_claims')
              .select('id, deal_id, lead_id, status, total_amount, approved_amount')
              .eq('org_id', orgId)
              .eq('client_id', clientId)
              .in('deal_id', part)
              .in('status', SPENT_STATUSES)
              .order('id', { ascending: true })
              .range(fromRow, fromRow + PAGE - 1);
            if (error) throw new Error(error.message);
            const rows = (data ?? []) as Row[];
            for (const c of rows) {
              const did = typeof c.deal_id === 'string' ? c.deal_id : null;
              if (did && deals.has(did)) costByDeal.set(did, (costByDeal.get(did) ?? 0) + claimAmount(c));
            }
            if (rows.length < PAGE) break;
          }
        }
      }
      // (b) lead-only claims (no deal_id) linked to the in-scope deals' leads
      if (costLeadIds.size) {
        const PAGE = 1000;
        for (const part of chunk(Array.from(costLeadIds), 200)) {
          for (let fromRow = 0; ; fromRow += PAGE) {
            const { data, error } = await supabaseAdmin
              .from('expense_claims')
              .select('id, deal_id, lead_id, status, total_amount, approved_amount')
              .eq('org_id', orgId)
              .eq('client_id', clientId)
              .in('lead_id', part)
              .is('deal_id', null)
              .in('status', SPENT_STATUSES)
              .order('id', { ascending: true })
              .range(fromRow, fromRow + PAGE - 1);
            if (error) throw new Error(error.message);
            const rows = (data ?? []) as Row[];
            for (const c of rows) {
              const lid = typeof c.lead_id === 'string' ? c.lead_id : null;
              const did = lid ? dealsByLead.get(lid) : undefined;
              if (did) costByDeal.set(did, (costByDeal.get(did) ?? 0) + claimAmount(c));
            }
            if (rows.length < PAGE) break;
          }
        }
      }
    } catch (e) {
      costAvailable = false;
      logger.warn({ err: (e as Error).message }, 'businessReport: expense cost read failed — cost null');
    }
  }

  // ── Group the in-scope deals and fold metrics in ──────────────────────────
  const groups = new Map<string, Acc>();
  const ensureGroup = (key: string, label: string, costNull: boolean): Acc => {
    let g = groups.get(key);
    if (!g) {
      g = { key, label, leadSet: new Set(), orders_won: 0, quoted_value: 0, order_value: 0, brandSet: new Set(), cost: 0, costNull };
      groups.set(key, g);
    } else if (label && (!g.label || g.label === g.key)) {
      g.label = label;
    }
    return g;
  };

  // The group targets (one per deal for engineer/account/industry; many for brand/product).
  const targetsFor = (info: DealInfo): Array<{ key: string; label: string }> => {
    switch (groupBy) {
      case 'engineer':
        return [info.owner ? { key: info.owner, label: info.owner } : { key: UNSPECIFIED, label: 'Unassigned' }];
      case 'account':
        return [info.accountId
          ? { key: info.accountId, label: accountName.get(info.accountId) || info.accountId }
          : { key: UNSPECIFIED, label: 'No Account' }];
      case 'industry':
        return [info.industry ? { key: info.industry, label: info.industry } : { key: UNSPECIFIED, label: 'Unspecified' }];
      case 'brand':
        return info.brands.length
          ? info.brands.map((b) => ({ key: b, label: b }))
          : [{ key: UNSPECIFIED, label: 'Unspecified' }];
      case 'product':
        return info.products.length
          ? info.products.map((p) => ({ key: p.key, label: p.label }))
          : [{ key: UNSPECIFIED, label: 'Unspecified' }];
    }
  };
  // Cost is attributable only at the deal level (engineer/account/industry); brand &
  // product fan out, so their rows carry cost: null.
  const costNullDimension = groupBy === 'brand' || groupBy === 'product';

  // Totals are computed independently at the deal level (deduped) so fan-out never distorts them.
  const totalLeadSet = new Set<string>();
  const totalBrandSet = new Set<string>();
  let totalOrdersWon = 0, totalQuoted = 0, totalOrderValue = 0, totalCost = 0;

  for (const info of deals.values()) {
    // deal-level totals
    if (info.leadId) totalLeadSet.add(info.leadId);
    if (info.wonInRange) { totalOrdersWon += 1; totalOrderValue += info.orderValue; }
    if (info.activeInRange) totalQuoted += info.quotedValue;
    for (const b of info.brands) totalBrandSet.add(b);
    totalCost += costByDeal.get(info.id) ?? 0;

    // per-group fold (fan-out for brand/product)
    for (const t of targetsFor(info)) {
      const g = ensureGroup(t.key, t.label, costNullDimension);
      if (info.leadId) g.leadSet.add(info.leadId);
      if (info.wonInRange) { g.orders_won += 1; g.order_value += info.orderValue; }
      if (info.activeInRange) g.quoted_value += info.quotedValue;
      for (const b of info.brands) g.brandSet.add(b);
      if (!costNullDimension) g.cost += costByDeal.get(info.id) ?? 0;
    }
  }

  // ── Resolve engineer labels (user names) when grouping by engineer ────────
  if (groupBy === 'engineer') {
    const userIds = Array.from(groups.keys()).filter((k) => k !== UNSPECIFIED && UUID_RE.test(k));
    if (userIds.length) {
      try {
        for (const part of chunk(userIds, 200)) {
          const { data, error } = await supabaseAdmin
            .from('users')
            .select('id, name, email')
            .eq('org_id', orgId)
            .in('id', part)
            .limit(5000);
          if (error) throw new Error(error.message);
          for (const u of (data ?? []) as Row[]) {
            const g = typeof u.id === 'string' ? groups.get(u.id) : undefined;
            if (g) g.label = str(u.name) || str(u.email) || g.key;
          }
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'businessReport: engineer names read failed');
      }
    }
  }

  // ── Shape the rows + totals ───────────────────────────────────────────────
  const rows: BusinessReportRow[] = Array.from(groups.values()).map((g) => ({
    key: g.key,
    label: g.label,
    leads_count: g.leadSet.size,
    orders_won: g.orders_won,
    quoted_value: round2(g.quoted_value),
    order_value: round2(g.order_value),
    brands: Array.from(g.brandSet).sort(),
    cost: g.costNull || !costAvailable ? null : round2(g.cost),
  }));
  // Order value desc, then quoted value desc, then label — directors read top performers first.
  rows.sort((a, b) => b.order_value - a.order_value || b.quoted_value - a.quoted_value || a.label.localeCompare(b.label));

  const totals: BusinessReportTotals = {
    leads_count: totalLeadSet.size,
    orders_won: totalOrdersWon,
    quoted_value: round2(totalQuoted),
    order_value: round2(totalOrderValue),
    brands: Array.from(totalBrandSet).sort(),
    cost: costAvailable ? round2(totalCost) : null,
  };

  return {
    range: { from, to },
    group_by: groupBy,
    scope,
    filters: {
      engineer_id: fEngineer,
      industry: fIndustry,
      brand: fBrand,
      product_id: fProduct,
      account_id: fAccount,
    },
    rows,
    totals,
    cost_available: costAvailable,
  };
}
