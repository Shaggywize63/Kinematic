/**
 * Field Expense / Travel Claims — core service.
 *
 * A rep files a claim with one or more lines (mileage / travel / food / lodging
 * / fuel / toll / misc). On submit the claim:
 *   1. totals up, and mileage lines can be auto-priced from the GPS-derived
 *      distance (see mileage.service) × the policy rate;
 *   2. runs an anomaly pass (missing receipts, per-category cap breaches,
 *      claimed-vs-GPS mileage mismatch, duplicate lines) → `ai_flags`;
 *   3. gets a one-line AI approver brief → `ai_summary`;
 *   4. routes up the reporting hierarchy (users.supervisor_id). High-value
 *      claims (over the policy `escalate_over`) climb to each next manager up
 *      until the top, one `expense_approvals` row per level visited.
 *
 * AI is best-effort throughout: OCR, anomaly summary and the approver brief all
 * degrade to deterministic behaviour so a claim can always be filed and acted
 * on even when the model is unavailable.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { AIService } from '../ai.service';
import { mileageFromTrail } from './mileage.service';
import { notifyUsers } from '../notify';

export interface Actor { id: string; org_id: string; role?: string | null; client_id?: string | null; data_scope?: string | null; }

const ADMIN_ROLES = ['admin', 'super_admin', 'main_admin', 'org_admin', 'sub_admin', 'client'];
function isAdmin(role?: string | null) { return ADMIN_ROLES.includes((role ?? '').toLowerCase()); }

/**
 * Can this actor act as an approver/admin for expenses? Identical to isAdmin on
 * the legacy role, EXCEPT a field executive is never one. Flat field-force
 * tenants (e.g. ByteBack) give reps the `sub_admin` role — which isAdmin would
 * wrongly accept — distinguished from real managers only by an org-role
 * data_scope of 'own'. Denying own-scope here stops a rep from seeing or
 * deciding other people's claims via the coarse role check. Pure tightening:
 * non-own actors behave exactly as before.
 */
function isApprover(actor: Actor): boolean {
  if ((actor.data_scope ?? '').toLowerCase() === 'own') return false;
  return isAdmin(actor.role);
}

const ITEM_CATEGORIES = ['mileage', 'travel', 'food', 'lodging', 'fuel', 'toll', 'misc'];
const MAX_APPROVAL_LEVELS = 5; // hard stop so escalation can never loop up the tree forever

// ── policy ──────────────────────────────────────────────────────────────────
export interface Policy {
  id?: string;
  currency: string;
  mileage_rate: number;
  auto_approve_under: number;
  escalate_over: number | null;
  require_receipt_over: number;
  category_limits: Record<string, number> | null;
  is_active: boolean;
}

const DEFAULT_POLICY: Policy = {
  currency: 'INR', mileage_rate: 12, auto_approve_under: 0, escalate_over: null,
  require_receipt_over: 500, category_limits: null, is_active: true,
};

/** Resolve the effective policy: the client-scoped row if present, else the
 *  org-level row, else built-in defaults. */
export async function getPolicy(org_id: string, client_id: string | null): Promise<Policy> {
  const { data } = await supabaseAdmin
    .from('expense_policies').select('*').eq('org_id', org_id).eq('is_active', true);
  const rows = (data as any[]) || [];
  const scoped = rows.find((r) => r.client_id && r.client_id === client_id);
  const orgLevel = rows.find((r) => !r.client_id);
  const row = scoped || orgLevel;
  if (!row) return { ...DEFAULT_POLICY };
  return {
    id: row.id,
    currency: row.currency || 'INR',
    mileage_rate: Number(row.mileage_rate ?? 12),
    auto_approve_under: Number(row.auto_approve_under ?? 0),
    escalate_over: row.escalate_over == null ? null : Number(row.escalate_over),
    require_receipt_over: Number(row.require_receipt_over ?? 500),
    category_limits: row.category_limits ?? null,
    is_active: row.is_active !== false,
  };
}

export async function savePolicy(actor: Actor, body: any): Promise<Policy> {
  if (!isApprover(actor)) throw new AppError(403, 'Only an admin can edit the expense policy', 'FORBIDDEN');
  const row: any = {
    org_id: actor.org_id,
    client_id: actor.client_id ?? null,
    currency: body.currency ?? 'INR',
    mileage_rate: body.mileage_rate ?? 12,
    auto_approve_under: body.auto_approve_under ?? 0,
    escalate_over: body.escalate_over ?? null,
    require_receipt_over: body.require_receipt_over ?? 500,
    category_limits: body.category_limits ?? null,
    is_active: body.is_active ?? true,
    updated_by: actor.id,
    updated_at: new Date().toISOString(),
  };
  // Upsert on the (org, client) scope unique index.
  const { data, error } = await supabaseAdmin
    .from('expense_policies')
    .upsert(row, { onConflict: 'org_id,client_id', ignoreDuplicates: false })
    .select('*').maybeSingle();
  if (error) {
    // Fallback for the COALESCE-based partial unique index (client_id NULL):
    // do an explicit find-then-update/insert.
    const { data: existing } = await supabaseAdmin
      .from('expense_policies').select('id')
      .eq('org_id', actor.org_id)
      .is('client_id', actor.client_id ?? null).maybeSingle();
    if (existing) {
      const { data: upd } = await supabaseAdmin.from('expense_policies')
        .update(row).eq('id', (existing as any).id).select('*').maybeSingle();
      return getPolicy(actor.org_id, actor.client_id ?? null).then(() => normalizePolicy(upd));
    }
    const { data: ins, error: insErr } = await supabaseAdmin.from('expense_policies').insert(row).select('*').maybeSingle();
    if (insErr) throw new AppError(500, insErr.message, 'DB');
    return normalizePolicy(ins);
  }
  return normalizePolicy(data);
}

function normalizePolicy(row: any): Policy {
  if (!row) return { ...DEFAULT_POLICY };
  return {
    id: row.id, currency: row.currency || 'INR', mileage_rate: Number(row.mileage_rate ?? 12),
    auto_approve_under: Number(row.auto_approve_under ?? 0),
    escalate_over: row.escalate_over == null ? null : Number(row.escalate_over),
    require_receipt_over: Number(row.require_receipt_over ?? 500),
    category_limits: row.category_limits ?? null, is_active: row.is_active !== false,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────
async function supervisorOf(user_id: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('users').select('supervisor_id').eq('id', user_id).maybeSingle();
  return (data as any)?.supervisor_id ?? null;
}

async function notify(org_id: string, user_id: string | null, title: string, body: string, data: Record<string, string>) {
  if (!user_id) return;
  try {
    // The `notification_type` enum has no 'expense' value; inserting it fails
    // (silently, under PostgREST) — which historically dropped EVERY expense
    // notification (submit / approve / reject / reimburse). Use the guaranteed
    // 'general' type and carry the semantic kind in data.kind, the same
    // convention the mobile clients deep-link on (see services/notify.ts).
    const kind = data.type || 'expense';
    await supabaseAdmin.from('notifications').insert({
      org_id, user_id, title, body,
      type: 'general',
      data: { kind, ...data },
      is_read: false,
      sent_at: null,
    });
  } catch (e: any) { logger.warn(`[expenses] notify failed: ${e?.message || e}`); }
}

/**
 * Recipients for a "new claim to review" alert: the org's real approvers —
 * anyone with a team/all data-scope RBAC role, plus legacy admin/manager roles.
 * Deliberately data_scope-aware: ByteBack (and other flat field-force tenants)
 * give field execs the legacy `sub_admin` role, distinguished from managers only
 * by `org_roles.data_scope = 'own'`, so a role-only match would spam every rep.
 * Best-effort; excludes the claimant.
 */
const APPROVER_LEGACY_ROLES = ['admin', 'super_admin', 'main_admin', 'org_admin', 'client', 'manager', 'city_manager', 'supervisor', 'hr'];
async function resolveExpenseApprovers(org_id: string, client_id: string | null, excludeUserId?: string | null): Promise<string[]> {
  const out = new Set<string>();
  try {
    let q = supabaseAdmin
      .from('users')
      .select('id, role, client_id, org_role:org_roles!org_role_id(data_scope)')
      .eq('org_id', org_id).eq('is_active', true).limit(300);
    if (client_id) q = q.or(`client_id.eq.${client_id},client_id.is.null`);
    const { data } = await q;
    for (const u of ((data as any[]) ?? [])) {
      const scope = (u.org_role?.data_scope ?? '').toLowerCase();
      const role = (u.role ?? '').toLowerCase();
      const isApprover = scope === 'team' || scope === 'all' || APPROVER_LEGACY_ROLES.includes(role);
      if (isApprover && u.id !== excludeUserId) out.add(u.id);
    }
  } catch (e: any) { logger.warn(`[expenses] resolveExpenseApprovers failed: ${e?.message || e}`); }
  return [...out];
}

async function stampNames(rows: any[]): Promise<any[]> {
  if (!rows.length) return rows;
  const ids = Array.from(new Set(rows.flatMap((r) => [r.user_id, r.approver_id]).filter(Boolean)));
  if (!ids.length) return rows;
  const { data } = await supabaseAdmin.from('users').select('id, name, employee_id').in('id', ids);
  const m = new Map((data ?? []).map((u: any) => [u.id, u]));
  for (const r of rows) {
    r.user_name = m.get(r.user_id)?.name ?? null;
    r.employee_id = m.get(r.user_id)?.employee_id ?? null;
    r.approver_name = r.approver_id ? (m.get(r.approver_id)?.name ?? null) : null;
  }
  return rows;
}

function genClaimNo(): string {
  const d = new Date();
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `EXP-${ym}-${rand}`;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// ── claims (rep) ────────────────────────────────────────────────────────────
export interface ClaimItemInput {
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
}

export async function listMyClaims(actor: Actor, status?: string) {
  let q = supabaseAdmin.from('expense_claims').select('*')
    .eq('org_id', actor.org_id).eq('user_id', actor.id)
    .order('created_at', { ascending: false }).limit(200);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  return stampNames(data ?? []);
}

export async function getClaim(actor: Actor, id: string) {
  const { data: claim } = await supabaseAdmin.from('expense_claims').select('*')
    .eq('org_id', actor.org_id).eq('id', id).maybeSingle();
  if (!claim) throw new AppError(404, 'Claim not found', 'NOT_FOUND');
  // Visibility: owner, the current/any approver, or an admin.
  const c = claim as any;
  if (c.user_id !== actor.id && c.approver_id !== actor.id && !isApprover(actor)) {
    // Allow if the caller appears anywhere in the approval trail.
    const { data: mine } = await supabaseAdmin.from('expense_approvals')
      .select('id').eq('claim_id', id).eq('approver_id', actor.id).limit(1);
    if (!mine || !mine.length) throw new AppError(403, 'Not your claim', 'FORBIDDEN');
  }
  const { data: items } = await supabaseAdmin.from('expense_claim_items')
    .select('*').eq('claim_id', id).order('item_date', { ascending: true });
  const { data: approvals } = await supabaseAdmin.from('expense_approvals')
    .select('*').eq('claim_id', id).order('level', { ascending: true });
  await stampNames([c]);
  await stampNames((approvals as any[]) ?? []);
  return { ...c, items: items ?? [], approvals: approvals ?? [] };
}

/** Create a draft claim with its line items. Totals are computed from the lines. */
export async function createClaim(actor: Actor, body: { title?: string | null; items?: ClaimItemInput[] }) {
  const items = (body.items ?? []).filter((i) => i && ITEM_CATEGORIES.includes(i.category));
  const total = round2(items.reduce((s, i) => s + Number(i.amount || 0), 0));
  const distance = round2(items.filter((i) => i.category === 'mileage').reduce((s, i) => s + Number(i.distance_km || 0), 0));
  const policy = await getPolicy(actor.org_id, actor.client_id ?? null);

  const { data: claim, error } = await supabaseAdmin.from('expense_claims').insert({
    org_id: actor.org_id, client_id: actor.client_id ?? null, user_id: actor.id,
    claim_no: genClaimNo(), title: body.title ?? null, status: 'draft',
    currency: policy.currency, total_amount: total, distance_km: distance || null,
    current_level: 1, created_by: actor.id,
  }).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB');

  const c = claim as any;
  if (items.length) {
    const rows = items.map((i) => ({
      claim_id: c.id, org_id: actor.org_id, category: i.category,
      item_date: i.item_date ?? null, description: i.description ?? null,
      amount: Number(i.amount || 0), distance_km: i.distance_km ?? null,
      from_location: i.from_location ?? null, to_location: i.to_location ?? null,
      merchant: i.merchant ?? null, receipt_url: i.receipt_url ?? null,
      ai_extracted: i.ai_extracted ?? null,
    }));
    const { error: itErr } = await supabaseAdmin.from('expense_claim_items').insert(rows);
    if (itErr) throw new AppError(500, itErr.message, 'DB');
  }
  return getClaim(actor, c.id);
}

/**
 * Edit a claim's title + line items while it is still editable — i.e. BEFORE
 * approval. Allowed to the owner on a `draft` or `submitted` claim; once the
 * claim is approved / rejected / reimbursed / cancelled it can no longer be
 * changed (the caller/UI hides the edit affordance too). On a still-`submitted`
 * claim the totals, anomaly flags and approver brief are recomputed so the
 * pending approver always sees current numbers.
 */
export async function updateClaim(actor: Actor, id: string, body: { title?: string | null; items?: ClaimItemInput[] }) {
  const { data: claim } = await supabaseAdmin.from('expense_claims').select('*')
    .eq('org_id', actor.org_id).eq('id', id).maybeSingle();
  if (!claim) throw new AppError(404, 'Claim not found', 'NOT_FOUND');
  const c = claim as any;
  if (c.user_id !== actor.id) throw new AppError(403, 'Not your claim', 'FORBIDDEN');
  if (!['draft', 'submitted'].includes(c.status)) {
    throw new AppError(400, 'This claim has already been decided and can no longer be edited', 'BAD_STATE');
  }

  const items = (body.items ?? []).filter((i) => i && ITEM_CATEGORIES.includes(i.category as string));
  if (!items.length) throw new AppError(400, 'Add at least one line', 'EMPTY');
  const total = round2(items.reduce((s, i) => s + Number(i.amount || 0), 0));
  const claimedKm = round2(items.filter((i) => i.category === 'mileage').reduce((s, i) => s + Number(i.distance_km || 0), 0));

  // Replace the line items wholesale (simplest correct semantics for an edit).
  await supabaseAdmin.from('expense_claim_items').delete().eq('claim_id', id);
  const rows = items.map((i) => ({
    claim_id: id, org_id: actor.org_id, category: i.category,
    item_date: i.item_date ?? null, description: i.description ?? null,
    amount: Number(i.amount || 0), distance_km: i.distance_km ?? null,
    from_location: i.from_location ?? null, to_location: i.to_location ?? null,
    merchant: i.merchant ?? null, receipt_url: i.receipt_url ?? null,
    ai_extracted: i.ai_extracted ?? null,
  }));
  const { error: itErr } = await supabaseAdmin.from('expense_claim_items').insert(rows);
  if (itErr) throw new AppError(500, itErr.message, 'DB');

  const now = new Date().toISOString();
  const update: any = {
    title: body.title !== undefined ? body.title : c.title,
    total_amount: total,
    distance_km: claimedKm || null,
    updated_at: now,
  };

  // A submitted claim is awaiting an approver — re-run the anomaly pass + brief
  // so what they see reflects the edit.
  if (c.status === 'submitted') {
    const policy = await getPolicy(actor.org_id, actor.client_id ?? null);
    const { data: freshItems } = await supabaseAdmin.from('expense_claim_items').select('*').eq('claim_id', id);
    const its = (freshItems as any[]) || [];
    const gpsKm: number | null = c.gps_derived_km == null ? null : Number(c.gps_derived_km);
    const { flags, flaggedItemIds } = detectAnomalies(its, policy, claimedKm, gpsKm);
    for (const it of its) {
      const reason = flaggedItemIds[it.id];
      await supabaseAdmin.from('expense_claim_items').update({ flagged: !!reason, flag_reason: reason ?? null }).eq('id', it.id);
    }
    update.ai_flags = flags;
    update.ai_summary = await buildSummary({ ...c, total_amount: total, distance_km: claimedKm || null, gps_derived_km: gpsKm }, its, flags);
  }

  const { error } = await supabaseAdmin.from('expense_claims').update(update).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB');
  return getClaim(actor, id);
}

export async function cancelClaim(actor: Actor, id: string) {
  const { data: claim } = await supabaseAdmin.from('expense_claims').select('*')
    .eq('org_id', actor.org_id).eq('id', id).maybeSingle();
  if (!claim) throw new AppError(404, 'Claim not found', 'NOT_FOUND');
  const c = claim as any;
  if (c.user_id !== actor.id) throw new AppError(403, 'Not your claim', 'FORBIDDEN');
  if (!['draft', 'submitted'].includes(c.status)) throw new AppError(400, 'Only a draft or submitted claim can be cancelled', 'BAD_STATE');
  await supabaseAdmin.from('expense_claims').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', id);
  await supabaseAdmin.from('expense_approvals').update({ status: 'rejected', note: 'Claim cancelled by claimant', decided_at: new Date().toISOString() })
    .eq('claim_id', id).eq('status', 'pending');
  if (c.approver_id) await notify(actor.org_id, c.approver_id, 'Expense claim cancelled', `${c.claim_no || 'A claim'} was cancelled by the claimant.`, { type: 'expense_cancelled', claim_id: id });
  return { ok: true };
}

// ── anomaly detection (rule-based, AI-assisted brief) ──────────────────────
interface Flag { code: string; severity: 'info' | 'warn' | 'high'; detail: string; item_id?: string; }

function detectAnomalies(items: any[], policy: Policy, claimedKm: number, gpsKm: number | null): { flags: Flag[]; flaggedItemIds: Record<string, string> } {
  const flags: Flag[] = [];
  const flaggedItemIds: Record<string, string> = {};
  const limits = policy.category_limits || {};

  // Missing receipt above the policy threshold.
  for (const it of items) {
    if (it.category !== 'mileage' && Number(it.amount) > policy.require_receipt_over && !it.receipt_url) {
      const detail = `Missing receipt for ${it.category} of ${policy.currency} ${Number(it.amount).toFixed(0)} (policy requires one over ${policy.require_receipt_over}).`;
      flags.push({ code: 'receipt_missing', severity: 'warn', detail, item_id: it.id });
      flaggedItemIds[it.id] = detail;
    }
  }

  // Per-category, per-day cap breaches.
  const byCatDay = new Map<string, { sum: number; ids: string[] }>();
  for (const it of items) {
    const cap = limits[it.category];
    if (cap == null) continue;
    const key = `${it.category}|${String(it.item_date || '').slice(0, 10)}`;
    const agg = byCatDay.get(key) || { sum: 0, ids: [] };
    agg.sum += Number(it.amount || 0); agg.ids.push(it.id);
    byCatDay.set(key, agg);
  }
  for (const [key, agg] of byCatDay) {
    const [category] = key.split('|');
    const cap = limits[category];
    if (cap != null && agg.sum > cap) {
      const detail = `${category} spend ${policy.currency} ${agg.sum.toFixed(0)} exceeds the per-day cap of ${cap}.`;
      flags.push({ code: 'over_category_limit', severity: 'warn', detail });
      for (const id of agg.ids) if (!flaggedItemIds[id]) flaggedItemIds[id] = detail;
    }
  }

  // Claimed mileage materially above the GPS-derived distance.
  if (gpsKm != null && claimedKm > 0 && claimedKm - gpsKm > Math.max(5, gpsKm * 0.25)) {
    flags.push({ code: 'mileage_mismatch', severity: 'high', detail: `Claimed ${claimedKm.toFixed(1)} km but the GPS trail shows ${gpsKm.toFixed(1)} km.` });
  }

  // Duplicate lines (same category + amount + date).
  const seen = new Map<string, string>();
  for (const it of items) {
    const key = `${it.category}|${Number(it.amount || 0)}|${String(it.item_date || '').slice(0, 10)}`;
    if (Number(it.amount || 0) > 0 && seen.has(key)) {
      const detail = `Possible duplicate: two ${it.category} lines of ${policy.currency} ${Number(it.amount).toFixed(0)} on the same day.`;
      flags.push({ code: 'duplicate', severity: 'warn', detail, item_id: it.id });
      flaggedItemIds[it.id] = detail;
    } else if (Number(it.amount || 0) > 0) {
      seen.set(key, it.id);
    }
  }

  return { flags, flaggedItemIds };
}

/** One-line approver brief. AI when available, deterministic fallback otherwise. */
async function buildSummary(claim: any, items: any[], flags: Flag[]): Promise<string> {
  const byCat = new Map<string, number>();
  for (const it of items) byCat.set(it.category, (byCat.get(it.category) || 0) + Number(it.amount || 0));
  const breakdown = Array.from(byCat.entries()).map(([c, a]) => `${c} ${a.toFixed(0)}`).join(', ');
  const deterministic = `${claim.currency} ${Number(claim.total_amount).toFixed(0)} across ${items.length} line(s)${breakdown ? ` (${breakdown})` : ''}${flags.length ? ` — ${flags.length} flag(s): ${flags.map((f) => f.code).join(', ')}` : ' — no anomalies detected'}.`;
  try {
    const facts = {
      total: `${claim.currency} ${Number(claim.total_amount).toFixed(2)}`,
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

/**
 * Submit a draft claim: recompute totals, optionally auto-price mileage lines,
 * run the anomaly pass + AI brief, then route to the first approver up the
 * reporting hierarchy.
 */
export async function submitClaim(actor: Actor, id: string) {
  const { data: claim } = await supabaseAdmin.from('expense_claims').select('*')
    .eq('org_id', actor.org_id).eq('id', id).maybeSingle();
  if (!claim) throw new AppError(404, 'Claim not found', 'NOT_FOUND');
  const c = claim as any;
  if (c.user_id !== actor.id) throw new AppError(403, 'Not your claim', 'FORBIDDEN');
  if (c.status !== 'draft') throw new AppError(400, 'Only a draft claim can be submitted', 'BAD_STATE');

  const { data: itemsRaw } = await supabaseAdmin.from('expense_claim_items').select('*').eq('claim_id', id);
  const items = (itemsRaw as any[]) || [];
  if (!items.length) throw new AppError(400, 'Add at least one line before submitting', 'EMPTY');

  const policy = await getPolicy(actor.org_id, actor.client_id ?? null);
  const total = round2(items.reduce((s, i) => s + Number(i.amount || 0), 0));
  const claimedKm = round2(items.filter((i) => i.category === 'mileage').reduce((s, i) => s + Number(i.distance_km || 0), 0));

  // GPS cross-check: derive the day's driven distance from the trail across the
  // span of the claim's item dates, so mileage can be validated against reality.
  let gpsKm: number | null = c.gps_derived_km == null ? null : Number(c.gps_derived_km);
  if (claimedKm > 0 && gpsKm == null) {
    const dates = items.map((i) => String(i.item_date || '').slice(0, 10)).filter(Boolean).sort();
    if (dates.length) {
      const fromISO = `${dates[0]}T00:00:00.000Z`;
      const toISO = `${dates[dates.length - 1]}T23:59:59.999Z`;
      try {
        const m = await mileageFromTrail(actor.org_id, actor.id, fromISO, toISO);
        gpsKm = m.distance_km;
      } catch (e: any) { logger.warn(`[expenses] mileage cross-check failed: ${e?.message || e}`); }
    }
  }

  const { flags, flaggedItemIds } = detectAnomalies(items, policy, claimedKm, gpsKm);
  // Persist per-item flags.
  for (const it of items) {
    const reason = flaggedItemIds[it.id];
    if (reason) await supabaseAdmin.from('expense_claim_items').update({ flagged: true, flag_reason: reason }).eq('id', it.id);
  }

  const summary = await buildSummary({ ...c, total_amount: total, distance_km: claimedKm || null, gps_derived_km: gpsKm }, items, flags);

  // Route to the first approver up the chain.
  const approver_id = await supervisorOf(actor.id);
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from('expense_claims').update({
    status: 'submitted', total_amount: total, distance_km: claimedKm || null, gps_derived_km: gpsKm,
    ai_flags: flags, ai_summary: summary, approver_id, current_level: 1, submitted_at: now, updated_at: now,
  }).eq('id', id);
  if (error) throw new AppError(500, error.message, 'DB');

  // Open the level-1 approval row.
  await supabaseAdmin.from('expense_approvals').insert({
    claim_id: id, org_id: actor.org_id, level: 1, approver_id, status: 'pending',
  });

  const { data: me } = await supabaseAdmin.from('users').select('name').eq('id', actor.id).maybeSingle();
  const claimantName = (me as any)?.name || 'A team member';

  // 1) The direct supervisor in the reporting line, when one is set.
  if (approver_id) {
    await notify(actor.org_id, approver_id, 'Expense claim to review',
      `${claimantName} submitted ${policy.currency} ${total.toFixed(0)} — ${summary}`,
      { type: 'expense_submitted', claim_id: id });
  } else {
    logger.warn(`[expenses] claim ${id} submitted but claimant ${actor.id} has no supervisor — admins/managers notified instead.`);
  }

  // 2) The org's admins/managers (HR/Admin). This guarantees a claim is never
  //    missed when the claimant has no supervisor set (e.g. ByteBack's flat
  //    field-force teams), and keeps admins in the loop generally. Excludes the
  //    supervisor already notified above and the claimant.
  try {
    const approvers = await resolveExpenseApprovers(actor.org_id, actor.client_id ?? null, actor.id);
    await notifyUsers(
      approvers.filter((aId) => aId !== approver_id),
      {
        orgId: actor.org_id,
        kind: 'expense_submitted',
        title: 'Expense claim to review',
        body: `${claimantName} submitted ${policy.currency} ${total.toFixed(0)} for approval.`,
        data: { claim_id: id },
      },
    );
  } catch (e: any) { logger.warn(`[expenses] approver fan-out failed: ${e?.message || e}`); }

  return getClaim(actor, id);
}

// ── mileage helper for the rep (suggest an amount from the trail) ──────────
export async function mileageSuggestion(actor: Actor, fromISO: string, toISO: string, forUserId?: string) {
  const userId = forUserId && isApprover(actor) ? forUserId : actor.id;
  const m = await mileageFromTrail(actor.org_id, userId, fromISO, toISO);
  const policy = await getPolicy(actor.org_id, actor.client_id ?? null);
  return {
    ...m,
    mileage_rate: policy.mileage_rate,
    currency: policy.currency,
    suggested_amount: round2(m.distance_km * policy.mileage_rate),
  };
}

// ── approver ────────────────────────────────────────────────────────────────
export async function pendingForApprover(actor: Actor, city?: string, limit = 200) {
  let q = supabaseAdmin.from('expense_claims').select('*')
    .eq('org_id', actor.org_id).eq('status', 'submitted')
    .order('submitted_at', { ascending: false }).limit(limit);
  if (!isApprover(actor)) q = q.eq('approver_id', actor.id);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB');
  let rows = (data as any[]) || [];
  // Optional city scope: filter by the claimant's city (users.city).
  if (city) {
    const ids = Array.from(new Set(rows.map((r) => r.user_id).filter(Boolean)));
    if (ids.length) {
      const { data: us } = await supabaseAdmin.from('users').select('id, city').in('id', ids);
      const cityOf = new Map((us ?? []).map((u: any) => [u.id, (u.city || '').toLowerCase()]));
      const want = city.toLowerCase();
      rows = rows.filter((r) => cityOf.get(r.user_id) === want);
    }
  }
  return stampNames(rows);
}

/** Approved claims across the org still awaiting reimbursement (admin/finance). */
export async function awaitingReimbursement(actor: Actor, city?: string, limit = 200) {
  if (!isApprover(actor)) throw new AppError(403, 'Only an admin can view reimbursements', 'FORBIDDEN');
  const { data, error } = await supabaseAdmin.from('expense_claims').select('*')
    .eq('org_id', actor.org_id).eq('status', 'approved')
    .order('reviewed_at', { ascending: true }).limit(limit);
  if (error) throw new AppError(500, error.message, 'DB');
  let rows = (data as any[]) || [];
  // Optional city scope: filter by the claimant's city (users.city).
  if (city) {
    const ids = Array.from(new Set(rows.map((r) => r.user_id).filter(Boolean)));
    if (ids.length) {
      const { data: us } = await supabaseAdmin.from('users').select('id, city').in('id', ids);
      const cityOf = new Map((us ?? []).map((u: any) => [u.id, (u.city || '').toLowerCase()]));
      const want = city.toLowerCase();
      rows = rows.filter((r) => cityOf.get(r.user_id) === want);
    }
  }
  return stampNames(rows);
}

/**
 * Approve/reject at the current level. On approval, a claim whose total is over
 * the policy `escalate_over` climbs to the approver's own manager (next level
 * up) instead of finalising — up to MAX_APPROVAL_LEVELS. When there is no
 * higher manager, or the amount is within threshold, the claim is approved.
 */
export async function decide(actor: Actor, id: string, decision: 'approved' | 'rejected', note?: string) {
  const { data: claim } = await supabaseAdmin.from('expense_claims').select('*')
    .eq('org_id', actor.org_id).eq('id', id).maybeSingle();
  if (!claim) throw new AppError(404, 'Claim not found', 'NOT_FOUND');
  const c = claim as any;
  if (c.status !== 'submitted') throw new AppError(400, 'This claim is not awaiting approval', 'BAD_STATE');
  if (!isApprover(actor) && c.approver_id !== actor.id) throw new AppError(403, 'You are not the current approver for this claim', 'FORBIDDEN');

  const now = new Date().toISOString();
  // Close the caller's pending approval row at the current level.
  await supabaseAdmin.from('expense_approvals').update({ status: decision, note: note ?? null, decided_at: now })
    .eq('claim_id', id).eq('level', c.current_level).eq('status', 'pending');

  if (decision === 'rejected') {
    await supabaseAdmin.from('expense_claims').update({
      status: 'rejected', reviewed_by: actor.id, reviewed_at: now, review_note: note ?? null, approver_id: null, updated_at: now,
    }).eq('id', id);
    await notify(actor.org_id, c.user_id, 'Expense claim rejected', `${c.claim_no || 'Your claim'} was rejected${note ? ': ' + note : '.'}`, { type: 'expense_decision', claim_id: id, decision });
    return { ok: true, status: 'rejected' };
  }

  // Approved at this level — decide whether to escalate up the hierarchy.
  const policy = await getPolicy(actor.org_id, c.client_id ?? null);
  const needsEscalation = policy.escalate_over != null && Number(c.total_amount) > Number(policy.escalate_over);
  if (needsEscalation && c.current_level < MAX_APPROVAL_LEVELS) {
    const nextApprover = await supervisorOf(actor.id);
    // Avoid re-visiting anyone already in the trail (prevents cycles).
    const { data: trail } = await supabaseAdmin.from('expense_approvals').select('approver_id').eq('claim_id', id);
    const visited = new Set((trail ?? []).map((t: any) => t.approver_id).filter(Boolean));
    if (nextApprover && !visited.has(nextApprover)) {
      const nextLevel = c.current_level + 1;
      await supabaseAdmin.from('expense_claims').update({ approver_id: nextApprover, current_level: nextLevel, updated_at: now }).eq('id', id);
      await supabaseAdmin.from('expense_approvals').insert({ claim_id: id, org_id: actor.org_id, level: nextLevel, approver_id: nextApprover, status: 'pending' });
      await notify(actor.org_id, nextApprover, 'Expense claim to review (escalated)',
        `${c.claim_no || 'A claim'} for ${c.currency} ${Number(c.total_amount).toFixed(0)} needs your sign-off — ${c.ai_summary || ''}`.trim(),
        { type: 'expense_submitted', claim_id: id });
      await notify(actor.org_id, c.user_id, 'Expense claim escalated', `${c.claim_no || 'Your claim'} was approved and escalated to the next manager for final sign-off.`, { type: 'expense_escalated', claim_id: id });
      return { ok: true, status: 'submitted', escalated: true, level: nextLevel };
    }
  }

  // Final approval.
  await supabaseAdmin.from('expense_claims').update({
    status: 'approved', reviewed_by: actor.id, reviewed_at: now, review_note: note ?? null, approver_id: null, updated_at: now,
  }).eq('id', id);
  await notify(actor.org_id, c.user_id, 'Expense claim approved', `${c.claim_no || 'Your claim'} for ${c.currency} ${Number(c.total_amount).toFixed(0)} was approved.`, { type: 'expense_decision', claim_id: id, decision });
  return { ok: true, status: 'approved' };
}

/** Mark an approved claim reimbursed (admin/finance). */
export async function reimburse(actor: Actor, id: string, ref?: string) {
  if (!isApprover(actor)) throw new AppError(403, 'Only an admin can mark a claim reimbursed', 'FORBIDDEN');
  const { data: claim } = await supabaseAdmin.from('expense_claims').select('*')
    .eq('org_id', actor.org_id).eq('id', id).maybeSingle();
  if (!claim) throw new AppError(404, 'Claim not found', 'NOT_FOUND');
  const c = claim as any;
  if (c.status !== 'approved') throw new AppError(400, 'Only an approved claim can be reimbursed', 'BAD_STATE');
  const now = new Date().toISOString();
  await supabaseAdmin.from('expense_claims').update({ status: 'reimbursed', reimbursed_at: now, reimbursed_ref: ref ?? null, updated_at: now }).eq('id', id);
  await notify(actor.org_id, c.user_id, 'Expense reimbursed', `${c.claim_no || 'Your claim'} for ${c.currency} ${Number(c.total_amount).toFixed(0)} was reimbursed${ref ? ` (ref ${ref})` : ''}.`, { type: 'expense_reimbursed', claim_id: id });
  return { ok: true, status: 'reimbursed' };
}
