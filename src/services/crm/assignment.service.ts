/**
 * Lead assignment rule engine. Walks active rules in priority order;
 * first matching rule wins. Supports round-robin via crm_settings cursor.
 */
import { supabaseAdmin } from '../../lib/supabase';
import type { Lead } from '../../types/crm.types';

export async function assignOwner(org_id: string, lead: Partial<Lead>): Promise<string | null> {
  const { data: rules } = await supabaseAdmin.from('crm_lead_assignment_rules')
    .select('*').eq('org_id', org_id).eq('is_active', true).order('priority', { ascending: true });
  if (!rules) return await defaultOwner(org_id);

  for (const rule of rules) {
    if (matches(lead, rule.criteria)) {
      if (rule.assign_to_user_id) return rule.assign_to_user_id;
      if (rule.round_robin_pool && Array.isArray(rule.round_robin_pool) && rule.round_robin_pool.length > 0) {
        const next = await rotateRoundRobin(org_id, rule.id, rule.round_robin_pool as string[]);
        return next;
      }
    }
  }
  return await defaultOwner(org_id);
}

function matches(lead: Partial<Lead>, criteria: Record<string, unknown> | null | undefined): boolean {
  if (!criteria || Object.keys(criteria).length === 0) return true;
  for (const [k, v] of Object.entries(criteria)) {
    if (k === 'score_gte' && typeof v === 'number') {
      if ((lead.score ?? 0) < v) return false;
    } else if (Array.isArray(v)) {
      const fieldVal = (lead as Record<string, unknown>)[k];
      if (!v.includes(fieldVal as never)) return false;
    } else {
      if ((lead as Record<string, unknown>)[k] !== v) return false;
    }
  }
  return true;
}

async function rotateRoundRobin(org_id: string, rule_id: string, pool: string[]): Promise<string> {
  const key = `rr:${rule_id}`;
  const { data } = await supabaseAdmin.from('crm_settings').select('config').eq('org_id', org_id).maybeSingle();
  const cfg = (data?.config as Record<string, unknown>) ?? {};
  const lastIdx = typeof cfg[key] === 'number' ? (cfg[key] as number) : -1;
  const nextIdx = (lastIdx + 1) % pool.length;
  cfg[key] = nextIdx;
  await supabaseAdmin.from('crm_settings').upsert({ org_id, config: cfg }, { onConflict: 'org_id' });
  return pool[nextIdx];
}

async function defaultOwner(org_id: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('crm_settings').select('config').eq('org_id', org_id).maybeSingle();
  const cfg = (data?.config as Record<string, unknown>) ?? {};
  return (cfg.default_owner_id as string) ?? null;
}
