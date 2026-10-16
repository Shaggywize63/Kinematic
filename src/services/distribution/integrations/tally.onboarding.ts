/**
 * Pure logic for the Tally connector's zero-config onboarding: pairing codes,
 * the readiness checklist built from the agent's profile, the "create missing
 * ledgers" XML, and master normalisation / matching. No I/O here so it is
 * unit-testable.
 */
import crypto from 'crypto';
import { defaults, type TallyIntegrationConfig } from './tally.mapper';

/** Absolute base URL the connector should call. API_PUBLIC_URL is not set on the prod task,
 *  and a relative URL in the agent config breaks the connector, so fall back to prod. */
export function publicApiBase(): string {
  return (process.env.API_PUBLIC_URL || 'https://api.kinematicapp.com').replace(/\/+$/, '');
}

// ── Pairing code ────────────────────────────────────────────────────────────
// No 0/O/1/I/L so a code read over the phone is not mistyped. 6 chars of a
// 30-letter alphabet; single-use, short-lived, and hashed at rest.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_TTL_MS = 24 * 60 * 60 * 1000;

export function generatePairingCode(): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}
export function normalisePairingCode(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
export function hashPairingCode(raw: unknown): string {
  return crypto.createHash('sha256').update(normalisePairingCode(raw)).digest('hex');
}

// ── Profile + readiness checklist ───────────────────────────────────────────
export interface TallyProfile {
  tally_reachable?: boolean;
  tally_error?: string;
  companies?: string[];
  current_company?: string | null;
  company_found?: boolean;
  ledgers?: Array<{ name: string; parent?: string }>;
  voucher_types?: string[];
  stock_item_count?: number;
  party_count?: number;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface HealthCheck {
  key: string;
  label: string;
  status: CheckStatus;
  detail?: string;
  /** Ledgers the user can have created automatically. */
  fix?: 'create_ledgers';
}

interface RequiredLedger { key: string; name: string; parent: string; gstHead?: string }

export function requiredLedgers(cfg: TallyIntegrationConfig): RequiredLedger[] {
  const d = defaults(cfg);
  return [
    { key: 'sales',       name: d.sales,       parent: 'Sales Accounts' },
    { key: 'credit_note', name: d.credit_note, parent: 'Sales Accounts' },
    { key: 'cgst',        name: d.cgst,        parent: 'Duties & Taxes', gstHead: 'Central Tax' },
    { key: 'sgst',        name: d.sgst,        parent: 'Duties & Taxes', gstHead: 'State Tax' },
    { key: 'igst',        name: d.igst,        parent: 'Duties & Taxes', gstHead: 'Integrated Tax' },
    { key: 'cash',        name: d.cash,        parent: 'Cash-in-Hand' },
    { key: 'bank',        name: d.bank,        parent: 'Bank Accounts' },
    { key: 'round_off',   name: d.round_off,   parent: 'Indirect Expenses' },
  ];
}

const norm = (s: string) => s.trim().toLowerCase();

export function missingLedgers(cfg: TallyIntegrationConfig, profile: TallyProfile | null): RequiredLedger[] {
  if (!profile?.ledgers) return [];
  const have = new Set(profile.ledgers.map(l => norm(l.name)));
  return requiredLedgers(cfg).filter(r => !have.has(norm(r.name)));
}

export function computeHealth(opts: {
  agentSeenAt: string | null;
  profile: TallyProfile | null;
  config: TallyIntegrationConfig;
  now?: number;
}): { ready: boolean; checks: HealthCheck[] } {
  const now = opts.now ?? Date.now();
  const { profile, config } = opts;
  const checks: HealthCheck[] = [];

  const seenMs = opts.agentSeenAt ? now - new Date(opts.agentSeenAt).getTime() : Infinity;
  checks.push(
    seenMs <= 5 * 60_000
      ? { key: 'agent', label: 'Connector is running', status: 'ok' }
      : { key: 'agent', label: 'Connector is running', status: 'fail',
          detail: opts.agentSeenAt
            ? 'Not heard from the connector for over 5 minutes. Is the Tally PC on and online?'
            : 'The connector has not connected yet. Install it on the Tally PC and enter the pairing code.' },
  );

  if (!profile) {
    checks.push({ key: 'tally', label: 'Tally is reachable', status: 'warn', detail: 'Waiting for the connector to report.' });
    return { ready: false, checks };
  }

  checks.push(
    profile.tally_reachable
      ? { key: 'tally', label: 'Tally is reachable', status: 'ok' }
      : { key: 'tally', label: 'Tally is reachable', status: 'fail',
          detail: profile.tally_error
            || 'Open Tally and turn on F1 > Settings > Connectivity > Client/Server: "TallyPrime acts as" = Both, port 9000.' },
  );
  if (!profile.tally_reachable) return { ready: false, checks };

  const wanted = config.company_name?.trim();
  if (!wanted) {
    checks.push({ key: 'company', label: 'Tally company selected', status: 'fail',
      detail: `Choose one of: ${(profile.companies ?? []).join(', ') || '(no company open in Tally)'}` });
  } else if (!(profile.companies ?? []).some(c => norm(c) === norm(wanted))) {
    checks.push({ key: 'company', label: 'Tally company selected', status: 'fail',
      detail: `"${wanted}" is not open in Tally. Open it, or choose one of: ${(profile.companies ?? []).join(', ') || '(none open)'}` });
  } else {
    checks.push({ key: 'company', label: 'Tally company selected', status: 'ok', detail: wanted });
  }

  const missing = missingLedgers(config, profile);
  checks.push(
    missing.length === 0
      ? { key: 'ledgers', label: 'Required ledgers exist', status: 'ok' }
      : { key: 'ledgers', label: 'Required ledgers exist', status: 'fail', fix: 'create_ledgers',
          detail: `Missing in Tally: ${missing.map(m => m.name).join(', ')}` },
  );

  const vt = (profile.voucher_types ?? []).map(norm);
  const needed = ['sales', 'receipt', 'credit note'].filter(v => !vt.includes(v));
  checks.push(
    needed.length === 0
      ? { key: 'voucher_types', label: 'Voucher types available', status: 'ok' }
      : { key: 'voucher_types', label: 'Voucher types available', status: 'warn', detail: `Not found: ${needed.join(', ')}` },
  );

  const ready = checks.every(c => c.status !== 'fail');
  return { ready, checks };
}

// ── Create-missing-ledgers XML ──────────────────────────────────────────────
const xmlEscape = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildCreateLedgersXml(company: string, ledgers: RequiredLedger[]): string {
  const body = ledgers.map(l => `          <LEDGER NAME="${xmlEscape(l.name)}" ACTION="Create">
            <NAME>${xmlEscape(l.name)}</NAME>
            <PARENT>${xmlEscape(l.parent)}</PARENT>${l.gstHead ? `
            <TAXTYPE>GST</TAXTYPE>
            <GSTDUTYHEAD>${xmlEscape(l.gstHead)}</GSTDUTYHEAD>` : ''}
          </LEDGER>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
${body}
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// ── Masters ─────────────────────────────────────────────────────────────────
export type MasterKind = 'stock_item' | 'party';
export interface MasterIn { tally_guid: string; name: string; [k: string]: unknown }

export function sanitiseMaster(raw: unknown): MasterIn | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 300) : '';
  const guid = typeof r.tally_guid === 'string' ? r.tally_guid.trim().slice(0, 200) : '';
  if (!name || !guid) return null;
  // Keep only scalar fields so a hostile/buggy agent cannot store arbitrary blobs.
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'tally_guid' || k === 'name') continue;
    if (typeof v === 'string') data[k] = v.slice(0, 500);
    else if (typeof v === 'number' && Number.isFinite(v)) data[k] = v;
    else if (typeof v === 'boolean') data[k] = v;
  }
  return { tally_guid: guid, name, ...data };
}

const GSTIN_RE = /^[0-9A-Z]{15}$/;
export const cleanGstin = (v: unknown): string | null => {
  const g = String(v ?? '').trim().toUpperCase();
  return GSTIN_RE.test(g) ? g : null;
};
export const nameKey = (s: unknown) =>
  String(s ?? '').toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|m\/s|messrs)\b\.?/g, '').replace(/[^a-z0-9]/g, '');

export interface MatchCandidate { id: string; name: string; legal_name?: string | null; gstin?: string | null; sku_code?: string | null }

/** Find the existing Kinematic record for a Tally party. GSTIN is authoritative; a
 *  name match is only accepted when it is unambiguous. */
export function matchParty(
  m: { name: string; gstin?: unknown },
  existing: MatchCandidate[],
): { id: string; method: 'gstin' | 'name' } | null {
  const g = cleanGstin(m.gstin);
  if (g) {
    const hit = existing.filter(e => cleanGstin(e.gstin) === g);
    if (hit.length === 1) return { id: hit[0].id, method: 'gstin' };
    if (hit.length > 1) return null;
  }
  const k = nameKey(m.name);
  if (!k) return null;
  const hit = existing.filter(e => nameKey(e.name) === k || nameKey(e.legal_name) === k);
  return hit.length === 1 ? { id: hit[0].id, method: 'name' } : null;
}

export function matchStockItem(
  m: { name: string; part_number?: unknown },
  existing: MatchCandidate[],
): { id: string; method: 'name' } | null {
  const code = String(m.part_number ?? '').trim().toLowerCase();
  if (code) {
    const hit = existing.filter(e => (e.sku_code ?? '').trim().toLowerCase() === code);
    if (hit.length === 1) return { id: hit[0].id, method: 'name' };
  }
  const k = nameKey(m.name);
  if (!k) return null;
  const hit = existing.filter(e => nameKey(e.name) === k);
  return hit.length === 1 ? { id: hit[0].id, method: 'name' } : null;
}

/** Stable, unique-per-org distributor code for an imported Tally party. */
export function partyCode(tallyGuid: string): string {
  return `TLY-${crypto.createHash('sha1').update(tallyGuid).digest('hex').slice(0, 8).toUpperCase()}`;
}
