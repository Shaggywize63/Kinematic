/**
 * Odometer photo -> reading. The sibling of receiptScan.service.ts: a rep photographs the vehicle's
 * odometer and the app pre-fills the "before" / "after" reading instead of making them type it.
 *
 * Same plumbing as the receipt scan (direct Anthropic /messages with an image block +
 * AIService.getFunctionalKey), its own model override (ODOMETER_SCAN_MODEL, falling back to the
 * receipt model). The result is ONLY a suggestion the rep confirms on screen:
 *   - it must be the TOTAL distance (ODO), never a trip meter, the clock, the fuel gauge or speed;
 *   - whole kilometres, digits only; anything unsure or not an odometer is `null`.
 * A network / parse failure never throws out of `parseOdometerReply`, and the caller
 * (receipts.uploadReceipt) swallows a thrown `scanOdometer` so the photo upload is never lost.
 */
import { AppError } from '../../utils';
import { AIService } from '../ai.service';
import type { ReceiptMediaType } from './receiptScan.service';

export type OdometerConfidence = 'high' | 'medium' | 'low';

export interface OdometerReading {
  /** Whole kilometres on the total-distance odometer, or null when it could not be read reliably. */
  reading: number | null;
  confidence: OdometerConfidence | null;
}

export const EMPTY_ODOMETER: OdometerReading = { reading: null, confidence: null };

/** Anything above this is a misread, not a vehicle. */
export const MAX_ODOMETER_KM = 10_000_000;
const SCAN_TIMEOUT_MS = 25_000;

const SYSTEM = [
  'You read vehicle odometers from a photo (Indian field-sales context: motorcycle, scooter, car and tractor dashboards, analogue or digital).',
  'You receive ONE photo and must return ONLY a JSON object of this exact shape:',
  '{ "reading": number|null, "confidence": "high"|"medium"|"low"|null }',
  'Rules:',
  '- "reading" is the TOTAL distance odometer (usually labelled ODO, or the long counter that never resets), in whole kilometres, as a plain JSON number: digits only, no separators, no units, no leading zeros.',
  '- NEVER return a trip meter (TRIP, TRIP A, TRIP B, "A" / "B"), the clock or time, the fuel gauge or fuel level, a temperature, the speed, RPM, the gear, a service-due distance, the range / distance-to-empty or an average-mileage figure.',
  '- If the display shows a separate small or differently coloured last digit (tenths of a km), ignore it and return the whole-km number only.',
  '- If the photo is not an odometer, if any digit is blurred, glared out, cut off or otherwise uncertain, or if the display is clearly in miles, return {"reading": null, "confidence": null}. Never guess or complete a missing digit.',
  '- "confidence": "high" when every digit is sharp and unambiguous, "medium" when one digit is slightly unclear but you are fairly sure, "low" otherwise (and then prefer null).',
  '- Output JSON only: no prose, no markdown fences.',
].join('\n');

const CONFIDENCES: OdometerConfidence[] = ['high', 'medium', 'low'];

/** A model value -> whole km in [0, MAX_ODOMETER_KM], or null. Tolerates "12,345 km" style strings. */
export function toOdometerKm(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
      .replace(/\s*(?:kms?|kilomet(?:er|re)s?)\s*\.?$/, '')
      .replace(/[,\s_'’]/g, '');
    if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
    n = Number(t);
  } else return null;
  if (!Number.isFinite(n) || n < 0) return null;
  n = Math.floor(n); // whole km — a tenths digit is never part of the reading
  return n <= MAX_ODOMETER_KM ? n : null;
}

/** The model's reply text -> a reading. Never throws; an unusable reply is an empty reading. */
export function parseOdometerReply(text: string): OdometerReading {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return { ...EMPTY_ODOMETER };
    const p = JSON.parse(text.substring(start, end + 1));
    const reading = toOdometerKm(p?.reading);
    if (reading == null) return { ...EMPTY_ODOMETER };
    const c = typeof p?.confidence === 'string' ? p.confidence.trim().toLowerCase() : '';
    return { reading, confidence: (CONFIDENCES as string[]).includes(c) ? (c as OdometerConfidence) : null };
  } catch {
    return { ...EMPTY_ODOMETER };
  }
}

export async function scanOdometer(imageBase64: string, mediaType: ReceiptMediaType = 'image/jpeg'): Promise<OdometerReading> {
  const apiKey = await AIService.getFunctionalKey();
  const model = process.env.ODOMETER_SCAN_MODEL || process.env.RECEIPT_SCAN_MODEL || process.env.CARD_SCAN_MODEL || 'claude-haiku-4-5';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 100,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: 'Read the total-distance odometer (ODO) in this photo. JSON only.' },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const err: any = await response.json().catch(() => ({}));
    throw new AppError(response.status, err?.error?.message || `Odometer scan failed (${response.status})`, 'ODOMETER_SCAN_ERROR');
  }

  const data: any = await response.json();
  const text: string = data?.content?.[0]?.text || '';
  return parseOdometerReply(text);
}
