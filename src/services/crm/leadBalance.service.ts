/**
 * Lead order balance + "fulfill balance" (BMW Ventures and any steel-dealer
 * tenant that captures an interested quantity on the lead).
 *
 * A BMW lead records how much the customer is interested in (tonnage) on the
 * lead form (`estimated_tonnage`, or `quantity` + `measuring_unit`). When the
 * lead converts, the rep books only part of that as the first deal's volume.
 * The remainder is the **balance** — steel is booked in several orders over a
 * build's lifetime. This service:
 *   - computes the outstanding balance = interested − (volume already booked
 *     across the lead's non-lost deals), and
 *   - "fulfills" a balance by spawning a new OPEN deal for the remaining (or a
 *     requested) volume, linked to the same account / contact / lead, so the
 *     rep works it like any other deal. When that deal's volume is booked the
 *     balance shrinks to zero.
 *
 * Volume is the single source of truth (kg); amount is left to the backend's
 * existing steel-dealer derivation on the deal. No schema change — everything
 * rides in `crm_deals.custom_fields` (`volume_kg`, `product_lines`,
 * `balance_of`).
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { getDefaultPipelineId, getFirstOpenStageId } from './leads.service';

export interface LeadBalance {
  /** Interested quantity captured on the lead, in kg (0 when not quantified). */
  interested_kg: number;
  /** Volume already booked across the lead's non-lost deals, in kg. */
  booked_kg: number;
  /** Outstanding balance = max(0, interested − booked), in kg. */
  balance_kg: number;
  /** Whether the lead carries a quantified interest at all. */
  has_interest: boolean;
}

type Row = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Convert a {quantity, measuring_unit} pair (or a raw tonnage) to kg. */
function unitToKg(qty: number, unit: unknown): number {
  const u = String(unit ?? '').trim().toLowerCase();
  if (u === 'tonne') return qty * 1000;
  if (u === 'kg') return qty;
  return 0; // 'piece'/unknown can't be converted to a weight without a product
}

/** The interested quantity on a lead, in kg. Prefers `estimated_tonnage`
 *  (tonne → ×1000), else `quantity` + `measuring_unit`. 0 when unquantified. */
export function interestedKgForLead(lead: Row): number {
  const cf = (lead.custom_fields ?? {}) as Row;
  const tonnage = num(cf.estimated_tonnage);
  if (tonnage > 0) return tonnage * 1000;
  const qty = num(cf.quantity);
  if (qty > 0) return unitToKg(qty, cf.measuring_unit);
  return 0;
}

/** Volume booked on a single deal row, in kg: prefer the stored
 *  `custom_fields.volume_kg`, else derive from `product_lines`. */
function dealVolumeKg(deal: Row): number {
  const cf = (deal.custom_fields ?? {}) as Row;
  const stored = num(cf.volume_kg);
  if (stored > 0) return stored;
  const lines = cf.product_lines;
  if (Array.isArray(lines)) {
    let sum = 0;
    for (const l of lines as Row[]) sum += unitToKg(num(l.quantity), l.measuring_unit);
    return sum;
  }
  return 0;
}

/** Sum of volume booked across the lead's non-lost deals, in kg. */
export async function bookedKgForLead(org_id: string, lead_id: string): Promise<number> {
  const { data, error } = await supabaseAdmin.from('crm_deals')
    .select('status, custom_fields')
    .eq('org_id', org_id).eq('lead_id', lead_id).is('deleted_at', null);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  let sum = 0;
  for (const d of (data ?? []) as Row[]) {
    if (String(d.status ?? '').toLowerCase() === 'lost') continue; // a lost deal frees its volume
    sum += dealVolumeKg(d);
  }
  return Math.round(sum * 100) / 100;
}

async function loadLead(org_id: string, lead_id: string): Promise<Row> {
  const { data, error } = await supabaseAdmin.from('crm_leads')
    .select('id, first_name, last_name, email, company, owner_id, source_id, client_id, '
      + 'converted_account_id, converted_contact_id, converted_deal_id, custom_fields')
    .eq('org_id', org_id).eq('id', lead_id).is('deleted_at', null).maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if (!data) throw new AppError(404, 'Lead not found', 'NOT_FOUND');
  return data as unknown as Row;
}

/** Compute the outstanding balance for a lead. */
export async function computeLeadBalance(org_id: string, lead_id: string): Promise<LeadBalance> {
  const lead = await loadLead(org_id, lead_id);
  const interested = interestedKgForLead(lead);
  const booked = await bookedKgForLead(org_id, lead_id);
  const balance = Math.max(0, Math.round((interested - booked) * 100) / 100);
  return { interested_kg: interested, booked_kg: booked, balance_kg: balance, has_interest: interested > 0 };
}

export interface FulfillBalanceResult {
  deal_id: string;
  volume_kg: number;
  balance_before_kg: number;
  balance_remaining_kg: number;
}

/**
 * Create an OPEN "balance" deal for the lead's remaining balance (or a smaller
 * requested volume). Reuses the default pipeline + first open stage, links the
 * same account / contact / lead as the conversion, and carries the lead's
 * product basket onto the deal so the steel-dealer amount derivation and the
 * volume summaries work exactly as on a converted deal.
 */
export async function fulfillBalance(args: {
  org_id: string;
  user_id?: string;
  lead_id: string;
  volume_kg?: number;
  deal_name?: string;
}): Promise<FulfillBalanceResult> {
  const { org_id, user_id, lead_id } = args;
  const lead = await loadLead(org_id, lead_id);
  const interested = interestedKgForLead(lead);
  if (interested <= 0) {
    throw new AppError(400, 'This lead has no quantified interested volume, so there is no balance to fulfill.', 'NO_INTEREST');
  }
  const booked = await bookedKgForLead(org_id, lead_id);
  const balance = Math.max(0, Math.round((interested - booked) * 100) / 100);
  if (balance <= 0) {
    throw new AppError(400, 'The interested volume is fully booked — no balance remains.', 'NO_BALANCE');
  }
  // Book the whole balance by default; honour a smaller requested volume but
  // never more than what's outstanding.
  const requested = args.volume_kg != null ? Math.max(0, num(args.volume_kg)) : balance;
  const volumeKg = Math.min(balance, requested > 0 ? requested : balance);

  const leadClientId = (lead.client_id as string | null) ?? null;
  const pipeline_id = await getDefaultPipelineId(org_id, leadClientId);
  const stage_id = await getFirstOpenStageId(pipeline_id);

  const baseName = (args.deal_name ?? '').trim()
    || [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim()
    || (lead.email as string) || (lead.company as string) || 'Deal';

  const leadCf = (lead.custom_fields ?? {}) as Row;
  const cfOut: Row = { volume_kg: volumeKg };
  // Link back to the deal the conversion created, so the balance chain is
  // traceable (mirrors deals.service winDeal's balance_of).
  if (lead.converted_deal_id) cfOut.balance_of = lead.converted_deal_id;
  if (Array.isArray(leadCf.product_lines)) cfOut.product_lines = leadCf.product_lines;
  if (typeof leadCf.dealer === 'string' && (leadCf.dealer as string).trim() !== '') cfOut.dealer = leadCf.dealer;

  const dealInsert: Row = {
    org_id,
    client_id: leadClientId,
    pipeline_id,
    stage_id,
    name: `${baseName} — Balance`,
    account_id: lead.converted_account_id ?? null,
    primary_contact_id: lead.converted_contact_id ?? null,
    lead_id,
    owner_id: lead.owner_id ?? null,
    source_id: lead.source_id ?? null,
    custom_fields: cfOut,
    created_by: user_id ?? null,
  };
  const { data: deal, error } = await supabaseAdmin.from('crm_deals').insert(dealInsert).select('id').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');

  return {
    deal_id: (deal as { id: string }).id,
    volume_kg: volumeKg,
    balance_before_kg: balance,
    balance_remaining_kg: Math.max(0, Math.round((balance - volumeKg) * 100) / 100),
  };
}
