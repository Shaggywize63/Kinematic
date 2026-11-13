// Engineer Scorecard — read-only aggregation for the connected-B2B flow (Spark & Ray).
//
// The directors want each sales engineer's performance over a period: attendance,
// leads, contacts, brands worked, quoted value, order value and orders won,
// optionally broken down by day / week / month. This is PURE aggregation over
// tables that already exist — there is no migration. Every optional source degrades
// to 0 / null / [] on error so a missing column or table can never 500 the report.
//
// Leads vs contacts (fix): a lead that CONVERTS becomes a contact — convertLead /
// markLeadWon stamp crm_leads.status='converted' and create a crm_contacts row.
// `leads_count` previously counted EVERY crm_leads row in range, so those converted
// leads (now contacts) inflated the engineer's lead number. It now counts only TRUE
// (non-converted) leads; contacts are reported separately as `contacts_count` straight
// off crm_contacts, and the converted leads are kept as `converted_leads_count` so the
// old total stays recoverable (old leads_count === leads_count + converted_leads_count).
//
// Gated on `isB2bClient(clientId)`: any non-B2B tenant gets `null` back and the
// route answers "not available" exactly like the other Spark-only endpoints. All
// reads are org + strict-client scoped; owner attribution follows the CLAUDE.md
// rule (owner_id, falling back to assigned_to) and UUIDs are validated before use.
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { isB2bClient } from '../../lib/b2bClients';
import { chunk } from '../../lib/chunk';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IST_MIN = 330; // IST = UTC+05:30
const pad = (n: number) => String(n).padStart(2, '0');

export type Granularity = 'day' | 'week' | 'month';

/** Today's date in IST (YYYY-MM-DD). The server clock's own timezone never enters into it. */
function istDate(now: number = Date.now()): string {
  const d = new Date(now + IST_MIN * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** First and last day (YYYY-MM-DD) of the IST calendar month containing `now`. */
function istMonth(now: number = Date.now()): { start: string; end: string } {
  const d = new Date(now + IST_MIN * 60000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return {
    start: `${y}-${pad(m + 1)}-01`,
    end: `${y}-${pad(m + 1)}-${pad(new Date(Date.UTC(y, m + 1, 0)).getUTCDate())}`,
  };
}

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

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The IST calendar date (YYYY-MM-DD) of a timestamp string. */
function istDateOf(ts: unknown): string | null {
  if (typeof ts !== 'string' || !ts) return null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  return istDate(t);
}

/** Bucket key (bucket_start, YYYY-MM-DD) for a date under the chosen granularity. */
function bucketStart(date: string, granularity: Granularity): string {
  if (granularity === 'month') return `${date.slice(0, 7)}-01`;
  if (granularity === 'week') {
    // ISO week — Monday as the first day. Computed in UTC on the date-only value.
    const t = Date.parse(`${date}T00:00:00Z`);
    const dow = new Date(t).getUTCDay(); // 0=Sun..6=Sat
    const backToMonday = (dow + 6) % 7;
    const mon = new Date(t - backToMonday * 86400000);
    return `${mon.getUTCFullYear()}-${pad(mon.getUTCMonth() + 1)}-${pad(mon.getUTCDate())}`;
  }
  return date; // day
}

export interface ScorecardBucket {
  bucket_start: string;
  /** TRUE (non-converted) leads created in this bucket. Excludes converted leads. */
  leads_count: number;
  /** Contacts (crm_contacts) created in this bucket. Counted separately from leads. */
  contacts_count: number;
  orders_won: number;
  order_value: number;
}

export interface EngineerRow {
  user_id: string;
  name: string;
  attendance_days: number | null;
  /**
   * TRUE leads only: `crm_leads` rows created in range whose status is NOT
   * 'converted'. A converted lead spawns a `crm_contacts` row (it has become a
   * contact/customer), so counting it here would count a contact as a lead —
   * the over-count this report used to carry. See `contacts_count` /
   * `converted_leads_count` below.
   */
  leads_count: number;
  /** Contacts (`crm_contacts`) created in range for this engineer — the separate, authoritative contacts number. */
  contacts_count: number;
  /**
   * Leads created in range that have since converted (status='converted').
   * Kept so the previous total is fully recoverable:
   * old `leads_count` (all leads) === `leads_count` + `converted_leads_count`.
   */
  converted_leads_count: number;
  orders_won: number;
  quoted_value: number;
  order_value: number;
  brands: string[];
  buckets: ScorecardBucket[];
}

export interface ScorecardTotals {
  /** TRUE (non-converted) leads across all engineers. */
  leads_count: number;
  /** Contacts (crm_contacts) across all engineers. */
  contacts_count: number;
  /** Converted leads across all engineers (old leads_count === leads_count + converted_leads_count). */
  converted_leads_count: number;
  orders_won: number;
  quoted_value: number;
  order_value: number;
  brands: string[];
}

export interface Scorecard {
  range: { from: string; to: string; granularity: Granularity };
  engineers: EngineerRow[];
  totals: ScorecardTotals;
  /** True when the attendance table could not be read — attendance_days is null for every engineer. */
  attendance_available: boolean;
}

export interface ScorecardParams {
  orgId: string;
  clientId: string | null;
  from?: string | null;
  to?: string | null;
  granularity?: string | null;
}

type Row = Record<string, any>;

/** Normalise the requested range + granularity (IST calendar month by default). */
export function resolveRange(params: Pick<ScorecardParams, 'from' | 'to' | 'granularity'>): {
  from: string;
  to: string;
  granularity: Granularity;
} {
  const month = istMonth();
  let from = isRealDate(params.from) ? params.from : month.start;
  let to = isRealDate(params.to) ? params.to : month.end;
  if (from > to) [from, to] = [to, from];
  const g = String(params.granularity ?? 'month').toLowerCase();
  const granularity: Granularity = g === 'day' || g === 'week' ? g : 'month';
  return { from, to, granularity };
}

/** Owner of a CRM row: owner_id, falling back to assigned_to (CLAUDE.md). Only valid UUIDs. */
function ownerOf(row: Row): string | null {
  const o = typeof row.owner_id === 'string' && UUID_RE.test(row.owner_id) ? row.owner_id : null;
  if (o) return o;
  const a = typeof row.assigned_to === 'string' && UUID_RE.test(row.assigned_to) ? row.assigned_to : null;
  return a;
}

/**
 * Build the Engineer Scorecard for a connected-B2B client. Returns `null` when the
 * client is not B2B (the route then answers 404 / not-available). Never throws: any
 * failed optional read degrades that metric to 0 / null / [].
 */
export async function buildEngineerScorecard(params: ScorecardParams): Promise<Scorecard | null> {
  const { orgId, clientId } = params;
  if (!orgId || !isB2bClient(clientId) || !clientId) return null;

  const { from, to, granularity } = resolveRange(params);
  // created_at is timestamptz — bound the IST calendar day inclusively.
  const fromTs = `${from}T00:00:00+05:30`;
  const toTs = `${to}T23:59:59.999+05:30`;

  // ── Engineers: active users of the client ────────────────────────────────
  const engineers = new Map<string, EngineerRow>();
  const ensure = (userId: string, name?: string): EngineerRow => {
    let row = engineers.get(userId);
    if (!row) {
      row = {
        user_id: userId,
        name: name || userId,
        attendance_days: null,
        leads_count: 0,
        contacts_count: 0,
        converted_leads_count: 0,
        orders_won: 0,
        quoted_value: 0,
        order_value: 0,
        brands: [],
        buckets: [],
      };
      engineers.set(userId, row);
    } else if (name && (!row.name || row.name === row.user_id)) {
      row.name = name;
    }
    return row;
  };

  try {
    const { data } = await supabaseAdmin
      .from('users')
      .select('id, name, email')
      .eq('org_id', orgId)
      .eq('client_id', clientId)
      .eq('is_active', true)
      .limit(5000);
    for (const u of (data ?? []) as Row[]) {
      if (typeof u.id === 'string' && UUID_RE.test(u.id)) ensure(u.id, (u.name as string) || (u.email as string) || '');
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'engineerScorecard: active-users read failed');
  }

  // Per-user, per-bucket accumulators (kept out of the public row until the end).
  const buckets = new Map<string, Map<string, ScorecardBucket>>();
  const bucketFor = (userId: string, key: string): ScorecardBucket => {
    let byKey = buckets.get(userId);
    if (!byKey) buckets.set(userId, (byKey = new Map()));
    let b = byKey.get(key);
    if (!b) byKey.set(key, (b = { bucket_start: key, leads_count: 0, contacts_count: 0, orders_won: 0, order_value: 0 }));
    return b;
  };

  // ── Leads created in range, attributed to owner (fallback assigned_to) ────
  // TRUE leads only: a lead whose status is 'converted' has become a contact
  // (convertLead / markLeadWon stamp status='converted' and create a crm_contacts
  // row), so it is counted under `converted_leads_count` and surfaced separately
  // as a contact below — NOT as a lead. This is the fix for the report counting
  // contacts as leads. `status` is a core crm_leads column (used bare elsewhere),
  // so selecting it carries no missing-column risk.
  try {
    const PAGE = 1000;
    for (let fromRow = 0; ; fromRow += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('crm_leads')
        .select('id, owner_id, assigned_to, created_at, status')
        .eq('org_id', orgId)
        .eq('client_id', clientId)
        .is('deleted_at', null)
        .gte('created_at', fromTs)
        .lte('created_at', toTs)
        .order('id', { ascending: true })
        .range(fromRow, fromRow + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Row[];
      for (const l of rows) {
        const uid = ownerOf(l);
        if (!uid) continue;
        const row = ensure(uid);
        if (String(l.status ?? '').toLowerCase() === 'converted') {
          // Became a contact — do not count as a lead; kept for recoverability.
          row.converted_leads_count += 1;
          continue;
        }
        row.leads_count += 1;
        const d = istDateOf(l.created_at);
        if (d) bucketFor(uid, bucketStart(d, granularity)).leads_count += 1;
      }
      if (rows.length < PAGE) break;
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'engineerScorecard: leads read failed');
  }

  // ── Contacts created in range, attributed to owner (fallback assigned_to) ──
  // Counted SEPARATELY from leads, straight off crm_contacts — the authoritative
  // source for the engineer's contacts number (a converted lead creates exactly
  // one such row). Resilient: a legacy crm_contacts without `assigned_to` retries
  // with owner_id only; any other failure degrades contacts_count to 0.
  try {
    const PAGE = 1000;
    let cols = 'id, owner_id, assigned_to, created_at';
    let triedOwnerOnly = false;
    for (let fromRow = 0; ; ) {
      const { data, error } = await supabaseAdmin
        .from('crm_contacts')
        .select(cols)
        .eq('org_id', orgId)
        .eq('client_id', clientId)
        .is('deleted_at', null)
        .gte('created_at', fromTs)
        .lte('created_at', toTs)
        .order('id', { ascending: true })
        .range(fromRow, fromRow + PAGE - 1);
      if (error) {
        if (!triedOwnerOnly && /assigned_to/i.test(error.message)) {
          cols = 'id, owner_id, created_at';
          triedOwnerOnly = true;
          continue; // restart this page with the reduced column set
        }
        throw new Error(error.message);
      }
      const rows = (data ?? []) as Row[];
      for (const c of rows) {
        const uid = ownerOf(c);
        if (!uid) continue;
        const row = ensure(uid);
        row.contacts_count += 1;
        const d = istDateOf(c.created_at);
        if (d) bucketFor(uid, bucketStart(d, granularity)).contacts_count += 1;
      }
      if (rows.length < PAGE) break;
      fromRow += PAGE;
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'engineerScorecard: contacts read failed');
  }

  // ── Deals: fetch the client's deals, classify won + active-in-range ───────
  // Stage-type map so a deal in a `won` stage counts even if `status` wasn't stamped.
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
    logger.warn({ err: (e as Error).message }, 'engineerScorecard: deal-stages read failed');
  }

  const isWon = (d: Row): boolean => {
    if (String(d.status ?? '').toLowerCase() === 'won') return true;
    const st = typeof d.stage_id === 'string' ? stageType.get(d.stage_id) : undefined;
    return st === 'won';
  };

  interface DealAgg { userId: string; wonInRange: boolean; activeInRange: boolean; amount: number | null; wonBucket: string | null }
  const dealAgg = new Map<string, DealAgg>(); // deal_id -> classification
  const wonDealIds: string[] = [];   // need line-item order_value
  const activeDealIds: string[] = []; // need line-item brands

  try {
    const PAGE = 1000;
    for (let fromRow = 0; ; fromRow += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('crm_deals')
        .select('id, owner_id, assigned_to, status, stage_id, amount, actual_close_date, created_at')
        .eq('org_id', orgId)
        .eq('client_id', clientId)
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(fromRow, fromRow + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Row[];
      for (const d of rows) {
        const uid = ownerOf(d);
        if (!uid) continue;
        const createdDay = istDateOf(d.created_at);
        // Won in range: won AND its close date falls inside [from,to].
        const closeDay = isRealDate(d.actual_close_date) ? (d.actual_close_date as string) : null;
        const wonInRange = isWon(d) && !!closeDay && closeDay >= from && closeDay <= to;
        // Active in range: the deal existed by `to` and was not already closed before `from`
        // (open, or won/lost on-or-after `from`). created_at compared on the IST day.
        const existedByTo = !createdDay || createdDay <= to;
        const notClosedBefore = !closeDay || closeDay >= from;
        const activeInRange = existedByTo && notClosedBefore;
        const amount = numOrNull(d.amount);
        dealAgg.set(d.id as string, {
          userId: uid,
          wonInRange,
          activeInRange,
          amount,
          wonBucket: wonInRange && closeDay ? bucketStart(closeDay, granularity) : null,
        });
        if (wonInRange) wonDealIds.push(d.id as string);
        if (activeInRange) activeDealIds.push(d.id as string);
      }
      if (rows.length < PAGE) break;
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'engineerScorecard: deals read failed');
  }

  // ── Line items: per-deal order_value sum (won deals) + brand set (active deals) ──
  const lineOrder = new Map<string, number>();     // deal_id -> summed order_value
  const lineHasOrder = new Set<string>();           // deal_id has at least one order_value
  const lineBrands = new Map<string, Set<string>>(); // deal_id -> distinct brand names
  const lineDealIds = Array.from(new Set([...wonDealIds, ...activeDealIds]));
  if (lineDealIds.length) {
    try {
      const PAGE = 1000;
      for (const part of chunk(lineDealIds, 200)) {
        for (let fromRow = 0; ; fromRow += PAGE) {
          const { data, error } = await supabaseAdmin
            .from('crm_deal_line_items')
            .select('deal_id, custom_fields')
            .eq('org_id', orgId)
            .in('deal_id', part)
            .order('id', { ascending: true })
            .range(fromRow, fromRow + PAGE - 1);
          if (error) throw new Error(error.message);
          const rows = (data ?? []) as Row[];
          for (const l of rows) {
            const did = String(l.deal_id);
            const cf: Row = l.custom_fields && typeof l.custom_fields === 'object' ? l.custom_fields : {};
            const ov = numOrNull(cf.order_value);
            if (ov !== null) {
              lineOrder.set(did, (lineOrder.get(did) ?? 0) + ov);
              lineHasOrder.add(did);
            }
            const brand = typeof cf.brand_name === 'string' ? cf.brand_name.trim() : '';
            if (brand) {
              let set = lineBrands.get(did);
              if (!set) lineBrands.set(did, (set = new Set()));
              set.add(brand);
            }
          }
          if (rows.length < PAGE) break;
        }
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'engineerScorecard: deal line-items read failed');
    }
  }

  // ── Fold deal classifications into engineer rows ──────────────────────────
  const brandSetByUser = new Map<string, Set<string>>();
  const brandSetFor = (uid: string): Set<string> => {
    let s = brandSetByUser.get(uid);
    if (!s) brandSetByUser.set(uid, (s = new Set()));
    return s;
  };
  for (const [dealId, agg] of dealAgg) {
    const row = ensure(agg.userId);
    if (agg.wonInRange) {
      row.orders_won += 1;
      // order value: prefer the line-item order_value roll-up; fall back to the deal amount.
      const ov = lineHasOrder.has(dealId) ? (lineOrder.get(dealId) ?? 0) : (agg.amount ?? 0);
      row.order_value += ov;
      if (agg.wonBucket) {
        const b = bucketFor(agg.userId, agg.wonBucket);
        b.orders_won += 1;
        b.order_value += ov;
      }
    }
    if (agg.activeInRange) {
      if (agg.amount !== null) row.quoted_value += agg.amount;
      const brands = lineBrands.get(dealId);
      if (brands) { const us = brandSetFor(agg.userId); for (const b of brands) us.add(b); }
    }
  }

  // ── Attendance: distinct days present in range (resilient: null if unreadable) ──
  let attendanceAvailable = true;
  const attDays = new Map<string, Set<string>>();
  try {
    const PAGE = 1000;
    for (let fromRow = 0; ; fromRow += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('attendance')
        .select('user_id, date')
        .eq('org_id', orgId)
        .eq('client_id', clientId)
        .gte('date', from)
        .lte('date', to)
        .order('date', { ascending: true })
        .range(fromRow, fromRow + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Row[];
      for (const a of rows) {
        const uid = typeof a.user_id === 'string' && UUID_RE.test(a.user_id) ? a.user_id : null;
        const d = isRealDate(a.date) ? (a.date as string) : istDateOf(a.date);
        if (!uid || !d) continue;
        let set = attDays.get(uid);
        if (!set) attDays.set(uid, (set = new Set()));
        set.add(d);
      }
      if (rows.length < PAGE) break;
    }
  } catch (e) {
    attendanceAvailable = false;
    logger.warn({ err: (e as Error).message }, 'engineerScorecard: attendance read failed — attendance_days null');
  }

  // ── Finalise rows ─────────────────────────────────────────────────────────
  const engineerRows: EngineerRow[] = [];
  const totalBrands = new Set<string>();
  const totals: ScorecardTotals = { leads_count: 0, contacts_count: 0, converted_leads_count: 0, orders_won: 0, quoted_value: 0, order_value: 0, brands: [] };

  for (const row of engineers.values()) {
    row.quoted_value = round2(row.quoted_value);
    row.order_value = round2(row.order_value);
    row.brands = Array.from(brandSetFor(row.user_id)).sort();
    row.attendance_days = attendanceAvailable ? (attDays.get(row.user_id)?.size ?? 0) : null;
    row.buckets = Array.from(buckets.get(row.user_id)?.values() ?? [])
      .map((b) => ({ ...b, order_value: round2(b.order_value) }))
      .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));

    totals.leads_count += row.leads_count;
    totals.contacts_count += row.contacts_count;
    totals.converted_leads_count += row.converted_leads_count;
    totals.orders_won += row.orders_won;
    totals.quoted_value += row.quoted_value;
    totals.order_value += row.order_value;
    for (const b of row.brands) totalBrands.add(b);
    engineerRows.push(row);
  }

  // Drop engineers with no activity AND no attendance in range? Keep every active
  // user of the client (directors want the full roster), plus any owner with
  // activity in range (added via ensure()). Sort by order_value desc then name.
  engineerRows.sort((a, b) => b.order_value - a.order_value || a.name.localeCompare(b.name));

  totals.quoted_value = round2(totals.quoted_value);
  totals.order_value = round2(totals.order_value);
  totals.brands = Array.from(totalBrands).sort();

  return {
    range: { from, to, granularity },
    engineers: engineerRows,
    totals,
    attendance_available: attendanceAvailable,
  };
}
