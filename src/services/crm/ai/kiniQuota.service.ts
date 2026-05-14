/**
 * KINI usage cap. One small abstraction over the kini_usage table so the
 * chat routes (CRM + legacy) call the same gate.
 *
 * Budget: ~$1 / user / month at current Anthropic pricing. With a blended
 * ~$0.014 / query (60% Sonnet, 40% Haiku), 20 queries / user / month leaves
 * a healthy buffer for over-runs. Override with KINI_MONTHLY_QUERY_CAP.
 *
 * Shared-credit model (post-migration_kini_credits.sql):
 *   - kini_usage now has (user_id, org_id, month, platform) uniqueness so a
 *     single user on both web and iOS produces two rows that sum.
 *   - The cap applies ORG-WIDE: we sum every row in (org_id, month) and
 *     compare to org_settings.kini_monthly_query_limit (or the env default).
 *     Org-cap exceeded → 429 ORG_KINI_LIMIT_REACHED.
 *   - Per-user-per-platform stays as a secondary gate against the env
 *     default. User-cap exceeded → 429 USER_KINI_LIMIT_REACHED.
 *
 * Exemptions: super_admin and the demo placeholder user (org_id =
 * DEMO_ORG_ID) bypass the gate entirely so internal demos + admins never
 * see the limit screen.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { DEMO_ORG_ID } from '../../../utils/demoData';
import { logger } from '../../../lib/logger';

const DEFAULT_CAP = 20;
export function monthlyCap(): number {
  const env = Number(process.env.KINI_MONTHLY_QUERY_CAP);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : DEFAULT_CAP;
}

/** UTC year-month, e.g. "2026-05". Stable for the whole calendar month. */
export function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Last day of the given YYYY-MM, ISO date (YYYY-MM-DD). */
export function periodEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  // Day 0 of the next month = last day of the requested month.
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export type Platform = 'web' | 'ios' | 'android';
const PLATFORMS: Platform[] = ['web', 'ios', 'android'];
function normalizePlatform(p?: string | null): Platform {
  const v = (p ?? '').toLowerCase().trim();
  return (PLATFORMS as string[]).includes(v) ? (v as Platform) : 'web';
}

export interface UsageView {
  used: number;
  cap: number;
  remaining: number;
  month: string;
  exempt: boolean;
}

export interface UsageActor {
  id?: string;
  org_id?: string;
  role?: string | null;
}

function isExempt(actor: UsageActor): boolean {
  if (!actor?.id) return false;
  if (actor.org_id === DEMO_ORG_ID) return true;
  return (actor.role || '').toLowerCase() === 'super_admin';
}

/** Fetch the org-wide cap. Uses org_settings override if present. */
async function orgCap(orgId?: string): Promise<number> {
  if (!orgId) return monthlyCap();
  try {
    const { data } = await supabaseAdmin
      .from('org_settings')
      .select('kini_monthly_query_limit')
      .eq('org_id', orgId)
      .maybeSingle();
    const v = data?.kini_monthly_query_limit;
    if (typeof v === 'number' && v > 0) return Math.floor(v);
  } catch (e: any) {
    logger.warn(`[kiniQuota] orgCap lookup failed: ${e.message}`);
  }
  return monthlyCap();
}

/** Read the current usage without incrementing. UI uses this. */
export async function getUsage(actor: UsageActor): Promise<UsageView> {
  const cap = monthlyCap();
  const month = currentMonth();
  const exempt = isExempt(actor);
  if (exempt || !actor.id) {
    return { used: 0, cap, remaining: cap, month, exempt };
  }
  // Sum across platforms so the per-user view reflects every device.
  const { data } = await supabaseAdmin.from('kini_usage')
    .select('query_count').eq('user_id', actor.id).eq('month', month);
  const used = (data ?? []).reduce((a: number, r: any) => a + (r?.query_count ?? 0), 0);
  return { used, cap, remaining: Math.max(0, cap - used), month, exempt: false };
}

export type QuotaReason = 'ORG_KINI_LIMIT_REACHED' | 'USER_KINI_LIMIT_REACHED';

export interface QuotaCheck {
  allowed: boolean;
  used: number;          // user's monthly total (across platforms)
  cap: number;           // user-level cap (env default)
  remaining: number;
  month: string;
  exempt: boolean;
  org_used?: number;     // org-wide monthly total
  org_cap?: number;
  reason?: QuotaReason;
}

/** Gate the request. Returns allowed=false when org or user is at/over cap. */
export async function checkQuota(actor: UsageActor): Promise<QuotaCheck> {
  const month = currentMonth();
  const userCap = monthlyCap();
  const exempt = isExempt(actor);
  if (exempt || !actor.id) {
    return {
      allowed: true,
      used: 0, cap: userCap, remaining: userCap, month, exempt,
    };
  }

  // Org-wide aggregation (covers every user × platform row for the month).
  const orgLimit = await orgCap(actor.org_id);
  let orgUsed = 0;
  if (actor.org_id) {
    const { data } = await supabaseAdmin.from('kini_usage')
      .select('query_count').eq('org_id', actor.org_id).eq('month', month);
    orgUsed = (data ?? []).reduce((a: number, r: any) => a + (r?.query_count ?? 0), 0);
  }
  if (orgUsed >= orgLimit) {
    return {
      allowed: false,
      used: 0, cap: userCap, remaining: 0, month, exempt: false,
      org_used: orgUsed, org_cap: orgLimit,
      reason: 'ORG_KINI_LIMIT_REACHED',
    };
  }

  // Per-user secondary gate.
  const { data: userRows } = await supabaseAdmin.from('kini_usage')
    .select('query_count').eq('user_id', actor.id).eq('month', month);
  const userUsed = (userRows ?? []).reduce((a: number, r: any) => a + (r?.query_count ?? 0), 0);
  if (userUsed >= userCap) {
    return {
      allowed: false,
      used: userUsed, cap: userCap, remaining: 0, month, exempt: false,
      org_used: orgUsed, org_cap: orgLimit,
      reason: 'USER_KINI_LIMIT_REACHED',
    };
  }

  return {
    allowed: true,
    used: userUsed, cap: userCap, remaining: Math.max(0, userCap - userUsed), month, exempt: false,
    org_used: orgUsed, org_cap: orgLimit,
  };
}

/**
 * Increment the user's counter for the given platform. Best-effort: never
 * throws — a failed counter increment must not block the conversation that
 * just succeeded.
 *
 * Uses UPSERT-with-increment: insert at 1 on first call of the
 * (user, org, month, platform) tuple; on conflict, bump.
 */
export async function recordQuery(
  actor: UsageActor,
  tokens?: { input?: number; output?: number },
  platform: Platform | string = 'web',
): Promise<void> {
  if (isExempt(actor) || !actor.id || !actor.org_id) return;
  const month = currentMonth();
  const plat = normalizePlatform(platform);
  const inputTok  = tokens?.input  ?? 0;
  const outputTok = tokens?.output ?? 0;
  try {
    // Try insert; on (user_id, org_id, month, platform) conflict, increment.
    const insertRes = await supabaseAdmin.from('kini_usage').insert({
      user_id: actor.id, org_id: actor.org_id, month, platform: plat,
      query_count: 1, request_count: 1,
      input_tokens: inputTok, output_tokens: outputTok,
      last_query_at: new Date().toISOString(),
    }).select('id').maybeSingle();
    if (!insertRes.error) return;
    if (insertRes.error.code === '23505') {
      const { data: cur } = await supabaseAdmin.from('kini_usage')
        .select('id, query_count, request_count, input_tokens, output_tokens')
        .eq('user_id', actor.id).eq('org_id', actor.org_id)
        .eq('month', month).eq('platform', plat).maybeSingle();
      if (cur) {
        await supabaseAdmin.from('kini_usage').update({
          query_count:   (cur.query_count   ?? 0) + 1,
          request_count: (cur.request_count ?? 0) + 1,
          input_tokens:  (cur.input_tokens  ?? 0) + inputTok,
          output_tokens: (cur.output_tokens ?? 0) + outputTok,
          last_query_at: new Date().toISOString(),
          updated_at:    new Date().toISOString(),
        }).eq('id', cur.id);
      }
    }
  } catch (e: any) {
    logger.warn(`[kiniQuota] recordQuery failed: ${e.message}`);
  }
}

export interface CreditsView {
  used: number;
  limit: number;
  period_end: string;
  platform_breakdown: Record<Platform, number>;
}

/**
 * Org-wide credits snapshot for the given month. UI pills + mobile clients
 * consume this. `used` is the sum of query_count for the org in `month`;
 * `limit` comes from org_settings (else env default).
 */
export async function getCredits(orgId: string, month: string = currentMonth()): Promise<CreditsView> {
  const limit = await orgCap(orgId);
  const breakdown: Record<Platform, number> = { web: 0, ios: 0, android: 0 };
  let used = 0;
  if (orgId) {
    const { data } = await supabaseAdmin
      .from('kini_usage')
      .select('platform, query_count')
      .eq('org_id', orgId)
      .eq('month', month);
    for (const row of (data ?? []) as Array<{ platform: string; query_count: number | null }>) {
      const plat = normalizePlatform(row.platform);
      const n = row.query_count ?? 0;
      breakdown[plat] += n;
      used += n;
    }
  }
  return {
    used,
    limit,
    period_end: periodEnd(month),
    platform_breakdown: breakdown,
  };
}
