/**
 * GSTIN verification — provider-agnostic.
 *
 * If env var GSTIN_VERIFY_PROVIDER is set, dispatches to that provider's
 * verifier (currently scaffolded for Surepass and DigitalAPI; add others as
 * needed). Otherwise returns the locally-derived state info from the GSTIN
 * itself (still useful — proves the format + checksum are valid).
 *
 * Supported provider env vars:
 *   GSTIN_VERIFY_PROVIDER=surepass | digitalapi | none
 *   GSTIN_VERIFY_API_KEY=...
 *   GSTIN_VERIFY_API_URL=...     (override default endpoint if needed)
 *
 * Production notes:
 *   - Cache hit on (gstin) in-memory for 24h to avoid burning provider credits
 *     on form re-renders. The cache survives a single Node process; for a
 *     multi-replica deploy, stage in Supabase or Redis later.
 *   - Failures are non-fatal — verifier always returns `derived` data so the
 *     UI can still proceed.
 */

import { parseGstin, GstinParse } from '../utils/gstin';
import { logger } from '../lib/logger';

export interface GstinVerifyResult extends GstinParse {
  source: 'derived' | 'live';
  business_name?: string | null;
  trade_name?: string | null;
  legal_name?: string | null;
  registration_date?: string | null;
  status?: string | null;          // ACTIVE | CANCELLED | SUSPENDED
  address?: string | null;
  raw?: unknown;                   // provider response for audit
  cached?: boolean;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { value: GstinVerifyResult; expiry: number }>();

function fromCache(gstin: string): GstinVerifyResult | null {
  const hit = cache.get(gstin);
  if (!hit || hit.expiry < Date.now()) return null;
  return { ...hit.value, cached: true };
}

function intoCache(gstin: string, value: GstinVerifyResult) {
  cache.set(gstin, { value, expiry: Date.now() + TTL_MS });
}

export async function verifyGstin(input: string): Promise<GstinVerifyResult> {
  const parsed = parseGstin(input);
  if (!parsed.valid) return { ...parsed, source: 'derived' };

  const gstin = parsed.gstin!;
  const cached = fromCache(gstin);
  if (cached) return cached;

  const provider = (process.env.GSTIN_VERIFY_PROVIDER || '').toLowerCase();
  let live: Omit<GstinVerifyResult, keyof GstinParse | 'source'> = {};

  if (provider && provider !== 'none') {
    try {
      live = await callProvider(provider, gstin);
    } catch (e: any) {
      logger.warn(`[gstin-verify] provider ${provider} failed: ${e.message}`);
    }
  }

  const out: GstinVerifyResult = {
    ...parsed,
    source: provider && provider !== 'none' ? 'live' : 'derived',
    ...live,
  };
  intoCache(gstin, out);
  return out;
}

async function callProvider(provider: string, gstin: string) {
  switch (provider) {
    case 'surepass':   return callSurepass(gstin);
    case 'digitalapi': return callDigitalApi(gstin);
    default:
      throw new Error(`unknown GSTIN_VERIFY_PROVIDER: ${provider}`);
  }
}

// Surepass — https://docs.surepass.io/gstin-advanced
async function callSurepass(gstin: string) {
  const url = process.env.GSTIN_VERIFY_API_URL || 'https://kyc-api.surepass.io/api/v1/corporate/gstin-advanced';
  const key = process.env.GSTIN_VERIFY_API_KEY;
  if (!key) throw new Error('GSTIN_VERIFY_API_KEY missing');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ id_number: gstin }),
  });
  if (!res.ok) throw new Error(`Surepass HTTP ${res.status}`);
  const json: any = await res.json();
  const d = json?.data || {};
  return {
    business_name: d.business_name ?? d.legal_name ?? null,
    trade_name:    d.trade_name ?? null,
    legal_name:    d.legal_name ?? null,
    registration_date: d.registration_date ?? null,
    status:        d.gstin_status ?? null,
    address:       d.address ?? null,
    raw: json,
  };
}

// DigitalAPI / Karza-style endpoint.
async function callDigitalApi(gstin: string) {
  const url = process.env.GSTIN_VERIFY_API_URL;
  const key = process.env.GSTIN_VERIFY_API_KEY;
  if (!url || !key) throw new Error('DigitalAPI url/key missing');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ gstin }),
  });
  if (!res.ok) throw new Error(`DigitalAPI HTTP ${res.status}`);
  const json: any = await res.json();
  const d = json?.result || json?.data || {};
  return {
    business_name: d.lgnm ?? d.tradeNam ?? null,
    trade_name:    d.tradeNam ?? null,
    legal_name:    d.lgnm ?? null,
    registration_date: d.rgdt ?? null,
    status:        d.sts ?? null,
    address:       d.pradr?.adr ?? null,
    raw: json,
  };
}
