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

/**
 * Resolve a tenant-specific Anthropic API key for this org, or null to fall back
 * to the shared/global key (AIService.getFunctionalKey). The org_settings key
 * `anthropic_key_env` holds the NAME of an environment variable (e.g.
 * "ANTHROPIC_API_KEY_KONICA") — the secret value itself lives only in the
 * process environment (Railway secret store), never in the database. Used so a
 * tenant's Conversation Analysis + KINI usage bills to a dedicated key/workspace.
 * Returns null (→ shared key) when unset or misconfigured, so other tenants
 * (e.g. the Tata prod tenant) are completely unaffected.
 */
export async function getOrgAnthropicKey(orgId?: string | null): Promise<string | null> {
  const envName = asText(await readOrgSetting(orgId, 'anthropic_key_env'), 'name');
  if (!envName) return null;
  // Defensive: only ever read an env var explicitly namespaced for Anthropic
  // keys, so a stray/tampered org_settings value can never surface an unrelated
  // secret (DB creds, service keys, …).
  if (!/^ANTHROPIC_[A-Z0-9_]{1,64}$/.test(envName)) {
    logger.warn(`[orgAiContext] ignoring unsafe anthropic_key_env "${envName}" for org ${orgId}`);
    return null;
  }
  const val = process.env[envName];
  return val && val.trim() ? val.trim() : null;
}
