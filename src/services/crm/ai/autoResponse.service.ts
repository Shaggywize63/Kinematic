/**
 * Auto-response email drafter. Claude Sonnet. Always returns a draft;
 * never auto-sends.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { complete as aiComplete } from './aiClient';
import { AppError } from '../../../utils';

// Default model for the email drafting/template flows. We deliberately fall
// back to the same Haiku 4.5 model that every *working* CRM AI feature uses
// (lead scoring, WhatsApp drafting, summaries, NBA). The previous default
// `claude-sonnet-4-6` is not callable with this deployment's Anthropic key —
// it 404'd as model_not_found, surfacing only as a generic "AI request
// failed", which is why both the reply drafter and template generator
// silently produced nothing. Override per-env with CRM_AUTO_RESPONSE_MODEL.
const EMAIL_AI_MODEL = process.env.CRM_AUTO_RESPONSE_MODEL || 'claude-haiku-4-5-20251001';

export interface DraftReplyInput {
  org_id: string;
  user_id?: string;
  lead_id?: string | null;
  deal_id?: string | null;
  contact_id?: string | null;
  incoming_message?: string;
  intent: string;
  tone: 'friendly' | 'formal' | 'concise';
  template_hint?: string;
}

export interface DraftReplyOutput {
  subject: string;
  body_text: string;
  body_html: string;
  suggested_send_time: string;
  follow_up_recommendation: string;
}

const SYSTEM_PROMPT = `You are an experienced SDR/AE drafting outbound and reply emails.
Match the requested tone. Be concrete, reference the prospect's role and company. Use ONE clear CTA.
Output JSON ONLY:
{"subject": str, "body_text": str, "body_html": str,
 "suggested_send_time": ISO8601, "follow_up_recommendation": str}.
Never include placeholders like [NAME] — use real values. If info is missing, omit gracefully.`;

export async function draftReply(input: DraftReplyInput): Promise<DraftReplyOutput> {
  const { org_id } = input;
  const ctx: Record<string, unknown> = { intent: input.intent, tone: input.tone };

  if (input.lead_id) {
    const { data } = await supabaseAdmin.from('crm_leads').select('*')
      .eq('org_id', org_id).eq('id', input.lead_id).maybeSingle();
    if (data) ctx.lead = data;
  }
  if (input.contact_id) {
    const { data } = await supabaseAdmin.from('crm_contacts').select('*')
      .eq('org_id', org_id).eq('id', input.contact_id).maybeSingle();
    if (data) ctx.contact = data;
  }
  if (input.deal_id) {
    const { data } = await supabaseAdmin.from('crm_deals').select('*')
      .eq('org_id', org_id).eq('id', input.deal_id).maybeSingle();
    if (data) {
      ctx.deal = data;
      if (data.account_id) {
        const { data: a } = await supabaseAdmin.from('crm_accounts').select('*')
          .eq('id', data.account_id).maybeSingle();
        ctx.account = a;
      }
    }
  }
  if (input.incoming_message) ctx.incoming_message = input.incoming_message;
  if (input.template_hint) ctx.template_hint = input.template_hint;

  const refTable = input.deal_id ? 'crm_activities' : null;
  if (refTable) {
    const { data: recent } = await supabaseAdmin.from('crm_activities')
      .select('type, subject, body, completed_at')
      .eq('org_id', org_id).eq('deal_id', input.deal_id!)
      .order('completed_at', { ascending: false }).limit(5);
    ctx.recent_activities = recent ?? [];
  }

  const response = await aiComplete({
    org_id,
    model: EMAIL_AI_MODEL,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(ctx) }],
    max_tokens: 1200,
  });

  const json = JSON.parse(extractJson(response));
  return {
    subject: String(json.subject ?? '').slice(0, 300),
    body_text: String(json.body_text ?? ''),
    body_html: String(json.body_html ?? `<p>${escapeHtml(json.body_text ?? '')}</p>`),
    suggested_send_time: String(json.suggested_send_time ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()),
    follow_up_recommendation: String(json.follow_up_recommendation ?? 'Follow up in 3 business days if no reply.'),
  };
}

// ---------------------------------------------------------------------------
// Email TEMPLATE generation (distinct from reply drafting above).
//
// The reply drafter is lead/deal-centric and is told to use *real values, no
// placeholders* — wrong for a reusable template. This path is purpose-built:
// it asks for a marketing/transactional template with {{snake_case}}
// placeholders, returns a clean structured object, and is tolerant of the
// model wrapping its JSON in prose/code fences. Used by the dashboard
// "KINI AI Generate" template flow.
// ---------------------------------------------------------------------------

export interface DraftEmailTemplateInput {
  org_id: string;
  goal: string;
  tone?: 'friendly' | 'formal' | 'concise';
  audience?: string;
  language?: string; // ISO code; 'en' default
}

export interface DraftEmailTemplateOutput {
  name: string;
  subject: string;
  body_html: string;
  body_text: string;
  variables: string[];
  category: string;
}

const TEMPLATE_SYSTEM_PROMPT = `You are an expert email marketer drafting a REUSABLE email template.
Use {{snake_case}} placeholders for any value that changes per recipient (e.g. {{first_name}}, {{company}}, {{city}}).
Keep one clear call-to-action. Write clean, mobile-friendly, inline-styled HTML.

STRICT FORMATTING RULES — non-negotiable:
 - DO NOT wrap the body in <html>, <head> or <body>. Just the inner HTML.
 - DO NOT include <script>, <style>, <link>, <meta>, <iframe>, or <object> tags.
 - DO NOT use React, JSX, Vue, Svelte, custom components (e.g. <TweakSection>, <EmailTweaks>),
   ReactDOM.createRoot(...), useState/useEffect, or any client-side framework code.
   Emails cannot execute JavaScript. Any such output will be rejected.
 - DO NOT escape the HTML — return RAW HTML inside the JSON body_html string.
   For example return "<p>Hello</p>", NOT "<p>Hello<\\/p>" and NOT "\\u003cp\\u003eHello\\u003c\\/p\\u003e".

Output JSON ONLY — no prose, no markdown, no code fences — with EXACTLY these keys:
{
  "name": short template name, max 60 chars,
  "subject": email subject line, may include placeholders,
  "body_html": the HTML body (RAW HTML, not escaped),
  "body_text": a plain-text version of the same email,
  "variables": array of the placeholder names you used, e.g. ["first_name","company"],
  "category": one of "sales" | "follow_up" | "onboarding" | "support" | "marketing"
}`;

export async function draftEmailTemplate(input: DraftEmailTemplateInput): Promise<DraftEmailTemplateOutput> {
  const langName = LANG_NAMES[(input.language || 'en').toLowerCase()] || null;
  const langLine = langName && langName !== 'English'
    ? `\nWrite the subject and body in ${langName}. Keep the {{placeholder}} tokens in English (do not translate them).`
    : '';

  const userMsg = [
    `Goal / description: ${input.goal}`,
    `Tone: ${input.tone || 'friendly'}`,
    input.audience ? `Audience: ${input.audience}` : '',
    langLine,
    'Return JSON only.',
  ].filter(Boolean).join('\n');

  const response = await aiComplete({
    org_id: input.org_id,
    model: EMAIL_AI_MODEL,
    system: TEMPLATE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
    max_tokens: 1800,
  });

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(extractJson(response)) as Record<string, unknown>;
  } catch {
    throw new AppError(502, 'AI returned an unparseable response — try rephrasing the goal.', 'AI_BAD_RESPONSE');
  }

  const bodyTextRaw = String(json.body_text ?? '');
  const bodyHtmlRaw = String(json.body_html ?? (bodyTextRaw ? `<p>${escapeHtml(bodyTextRaw)}</p>` : ''));
  // The model sometimes double-JSON-encodes its body (the output JSON contains
  // body_html which is itself a JSON-encoded string of the HTML). The textarea
  // then shows literal "\n", "\"", "/" instead of real newlines / quotes /
  // slashes. Detect that, decode it, then strip React/JSX/script noise that
  // emails can't execute anyway. See KINI-EMAIL-TEMPLATE issue 2026-06-24.
  const bodyHtml = sanitiseEmailHtml(decodeIfDoubleEscaped(bodyHtmlRaw));
  const bodyText = decodeIfDoubleEscaped(bodyTextRaw);
  if (!bodyHtml.trim() && !bodyText.trim()) {
    throw new AppError(502, 'AI did not return a usable email body — try a more specific goal.', 'AI_EMPTY_RESPONSE');
  }

  // Prefer the model's declared variables; fall back to scanning the HTML so
  // the editor always shows the placeholders that are actually present.
  const declared = Array.isArray(json.variables) ? (json.variables as unknown[]).map(String) : [];
  const scanned = scanPlaceholders(`${json.subject ?? ''} ${bodyHtml} ${bodyText}`);
  const variables = Array.from(new Set([...declared, ...scanned]));

  const allowedCats = ['sales', 'follow_up', 'onboarding', 'support', 'marketing'];
  const category = allowedCats.includes(String(json.category)) ? String(json.category) : 'marketing';

  return {
    name: String(json.name ?? input.goal).slice(0, 60),
    subject: String(json.subject ?? '').slice(0, 300),
    body_html: bodyHtml,
    body_text: bodyText,
    variables,
    category,
  };
}

const LANG_NAMES: Record<string, string> = {
  en: 'English', hi: 'Hindi (Devanagari)', or: 'Odia (Oriya)', bn: 'Bengali', as: 'Assamese',
};

function scanPlaceholders(s: string): string[] {
  const set = new Set<string>();
  for (const m of s.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) set.add(m[1]);
  return Array.from(set);
}

function extractJson(s: string): string {
  // Strip code fences first, then grab the outermost {...} block.
  const fenced = s.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) return fenced[1];
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : '{}';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' } as Record<string, string>)[c]);
}

/**
 * If the model double-JSON-encoded its HTML body (so the value carries literal
 * "\n", "\"" and "/" sequences instead of real newlines / quotes / slashes)
 * decode it once. Heuristic: the string contains at least one of those
 * sequences AND lacks the matching real character that would normally be
 * present in raw HTML (real newline / closing-tag slash). Idempotent — a
 * cleanly-encoded HTML string passes through unchanged.
 */
function decodeIfDoubleEscaped(s: string): string {
  if (!s) return s;
  const hasLiteralEscape = /\\n|\\"|\\u00[0-9a-fA-F]{2}|\\\//.test(s);
  if (!hasLiteralEscape) return s;
  // Cheap and safe path: wrap in quotes and JSON-parse. If the input isn't a
  // valid JSON string body, fall back to the raw value rather than throwing —
  // we'd rather show messy HTML than no HTML.
  try {
    const parsed = JSON.parse(`"${s.replace(/(?<!\\)"/g, '\\"')}"`);
    return typeof parsed === 'string' ? parsed : s;
  } catch {
    return s;
  }
}

/**
 * Strip the noise the model occasionally injects into the email body:
 *  - <script>/<style>/<link>/<meta>/<iframe>/<object> blocks (emails can't
 *    execute JS, most clients strip <link>/<meta>, and <iframe>/<object> are
 *    almost universally blocked).
 *  - JSX/React component tags like <TweakSection>, <EmailTweaks>,
 *    <TweakText> that the model dreamed up — they render as literal text in
 *    every email client.
 *  - The matching ReactDOM.createRoot(...) / render(<X />) glue.
 * If the result is empty after stripping, leave the original so the user
 * still has something to edit rather than a blank textarea.
 */
function sanitiseEmailHtml(html: string): string {
  if (!html) return html;
  let out = html;
  // Block-level <script>/<style>/<link>/<meta>/<iframe>/<object> (open+close
  // pair, dot-all so multi-line bodies are caught).
  out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  out = out.replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
  out = out.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, '');
  out = out.replace(/<object\b[\s\S]*?<\/object\s*>/gi, '');
  // Void-ish tags (self-closing or no body).
  out = out.replace(/<(link|meta)\b[^>]*\/?>(\s*<\/\1\s*>)?/gi, '');
  // React/Tweak custom components and their orphaned closers. The model
  // capitalises these (HTML tags are lowercase by convention), so the
  // PascalCase heuristic catches them without hitting real HTML tags.
  out = out.replace(/<\/?[A-Z][A-Za-z0-9]*\b[^>]*\/?>/g, '');
  // Bare ReactDOM.createRoot(...).render(...) snippets that survived the
  // <script> strip because the model emitted them without a wrapper tag.
  // Lines (not paren-matched) so the inner parens of getElementById(...) etc.
  // don't trip the regex up.
  out = out.replace(/^.*ReactDOM\.createRoot[\s\S]*?(?:;|$)/gm, '');
  // Orphaned closing tags that the React strip leaves behind (e.g. </script>
  // when the opening was inside a code fence the model never closed).
  out = out.replace(/<\/(?:script|style|iframe|object|TweaksPanel)\s*>/gi, '');
  // Collapse runs of >2 blank lines that the strips leave behind.
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out || html;
}
