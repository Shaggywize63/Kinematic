import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';

/**
 * Per-account rollups for the accounts LIST: how many open deals an account has and what they are worth, what has been
 * won, and how many contacts it has. Stamped onto each row the list returns (additive keys only, so the mobile apps,
 * which ignore unknown keys, are unaffected).
 *
 * Scope matches the account detail page: GET /crm/accounts/:id/deals and /:id/contacts list every non-deleted deal /
 * contact of the account in the org, so the counts here are the ones a person sees when they open the account. The rows
 * passed in are already client- and owner-scoped by the list query, and the lookups are keyed by those account ids.
 *
 * Never throws: a failed lookup leaves the rollup keys at zero and logs, so the list itself still loads.
 */

type Row = Record<string, unknown>;

export interface AccountRollup {
  open_deals_count: number;
  open_deals_value: number;
  won_deals_count: number;
  won_deals_value: number;
  contacts_count: number;
}

const ZERO: AccountRollup = { open_deals_count: 0, open_deals_value: 0, won_deals_count: 0, won_deals_value: 0, contacts_count: 0 };
const CHUNK = 100;   // keeps each PostgREST `in.(...)` URL well under the length limit

const chunks = <T,>(xs: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const amountOf = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Pure: fold deal and contact rows into one rollup per account id. Lost deals are not counted anywhere. */
export function foldRollups(accountIds: string[], deals: Row[], contacts: Row[]): Map<string, AccountRollup> {
  const out = new Map<string, AccountRollup>();
  for (const id of accountIds) out.set(id, { ...ZERO });
  for (const d of deals) {
    const r = out.get(String(d.account_id));
    if (!r) continue;
    if (d.status === 'open') { r.open_deals_count += 1; r.open_deals_value += amountOf(d.amount); }
    else if (d.status === 'won') { r.won_deals_count += 1; r.won_deals_value += amountOf(d.amount); }
  }
  for (const c of contacts) {
    const r = out.get(String(c.account_id));
    if (r) r.contacts_count += 1;
  }
  for (const r of out.values()) { r.open_deals_value = Math.round(r.open_deals_value); r.won_deals_value = Math.round(r.won_deals_value); }
  return out;
}

async function fetchByAccount(table: 'crm_deals' | 'crm_contacts', cols: string, orgId: string, ids: string[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const part of chunks(ids, CHUNK)) {
    const { data, error } = await supabaseAdmin.from(table).select(cols).eq('org_id', orgId).in('account_id', part).is('deleted_at', null);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as unknown as Row[]));
  }
  return rows;
}

export async function stampAccountRollups<T extends Row>(orgId: string, rows: T[]): Promise<Array<T & AccountRollup>> {
  if (!rows?.length) return rows as Array<T & AccountRollup>;
  const ids = Array.from(new Set(rows.map((r) => String(r.id ?? '')).filter(Boolean)));
  let rollups = new Map<string, AccountRollup>();
  try {
    const [deals, contacts] = await Promise.all([
      fetchByAccount('crm_deals', 'account_id, status, amount', orgId, ids),
      fetchByAccount('crm_contacts', 'account_id', orgId, ids),
    ]);
    rollups = foldRollups(ids, deals, contacts);
  } catch (e) {
    logger.warn(`[accounts] rollups unavailable: ${(e as Error).message}`);
  }
  return rows.map((r) => ({ ...r, ...(rollups.get(String(r.id)) ?? ZERO) }));
}
