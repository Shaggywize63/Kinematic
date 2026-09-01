/**
 * Per-org AI domain context — config-driven, opt-in.
 *
 * Lets a tenant tailor the AI (Conversation Analysis persona + KINI copilot)
 * to its own industry and product catalogue WITHOUT code changes, by storing
 * two org_settings keys (org-wide, client_id IS NULL):
 *
 *   conversation_intel_persona : jsonb string (or {system}) used as the SYSTEM
 *                                prompt for Conversation Analysis. Absent →
 *                                the built-in default persona is used.
 *   ai_domain_context          : jsonb string (or {text}) appended to KINI's
 *                                system prompt as company/product knowledge.
 *                                Absent → nothing is appended.
 *
 * Both default to null, so tenants without these keys (e.g. the Tata prod
 * tenant) are completely unaffected.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';

async function readOrgSetting(orgId: string | undefined | null, key: string): Promise<unknown | null> {
  if (!orgId) return null;
  try {
    const { data } = await supabaseAdmin
      .from('org_settings')
      .select('value')
      .eq('org_id', orgId)
      .eq('key', key)
      .is('client_id', null)
      .maybeSingle();
    return (data as { value?: unknown } | null)?.value ?? null;
  } catch (e: any) {
    logger.warn(`[orgAiContext] read ${key} failed: ${e?.message || e}`);
    return null;
  }
}

/** Accept either a plain jsonb string or an object carrying the text in `prop`. */
function asText(v: unknown, prop: string): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    const inner = (v as Record<string, unknown>)[prop];
    if (typeof inner === 'string') return inner.trim() || null;
  }
  return null;
}

/** Tenant-specific Conversation Analysis SYSTEM prompt, or null to use the default. */
export async function getConversationPersona(orgId?: string | null): Promise<string | null> {
  return asText(await readOrgSetting(orgId, 'conversation_intel_persona'), 'system');
}

/** Tenant-specific company/product knowledge for KINI, or null to append nothing. */
export async function getKiniDomainContext(orgId?: string | null): Promise<string | null> {
  return asText(await readOrgSetting(orgId, 'ai_domain_context'), 'text');
}
