/**
 * Inbound-email provider — turn a forwarded / parsed email into a lead.
 *
 * Auth model: per-integration `webhook_secret` shipped as `?key=<secret>` on
 * the public POST URL (same as web_form). The mail provider's inbound-parse
 * hook (Mailgun routes, SES→SNS→Lambda, SendGrid "post JSON", or a
 * Zapier/Make relay) is configured to POST the message to that URL.
 *
 * Payload: a flat JSON object. We read the common envelope keys across the
 * major providers (from/sender, subject, text/body-plain, html/body-html),
 * derive the sender's name + email deterministically, then use KINI to pull
 * any phone / company / city / person-name mentioned in the body. Sender email
 * is always trusted over the AI's guess. If the AI is unavailable we still
 * create a lead from the envelope alone — a captured contact beats a dropped one.
 *
 * Note: the webhook stack parses JSON only, so the mail provider must POST
 * application/json (multipart form-data from SendGrid's classic Inbound Parse
 * needs a tiny relay). This is documented in the dashboard connect steps.
 */
import type { Request } from 'express';
import type { IntegrationProvider, IntegrationRow } from './types';
import type { NormalizedLead } from '../dedup.orchestrator';
import { complete as aiComplete } from '../../ai/aiClient';
import { logger } from '../../../../lib/logger';

const FROM_ALIASES    = ['from', 'sender', 'From', 'Sender', 'from_email', 'envelope_from', 'reply_to', 'Reply-To'];
const SUBJECT_ALIASES = ['subject', 'Subject'];
const TEXT_ALIASES    = ['text', 'body-plain', 'stripped-text', 'plain', 'TextBody', 'body', 'text_body'];
const HTML_ALIASES    = ['html', 'body-html', 'stripped-html', 'HtmlBody', 'html_body'];

function pick(body: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = body[k];
    if (v != null && typeof v !== 'object' && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Split a "Display Name <email@host>" (or bare email) into name + email. */
function parseFrom(raw: string): { name: string | null; email: string | null } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<\s*([^>]+?)\s*>\s*$/);
  if (m) {
    const name = m[1].trim();
    return { name: name || null, email: m[2].trim().toLowerCase() || null };
  }
  const bare = raw.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  return { name: null, email: bare ? bare[0].toLowerCase() : null };
}

function splitName(full: string): { first: string | null; last: string | null } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EXTRACT_SYSTEM = `You extract CRM lead details from an inbound email (an enquiry, a web form
forwarded by email, or a signature). Return ONLY a JSON object with these keys (omit any you can't find,
never invent): { "first_name": string, "last_name": string, "phone": string, "company": string,
"city": string, "person_name": string }.
- phone: digits only, best single contact number in the body/signature.
- person_name: the sender's full name if it appears (used only if the From header had no name).
Output JSON only — no prose, no markdown.`;

interface Extracted {
  first_name?: string; last_name?: string; phone?: string;
  company?: string; city?: string; person_name?: string;
}

async function aiExtract(from: string, subject: string, text: string): Promise<Extracted> {
  const content = `From: ${from}\nSubject: ${subject}\n\n${text}`.slice(0, 4000);
  try {
    const raw = await aiComplete({
      // The prod functional key isn't provisioned for Claude Haiku 4.5 (it
      // 404s), but works for claude-sonnet-5 — so that's the fallback.
      model: process.env.CRM_EMAIL_PARSE_MODEL || 'claude-sonnet-5',
      max_tokens: 400,
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content }],
    });
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return {};
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return {
      first_name: s(parsed.first_name),
      last_name: s(parsed.last_name),
      phone: s(parsed.phone),
      company: s(parsed.company),
      city: s(parsed.city),
      person_name: s(parsed.person_name),
    };
  } catch (e) {
    // AI is best-effort enrichment — never let it drop the lead. We still
    // create one from the envelope (sender email/name + subject) below.
    logger.warn(`[email-inbound] AI extraction failed: ${e instanceof Error ? e.message : e}`);
    return {};
  }
}

export const emailInboundProvider: IntegrationProvider = {
  id: 'email_inbound',

  async verifyWebhook(req: Request, integration: IntegrationRow): Promise<boolean> {
    const provided =
      (req.query.key as string | undefined) ??
      (req.headers['x-webhook-key'] as string | undefined);
    if (!provided || !integration.webhook_secret) return false;
    if (provided.length !== integration.webhook_secret.length) return false;
    let diff = 0;
    for (let i = 0; i < provided.length; i++) {
      diff |= provided.charCodeAt(i) ^ integration.webhook_secret.charCodeAt(i);
    }
    return diff === 0;
  },

  async normalize(raw: unknown): Promise<NormalizedLead> {
    const body = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
    const fromRaw = pick(body, FROM_ALIASES);
    const subject = pick(body, SUBJECT_ALIASES);
    const textRaw = pick(body, TEXT_ALIASES);
    const htmlRaw = pick(body, HTML_ALIASES);
    const text = textRaw || (htmlRaw ? stripHtml(htmlRaw) : '');

    const { name: headerName, email } = parseFrom(fromRaw);
    const ai = await aiExtract(fromRaw, subject, text);

    // Name precedence: explicit AI first/last → From-header display name →
    // AI-detected person_name → null. Sender email always wins over any guess.
    let first_name = ai.first_name ?? null;
    let last_name = ai.last_name ?? null;
    if (!first_name && !last_name) {
      const nameStr = headerName || ai.person_name || '';
      if (nameStr) {
        const sp = splitName(nameStr);
        first_name = sp.first;
        last_name = sp.last;
      }
    }

    const notes = subject
      ? `Email: ${subject}${text ? `\n\n${text.slice(0, 500)}` : ''}`
      : (text ? text.slice(0, 500) : null);

    return {
      first_name,
      last_name,
      email: email ?? null,
      phone: ai.phone ? ai.phone.replace(/[^\d+]/g, '') || null : null,
      company: ai.company ?? null,
      city: ai.city ?? null,
      notes,
      custom_fields: {
        email_subject: subject || undefined,
        email_from: fromRaw || undefined,
      },
    };
  },
};
