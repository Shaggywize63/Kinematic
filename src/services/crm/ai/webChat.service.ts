/**
 * Website chatbot (KINI) — public conversation capture + lead creation.
 *
 * The marketing website (kinematicapp.com) runs a public AI chatbot ("KINI")
 * that talks to anonymous visitors. Each turn, the website's server-side proxy
 * (kini-chat.php) POSTs the whole conversation here so that:
 *   1. Every visitor turn + KINI reply is stored and visible in the dashboard.
 *   2. As soon as KINI has collected enough contact info (a name AND an email
 *      or phone), we create a real CRM lead — reusing findOrCreateLead so the
 *      lead inherits dedup, owner-assignment, scoring and the lead_created
 *      automation for free, exactly like a web-form or Meta lead.
 *
 * This service is tenant-fixed: the whole feature lives in ONE org (the
 * Kinematic marketing tenant). The caller (the public route) has already
 * switched the request onto the Kinematic Supabase project via runWithProject,
 * so `supabaseAdmin` here points at that project.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { findOrCreateLead } from '../integrations/dedup.orchestrator';
import type { NormalizedLead } from '../integrations/dedup.orchestrator';
import { logger } from '../../../lib/logger';

const SOURCE_NAME = 'KINI AI';

export interface WebChatTurn {
  role: 'visitor' | 'kini';
  content: string;
  ts?: string;
}

export interface WebChatVisitor {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  team_size?: string | null;
  interest?: string | null;
  city?: string | null;
  /** For a demo/call request: the visitor's preferred day + time slot. */
  preferred_time?: string | null;
}

export interface WebChatIngestInput {
  session_key: string;
  transcript: WebChatTurn[];
  visitor?: WebChatVisitor;
  page?: { url?: string | null; path?: string | null; title?: string | null };
  referrer_url?: string | null;
  landing_page?: string | null;
  utm?: { source?: string | null; medium?: string | null; campaign?: string | null };
  user_agent?: string | null;
}

export interface WebChatIngestResult {
  session_id: string;
  lead_id: string | null;
  lead_created: boolean;
}

/** Resolve the org that owns the website chatbot. Env override first, then the
 *  organisation literally named "Kinematic" (the marketing tenant). */
async function resolveOrgId(): Promise<string | null> {
  const envOrg = (process.env.KINI_WEB_CHAT_ORG_ID || '').trim();
  if (envOrg) return envOrg;
  const { data } = await supabaseAdmin
    .from('organisations')
    .select('id')
    .ilike('name', 'Kinematic')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/** Get-or-create the "Website Chatbot (KINI)" lead source for this org. */
async function resolveSourceId(orgId: string): Promise<string | null> {
  const { data: existing } = await supabaseAdmin
    .from('crm_lead_sources')
    .select('id')
    .eq('org_id', orgId)
    .eq('name', SOURCE_NAME)
    .maybeSingle();
  if ((existing as { id?: string } | null)?.id) return (existing as { id: string }).id;

  const { data: created, error } = await supabaseAdmin
    .from('crm_lead_sources')
    .insert({ org_id: orgId, name: SOURCE_NAME, is_active: true })
    .select('id')
    .single();
  if (error) {
    logger.error({ orgId, err: error.message }, 'webChat: lead-source create failed');
    return null;
  }
  return (created as { id: string }).id;
}

function splitName(full?: string | null): { first: string | null; last: string | null } {
  const t = (full || '').trim();
  if (!t) return { first: null, last: null };
  const parts = t.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** Coalesce a freshly-collected value over the stored one (non-empty wins). */
function coalesce(next?: string | null, prev?: string | null): string | null {
  const n = (next ?? '').trim();
  if (n) return n;
  const p = (prev ?? '').trim();
  return p || null;
}

/**
 * Upsert a conversation and, when eligible, create the lead. Idempotent per
 * session_key: the website always POSTs the full transcript, so we replace it
 * wholesale rather than appending (no message-dedup, no race).
 */
export async function ingestWebChat(input: WebChatIngestInput): Promise<WebChatIngestResult> {
  const orgId = await resolveOrgId();
  if (!orgId) throw new Error('webChat: could not resolve org');

  const sessionKey = String(input.session_key || '').slice(0, 200);
  if (!sessionKey) throw new Error('webChat: session_key required');

  const transcript: WebChatTurn[] = Array.isArray(input.transcript)
    ? input.transcript
        .filter((t) => t && (t.role === 'visitor' || t.role === 'kini') && typeof t.content === 'string')
        .map((t) => ({ role: t.role, content: String(t.content).slice(0, 8000), ts: t.ts }))
        .slice(-100)
    : [];

  const v = input.visitor ?? {};
  const nowIso = new Date().toISOString();

  // Load any existing row so we merge visitor info instead of clobbering it
  // (KINI may re-send with a field newly filled or newly blank).
  const { data: prev } = await supabaseAdmin
    .from('crm_web_chat_sessions')
    .select('id, lead_id, visitor_name, visitor_email, visitor_phone, visitor_company, team_size, interest, city, preferred_time')
    .eq('org_id', orgId)
    .eq('session_key', sessionKey)
    .maybeSingle();
  const prevRow = prev as Record<string, string | null> | null;

  const merged = {
    visitor_name: coalesce(v.name, prevRow?.visitor_name),
    visitor_email: coalesce(v.email, prevRow?.visitor_email),
    visitor_phone: coalesce(v.phone, prevRow?.visitor_phone),
    visitor_company: coalesce(v.company, prevRow?.visitor_company),
    team_size: coalesce(v.team_size, prevRow?.team_size),
    interest: coalesce(v.interest, prevRow?.interest),
    city: coalesce(v.city, prevRow?.city),
    preferred_time: coalesce(v.preferred_time, prevRow?.preferred_time),
  };

  let leadId: string | null = prevRow?.lead_id ?? null;
  let leadCreated = false;

  // Eligible to become a lead: a name and at least one contact channel, and no
  // lead created for this session yet.
  const eligible = !!merged.visitor_name && (!!merged.visitor_email || !!merged.visitor_phone);
  if (eligible && !leadId) {
    try {
      const sourceId = await resolveSourceId(orgId);
      if (sourceId) {
        const { first, last } = splitName(merged.visitor_name);
        const notesParts: string[] = ['Captured by KINI website chatbot.'];
        if (merged.team_size) notesParts.push(`Team size: ${merged.team_size}`);
        if (merged.interest) notesParts.push(`Interest: ${merged.interest}`);
        if (merged.preferred_time) notesParts.push(`Preferred demo slot: ${merged.preferred_time}`);
        if (input.page?.url) notesParts.push(`Chatting on: ${input.page.url}`);

        const normalized: NormalizedLead = {
          first_name: first,
          last_name: last,
          email: merged.visitor_email,
          phone: merged.visitor_phone,
          company: merged.visitor_company,
          city: merged.city,
          notes: notesParts.join(' | '),
          referrer_url: input.referrer_url ?? null,
          landing_page: input.landing_page ?? input.page?.url ?? null,
          utm_source: input.utm?.source ?? null,
          utm_medium: input.utm?.medium ?? null,
          utm_campaign: input.utm?.campaign ?? null,
          tags: ['kini-chatbot'],
        };
        const r = await findOrCreateLead({ org_id: orgId, source_id: sourceId, normalized });
        leadId = r.lead_id;
        leadCreated = r.was_new;
      }
    } catch (e) {
      // Never fail the conversation store just because lead creation hiccuped.
      logger.error({ err: (e as Error).message, sessionKey }, 'webChat: lead create failed');
    }
  }

  const row = {
    org_id: orgId,
    session_key: sessionKey,
    status: leadId ? 'lead_captured' : 'active',
    ...merged,
    page_url: input.page?.url ?? null,
    page_path: input.page?.path ?? null,
    page_title: input.page?.title ?? null,
    referrer_url: input.referrer_url ?? null,
    landing_page: input.landing_page ?? null,
    utm_source: input.utm?.source ?? null,
    utm_medium: input.utm?.medium ?? null,
    utm_campaign: input.utm?.campaign ?? null,
    transcript,
    message_count: transcript.length,
    lead_id: leadId,
    lead_created_at: leadId && !prevRow?.lead_id ? nowIso : undefined,
    user_agent: (input.user_agent ?? '').slice(0, 400) || null,
    last_seen_at: nowIso,
    updated_at: nowIso,
  };

  const { data: saved, error } = await supabaseAdmin
    .from('crm_web_chat_sessions')
    .upsert(row, { onConflict: 'org_id,session_key' })
    .select('id')
    .single();
  if (error) throw new Error(`webChat upsert failed: ${error.message}`);

  return { session_id: (saved as { id: string }).id, lead_id: leadId, lead_created: leadCreated };
}

// ── Dashboard read paths (authenticated) ─────────────────────────────────

export interface WebChatListRow {
  id: string;
  visitor_name: string | null;
  visitor_email: string | null;
  visitor_phone: string | null;
  visitor_company: string | null;
  interest: string | null;
  page_path: string | null;
  page_title: string | null;
  status: string;
  message_count: number;
  lead_id: string | null;
  last_seen_at: string;
  created_at: string;
}

export async function listWebChats(
  orgId: string,
  opts: { limit?: number; offset?: number; search?: string } = {},
): Promise<{ rows: WebChatListRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  let q = supabaseAdmin
    .from('crm_web_chat_sessions')
    .select(
      'id, visitor_name, visitor_email, visitor_phone, visitor_company, interest, page_path, page_title, status, message_count, lead_id, last_seen_at, created_at',
      { count: 'exact' },
    )
    .eq('org_id', orgId)
    .order('last_seen_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const s = (opts.search || '').trim();
  if (s) {
    const like = `%${s.replace(/[%,()*]/g, '')}%`;
    q = q.or(
      `visitor_name.ilike.${like},visitor_email.ilike.${like},visitor_phone.ilike.${like},visitor_company.ilike.${like}`,
    );
  }

  const { data, error, count } = await q;
  if (error) throw new Error(error.message);
  return { rows: (data as WebChatListRow[]) ?? [], total: count ?? 0 };
}

export async function getWebChat(orgId: string, id: string) {
  const { data, error } = await supabaseAdmin
    .from('crm_web_chat_sessions')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
