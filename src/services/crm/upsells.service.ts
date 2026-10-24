/**
 * Upsells — additional revenue logged against an existing deal and/or lead.
 *
 * An upsell is a lightweight, itemisable record (NOT a flat field, NOT an
 * activity) so a rep can log several upsells on one customer, each with its own
 * amount / product / date / status, and so upsell revenue can be reported apart
 * from the deal's original value. A row links to a deal, a lead, or both — the
 * "Upsells" section renders on both the deal- and lead-detail pages.
 *
 * Tenant-scoped exactly like the deals/leads it hangs off (org_id + client_id);
 * all access is through the service-role client with scoping enforced in code.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

export type UpsellStatus = 'proposed' | 'won' | 'lost';
const STATUSES: UpsellStatus[] = ['proposed', 'won', 'lost'];

export interface UpsellInput {
  deal_id?: string | null;
  lead_id?: string | null;
  amount?: unknown;
  currency?: unknown;
  quantity?: unknown;
  product_id?: string | null;
  product_name?: unknown;
  status?: unknown;
  note?: unknown;
  occurred_at?: unknown;
}

export interface UpsellRow {
  deal_id: string | null;
  lead_id: string | null;
  amount: number;
  currency: string;
  quantity: number | null;
  product_id: string | null;
  product_name: string | null;
  status: UpsellStatus;
  note: string | null;
  occurred_at: string | null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Validate + normalise an upsell before insert. PURE (no DB) so it is unit-testable.
 * Throws AppError on anything the table would reject:
 *   - must link to a deal OR a lead (the table CHECKs this too);
 *   - amount is required and must be a finite, non-negative number;
 *   - status defaults to 'won' and must be one of proposed|won|lost.
 */
export function normalizeUpsellInput(input: UpsellInput): UpsellRow {
  const deal_id = str(input.deal_id, 64);
  const lead_id = str(input.lead_id, 64);
  if (!deal_id && !lead_id) throw new AppError(400, 'An upsell must be attached to a deal or a lead', 'VALIDATION');

  const amount = num(input.amount);
  if (amount == null || amount < 0) throw new AppError(400, 'A valid upsell amount is required', 'VALIDATION');

  const statusRaw = (str(input.status, 20) || 'won').toLowerCase();
  if (!STATUSES.includes(statusRaw as UpsellStatus)) throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`, 'VALIDATION');

  const qty = num(input.quantity);
  const occurred = str(input.occurred_at, 40);

  return {
    deal_id, lead_id,
    amount,
    currency: (str(input.currency, 8) || 'INR').toUpperCase(),
    quantity: qty != null && qty > 0 ? qty : null,
    product_id: str(input.product_id, 64),
    product_name: str(input.product_name, 300),
    status: statusRaw as UpsellStatus,
    note: str(input.note, 2000),
    // A bad/absent date falls to now() at insert (occurred_at is NOT NULL DEFAULT now()).
    occurred_at: occurred && !Number.isNaN(Date.parse(occurred)) ? occurred : null,
  };
}

/** List upsells for a deal or a lead (newest first), hydrated with the recorder's name. */
export async function listUpsells(
  org_id: string,
  opts: { deal_id?: string | null; lead_id?: string | null },
): Promise<Array<Record<string, unknown>>> {
  const dealId = (opts.deal_id || '').trim();
  const leadId = (opts.lead_id || '').trim();
  if (!dealId && !leadId) throw new AppError(400, 'deal_id or lead_id is required', 'VALIDATION');

  let q = supabaseAdmin.from('crm_upsells')
    .select('id, deal_id, lead_id, amount, currency, quantity, product_id, product_name, status, note, occurred_at, created_by, created_at')
    .eq('org_id', org_id);
  if (dealId) q = q.eq('deal_id', dealId);
  if (leadId) q = q.eq('lead_id', leadId);
  const { data, error } = await q.order('occurred_at', { ascending: false }).limit(200);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = (data || []) as Array<Record<string, any>>;

  const ids = Array.from(new Set(rows.map((r) => r.created_by).filter(Boolean))) as string[];
  const nameById = new Map<string, string>();
  if (ids.length) {
    const { data: users } = await supabaseAdmin.from('users').select('id, name, email').in('id', ids);
    for (const u of users || []) nameById.set((u as any).id, (u as any).name || (u as any).email || 'User');
  }
  return rows.map((r) => ({ ...r, created_by_name: r.created_by ? (nameById.get(r.created_by) ?? null) : null }));
}

/** Create an upsell. `client_id`/`created_by` come from the request scope, not the body. */
export async function createUpsell(
  org_id: string,
  client_id: string | null,
  created_by: string | null,
  input: UpsellInput,
): Promise<Record<string, unknown>> {
  const row = normalizeUpsellInput(input);
  const insert: Record<string, unknown> = { ...row, org_id, client_id, created_by };
  if (!insert.occurred_at) delete insert.occurred_at; // let the column default to now()
  const { data, error } = await supabaseAdmin.from('crm_upsells').insert(insert).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data as Record<string, unknown>;
}

/** Delete an upsell within the caller's org (idempotent — a missing row is a no-op). */
export async function deleteUpsell(org_id: string, id: string): Promise<void> {
  const { error } = await supabaseAdmin.from('crm_upsells').delete().eq('org_id', org_id).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
}
