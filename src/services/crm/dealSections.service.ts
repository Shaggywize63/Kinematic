/**
 * Connected-B2B deal sections (Spark & Ray): the pricing block that follows the quotation number, the product
 * trial block, and the people on the deal (technical approval by / prepared by / checked by / supervisor).
 * They are real columns on crm_deals (migration_spark_round2.sql). For every other client the keys are dropped,
 * so their writes are byte-identical to before.
 */
import { isB2bClient } from '../../lib/b2bClients';
import { AppError } from '../../utils';
import { assertAssigneesInOrg } from './activityExtras.service';

export const DEAL_SECTION_KEYS = [
  'pricing_quoted', 'pricing_discount_pct', 'pricing_final', 'pricing_valid_till',
  'trial_required', 'trial_start', 'trial_end', 'trial_result', 'trial_notes',
  'technical_approval_by', 'prepared_by', 'checked_by', 'supervisor_id',
] as const;

/** The deal columns that point at a user. */
export const DEAL_PERSON_KEYS = ['technical_approval_by', 'prepared_by', 'checked_by', 'supervisor_id'] as const;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Final price from the quoted price and a discount percentage (null when there is no quoted price). */
export function finalPrice(quoted: unknown, discountPct: unknown): number | null {
  const q = num(quoted);
  if (q === null) return null;
  const d = Math.min(Math.max(num(discountPct) ?? 0, 0), 100);
  return round2(q * (1 - d / 100));
}

/**
 * Applies the section keys of a validated create / patch payload (mutating it):
 *  - non-B2B client: every section key is removed;
 *  - B2B client: people must be users of the org; a blank trial_result is left alone; the final price follows
 *    the quoted price and discount unless the caller sent one explicitly.
 * `existing` is the deal as it is now (patch only), so a changed discount re-prices against the stored quote.
 */
export async function applyDealSections(args: {
  orgId: string;
  clientId: string | null | undefined;
  payload: Record<string, unknown>;
  existing?: Record<string, unknown> | null;
}): Promise<void> {
  const { orgId, clientId, payload, existing } = args;
  if (!isB2bClient(clientId)) {
    for (const k of DEAL_SECTION_KEYS) delete payload[k];
    return;
  }
  const people = Array.from(new Set(
    DEAL_PERSON_KEYS.map((k) => payload[k]).filter((x): x is string => typeof x === 'string' && x.length > 0),
  ));
  await assertAssigneesInOrg(orgId, people);

  const sent = (k: string) => payload[k] !== undefined;
  if ((sent('pricing_quoted') || sent('pricing_discount_pct')) && !sent('pricing_final')) {
    const quoted = sent('pricing_quoted') ? payload.pricing_quoted : existing?.pricing_quoted;
    const disc = sent('pricing_discount_pct') ? payload.pricing_discount_pct : existing?.pricing_discount_pct;
    const fin = finalPrice(quoted, disc);
    if (fin !== null) payload.pricing_final = fin;
  }
  const start = (sent('trial_start') ? payload.trial_start : existing?.trial_start) as string | null | undefined;
  const end = (sent('trial_end') ? payload.trial_end : existing?.trial_end) as string | null | undefined;
  if (start && end && end < start) {
    throw new AppError(400, 'The trial end date cannot be before its start date', 'VALIDATION');
  }
}

/**
 * Adds `technical_approval_by_name` / `prepared_by_name` / `checked_by_name` / `supervisor_id_name` to deals of a
 * connected-B2B client, so every client can show who is on the deal without a second lookup. Never throws.
 */
export async function stampDealPeopleNames<T extends Record<string, any>>(rows: T[]): Promise<T[]> {
  const b2b = rows.filter((r) => r && isB2bClient(r.client_id) && DEAL_PERSON_KEYS.some((k) => r[k]));
  if (!b2b.length) return rows;
  try {
    const { supabaseAdmin } = await import('../../lib/supabase');
    const ids = Array.from(new Set(b2b.flatMap((r) => DEAL_PERSON_KEYS.map((k) => r[k]).filter(Boolean)) as string[]));
    const { data } = await supabaseAdmin.from('users').select('id, name, email').in('id', ids);
    const names = new Map(((data ?? []) as Array<{ id: string; name?: string | null; email?: string | null }>)
      .map((u) => [u.id, u.name || u.email || null]));
    return rows.map((r) => {
      if (!b2b.includes(r)) return r;
      const extra: Record<string, unknown> = {};
      for (const k of DEAL_PERSON_KEYS) if (r[k]) extra[`${k}_name`] = names.get(r[k]) ?? null;
      return { ...r, ...extra };
    });
  } catch {
    return rows;
  }
}
