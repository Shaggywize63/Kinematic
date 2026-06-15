/**
 * Sales leaderboard — ranks reps by closed-won deals over a period.
 *
 * Why a separate service: the existing analytics.service is dominated by
 * dashboard / funnel / forecast aggregations. Leaderboard has its own shape
 * (one row per owner with both count + revenue + secondary stats) and its own
 * period semantics (MTD/QTD/YTD/custom), so isolating it keeps both files
 * readable and the leaderboard query path independent of the analytics
 * cache key scheme.
 *
 * Multi-tenancy: honours the same client scope as listLeads / listDeals —
 * JWT-pinned client users are hard-isolated to their client_id; admin
 * pickers see legacy NULL rows alongside the picked client (OR-with-NULL).
 */
import { supabaseAdmin } from '../../lib/supabase';

export type LeaderboardMetric = 'count' | 'revenue';
export type LeaderboardPeriod = 'mtd' | 'qtd' | 'ytd' | 'custom';

export interface LeaderboardParams {
  metric: LeaderboardMetric;
  period: LeaderboardPeriod;
  from?: string; // YYYY-MM-DD, required when period === 'custom'
  to?: string;   // YYYY-MM-DD, required when period === 'custom'
}

export interface LeaderboardScope {
  client_id: string | null;
  /** When true, isolate strictly to client_id (client-pinned JWT). */
  strict: boolean;
}

export interface LeaderboardRow {
  user_id: string | null;
  full_name: string;
  avatar_url: string | null;
  email: string | null;
  count: number;
  revenue: number;
  avg_deal_size: number;
  win_rate: number; // 0..1, won / (won+lost) in the same window
}

export interface LeaderboardResponse {
  metric: LeaderboardMetric;
  period: { type: LeaderboardPeriod; from: string; to: string };
  rows: LeaderboardRow[];
}

// Compute [from, to] as YYYY-MM-DD calendar dates (inclusive) for the
// requested preset. We use the server's local clock; the dashboard sends
// the period selector so the rep can re-pick if their TZ disagrees.
export function resolvePeriod(p: LeaderboardParams): { from: string; to: string } {
  if (p.period === 'custom') {
    if (!p.from || !p.to) {
      throw new Error("period='custom' requires both from and to");
    }
    return { from: p.from.slice(0, 10), to: p.to.slice(0, 10) };
  }
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  const today = now.toISOString().slice(0, 10);
  if (p.period === 'mtd') {
    const from = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    return { from, to: today };
  }
  if (p.period === 'qtd') {
    const qStartMonth = Math.floor(month / 3) * 3;
    const from = new Date(Date.UTC(year, qStartMonth, 1)).toISOString().slice(0, 10);
    return { from, to: today };
  }
  // ytd
  const from = new Date(Date.UTC(year, 0, 1)).toISOString().slice(0, 10);
  return { from, to: today };
}

export async function leaderboard(
  org_id: string,
  params: LeaderboardParams,
  scope: LeaderboardScope,
): Promise<LeaderboardResponse> {
  const { from, to } = resolvePeriod(params);

  // Pull every closed deal (won OR lost) in the window. We need lost rows so
  // win_rate is a real ratio rather than an empty value. The join to
  // crm_deal_stages gives stage_type so we don't trust the deal.status alone
  // (older rows pre-status column).
  // .range(0, 99999) lifts the 1000-row cap so leaderboard totals
  // reflect every closed deal in the window, not just the first 1000.
  let q = supabaseAdmin.from('crm_deals')
    .select('owner_id, amount, status, actual_close_date, crm_deal_stages!inner(stage_type)')
    .eq('org_id', org_id)
    .is('deleted_at', null)
    .not('actual_close_date', 'is', null)
    .gte('actual_close_date', from)
    .lte('actual_close_date', to)
    .in('crm_deal_stages.stage_type', ['won', 'lost'])
    .range(0, 99999);
  // Hard-isolate JWT-pinned client users; permissive OR-with-NULL for admin
  // pickers so they still see legacy org-level rows.
  if (scope.client_id) {
    q = scope.strict
      ? q.eq('client_id', scope.client_id)
      : q.or(`client_id.is.null,client_id.eq.${scope.client_id}`);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  type RawRow = {
    owner_id: string | null;
    amount: number | string | null;
    status: string | null;
    crm_deal_stages: { stage_type: string } | null;
  };
  const acc = new Map<string, { won: number; lost: number; revenue: number }>();
  for (const r of (data ?? []) as unknown as RawRow[]) {
    const stageType = r.crm_deal_stages?.stage_type ?? r.status ?? 'open';
    if (stageType !== 'won' && stageType !== 'lost') continue;
    const owner = r.owner_id ?? 'unassigned';
    const e = acc.get(owner) ?? { won: 0, lost: 0, revenue: 0 };
    if (stageType === 'won') {
      e.won += 1;
      e.revenue += Number(r.amount ?? 0);
    } else {
      e.lost += 1;
    }
    acc.set(owner, e);
  }

  // Look up owner display info in one IN(...) query. Mirrors
  // owners.helper.ts so the leaderboard renders the same names the rest of
  // the CRM uses, even when a user has been renamed since the deal closed.
  const userIds = Array.from(acc.keys()).filter(id => id !== 'unassigned');
  let usersById = new Map<string, { id: string; full_name: string; avatar_url: string | null; email: string | null }>();
  if (userIds.length) {
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, name, full_name, avatar_url, email')
      .in('id', userIds);
    for (const u of (users ?? []) as Array<{ id: string; name?: string; full_name?: string; avatar_url?: string | null; email?: string | null }>) {
      // Some legacy rows store the display name in `name`; prefer full_name
      // when present, fall back to name, then email.
      const display = u.full_name || u.name || u.email || 'Unknown';
      usersById.set(u.id, {
        id: u.id,
        full_name: display,
        avatar_url: u.avatar_url ?? null,
        email: u.email ?? null,
      });
    }
  }

  // Drop reps with zero wins in the window — the leaderboard is about wins.
  // A rep with only losses can still show via the "Show all" toggle in v2.
  const rows: LeaderboardRow[] = Array.from(acc.entries())
    .filter(([, v]) => v.won > 0)
    .map(([owner_id, v]) => {
      const closed = v.won + v.lost;
      const user = owner_id === 'unassigned' ? null : usersById.get(owner_id) ?? null;
      return {
        user_id: owner_id === 'unassigned' ? null : owner_id,
        full_name: user?.full_name ?? (owner_id === 'unassigned' ? 'Unassigned' : 'Unknown user'),
        avatar_url: user?.avatar_url ?? null,
        email: user?.email ?? null,
        count: v.won,
        revenue: v.revenue,
        avg_deal_size: v.won > 0 ? Math.round(v.revenue / v.won) : 0,
        win_rate: closed > 0 ? v.won / closed : 0,
      };
    });

  // Sort by the chosen primary metric DESC, tiebreak by the other one so two
  // reps with identical counts don't randomly swap places on each refresh.
  rows.sort((a, b) => {
    if (params.metric === 'revenue') {
      if (b.revenue !== a.revenue) return b.revenue - a.revenue;
      return b.count - a.count;
    }
    if (b.count !== a.count) return b.count - a.count;
    return b.revenue - a.revenue;
  });

  return {
    metric: params.metric,
    period: { type: params.period, from, to },
    rows: rows.slice(0, 50),
  };
}
