/**
 * Pure helpers for the unified `GET /api/v1/crm/search` omnisearch: turn each
 * entity's raw rows into a normalized { id, title, subtitle } item, score it by
 * relevance to the query term, and assemble ranked groups.
 *
 * There is deliberately NO database access and NO tenant scoping in this file —
 * the route (crm.routes.ts) owns those and reuses the EXACT scoping each list
 * endpoint applies (org + strict client + hierarchy subtree + effective-city
 * gate) so global search can never surface a record the caller couldn't already
 * reach on the entity's own list page. This module only shapes + ranks the rows
 * the route already fetched, which keeps it trivially unit-testable.
 */

export interface SearchItem {
  id: string;
  title: string;
  subtitle?: string;
  /** Relevance score (higher = better). Used to sort within + order groups. */
  score: number;
}

export interface SearchGroup {
  /** Stable machine type the frontend maps to an icon + route. */
  type: string;
  label: string;
  count: number;
  items: SearchItem[];
}

type Row = Record<string, unknown>;
type RawItem = { id: string; title: string; subtitle?: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const nameOf = (r: Row): string => [str(r.first_name), str(r.last_name)].filter(Boolean).join(' ').trim();
const snippet = (s: string, n = 64): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** First candidate that is non-empty and not equal to `title` (avoids a
 *  subtitle that just repeats the title, e.g. a company-named lead). */
function distinct(title: string, candidates: string[]): string | undefined {
  const t = title.trim().toLowerCase();
  for (const c of candidates) {
    const v = c.trim();
    if (v && v.toLowerCase() !== t) return v;
  }
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Relevance of one item to the query. There is no full-text ranking in the DB
 * (it's all substring ILIKE), so we rank the small fetched set here:
 *   exact title            → 100
 *   title starts-with      →  70
 *   title word starts-with →  55
 *   title contains         →  40
 *   subtitle contains only →  25
 * A subtitle that also matches adds a small tie-break boost. Case-insensitive.
 */
export function scoreItem(term: string, title: string, subtitle = ''): number {
  const t = term.trim().toLowerCase();
  if (!t) return 0;
  const titleL = title.toLowerCase();
  const subL = subtitle.toLowerCase();
  let s = 0;
  if (titleL === t) s = 100;
  else if (titleL.startsWith(t)) s = 70;
  else if (new RegExp(`\\b${escapeRe(t)}`).test(titleL)) s = 55;
  else if (titleL.includes(t)) s = 40;
  else if (subL.includes(t)) s = 25;
  if (s > 0 && s < 100 && subL.includes(t)) s += 5;
  return s;
}

/** Score, sort (desc) and cap a set of raw items into a group. */
export function toGroup(type: string, label: string, items: RawItem[], term: string, cap: number): SearchGroup {
  const scored: SearchItem[] = items
    .filter((it) => it.id && it.title)
    .map((it) => ({ ...it, score: scoreItem(term, it.title, it.subtitle) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);
  return { type, label, count: scored.length, items: scored };
}

/** Drop empty groups; order by best in-group score, ties broken by `priority`. */
export function orderGroups(groups: SearchGroup[], priority: string[]): SearchGroup[] {
  return groups
    .filter((g) => g.items.length > 0)
    .sort((a, b) => {
      const bestA = a.items[0]?.score ?? 0;
      const bestB = b.items[0]?.score ?? 0;
      if (bestB !== bestA) return bestB - bestA;
      return priority.indexOf(a.type) - priority.indexOf(b.type);
    });
}

// ── Per-entity row → { id, title, subtitle } mappers ────────────────────────

export function leadItems(rows: Row[]): RawItem[] {
  return rows.map((r) => {
    const title = nameOf(r) || str(r.company) || str(r.email) || str(r.phone) || 'Lead';
    return { id: str(r.id), title, subtitle: distinct(title, [str(r.company), str(r.email), str(r.phone), str(r.status)]) };
  });
}

export function dealItems(rows: Row[]): RawItem[] {
  return rows.map((r) => {
    const title = str(r.title) || str(r.name) || 'Deal';
    const st = r.crm_deal_stages as { name?: unknown } | Array<{ name?: unknown }> | null | undefined;
    const stage = str(Array.isArray(st) ? st[0]?.name : st?.name);
    const amt = r.amount != null && r.amount !== '' && Number.isFinite(Number(r.amount))
      ? `₹${Number(r.amount).toLocaleString('en-IN')}`
      : '';
    const subtitle = [stage, amt].filter(Boolean).join(' · ') || str(r.status) || undefined;
    return { id: str(r.id), title, subtitle };
  });
}

export function contactItems(rows: Row[]): RawItem[] {
  return rows.map((r) => {
    const title = nameOf(r) || str(r.email) || str(r.mobile) || str(r.phone) || 'Contact';
    return { id: str(r.id), title, subtitle: distinct(title, [str(r.title), str(r.email), str(r.phone), str(r.mobile)]) };
  });
}

export function accountItems(rows: Row[]): RawItem[] {
  return rows.map((r) => {
    const title = str(r.name) || 'Account';
    return { id: str(r.id), title, subtitle: distinct(title, [str(r.industry), str(r.domain)]) };
  });
}

export function activityItems(rows: Row[]): RawItem[] {
  return rows.map((r) => {
    const title = str(r.subject) || str(r.type) || 'Activity';
    return { id: str(r.id), title, subtitle: distinct(title, [str(r.type), snippet(str(r.body))]) };
  });
}

export function productItems(rows: Row[]): RawItem[] {
  return rows.map((r) => {
    const title = str(r.name) || str(r.sku) || 'Product';
    return { id: str(r.id), title, subtitle: distinct(title, [str(r.sku), snippet(str(r.description))]) };
  });
}

export function personItems(rows: Row[]): RawItem[] {
  return rows.map((r) => {
    const title = nameOf(r) || str(r.mobile) || str(r.email) || 'Person';
    return { id: str(r.id), title, subtitle: distinct(title, [str(r.type), str(r.mobile), str(r.city)]) };
  });
}

// ── Distribution + field-force mappers ──────────────────────────────────────

export function distributorItems(rows: Row[]): RawItem[] {
  return rows.map((r) => {
    const title = str(r.name) || str(r.code) || 'Distributor';
    return { id: str(r.id), title, subtitle: distinct(title, [str(r.code), str(r.contact_name), str(r.contact_mobile), str(r.region)]) };
  });
}

export function brandItems(rows: Row[]): RawItem[] {
  return rows.map((r) => {
    const title = str(r.name) || str(r.code) || 'Brand';
    return { id: str(r.id), title, subtitle: distinct(title, [str(r.code), str(r.legal_name)]) };
  });
}

export function orderItems(rows: Row[]): RawItem[] {
  return rows.map((r) => {
    const no = str(r.order_no);
    const title = no ? `Order ${no}` : 'Order';
    const placed = str(r.placed_at).slice(0, 10);
    const subtitle = [str(r.status), placed].filter(Boolean).join(' · ') || undefined;
    return { id: str(r.id), title, subtitle };
  });
}

export function userItems(rows: Row[]): RawItem[] {
  return rows.map((r) => {
    const title = str(r.name) || str(r.employee_id) || str(r.email) || 'User';
    return { id: str(r.id), title, subtitle: distinct(title, [str(r.employee_id), str(r.email), str(r.mobile), str(r.city)]) };
  });
}

export function storeItems(rows: Row[]): RawItem[] {
  return rows.map((r) => {
    const title = str(r.name) || str(r.store_code) || 'Store';
    return { id: str(r.id), title, subtitle: distinct(title, [str(r.store_code), snippet(str(r.address))]) };
  });
}
