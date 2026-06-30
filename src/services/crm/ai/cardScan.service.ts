/**
 * Business-card → lead OCR. Takes a photo of a business card and returns the
 * structured contact fields so the apps can open Create Lead pre-filled —
 * turning a handshake into a CRM lead in seconds.
 *
 * Mirrors the planogram-vision call (direct Anthropic /messages with an image
 * block + AIService.getFunctionalKey). Single-shot; parse failures degrade to
 * an all-null result so the scan button never hard-errors — the rep just edits
 * the blank form.
 */
import { AppError } from '../../../utils';
import { AIService } from '../../ai.service';
import { logger } from '../../../lib/logger';

export interface CardFields {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
}

const EMPTY: CardFields = {
  first_name: null, last_name: null, company: null, title: null,
  email: null, phone: null, website: null, address: null,
};

export type CardMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

const SYSTEM = [
  'You are an OCR + contact-extraction engine for business cards.',
  'You receive ONE photo of a business card and must return ONLY a JSON object of this exact shape:',
  '{ "first_name": string|null, "last_name": string|null, "company": string|null, "title": string|null, "email": string|null, "phone": string|null, "website": string|null, "address": string|null }',
  'Rules:',
  '- Split the person\'s name into first_name / last_name; if only one token, put it in first_name.',
  '- If several phone numbers are present, pick the primary mobile.',
  '- Strip field labels ("Mob:", "E:", "Tel"), lowercase the email.',
  '- Use null for any field the card does not show. Never invent data not on the card.',
  '- Output JSON only — no prose, no markdown fences.',
].join('\n');

function str(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim() : '';
  return t || null;
}

export async function scanCard(imageBase64: string, mediaType: CardMediaType = 'image/jpeg'): Promise<CardFields> {
  const apiKey = await AIService.getFunctionalKey();
  const model = process.env.CARD_SCAN_MODEL || 'claude-sonnet-4-6';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: 'Extract the contact fields from this business card. JSON only.' },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const err: any = await response.json().catch(() => ({}));
    throw new AppError(response.status, err?.error?.message || `Card scan failed (${response.status})`, 'CARD_SCAN_ERROR');
  }

  const data: any = await response.json();
  const text: string = data?.content?.[0]?.text || '';
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return { ...EMPTY };
    const p = JSON.parse(text.substring(start, end + 1));
    return {
      first_name: str(p.first_name),
      last_name: str(p.last_name),
      company: str(p.company),
      title: str(p.title),
      email: str(p.email)?.toLowerCase() ?? null,
      phone: str(p.phone),
      website: str(p.website),
      address: str(p.address),
    };
  } catch (err: any) {
    logger.warn(`[card-scan] parse failed: ${err?.message || err}`);
    return { ...EMPTY };
  }
}
