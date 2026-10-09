/**
 * Field Expense / Travel Claims — core service.
 *
 * A person files a claim with one or more lines (mileage / travel / food /
 * lodging / fuel / toll / misc), attaching a receipt photo to each. On submit
 * the claim:
 *   1. resolves the policy that governs the claimant (see policy.service) and is
 *      checked against its rules — caps, receipts, late or future dates. Under a
 *      "block" policy a violating claim cannot be submitted at all;
 *   2. gets a one-line AI approver brief, plus duplicate / GPS-mileage checks;
 *   3. is approved on the spot when the policy's auto-approve threshold allows,
 *      otherwise routes up the reporting line (users.supervisor_id), climbing to
 *      the next manager when the amount is over the policy's escalation limit.
 *
 * An approver can approve or reject the whole claim, or decide line by line.
 * Every rejection — of a claim or of a single line — must carry a remark; the
 * remark is stored on the claim / line / approval trail and sent to the claimant.
 * Approving only some lines is a partial approval: the claim pays out the
 * approved amount.
 *
 * AI is best-effort throughout, so a claim can always be filed and acted on even
 * when the model is unavailable.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { AIService } from '../ai.service';
import { mileageFromTrail } from './mileage.service';
import { notifyUsers } from '../notify';
import { Actor, isApprover } from './access';
import {
  CATEGORIES, ExpensePolicy, PolicyViolation, canAutoApprove, createPolicy, evaluateAgainstPolicy, hasPolicyV2,
  listPolicies, policyUserOf, priorMonthSpend, resolvePolicy, resolvePolicyForUserId, toClientShape, updatePolicy,
} from './policy.service';
import { assertReceiptsOwned, signReceipt } from './receipts.service';
import {
  ODOMETER_KEYS, ODOMETER_PHOTO_KEYS, assertOdometerOrder, assertOdometerStorable, hasOdometerInput, priceVehicleLine, vehicleFlowOn,
} from './vehicleAllowance';

export type { Actor } from './access';

const MAX_APPROVAL_LEVELS = 5; // hard stop so escalation can never loop up the tree forever

/** Submission blocked by a "block"-enforcement policy; carries the reasons. */
export class PolicyBlockedError extends AppError {
  constructor(public violations: PolicyViolation[]) {
    super(422, `This claim breaks the expense policy and can't be submitted: ${violations.slice(0, 3).map((v) => v.detail).join(' ')}`, 'POLICY_BLOCKED');
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const cur = (c: { currency?: string | null }) => c.currency || 'INR';
const fmt = (c: { currency?: string | null }, n: number) => `${cur(c)} ${Number(n).toFixed(0)}`;

// ── the policy a person sees ────────────────────────────────────────────────
/** The policy governing the caller, in the shape the apps already parse. */
export async function getMyPolicy(actor: Actor) {
  const p = await resolvePolicyForUserId(actor.org_id, actor.client_id ?? null, actor.id);
  return toClientShape(p);
}

/**
 * Edit "the" policy through the original single-policy endpoint. Kept so older
 * dashboard builds keep working: on a v2 workspace it maintains one policy named
 * "Default policy" that applies to everyone.
 */
export async function saveDefaultPolicy(actor: Actor, body: any) {
  if (!isApprover(actor)) throw new AppError(403, 'Only an admin can edit the expense policy', 'FORBIDDEN');
  if (await hasPolicyV2()) {
    const existing = (await listPolicies(actor)).find((p) => p.name.toLowerCase() === 'default policy');
    const categories: Record<string, any> = {};
    for (const [k, v] of Object.entries((body.category_limits ?? {}) as Record<string, number>)) categories[k] = { per_day_limit: v };
    const payload = {
      name: 'Default policy', is_active: body.is_active ?? true, currency: body.currency ?? 'INR',
      applies_to: { everyone: true },
      rules: {
        ...(existing?.rules ?? {}),
        mileage_rate: body.mileage_rate ?? existing?.rules.mileage_rate ?? 12,
        auto_approve_under: body.auto_approve_under ?? existing?.rules.auto_approve_under ?? 0,
        escalate_over: body.escalate_over === undefined ? existing?.rules.escalate_over ?? null : body.escalate_over,
        receipt_required_over: body.require_receipt_over ?? existing?.rules.receipt_required_over ?? 500,
        categories: Object.fromEntries(CATEGORIES.map((c) => [c, { ...(existing?.rules.categories[c] ?? {}), ...(categories[c] ?? {}) }])),
      },
    };
    const saved = existing ? await updatePolicy(actor, existing.id as string, payload) : await createPolicy(actor, payload);
    return toClientShape(saved);
  }
  return legacySavePolicy(actor, body);
}

async function legacySavePolicy(actor: Actor, body: any) {
  const row: any = {
    org_id: actor.org_id, client_id: actor.client_id ?? null,
    currency: body.currency ?? 'INR', mileage_rate: body.mileage_rate ?? 12,
    auto_approve_under: body.auto_approve_under ?? 0, escalate_over: body.escalate_over ?? null,
    require_receipt_over: body.require_receipt_over ?? 500, category_limits: body.category_limits ?? null,
    is_active: body.is_active ?? true, updated_by: actor.id, updated_at: new Date().toISOString(),
  };
  const { data: existing } = await supabaseAdmin.from('expense_policies').select('id')
    .eq('org_id', actor.org_id).is('client_id', actor.client_id ?? null).maybeSingle();
  const q = existing
    ? supabaseAdmin.from('expense_policies').update(row).eq('id', (existing as any).id)
    : supabaseAdmin.from('expense_policies').insert(row);
  const { error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  return getMyPolicy(actor);
}

// ── helpers ─────────────────────────────────────────────────────────────────
async function supervisorOf(user_id: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('users').select('supervisor_id').eq('id', user_id).maybeSingle();
  return (data as any)?.supervisor_id ?? null;
}

async function notify(org_id: string, user_id: string | null, title: string, body: string, data: Record<string, string>) {
  if (!user_id) return;
  try {
    // The `notification_type` enum has no 'expense' value; inserting it fails
    // silently under PostgREST. Use 'general' and carry the semantic kind in
    // data.kind — the convention the apps deep-link on (see services/notify.ts).
    const kind = data.type || 'expense';
    await supabaseAdmin.from('notifications').insert({
      org_id, user_id, title, body, type: 'general', data: { kind, ...data }, is_read: false, sent_at: null,
    });
  } catch (e: any) { logger.warn(`[expenses] notify failed: ${e?.message || e}`); }
}

/**
 * Recipients for a "new claim to review" alert: the org's real approvers —
 * anyone with a team/all data-scope RBAC role, plus legacy admin/manager roles.
 * data_scope-aware: flat field-force tenants give reps the legacy `sub_admin`
 * role, distinguished from managers only by `org_roles.data_scope = 'own'`.
 */
const APPROVER_LEGACY_ROLES = ['admin', 'super_admin', 'main_admin', 'org_admin', 'client', 'manager', 'city_manager', 'supervisor', 'hr'];
async function resolveExpenseApprovers(org_id: string, client_id: string | null, excludeUserId?: string | null): Promise<string[]> {
  const out = new Set<string>();
  try {
    let q = supabaseAdmin.from('users')
      .select('id, role, client_id, org_role:org_roles!org_role_id(data_scope)')
      .eq('org_id', org_id).eq('is_active', true).limit(300);
    if (client_id) q = q.or(`client_id.eq.${client_id},client_id.is.null`);
    const { data } = await q;
    for (const u of ((data as any[]) ?? [])) {
      const scope = (u.org_role?.data_scope ?? '').toLowerCase();
      const role = (u.role ?? '').toLowerCase();
      if ((scope === 'team' || scope === 'all' || APPROVER_LEGACY_ROLES.includes(role)) && u.id !== excludeUserId) out.add(u.id);
    }
  } catch (e: any) { logger.warn(`[expenses] resolveExpenseApprovers failed: ${e?.message || e}`); }
  return [...out];
}

export async function stampNames(rows: any[]): Promise<any[]> {
  if (!rows.length) return rows;
  const ids = Array.from(new Set(rows.flatMap((r) => [r.user_id, r.approver_id, r.reviewed_by]).filter(Boolean)));
  if (!ids.length) return rows;
  const { data } = await supabaseAdmin.from('users').select('id, name, employee_id').in('id', ids);
  const m = new Map((data ?? []).map((u: any) => [u.id, u]));
  for (const r of rows) {
    r.user_name = m.get(r.user_id)?.name ?? null;
    r.employee_id = m.get(r.user_id)?.employee_id ?? null;
    r.approver_name = r.approver_id ? (m.get(r.approver_id)?.name ?? null) : null;
    r.reviewer_name = r.reviewed_by ? (m.get(r.reviewed_by)?.name ?? null) : null;
  }
  return rows;
}

function genClaimNo(): string {
  const d = new Date();
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return `EXP-${ym}-${Math.floor(1000 + Math.random() * 9000)}`;
}

async function loadClaim(org_id: string, id: string) {
  const { data } = await supabaseAdmin.from('expense_claims').select('*').eq('org_id', org_id).eq('id', id).maybeSingle();
  if (!data) throw new AppError(404, 'Claim not found', 'NOT_FOUND');
  return data as any;
}
async function loadOwnClaim(actor: Actor, id: string) {
  const c = await loadClaim(actor.org_id, id);
  if (c.user_id !== actor.id) throw new AppError(403, 'Not your claim', 'FORBIDDEN');
  return c;
}
async function loadItems(claim_id: string): Promise<any[]> {
  const { data } = await supabaseAdmin.from('expense_claim_items').select('*').eq('claim_id', claim_id).order('item_date', { ascending: true });
  return (data as any[]) ?? [];
}

// ── claim lines ─────────────────────────────────────────────────────────────
export interface ClaimItemInput {
  id?: string;
  category?: string;
  item_date?: string | null;
  description?: string | null;
  amount?: number | null;
  distance_km?: number | null;
  from_location?: string | null;
  to_location?: string | null;
  merchant?: string | null;
  receipt_url?: string | null;
  ai_extracted?: any;
  // Travel allowance by vehicle — only meaningful under a policy with vehicle_rates.
  vehicle_type?: string | null;
  odometer_start?: number | null;
  odometer_end?: number | null;
  odometer_start_photo_url?: string | null;
  odometer_end_photo_url?: string | null;
}

const validItems = (items: ClaimItemInput[] | undefined) =>
  (items ?? []).filter((i) => i && (CATEGORIES as readonly string[]).includes(i.category as string))
    // "" is how a client that omits nulls asks for the receipt (or an odometer photo) to be removed.
    .map((i) => {
      const cleared: Record<string, null> = {};
      if (i.receipt_url === '') cleared.receipt_url = null;
      for (const k of ODOMETER_PHOTO_KEYS) if ((i as any)[k] === '') cleared[k] = null;
      return Object.keys(cleared).length ? { ...i, ...cleared } : i;
    });

/** A mileage line with a distance but no amount is priced at the policy rate. */
function priceMileage<T extends { category?: string | null; amount?: number | null; distance_km?: number | null }>(items: T[], rate: number): T[] {
  return items.map((i) => (i.category === 'mileage' && Number(i.distance_km) > 0 && !(Number(i.amount) > 0)
    ? { ...i, amount: round2(Number(i.distance_km) * rate) } : i));
}

/**
 * Price the lines under the policy. With vehicle rates, a mileage line's distance and amount come
 * from the odometer readings and the chosen vehicle (a line with no vehicle takes the policy's only
 * vehicle when it has exactly one rate); otherwise a mileage line with a distance and no amount is
 * priced at the single policy rate, exactly as before.
 */
function priceItems<T extends ClaimItemInput>(items: T[], rules: ExpensePolicy['rules']): T[] {
  if (vehicleFlowOn(rules)) {
    return items.map((i) => (i.category === 'mileage' ? priceVehicleLine(i as any, rules.vehicle_rates!) as T : i));
  }
  return priceMileage(items, rules.mileage_rate);
}

const itemRow = (claim_id: string, org_id: string, i: ClaimItemInput) => {
  const row: Record<string, unknown> = {
    claim_id, org_id, category: i.category, item_date: i.item_date ?? null, description: i.description ?? null,
    amount: Number(i.amount || 0), distance_km: i.distance_km ?? null, from_location: i.from_location ?? null,
    to_location: i.to_location ?? null, merchant: i.merchant ?? null, receipt_url: i.receipt_url ?? null,
    ai_extracted: i.ai_extracted ?? null,
  };
  // Odometer columns only exist after migrations/expense_odometer.sql, so they are written only
  // when the line actually carries them — every other claim's insert is byte-for-byte unchanged.
  for (const k of ODOMETER_KEYS) {
    const v = (i as any)[k];
    if (v !== undefined) row[k] = v ?? null;
  }
  return row;
};

export async function listMyClaims(actor: Actor, status?: string) {
  let q = supabaseAdmin.from('expense_claims').select('*')
    .eq('org_id', actor.org_id).eq('user_id', actor.id).order('created_at', { ascending: false }).limit(200);
  const statuses = (status ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (statuses.length) q = q.in('status', statuses);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  return stampNames(data ?? []);
}

export async function getClaim(actor: Actor, id: string) {
  const c = await loadClaim(actor.org_id, id);
  // Visibility: the owner, the current approver, an admin, or anyone in the trail.
  if (c.user_id !== actor.id && c.approver_id !== actor.id && !isApprover(actor)) {
    const { data: mine } = await supabaseAdmin.from('expense_approvals').select('id').eq('claim_id', id).eq('approver_id', actor.id).limit(1);
    if (!mine || !mine.length) throw new AppError(403, 'Not your claim', 'FORBIDDEN');
  }
  const items = await loadItems(id);
  const { data: approvals } = await supabaseAdmin.from('expense_approvals').select('*').eq('claim_id', id)
    .order('round', { ascending: true }).order('level', { ascending: true });
  await stampNames([c]);
  await stampNames((approvals as any[]) ?? []);
  // A viewable link per receipt (short-lived; gated by the visibility check above).
  const withReceipts = await Promise.all(items.map(async (it) => ({
    ...it,
    receipt_signed_url: await signReceipt(actor.org_id, it.receipt_url),
    // Same for the odometer photos (only present on lines recorded under a vehicle policy).
    ...(it.odometer_start_photo_url || it.odometer_end_photo_url ? {
      odometer_start_photo_signed_url: await signReceipt(actor.org_id, it.odometer_start_photo_url),
      odometer_end_photo_signed_url: await signReceipt(actor.org_id, it.odometer_end_photo_url),
    } : {}),
  })));
  return { ...c, items: withReceipts, approvals: approvals ?? [] };
}

/** Create a draft claim with its lines. Totals are computed from the lines. */
export async function createClaim(actor: Actor, body: { title?: string | null; items?: ClaimItemInput[] }) {
  const policy = await resolvePolicyForUserId(actor.org_id, actor.client_id ?? null, actor.id);
  const items = priceItems(validItems(body.items), policy.rules);
  assertReceiptsOwned(actor, items);
  assertOdometerOrder(items);
  await assertOdometerStorable(items);
  const total = round2(items.reduce((s, i) => s + Number(i.amount || 0), 0));
  const distance = round2(items.filter((i) => i.category === 'mileage').reduce((s, i) => s + Number(i.distance_km || 0), 0));

  const { data: claim, error } = await supabaseAdmin.from('expense_claims').insert({
    org_id: actor.org_id, client_id: actor.client_id ?? null, user_id: actor.id, claim_no: genClaimNo(),
    title: body.title ?? null, status: 'draft', currency: policy.currency, total_amount: total,
    distance_km: distance || null, current_level: 1, created_by: actor.id,
  }).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB');

  const c = claim as any;
  if (items.length) {
    const { error: itErr } = await supabaseAdmin.from('expense_claim_items').insert(items.map((i) => itemRow(c.id, actor.org_id, i)));
    if (itErr) throw new AppError(500, itErr.message, 'DB');
  }
  return getClaim(actor, c.id);
}

// ── policy check ────────────────────────────────────────────────────────────
function detectDuplicatesAndMileage(items: any[], claimedKm: number, gpsKm: number | null, currency: string) {
  const flags: PolicyViolation[] = [];
  const flaggedItemIds: Record<string, string> = {};
  if (gpsKm != null && claimedKm > 0 && claimedKm - gpsKm > Math.max(5, gpsKm * 0.25)) {
    flags.push({ code: 'mileage_mismatch', severity: 'high', detail: `Claimed ${claimedKm.toFixed(1)} km but the GPS trail shows ${gpsKm.toFixed(1)} km.` });
  }
  const seen = new Map<string, string>();
  for (const it of items) {
    const amt = Number(it.amount || 0);
    if (amt <= 0) continue;
    const key = `${it.category}|${amt}|${String(it.item_date || '').slice(0, 10)}`;
    if (seen.has(key)) {
      const detail = `Possible duplicate: two ${it.category} lines of ${currency} ${amt.toFixed(0)} on the same day.`;
      flags.push({ code: 'duplicate', severity: 'warn', detail, item_id: it.id });
      flaggedItemIds[it.id] = detail;
    } else seen.set(key, it.id);
  }
  return { flags, flaggedItemIds };
}

async function analyze(org_id: string, claimUserId: string, claimId: string, items: any[], policy: ExpensePolicy, gpsKm: number | null) {
  const claimedKm = round2(items.filter((i) => i.category === 'mileage').reduce((s, i) => s + Number(i.distance_km || 0), 0));
  const total = round2(items.reduce((s, i) => s + Number(i.amount || 0), 0));
  let prior: Record<string, number> = {};
  const needsMonth = Object.values(policy.rules.categories).some((c) => c.per_month_limit != null);
  if (needsMonth && (await hasPolicyV2())) {
    const months = Array.from(new Set(items.map((i) => String(i.item_date || '').slice(0, 7)).filter(Boolean)));
    prior = await priorMonthSpend(org_id, claimUserId, claimId, months);
  }
  const rules = evaluateAgainstPolicy(policy, items, { priorMonthSpend: prior });
  const extra = detectDuplicatesAndMileage(items, claimedKm, gpsKm, policy.currency);
  const violations = [...rules.violations, ...extra.flags];
  const flaggedItemIds = { ...extra.flaggedItemIds, ...rules.flaggedItemIds };
  return { violations, flaggedItemIds, blocking: violations.filter((v) => v.blocking), claimedKm, total };
}

/** What would the policy say about these lines? Lets the apps warn before submitting. */
export async function checkClaim(actor: Actor, body: { items?: ClaimItemInput[]; claim_id?: string }) {
  const policy = await resolvePolicyForUserId(actor.org_id, actor.client_id ?? null, actor.id);
  // Unsaved lines are identified by their position, so a warning can point at a row.
  const items = priceItems(validItems(body.items), policy.rules).map((i, idx) => ({ ...i, id: String(idx) }));
  const a = await analyze(actor.org_id, actor.id, body.claim_id ?? '00000000-0000-0000-0000-000000000000', items, policy, null);
  return {
    policy: toClientShape(policy),
    total: a.total,
    violations: a.violations,
    blocking: a.blocking.length > 0,
    would_auto_approve: canAutoApprove(policy, a.total, a.violations),
  };
}

/** One-line approver brief. AI when available, deterministic fallback otherwise. */
async function buildSummary(claim: any, items: any[], flags: PolicyViolation[]): Promise<string> {
  const byCat = new Map<string, number>();
  for (const it of items) byCat.set(it.category, (byCat.get(it.category) || 0) + Number(it.amount || 0));
  const breakdown = Array.from(byCat.entries()).map(([c, a]) => `${c} ${a.toFixed(0)}`).join(', ');
  const deterministic = `${cur(claim)} ${Number(claim.total_amount).toFixed(0)} across ${items.length} line(s)${breakdown ? ` (${breakdown})` : ''}${flags.length ? ` — ${flags.length} flag(s): ${flags.map((f) => f.code).join(', ')}` : ' — no anomalies detected'}.`;
  try {
    const facts = {
      total: `${cur(claim)} ${Number(claim.total_amount).toFixed(2)}`,
      lines: items.map((it) => ({ category: it.category, amount: Number(it.amount || 0), date: it.item_date, merchant: it.merchant, from: it.from_location, to: it.to_location, distance_km: it.distance_km })),
      claimed_distance_km: claim.distance_km, gps_distance_km: claim.gps_derived_km,
      flags: flags.map((f) => `${f.severity}:${f.code} ${f.detail}`),
    };
    const text = await AIService.callKiniAI({
      model: process.env.EXPENSE_SUMMARY_MODEL || 'claude-haiku-4-5',
      max_tokens: 120,
      system: 'You brief a manager approving a field-sales expense claim. Given the claim facts as JSON, write ONE plain-text sentence (max 40 words) an approver can read at a glance: the total, what it is for, and the single most important thing to check if anything is flagged. No preamble, no markdown, no bullet points.',
      messages: [{ role: 'user', content: JSON.stringify(facts) }],
    });
    const line = (text || '').trim().replace(/\s+/g, ' ');
    return line || deterministic;
  } catch (e: any) {
    logger.warn(`[expenses] AI summary failed: ${e?.message || e}`);
    return deterministic;
  }
}

const stripFlag = (f: PolicyViolation) => ({ code: f.code, severity: f.severity, detail: f.detail, ...(f.item_id ? { item_id: f.item_id } : {}) });

async function persistFlags(items: any[], flaggedItemIds: Record<string, string>) {
  await supabaseAdmin.from('expense_claim_items').update({ flagged: false, flag_reason: null }).eq('claim_id', items[0]?.claim_id);
  for (const it of items) {
    const reason = flaggedItemIds[it.id];
    if (reason) await supabaseAdmin.from('expense_claim_items').update({ flagged: true, flag_reason: reason }).eq('id', it.id);
  }
}

/**
 * Edit a claim's title + lines while it can still change: a draft, one awaiting
 * approval, or a rejected one being fixed for resubmission. Lines that arrive
 * with their id are updated in place (keeping their receipt and history); lines
 * without one are added; lines left out are removed.
 */
export async function updateClaim(actor: Actor, id: string, body: { title?: string | null; items?: ClaimItemInput[] }) {
  const c = await loadOwnClaim(actor, id);
  if (!['draft', 'submitted', 'rejected'].includes(c.status)) {
    throw new AppError(400, 'This claim has already been approved and can no longer be edited', 'BAD_STATE');
  }
  const policy = c.policy_snapshot?.rules ? (c.policy_snapshot as ExpensePolicy) : await resolvePolicyForUserId(actor.org_id, actor.client_id ?? null, actor.id);
  const items = priceItems(validItems(body.items), policy.rules);
  if (!items.length) throw new AppError(400, 'Add at least one line', 'EMPTY');
  assertReceiptsOwned(actor, items);
  assertOdometerOrder(items);
  await assertOdometerStorable(items);

  const existing = await loadItems(id);
  const byId = new Map(existing.map((i) => [i.id, i]));
  const keep = new Set<string>();
  for (const i of items) {
    const prev = i.id ? byId.get(i.id) : undefined;
    if (prev) {
      keep.add(prev.id);
      const row: any = itemRow(id, actor.org_id, i);
      // A client that never heard of receipts must not wipe the one on file.
      if (i.receipt_url === undefined) row.receipt_url = prev.receipt_url;
      if (i.ai_extracted === undefined) row.ai_extracted = prev.ai_extracted;
      // (An odometer field the client did not send is simply left out of the update, so it keeps its value.)
      const { error } = await supabaseAdmin.from('expense_claim_items').update(row).eq('id', prev.id);
      if (error) throw new AppError(500, error.message, 'DB');
    } else {
      const { error } = await supabaseAdmin.from('expense_claim_items').insert(itemRow(id, actor.org_id, i));
      if (error) throw new AppError(500, error.message, 'DB');
    }
  }
  // Whatever was on file and isn't kept is removed. A client that sends no ids is
  // replacing the whole set: everything old goes, the new lines (inserted above)
  // stay — they were not in `existing`.
  const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (toDelete.length) await supabaseAdmin.from('expense_claim_items').delete().in('id', toDelete);

  const fresh = await loadItems(id);
  const total = round2(fresh.reduce((s, i) => s + Number(i.amount || 0), 0));
  const claimedKm = round2(fresh.filter((i) => i.category === 'mileage').reduce((s, i) => s + Number(i.distance_km || 0), 0));
  const update: any = {
    title: body.title !== undefined ? body.title : c.title, total_amount: total, distance_km: claimedKm || null,
    updated_at: new Date().toISOString(),
  };

  // A claim already with an approver is re-checked so they see current numbers.
  if (c.status === 'submitted') {
    const gpsKm: number | null = c.gps_derived_km == null ? null : Number(c.gps_derived_km);
    const a = await analyze(actor.org_id, actor.id, id, fresh, policy, gpsKm);
    if (a.blocking.length) throw new PolicyBlockedError(a.blocking);
    await persistFlags(fresh, a.flaggedItemIds);
    update.ai_flags = a.violations.map(stripFlag);
    update.ai_summary = await buildSummary({ ...c, total_amount: total, distance_km: claimedKm || null, gps_derived_km: gpsKm }, fresh, a.violations);
  }

  const { error } = await supabaseAdmin.from('expense_claims').update(update).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB');
  return getClaim(actor, id);
}

export async function cancelClaim(actor: Actor, id: string) {
  const c = await loadOwnClaim(actor, id);
  if (!['draft', 'submitted', 'rejected'].includes(c.status)) throw new AppError(400, 'Only a draft, submitted or rejected claim can be cancelled', 'BAD_STATE');
  await supabaseAdmin.from('expense_claims').update({ status: 'cancelled', approver_id: null, updated_at: new Date().toISOString() }).eq('id', id);
  await supabaseAdmin.from('expense_approvals').update({ status: 'rejected', note: 'Claim cancelled by claimant', decided_at: new Date().toISOString() })
    .eq('claim_id', id).eq('status', 'pending');
  if (c.approver_id) await notify(actor.org_id, c.approver_id, 'Expense claim cancelled', `${c.claim_no || 'A claim'} was cancelled by the claimant.`, { type: 'expense_cancelled', claim_id: id });
  return { ok: true };
}

/**
 * Submit a draft (or resubmit a rejected) claim: check it against the policy,
 * auto-approve when the policy allows, otherwise route to the first approver up
 * the reporting line.
 */
export async function submitClaim(actor: Actor, id: string) {
  const c = await loadOwnClaim(actor, id);
  if (!['draft', 'rejected'].includes(c.status)) throw new AppError(400, 'Only a draft or rejected claim can be submitted', 'BAD_STATE');

  const v2 = await hasPolicyV2();
  const policy = await resolvePolicyForUserId(actor.org_id, actor.client_id ?? null, actor.id);
  let items = await loadItems(id);
  if (!items.length) throw new AppError(400, 'Add at least one line before submitting', 'EMPTY');

  // Travel allowance by vehicle: a draft may have been saved before the rates changed, so price
  // each trip at the policy's current rate for its vehicle.
  if (vehicleFlowOn(policy.rules)) {
    for (const it of items) {
      if (it.category !== 'mileage') continue;
      const priced = priceVehicleLine(it as any, policy.rules.vehicle_rates!) as any;
      const patch: Record<string, unknown> = {};
      if (Number(priced.amount) !== Number(it.amount) || Number(priced.distance_km ?? 0) !== Number(it.distance_km ?? 0)) {
        patch.amount = priced.amount;
        patch.distance_km = priced.distance_km;
      }
      // A line saved without a vehicle under a one-vehicle policy is stored with that vehicle. (Only when the
      // row actually has the column: a database that has not run expense_odometer.sql has no vehicle_type.)
      if (priced.vehicle_type !== it.vehicle_type && Object.prototype.hasOwnProperty.call(it, 'vehicle_type')) {
        patch.vehicle_type = priced.vehicle_type;
      }
      if (Object.keys(patch).length) {
        await supabaseAdmin.from('expense_claim_items').update(patch).eq('id', it.id);
        Object.assign(it, patch);
      }
    }
  }
  // Price any mileage line that has a distance but no amount yet.
  for (const it of items) {
    if (it.category === 'mileage' && Number(it.distance_km) > 0 && !(Number(it.amount) > 0)) {
      const amount = round2(Number(it.distance_km) * policy.rules.mileage_rate);
      await supabaseAdmin.from('expense_claim_items').update({ amount }).eq('id', it.id);
      it.amount = amount;
    }
  }
  items = items.map((i) => ({ ...i }));
  const claimedKm = round2(items.filter((i) => i.category === 'mileage').reduce((s, i) => s + Number(i.distance_km || 0), 0));

  // GPS cross-check across the span of the claim's dates.
  let gpsKm: number | null = c.gps_derived_km == null ? null : Number(c.gps_derived_km);
  if (claimedKm > 0 && gpsKm == null) {
    const dates = items.map((i) => String(i.item_date || '').slice(0, 10)).filter(Boolean).sort();
    if (dates.length) {
      try { gpsKm = (await mileageFromTrail(actor.org_id, actor.id, `${dates[0]}T00:00:00.000Z`, `${dates[dates.length - 1]}T23:59:59.999Z`)).distance_km; }
      catch (e: any) { logger.warn(`[expenses] mileage cross-check failed: ${e?.message || e}`); }
    }
  }

  const a = await analyze(actor.org_id, actor.id, id, items, policy, gpsKm);
  if (a.blocking.length) throw new PolicyBlockedError(a.blocking);
  await persistFlags(items, a.flaggedItemIds);

  const total = a.total;
  const summary = await buildSummary({ ...c, currency: policy.currency, total_amount: total, distance_km: claimedKm || null, gps_derived_km: gpsKm }, items, a.violations);
  const round = Number(c.submit_count ?? 0) + 1;
  const now = new Date().toISOString();
  const auto = canAutoApprove(policy, total, a.violations);

  // A fresh round: previous decisions are cleared (the trail keeps them).
  if (v2) await supabaseAdmin.from('expense_claim_items').update({ decision: null, decision_note: null, decided_by: null, decided_at: null }).eq('claim_id', id);

  const approver_id = auto ? null : await supervisorOf(actor.id);
  const base: any = {
    status: auto ? 'approved' : 'submitted', total_amount: total, distance_km: claimedKm || null, gps_derived_km: gpsKm,
    ai_flags: a.violations.map(stripFlag), ai_summary: summary, approver_id, current_level: 1, currency: policy.currency,
    submitted_at: now, updated_at: now,
    reviewed_by: null, reviewed_at: auto ? now : null,
    review_note: auto ? `Auto-approved by policy "${policy.name}"` : null,
  };
  if (v2) Object.assign(base, {
    policy_id: policy.id ?? null, policy_name: policy.name, policy_snapshot: policy,
    approved_amount: auto ? total : null, submit_count: round, auto_approved: auto,
  });
  const { error } = await supabaseAdmin.from('expense_claims').update(base).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB');

  const roundCol = v2 ? { round } : {};
  const { data: me } = await supabaseAdmin.from('users').select('name').eq('id', actor.id).maybeSingle();
  const claimantName = (me as any)?.name || 'A team member';

  if (auto) {
    if (v2) await supabaseAdmin.from('expense_claim_items').update({ decision: 'approved', decided_at: now }).eq('claim_id', id);
    await supabaseAdmin.from('expense_approvals').insert({
      claim_id: id, org_id: actor.org_id, level: 1, approver_id: null, status: 'approved',
      note: `Auto-approved by policy "${policy.name}"`, decided_at: now, ...roundCol,
    });
    await notify(actor.org_id, actor.id, 'Expense claim approved',
      `${c.claim_no || 'Your claim'} for ${fmt(policy, total)} was approved automatically.`, { type: 'expense_decision', claim_id: id, decision: 'approved' });
    return getClaim(actor, id);
  }

  await supabaseAdmin.from('expense_approvals').insert({ claim_id: id, org_id: actor.org_id, level: 1, approver_id, status: 'pending', ...roundCol });

  // 1) The direct supervisor, when one is set.
  if (approver_id) {
    await notify(actor.org_id, approver_id, 'Expense claim to review',
      `${claimantName} submitted ${fmt(policy, total)} — ${summary}`, { type: 'expense_submitted', claim_id: id });
  } else {
    logger.warn(`[expenses] claim ${id} submitted but claimant ${actor.id} has no supervisor — admins/managers notified instead.`);
  }
  // 2) The org's admins/managers, so a claim is never missed when no supervisor is set.
  try {
    const approvers = await resolveExpenseApprovers(actor.org_id, actor.client_id ?? null, actor.id);
    await notifyUsers(approvers.filter((x) => x !== approver_id), {
      orgId: actor.org_id, kind: 'expense_submitted', title: 'Expense claim to review',
      body: `${claimantName} submitted ${fmt(policy, total)} for approval.`, data: { claim_id: id },
    });
  } catch (e: any) { logger.warn(`[expenses] approver fan-out failed: ${e?.message || e}`); }

  return getClaim(actor, id);
}

// ── mileage helper (suggest an amount from the trail) ───────────────────────
export async function mileageSuggestion(actor: Actor, fromISO: string, toISO: string, forUserId?: string) {
  const userId = forUserId && isApprover(actor) ? forUserId : actor.id;
  const m = await mileageFromTrail(actor.org_id, userId, fromISO, toISO);
  const policy = await resolvePolicy(actor.org_id, actor.client_id ?? null, await policyUserOf(userId));
  return { ...m, mileage_rate: policy.rules.mileage_rate, currency: policy.currency, suggested_amount: round2(m.distance_km * policy.rules.mileage_rate) };
}

// ── approver ────────────────────────────────────────────────────────────────
async function filterByCity(rows: any[], city?: string) {
  if (!city || !rows.length) return rows;
  const ids = Array.from(new Set(rows.map((r) => r.user_id).filter(Boolean)));
  const { data: us } = await supabaseAdmin.from('users').select('id, city').in('id', ids);
  const cityOf = new Map((us ?? []).map((u: any) => [u.id, (u.city || '').toLowerCase()]));
  return rows.filter((r) => cityOf.get(r.user_id) === city.toLowerCase());
}

export async function pendingForApprover(actor: Actor, city?: string, limit = 200) {
  let q = supabaseAdmin.from('expense_claims').select('*').eq('org_id', actor.org_id).eq('status', 'submitted')
    .order('submitted_at', { ascending: false }).limit(limit);
  if (!isApprover(actor)) q = q.eq('approver_id', actor.id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  return stampNames(await filterByCity((data as any[]) || [], city));
}

/** Approved claims across the org still awaiting reimbursement (admin/finance). */
export async function awaitingReimbursement(actor: Actor, city?: string, limit = 200) {
  if (!isApprover(actor)) throw new AppError(403, 'Only an admin can view reimbursements', 'FORBIDDEN');
  const { data, error } = await supabaseAdmin.from('expense_claims').select('*')
    .eq('org_id', actor.org_id).eq('status', 'approved').order('reviewed_at', { ascending: true }).limit(limit);
  if (error) throw new AppError(500, error.message, 'DB');
  return stampNames(await filterByCity((data as any[]) || [], city));
}

export interface LineDecisionInput { id: string; decision: 'approved' | 'rejected'; note?: string | null }
export interface DecisionInput { decision: 'approved' | 'rejected'; note?: string | null; items?: LineDecisionInput[] }

/**
 * Approve or reject at the current level.
 *
 *   - Rejecting needs a remark — for the whole claim, and for any single line.
 *   - Lines can be decided one by one; the claim then pays out the approved
 *     lines only (a partial approval). If every line ends up rejected the claim
 *     is rejected and needs an overall remark.
 *   - A claim over the policy's escalation limit climbs to the approver's own
 *     manager instead of finalising, up to MAX_APPROVAL_LEVELS.
 */
export async function decide(actor: Actor, id: string, input: DecisionInput) {
  const note = (input.note ?? '').toString().trim();
  const c = await loadClaim(actor.org_id, id);
  if (c.status !== 'submitted') throw new AppError(400, 'This claim is not awaiting approval', 'BAD_STATE');
  if (!isApprover(actor) && c.approver_id !== actor.id) throw new AppError(403, 'You are not the current approver for this claim', 'FORBIDDEN');

  const v2 = await hasPolicyV2();
  const items = await loadItems(id);
  const byId = new Map(items.map((i) => [i.id, i]));

  // Work out the decision on every line.
  const line = new Map<string, { decision: 'approved' | 'rejected'; note: string | null }>();
  const given = new Map((input.items ?? []).map((l) => [l.id, l]));
  if (v2) {
    for (const l of given.values()) {
      if (!byId.has(l.id)) throw new AppError(400, 'One of the lines does not belong to this claim', 'VALIDATION');
      if (l.decision === 'rejected' && !(l.note ?? '').trim()) {
        const it = byId.get(l.id);
        throw new AppError(400, `Add a remark for the rejected ${it.category} line (${fmt(c, it.amount)}).`, 'REMARK_REQUIRED');
      }
    }
    for (const it of items) {
      const g = given.get(it.id);
      if (g) line.set(it.id, { decision: g.decision, note: (g.note ?? '').trim() || null });
      else if (input.decision === 'rejected') line.set(it.id, { decision: 'rejected', note: note || null });
      else line.set(it.id, { decision: 'approved', note: null });
    }
  }

  let decision = input.decision;
  if (decision === 'rejected' && !note) throw new AppError(400, 'Add a remark explaining why this claim is rejected.', 'REMARK_REQUIRED');
  if (decision === 'approved' && v2 && items.length && items.every((i) => line.get(i.id)?.decision === 'rejected')) {
    if (!note) throw new AppError(400, 'Every line is rejected — add an overall remark for the claim.', 'REMARK_REQUIRED');
    decision = 'rejected';
  }

  const approvedItems = v2 ? items.filter((i) => line.get(i.id)?.decision !== 'rejected') : items;
  const approvedAmount = decision === 'rejected' ? 0 : round2(approvedItems.reduce((s, i) => s + Number(i.amount || 0), 0));
  const rejectedLines = v2 ? items.filter((i) => line.get(i.id)?.decision === 'rejected') : [];
  const now = new Date().toISOString();

  // Record each line's decision on the line itself and as a frozen trail snapshot.
  const snapshot = v2 ? items.map((i) => ({ item_id: i.id, category: i.category, amount: Number(i.amount || 0), decision: line.get(i.id)?.decision, note: line.get(i.id)?.note ?? null })) : null;
  if (v2) {
    for (const it of items) {
      const d = line.get(it.id)!;
      await supabaseAdmin.from('expense_claim_items').update({ decision: d.decision, decision_note: d.note, decided_by: actor.id, decided_at: now }).eq('id', it.id);
    }
  }
  // Record who actually decided (an admin may act on the assigned approver's behalf).
  const trailUpdate: any = { status: decision, note: note || null, decided_at: now, approver_id: actor.id };
  if (v2) trailUpdate.item_decisions = snapshot;
  await supabaseAdmin.from('expense_approvals').update(trailUpdate).eq('claim_id', id).eq('level', c.current_level).eq('status', 'pending');

  if (decision === 'rejected') {
    const patch: any = { status: 'rejected', reviewed_by: actor.id, reviewed_at: now, review_note: note, approver_id: null, updated_at: now };
    if (v2) patch.approved_amount = null;
    await supabaseAdmin.from('expense_claims').update(patch).eq('id', id);
    await notify(actor.org_id, c.user_id, 'Expense claim rejected', `${c.claim_no || 'Your claim'} was rejected: ${note}`,
      { type: 'expense_decision', claim_id: id, decision: 'rejected' });
    return { ok: true, status: 'rejected' };
  }

  // Approved at this level — escalate if the approved amount is over the limit.
  const policy: ExpensePolicy = c.policy_snapshot?.rules ? c.policy_snapshot : await resolvePolicy(actor.org_id, c.client_id ?? null, await policyUserOf(c.user_id));
  const limit = policy.rules.escalate_over;
  if (limit != null && approvedAmount > Number(limit) && c.current_level < MAX_APPROVAL_LEVELS) {
    const nextApprover = await supervisorOf(actor.id);
    const { data: trail } = await supabaseAdmin.from('expense_approvals').select('approver_id').eq('claim_id', id);
    const visited = new Set((trail ?? []).map((t: any) => t.approver_id).filter(Boolean));
    if (nextApprover && !visited.has(nextApprover)) {
      const nextLevel = c.current_level + 1;
      await supabaseAdmin.from('expense_claims').update({ approver_id: nextApprover, current_level: nextLevel, updated_at: now }).eq('id', id);
      await supabaseAdmin.from('expense_approvals').insert({
        claim_id: id, org_id: actor.org_id, level: nextLevel, approver_id: nextApprover, status: 'pending', ...(v2 ? { round: Number(c.submit_count ?? 1) } : {}),
      });
      await notify(actor.org_id, nextApprover, 'Expense claim to review (escalated)',
        `${c.claim_no || 'A claim'} for ${fmt(c, approvedAmount)} needs your sign-off — ${c.ai_summary || ''}`.trim(), { type: 'expense_submitted', claim_id: id });
      await notify(actor.org_id, c.user_id, 'Expense claim escalated',
        `${c.claim_no || 'Your claim'} was approved and escalated to the next manager for final sign-off.`, { type: 'expense_escalated', claim_id: id });
      return { ok: true, status: 'submitted', escalated: true, level: nextLevel, approved_amount: approvedAmount };
    }
  }

  const patch: any = { status: 'approved', reviewed_by: actor.id, reviewed_at: now, review_note: note || null, approver_id: null, updated_at: now };
  if (v2) patch.approved_amount = approvedAmount;
  await supabaseAdmin.from('expense_claims').update(patch).eq('id', id);

  const partial = rejectedLines.length > 0;
  const firstRemark = rejectedLines.find((l) => line.get(l.id)?.note)?.id;
  await notify(actor.org_id, c.user_id, partial ? 'Expense claim partly approved' : 'Expense claim approved',
    partial
      ? `${c.claim_no || 'Your claim'}: ${fmt(c, approvedAmount)} of ${fmt(c, c.total_amount)} approved. ${rejectedLines.length} line(s) rejected${firstRemark ? ` — ${line.get(firstRemark)!.note}` : ''}.`
      : `${c.claim_no || 'Your claim'} for ${fmt(c, approvedAmount)} was approved.`,
    { type: 'expense_decision', claim_id: id, decision: 'approved' });
  return { ok: true, status: 'approved', approved_amount: approvedAmount, rejected_lines: rejectedLines.length };
}

/** Decide many claims at once. Each is processed on its own; failures are reported, not fatal. */
export async function bulkDecide(actor: Actor, ids: string[], decision: 'approved' | 'rejected', note?: string | null) {
  if (decision === 'rejected' && !(note ?? '').trim()) throw new AppError(400, 'Add a remark explaining why these claims are rejected.', 'REMARK_REQUIRED');
  const done: Array<{ id: string; status: string }> = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of Array.from(new Set(ids)).slice(0, 100)) {
    try { const r = await decide(actor, id, { decision, note }); done.push({ id, status: r.status }); }
    catch (e: any) { failed.push({ id, error: e?.message || 'Failed' }); }
  }
  return { done, failed };
}

/** Mark an approved claim reimbursed (admin/finance). Pays the approved amount. */
export async function reimburse(actor: Actor, id: string, ref?: string) {
  if (!isApprover(actor)) throw new AppError(403, 'Only an admin can mark a claim reimbursed', 'FORBIDDEN');
  const c = await loadClaim(actor.org_id, id);
  if (c.status !== 'approved') throw new AppError(400, 'Only an approved claim can be reimbursed', 'BAD_STATE');
  const now = new Date().toISOString();
  await supabaseAdmin.from('expense_claims').update({ status: 'reimbursed', reimbursed_at: now, reimbursed_ref: ref ?? null, updated_at: now }).eq('id', id);
  const paid = c.approved_amount != null ? Number(c.approved_amount) : Number(c.total_amount);
  await notify(actor.org_id, c.user_id, 'Expense reimbursed', `${c.claim_no || 'Your claim'} for ${fmt(c, paid)} was reimbursed${ref ? ` (ref ${ref})` : ''}.`,
    { type: 'expense_reimbursed', claim_id: id });
  return { ok: true, status: 'reimbursed' };
}
