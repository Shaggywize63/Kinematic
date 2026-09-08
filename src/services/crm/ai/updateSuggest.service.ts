/**
 * Inline lead-update suggestions.
 *
 * Powers the ✨ Suggest button next to the "Add an update" box on the lead
 * detail screen (web + iOS + Android). When a rep types a free-text update
 * ("Met the customer, they want a quote for 200 bundles") this reads that
 * draft + a little lead context and proposes one-tap next steps:
 *
 *   - an activity to log (call / meeting / note / task / whatsapp, pre-filled
 *     subject + body, optional due date for a follow-up task)
 *   - a follow-up message to send (email / whatsapp / sms, pre-drafted)
 *   - 0-3 short "next action" chips
 *
 * Deliberately a single-shot Haiku call (cheap, fast, JSON-only) — NOT the
 * agentic chat loop — so the route does NOT consume the KINI monthly chat
 * quota. Parse failures degrade to an empty suggestion set rather than
 * surfacing an error, so the button never blocks the rep.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { complete as aiComplete } from './aiClient';

export interface UpdateSuggestion {
  activity: {
    type: 'call' | 'meeting' | 'note' | 'task' | 'whatsapp';
    subject: string;
    body: string;
    due_at: string | null;
  } | null;
  followup: {
    channel: 'email' | 'whatsapp' | 'sms';
    message: string;
  } | null;
  next_actions: string[];
}

const EMPTY: UpdateSuggestion = { activity: null, followup: null, next_actions: [] };

const SYSTEM = [
  'You are KINI, a CRM copilot helping a sales rep turn a free-text lead update into the next concrete CRM action.',
  'Given the rep\'s draft note and a little lead context, reply with ONLY a JSON object of this exact shape:',
  '{',
  '  "activity": { "type": "call|meeting|note|task|whatsapp", "subject": "string", "body": "string", "due_at": "ISO-8601 or null" } | null,',
  '  "followup": { "channel": "email|whatsapp|sms", "message": "string" } | null,',
  '  "next_actions": ["short imperative", ...]',
  '}',
  'Rules:',
  '- "activity" = the single best activity to LOG for what the rep just described. If the note describes something that already happened (a call, a visit), use that type with status implied completed. If it implies a future to-do ("call back next week"), use "task" and set due_at. If nothing is worth logging, use null.',
  '- "followup" = a ready-to-send follow-up message IF the note implies the customer is waiting on the rep (a quote, info, a callback). Draft it in the customer\'s likely language (Hindi/English are common). Otherwise null.',
  '- "next_actions" = up to 3 very short next steps (≤6 words each), e.g. "Send the quote", "Schedule a site visit". Empty array if none.',
  '- Keep subjects ≤ 60 chars. Be specific to the note; never invent facts not implied by it.',
  '- Output JSON only — no prose, no markdown fences.',
].join('\n');

const ACTIVITY_TYPES = ['call', 'meeting', 'note', 'task', 'whatsapp'] as const;
type ActivityType = (typeof ACTIVITY_TYPES)[number];

function clampType(t: unknown): ActivityType {
  const s = String(t || '').toLowerCase();
  return (ACTIVITY_TYPES as readonly string[]).includes(s) ? (s as ActivityType) : 'note';
}

function coerce(raw: unknown): UpdateSuggestion {
  if (!raw || typeof raw !== 'object') return EMPTY;
  const o = raw as Record<string, unknown>;

  let activity: UpdateSuggestion['activity'] = null;
  if (o.activity && typeof o.activity === 'object') {
    const a = o.activity as Record<string, unknown>;
    const subject = String(a.subject || '').trim().slice(0, 120);
    if (subject) {
      activity = {
        type: clampType(a.type),
        subject,
        body: String(a.body || '').trim().slice(0, 2000),
        due_at: typeof a.due_at === 'string' && a.due_at ? a.due_at : null,
      };
    }
  }

  let followup: UpdateSuggestion['followup'] = null;
  if (o.followup && typeof o.followup === 'object') {
    const f = o.followup as Record<string, unknown>;
    const message = String(f.message || '').trim().slice(0, 2000);
    const channelRaw = String(f.channel || 'email').toLowerCase();
    const channel = (['email', 'whatsapp', 'sms'].includes(channelRaw) ? channelRaw : 'email') as 'email' | 'whatsapp' | 'sms';
    if (message) followup = { channel, message };
  }

  const next_actions = Array.isArray(o.next_actions)
    ? o.next_actions.map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
    : [];

  return { activity, followup, next_actions };
}

export async function suggestFromUpdate(
  org_id: string,
  client_id: string | null,
  lead_id: string,
  draft: string,
): Promise<UpdateSuggestion> {
  const text = (draft || '').trim();
  if (!text) return EMPTY;

  // Pull just enough lead context to ground the suggestion. Client scope is
  // enforced by org_id + the lead's own row; we never echo other clients'
  // data into the prompt.
  let lead: Record<string, unknown> | null = null;
  let recentActivities: unknown[] = [];
  try {
    const leadQ = supabaseAdmin
      .from('crm_leads')
      .select('id, first_name, last_name, company, status, source, latest_update, city')
      .eq('org_id', org_id)
      .eq('id', lead_id);
    if (client_id) leadQ.eq('client_id', client_id);
    const { data: leadRow } = await leadQ.maybeSingle();
    lead = leadRow as Record<string, unknown> | null;

    const { data: acts } = await supabaseAdmin
      .from('crm_activities')
      .select('type, subject, status, completed_at')
      .eq('org_id', org_id)
      .eq('lead_id', lead_id)
      .order('created_at', { ascending: false })
      .limit(5);
    recentActivities = acts || [];
  } catch {
    /* context is best-effort — fall through with whatever we have */
  }

  let parsed: unknown;
  try {
    const out = await aiComplete({
      org_id,
      model: process.env.CRM_NBA_MODEL || 'claude-haiku-4-5',
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            draft_update: text,
            lead: lead
              ? {
                  name: `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim(),
                  company: lead.company ?? null,
                  status: lead.status ?? null,
                  city: lead.city ?? null,
                }
              : null,
            recent_activities: recentActivities,
          }),
        },
      ],
      max_tokens: 500,
    });
    // Strip any accidental ```json fences before parsing.
    const cleaned = out.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return EMPTY;
  }

  return coerce(parsed);
}
