/**
 * KINI usage cap. One small abstraction over the kini_usage table so the
 * chat routes (CRM + legacy) call the same gate.
 *
 * Budget: ~$1 / user / month at current Anthropic pricing. With a blended
 * ~$0.014 / query (60% Sonnet, 40% Haiku), 20 queries / user / month leaves
 * a healthy buffer for over-runs. Override with KINI_MONTHLY_QUERY_CAP.
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

/** Read the current usage without incrementing. UI uses this. */
export async function getUsage(actor: UsageActor): Promise<UsageView> {
  const cap = monthlyCap();
  const month = currentMonth();
  const exempt = isExempt(actor);
  if (exempt || !actor.id) {
    return { used: 0, cap, remaining: cap, month, exempt };
  }
  const { data } = await supabaseAdmin.from('kini_usage')
    .select('query_count').eq('user_id', actor.id).eq('month', month).maybeSingle();
  const used = data?.query_count ?? 0;
  return { used, cap, remaining: Math.max(0, cap - used), month, exempt: false };
}

export interface QuotaCheck {
  allowed: boolean;
  used: number;
  cap: number;
  remaining: number;
  month: string;
  exempt: boolean;
}

/** Gate the request. Returns allowed=false when the user is at/over cap. */
export async function checkQuota(actor: UsageActor): Promise<QuotaCheck> {
  const view = await getUsage(actor);
  return {
    allowed: view.exempt || view.used < view.cap,
    used: view.used,
    cap: view.cap,
    remaining: view.remaining,
    month: view.month,
    exempt: view.exempt,
  };
}

/**
 * Increment the user's counter. Best-effort: never throws — a failed
 * counter increment must not block the conversation that just succeeded.
 *
 * Uses UPSERT-with-increment: insert at 1 on first call of the month,
 * bump on subsequent calls via the unique-index conflict path.
 */
export async function recordQuery(actor: UsageActor, tokens?: { input?: number; output?: number }): Promise<void> {
  if (isExempt(actor) || !actor.id || !actor.org_id) return;
  const month = currentMonth();
  const inputTok  = tokens?.input  ?? 0;
  const outputTok = tokens?.output ?? 0;
  try {
    // We can't do an atomic increment via supabase-js without an RPC, so
    // read-modify-write inside a single PostgREST call via the on-conflict
    // path: try insert at 1, fall back to update if the unique index hits.
    const insertRes = await supabaseAdmin.from('kini_usage').insert({
      user_id: actor.id, org_id: actor.org_id, month,
      query_count: 1, input_tokens: inputTok, output_tokens: outputTok,
      last_query_at: new Date().toISOString(),
    }).select('id').maybeSingle();
    if (!insertRes.error) return;
    // Conflict → existing row, increment
    if (insertRes.error.code === '23505') {
      const { data: cur } = await supabaseAdmin.from('kini_usage')
        .select('id, query_count, input_tokens, output_tokens')
        .eq('user_id', actor.id).eq('month', month).maybeSingle();
      if (cur) {
        await supabaseAdmin.from('kini_usage').update({
          query_count:  (cur.query_count  ?? 0) + 1,
          input_tokens: (cur.input_tokens ?? 0) + inputTok,
          output_tokens:(cur.output_tokens?? 0) + outputTok,
          last_query_at: new Date().toISOString(),
          updated_at:    new Date().toISOString(),
        }).eq('id', cur.id);
      }
    }
  } catch (e: any) {
    logger.warn(`[kiniQuota] recordQuery failed: ${e.message}`);
  }
}
