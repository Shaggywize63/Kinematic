/**
 * Voice/text → lead fields. Takes a short spoken (or typed) description of a
 * prospect — e.g. "Rajesh Kumar from Acme Steel, mobile nine eight …, wants TMT
 * bars in Pune" — and returns the structured lead fields so the apps can open
 * Create Lead pre-filled. This is the "add a lead by voice with KINI" backend.
 *
 * Mirrors cardScan.service.ts: a single-shot Anthropic /messages call with the
 * shared functional key, Haiku by default, and a degrade-to-empty parse so the
 * feature never hard-errors — a bad transcript just yields a blank form the rep
 * fills in. It is NOT a KINI chat turn, so it deliberately does not touch
 * gateAi / kiniQuota (mirrors suggest-from-update).
 *
 * The tenant's active lead custom-field definitions are injected into the
 * prompt so the model can also fill admin-defined fields by their key.
 */
import { AppError } from '../../../utils';
import { AIService } from '../../ai.service';
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';

export interface ExtractedLead {
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  alternate_mobiles: string[] | null;
  email: string | null;
  company: string | null;
  title: string | null;
  industry: string | null;
  // B2C / person-oriented
  date_of_birth: string | null; // YYYY-MM-DD when derivable
  gender: 'male' | 'female' | 'other' | 'prefer_not_to_say' | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  preferred_contact_method: 'email' | 'phone' | 'whatsapp' | 'sms' | null;
  // Free-text catch-all for anything spoken that doesn't map to a field.
  notes: string | null;
  // A source *hint* (e.g. "referral", "exhibition") — the client fuzzy-matches
  // it to its own source list; never a source_id.
  source_hint: string | null;
  // Admin-defined custom fields, keyed by field_key.
  custom_fields: Record<string, string> | null;
}

const EMPTY: ExtractedLead = {
  first_name: null, last_name: null, phone: null, alternate_mobiles: null,
  email: null, company: null, title: null, industry: null,
  date_of_birth: null, gender: null, address_line1: null, city: null,
  state: null, postal_code: null, country: null, preferred_contact_method: null,
  notes: null, source_hint: null, custom_fields: null,
};

function str(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim() : '';
  return t || null;
}

// Normalise an Indian mobile to the 10-digit form the lead schema requires
// (^\d{10}$). Drops country code / spaces / punctuation and keeps the last 10
// digits; returns null if it can't produce exactly 10.
function phone10(v: unknown): string | null {
  const digits = (typeof v === 'string' ? v : '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

const GENDERS = new Set(['male', 'female', 'other', 'prefer_not_to_say']);
const CHANNELS = new Set(['email', 'phone', 'whatsapp', 'sms']);

interface LeadCustomDef { field_key: string; label: string; field_type: string; options: unknown }

async function leadCustomDefs(orgId: string, clientId: string | null): Promise<LeadCustomDef[]> {
  try {
    let q = supabaseAdmin
      .from('crm_custom_field_defs')
      .select('field_key,label,field_type,options,is_active,client_id')
      .eq('org_id', orgId)
      .eq('entity_type', 'lead')
      .eq('is_active', true);
    // Shared (client_id null) OR this client's fields.
    q = clientId ? q.or(`client_id.is.null,client_id.eq.${clientId}`) : q.is('client_id', null);
    const { data, error } = await q;
    if (error) { logger.warn(`[extract-lead] custom-def fetch failed: ${error.message}`); return []; }
    return (data || []).map((d) => ({
      field_key: String(d.field_key), label: String(d.label || d.field_key),
      field_type: String(d.field_type || 'text'), options: d.options,
    }));
  } catch (e) {
    logger.warn(`[extract-lead] custom-def fetch threw: ${(e as Error)?.message || e}`);
    return [];
  }
}

function buildSystem(isB2C: boolean, defs: LeadCustomDef[]): string {
  const persona = isB2C
    ? 'The lead is a B2C consumer. Prioritise the person\'s name, phone, city/state and any personal preferences.'
    : 'The lead is a B2B business contact. Prioritise the person\'s name, company, title, industry, phone and city.';
  const customBlock = defs.length
    ? [
        'The tenant also has these admin-defined custom lead fields. If the transcript clearly states a value for one, put it in "custom_fields" keyed by field_key (use the option label verbatim for select types):',
        ...defs.slice(0, 40).map((d) => `- ${d.field_key} (${d.field_type}): ${d.label}`),
      ].join('\n')
    : 'This tenant has no custom lead fields; omit "custom_fields" or set it to {}.';
  return [
    'You extract structured CRM lead fields from a short spoken description a salesperson dictated. Speech-to-text may contain small errors and spelled-out digits ("nine eight" → 98).',
    persona,
    'Return ONLY a JSON object of this exact shape (use null for anything not stated — NEVER invent data):',
    '{',
    '  "first_name": string|null, "last_name": string|null,',
    '  "phone": string|null, "alternate_mobiles": string[]|null,',
    '  "email": string|null, "company": string|null, "title": string|null, "industry": string|null,',
    '  "date_of_birth": string|null, "gender": "male"|"female"|"other"|"prefer_not_to_say"|null,',
    '  "address_line1": string|null, "city": string|null, "state": string|null, "postal_code": string|null, "country": string|null,',
    '  "preferred_contact_method": "email"|"phone"|"whatsapp"|"sms"|null,',
    '  "source_hint": string|null, "notes": string|null,',
    '  "custom_fields": { [field_key: string]: string }|null',
    '}',
    'Rules:',
    '- Split the person\'s name into first_name / last_name; if only one token, put it in first_name.',
    '- phone / alternate_mobiles: digits only, 10-digit Indian mobiles (strip +91, 0, spaces). Convert spelled-out digits to numerals.',
    '- date_of_birth as YYYY-MM-DD only if a full date is stated; otherwise null.',
    '- notes: put anything relevant the rep said that has no field of its own (product interest, requirement, budget, timeline).',
    '- source_hint: how the lead came in if mentioned (referral, exhibition, website, walk-in, cold call) — a short lowercase phrase, else null.',
    customBlock,
    'Output JSON only — no prose, no markdown fences.',
  ].join('\n');
}

export async function extractLead(
  transcript: string,
  isB2C: boolean,
  orgId: string,
  clientId: string | null,
): Promise<ExtractedLead> {
  const text = (transcript || '').trim();
  if (!text) return { ...EMPTY };

  const defs = await leadCustomDefs(orgId, clientId);
  const system = buildSystem(isB2C, defs);
  const allowedKeys = new Set(defs.map((d) => d.field_key));

  // Single-shot Haiku via the shared self-healing helper (404 → servable model).
  // Not a chat turn: no gateAi / recordQuery.
  const raw = await AIService.callKiniAI({
    system,
    model: process.env.CRM_LEAD_EXTRACT_MODEL || process.env.CARD_SCAN_MODEL || 'claude-haiku-4-5',
    max_tokens: 700,
    messages: [{ role: 'user', content: `Transcript:\n"""${text.slice(0, 4000)}"""\n\nExtract the lead fields. JSON only.` }],
  }).catch((e: unknown) => {
    // Surface auth/limit errors (e.g. the monthly usage cap) so the client can
    // show a real message; everything else degrades to an empty form.
    if (e instanceof AppError) throw e;
    logger.warn(`[extract-lead] upstream failed: ${(e as Error)?.message || e}`);
    return '';
  });

  if (!raw) return { ...EMPTY };

  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return { ...EMPTY };
    const p = JSON.parse(raw.substring(start, end + 1));

    const gender = str(p.gender)?.toLowerCase() ?? null;
    const channel = str(p.preferred_contact_method)?.toLowerCase() ?? null;
    const alts = Array.isArray(p.alternate_mobiles)
      ? (p.alternate_mobiles.map(phone10).filter(Boolean) as string[])
      : null;

    // Keep only custom_fields whose key is a real active def for this tenant.
    let custom: Record<string, string> | null = null;
    if (p.custom_fields && typeof p.custom_fields === 'object') {
      const kept: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.custom_fields as Record<string, unknown>)) {
        const val = str(v);
        if (val && allowedKeys.has(k)) kept[k] = val;
      }
      if (Object.keys(kept).length) custom = kept;
    }

    return {
      first_name: str(p.first_name),
      last_name: str(p.last_name),
      phone: phone10(p.phone),
      alternate_mobiles: alts && alts.length ? alts : null,
      email: str(p.email)?.toLowerCase() ?? null,
      company: str(p.company),
      title: str(p.title),
      industry: str(p.industry),
      date_of_birth: /^\d{4}-\d{2}-\d{2}$/.test(str(p.date_of_birth) || '') ? str(p.date_of_birth) : null,
      gender: gender && GENDERS.has(gender) ? (gender as ExtractedLead['gender']) : null,
      address_line1: str(p.address_line1),
      city: str(p.city),
      state: str(p.state),
      postal_code: str(p.postal_code),
      country: str(p.country),
      preferred_contact_method: channel && CHANNELS.has(channel) ? (channel as ExtractedLead['preferred_contact_method']) : null,
      notes: str(p.notes),
      source_hint: str(p.source_hint)?.toLowerCase() ?? null,
      custom_fields: custom,
    };
  } catch (err) {
    logger.warn(`[extract-lead] parse failed: ${(err as Error)?.message || err}`);
    return { ...EMPTY };
  }
}
