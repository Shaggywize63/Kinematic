/**
 * Translate WhatsApp template body/header/footer text into one or more Indian
 * languages via Claude. Results are merged into the template's `translations`
 * JSONB column so the dashboard can pick the right copy per recipient.
 *
 * Supported targets (trimmed for Tata Tiscon footprint):
 *   Hindi (hi), Odia (or), Bengali (bn), Assamese (as).
 * English (en) is treated as the source and lives in the template's
 * top-level columns. To re-enable more languages later, uncomment in
 * LANG_NAMES below and add the code to the frontend SUPPORTED_LANGS.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { complete } from './ai/aiClient';
import { AppError } from '../../utils';

const LANG_NAMES: Record<string, string> = {
  hi: 'Hindi (Devanagari script)',
  or: 'Odia (Oriya)',
  bn: 'Bengali',
  as: 'Assamese',
  // ta: 'Tamil',
  // te: 'Telugu',
  // kn: 'Kannada',
  // mr: 'Marathi',
  // gu: 'Gujarati',
  // pa: 'Punjabi (Gurmukhi script)',
};

export interface TranslatedTemplatePart {
  body_text?: string;
  header_text?: string;
  footer_text?: string;
}

async function translateOne(
  langCode: string,
  parts: { body_text: string; header_text?: string | null; footer_text?: string | null },
): Promise<TranslatedTemplatePart> {
  const langName = LANG_NAMES[langCode];
  if (!langName) throw new AppError(400, `Unsupported language code: ${langCode}`, 'VALIDATION');

  const system =
    `You translate WhatsApp message templates from English into ${langName}. ` +
    `Return ONLY a JSON object with keys "body_text" (always), "header_text" (only if a header was given), and "footer_text" (only if a footer was given). ` +
    `Preserve every {{placeholder}} EXACTLY as-is — do not translate the placeholders or change their casing. ` +
    `Keep the translation natural and concise, suitable for SMS-length WhatsApp messaging in India. ` +
    `Do not add any commentary, code fences, or extra keys. Output JSON only.`;

  const userPayload = JSON.stringify({
    body_text:   parts.body_text,
    header_text: parts.header_text || undefined,
    footer_text: parts.footer_text || undefined,
  });

  const raw = await complete({
    system,
    messages: [{ role: 'user', content: userPayload }],
    max_tokens: 800,
  });

  // Claude sometimes wraps JSON in ```json ... ``` despite instructions; strip.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as TranslatedTemplatePart;
    if (typeof parsed.body_text !== 'string' || !parsed.body_text.trim()) {
      throw new Error('translation missing body_text');
    }
    return {
      body_text:   parsed.body_text.trim(),
      header_text: parsed.header_text?.trim() || undefined,
      footer_text: parsed.footer_text?.trim() || undefined,
    };
  } catch (e: any) {
    throw new AppError(502, `Translation parse failed for ${langCode}: ${e.message}`, 'AI_PARSE');
  }
}

/**
 * Translate a template into one-or-more languages and persist the results
 * back to the template's `translations` jsonb column. Existing entries are
 * merged-overwritten so re-running gives fresh copy.
 */
export async function translateTemplate(
  org_id: string,
  template_id: string,
  target_languages: string[],
): Promise<Record<string, TranslatedTemplatePart>> {
  if (!target_languages.length) throw new AppError(400, 'target_languages required', 'VALIDATION');

  const { data: tpl, error: tplErr } = await supabaseAdmin
    .from('crm_whatsapp_templates')
    .select('id, org_id, body_text, header_text, footer_text, translations')
    .eq('org_id', org_id).eq('id', template_id).maybeSingle();
  if (tplErr || !tpl) throw new AppError(404, 'Template not found', 'NOT_FOUND');

  const out: Record<string, TranslatedTemplatePart> = {};
  // Run translations in parallel; cap concurrency at 4 so we don't blow
  // through Anthropic's rate limits on a single bulk-translate click.
  const queue = [...target_languages];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const lang = queue.shift()!;
      out[lang] = await translateOne(lang, {
        body_text: tpl.body_text,
        header_text: tpl.header_text,
        footer_text: tpl.footer_text,
      });
    }
  });
  await Promise.all(workers);

  const merged = { ...(tpl.translations || {}), ...out };
  const { error: updErr } = await supabaseAdmin
    .from('crm_whatsapp_templates')
    .update({ translations: merged })
    .eq('id', template_id).eq('org_id', org_id);
  if (updErr) throw new AppError(500, updErr.message, 'DB_ERROR');

  return out;
}

export const SUPPORTED_LANGUAGES = Object.keys(LANG_NAMES);
