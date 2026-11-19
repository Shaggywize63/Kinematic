/**
 * One-tap approvals on WhatsApp (Client Management → WhatsApp alerts → "One-tap approvals").
 *
 * When a leave request, an expense claim or an attendance correction lands with its approver, the approver also gets
 * it on their own WhatsApp (users.mobile) with Approve and Reject buttons. Tapping one records the decision exactly as
 * the app would: the same decide() call, as that approver, with the same checks (still pending, still their request
 * or they are an admin) and the same notifications to the requester.
 *
 * Sending piggybacks on the push dispatcher (services/notifications.service.ts), like the WhatsApp alerts: the
 * approver's own notification row is offered here. Only the request's current approver gets buttons; the other
 * managers who are told about an expense claim keep getting the normal in-app notice. When an expense escalates to
 * the next level, that approver's new notification brings a fresh WhatsApp message.
 *
 * Each button carries `apv:<l|e|r>:<request id>:<a|r>:<signature>`. The signature binds the button to the approver it
 * was sent to, so a tap only counts from that approver's number, and a forged payload is ignored.
 *
 * Off by default (`approvals` in org_settings `notifications.whatsapp`). Needs the client's WhatsApp connection and an
 * approved template with "Approve" and "Reject" quick-reply buttons (SUGGESTED_APPROVAL_TEMPLATE).
 */
import crypto from 'crypto';
import { supabaseAdmin } from '../lib/supabase';
import { currentProjectKey } from '../lib/projects';
import { logger } from '../lib/logger';
import { canonicalKind } from '../lib/notificationCatalog';
import { isProjectDisabled } from './notificationPolicy';
import { sendWhatsapp } from './crm/whatsapp.service';
import { findRepByPhone } from './crm/whatsappVoiceLead.service';
import {
  WA_SETTING_KEY, toSettings, alertsActive, normalizePhone, listTemplates, pickApprovalTemplate, placeholderCount,
  templateVariables, type ApprovalTemplate,
} from './clientWhatsappAlerts.service';
import { buildUserContext } from '../middleware/auth';
import * as leaveSvc from './leave.service';
import * as attRegSvc from './attendanceRegularization.service';
import * as expensesSvc from './expenses/expenses.service';

export type ApprovalEntity = 'leave' | 'expense' | 'regularization';
type Decision = 'approved' | 'rejected';

const ENTITY: Record<ApprovalEntity, { code: string; table: string; pending: string; label: string }> = {
  leave: { code: 'l', table: 'leave_requests', pending: 'pending', label: 'Leave request' },
  expense: { code: 'e', table: 'expense_claims', pending: 'submitted', label: 'Expense claim' },
  regularization: { code: 'r', table: 'attendance_regularizations', pending: 'pending', label: 'Attendance correction' },
};
const BY_CODE = new Map(Object.entries(ENTITY).map(([k, v]) => [v.code, k as ApprovalEntity]));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PER_ORG_PER_RUN = 20;
const SENT_TTL_MS = 6 * 60 * 60_000;
const TAP_TTL_MS = 60 * 60_000;
export const APPROVE_NOTE = 'Approved on WhatsApp';
export const REJECT_NOTE = 'Rejected on WhatsApp';

/** Which request a notification is about, when it is one we can approve. */
export function approvalTarget(kind: string, data: unknown): { entity: ApprovalEntity; id: string } | null {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const k = canonicalKind(kind);
  const pick = (key: string) => (typeof d[key] === 'string' && UUID.test(d[key] as string) ? (d[key] as string) : null);
  if (k === 'leave_request') { const id = pick('request_id'); return id ? { entity: 'leave', id } : null; }
  if (k === 'att_reg_request') { const id = pick('request_id'); return id ? { entity: 'regularization', id } : null; }
  if (k === 'expense_submitted') { const id = pick('claim_id'); return id ? { entity: 'expense', id } : null; }
  return null;
}

// ── Button payloads ─────────────────────────────────────────────────────────────────────────────────────────────

const secret = (): string =>
  process.env.WHATSAPP_APPROVAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_JWT_SECRET || 'kinematic-wa-approvals';

function sign(entity: ApprovalEntity, id: string, action: 'a' | 'r', userId: string): string {
  return crypto.createHmac('sha256', secret()).update(`${ENTITY[entity].code}:${id}:${action}:${userId}`).digest('base64url').slice(0, 16);
}

/** The payload for one button, signed for the approver it is sent to. */
export function buttonPayload(entity: ApprovalEntity, id: string, decision: Decision, userId: string): string {
  const action = decision === 'approved' ? 'a' : 'r';
  return `apv:${ENTITY[entity].code}:${id}:${action}:${sign(entity, id, action, userId)}`;
}

export const isApprovalPayload = (p: unknown): p is string => typeof p === 'string' && p.startsWith('apv:');

export interface ParsedPayload { entity: ApprovalEntity; id: string; decision: Decision; sig: string }

export function parsePayload(p: string): ParsedPayload | null {
  const m = /^apv:([ler]):([0-9a-f-]{36}):([ar]):([A-Za-z0-9_-]{16})$/i.exec(p.trim());
  if (!m || !UUID.test(m[2])) return null;
  return { entity: BY_CODE.get(m[1].toLowerCase())!, id: m[2].toLowerCase(), decision: m[3] === 'a' ? 'approved' : 'rejected', sig: m[4] };
}

/** Was this payload signed for this user? Constant-time compare. */
export function payloadIsFor(p: ParsedPayload, userId: string): boolean {
  const want = Buffer.from(sign(p.entity, p.id, p.decision === 'approved' ? 'a' : 'r', userId));
  const got = Buffer.from(p.sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────────────────────

async function approvalsOn(orgId: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from('org_settings').select('value').eq('org_id', orgId).eq('key', WA_SETTING_KEY).maybeSingle();
  return toSettings((data as { value?: unknown } | null)?.value).approvals;
}

const sent = new Map<string, number>();
const taps = new Map<string, number>();
/** Test seam. */
export const _resetApprovalState = (): void => { sent.clear(); taps.clear(); };
const prune = (m: Map<string, number>, ttl: number, now: number) => { for (const [k, at] of m) if (now - at > ttl) m.delete(k); };

// ── Sending (called by the push dispatcher) ─────────────────────────────────────────────────────────────────────

export interface ApprovalCandidate { orgId: string | null; userId: string; kind: string; title: string; body: string; data?: unknown }

/**
 * Send approval requests with Approve / Reject buttons to their approvers. Best-effort: never throws, so the push
 * dispatcher is never held up by it. Returns how many messages went out.
 */
export async function forwardApprovalRequests(items: ApprovalCandidate[]): Promise<number> {
  if (!alertsActive() || isProjectDisabled() || !items.length) return 0;
  try {
    const now = Date.now();
    prune(sent, SENT_TTL_MS, now);
    const wanted = items
      .map((it) => ({ it, target: approvalTarget(it.kind, it.data) }))
      .filter((x): x is { it: ApprovalCandidate & { orgId: string }; target: { entity: ApprovalEntity; id: string } } => !!x.target && !!x.it.orgId && !!x.it.userId);
    if (!wanted.length) return 0;

    const orgIds = [...new Set(wanted.map((x) => x.it.orgId))];
    const { data: settingsRows } = await supabaseAdmin.from('org_settings').select('org_id, value').eq('key', WA_SETTING_KEY).in('org_id', orgIds);
    const onOrgs = new Set(((settingsRows ?? []) as Array<{ org_id: string; value: unknown }>).filter((r) => toSettings(r.value).approvals).map((r) => r.org_id));
    if (!onOrgs.size) return 0;

    const templateByOrg = new Map<string, ApprovalTemplate | null>();
    const perOrg = new Map<string, number>();
    let count = 0;
    for (const { it, target } of wanted) {
      if (!onOrgs.has(it.orgId)) continue;
      const key = `${currentProjectKey()}|${it.userId}|${target.entity}|${target.id}`;
      if (sent.has(key)) continue;
      if ((perOrg.get(it.orgId) ?? 0) >= MAX_PER_ORG_PER_RUN) continue;

      if (!templateByOrg.has(it.orgId)) templateByOrg.set(it.orgId, pickApprovalTemplate(await listTemplates(it.orgId, supabaseAdmin)));
      const tpl = templateByOrg.get(it.orgId);
      if (!tpl) { logger.warn(`[wa-approvals] org=${it.orgId} has no approved template with Approve / Reject buttons`); continue; }

      // Only the request's CURRENT approver, and only while it still waits for them.
      const e = ENTITY[target.entity];
      const { data: row } = await supabaseAdmin.from(e.table).select('id, approver_id, status').eq('id', target.id).maybeSingle();
      const r = row as { approver_id?: string | null; status?: string } | null;
      if (!r || r.approver_id !== it.userId || r.status !== e.pending) continue;

      const { data: user } = await supabaseAdmin.from('users').select('id, mobile, is_active').eq('id', it.userId).maybeSingle();
      const u = user as { mobile?: string | null; is_active?: boolean } | null;
      const to = normalizePhone(u?.mobile);
      if (!u?.is_active || !to) continue;

      sent.set(key, now);
      perOrg.set(it.orgId, (perOrg.get(it.orgId) ?? 0) + 1);
      const buttons: string[] = [];
      buttons[tpl.approveIndex] = buttonPayload(target.entity, target.id, 'approved', it.userId);
      buttons[tpl.rejectIndex] = buttonPayload(target.entity, target.id, 'rejected', it.userId);
      // Sparse on purpose: any other button on the template keeps its default payload (its own text).
      try {
        const res = await sendWhatsapp({
          org_id: it.orgId, to, user_id: it.userId, template_id: tpl.id,
          template_variables: templateVariables(placeholderCount(tpl.body), it.title, it.body),
          template_buttons: buttons,
        });
        if (res.status === 'failed') logger.warn(`[wa-approvals] send failed org=${it.orgId} ${target.entity}=${target.id}: ${res.error}`);
        else count++;
      } catch (err: any) {
        logger.warn(`[wa-approvals] send failed org=${it.orgId} ${target.entity}=${target.id}: ${err?.message || err}`);
      }
    }
    return count;
  } catch (e: any) {
    logger.error(`[wa-approvals] forwarding failed: ${e?.message || e}`);
    return 0;
  }
}

// ── Taps (called from the WhatsApp webhook) ─────────────────────────────────────────────────────────────────────

export interface ApprovalTap { id?: string; from: string; payload: string }

export type ApprovalTapOutcome =
  | 'ignored' | 'duplicate' | 'not_user' | 'bad_signature' | 'disabled' | 'approved' | 'rejected' | 'escalated'
  | 'already_decided' | 'forbidden' | 'not_found' | 'failed';

async function requesterName(entity: ApprovalEntity, id: string): Promise<string | null> {
  try {
    const { data: row } = await supabaseAdmin.from(ENTITY[entity].table).select('user_id').eq('id', id).maybeSingle();
    const uid = (row as { user_id?: string } | null)?.user_id;
    if (!uid) return null;
    const { data: u } = await supabaseAdmin.from('users').select('name').eq('id', uid).maybeSingle();
    return (u as { name?: string | null } | null)?.name ?? null;
  } catch { return null; }
}

/**
 * Record an Approve / Reject tap. Never throws; every tap from a known user gets a short reply saying what happened.
 * Runs in the CURRENT project (the webhook sets it from the WhatsApp connection).
 */
export async function handleApprovalTap(orgId: string, tap: ApprovalTap): Promise<ApprovalTapOutcome> {
  const p = isApprovalPayload(tap.payload) ? parsePayload(tap.payload) : null;
  if (!p) return 'ignored';
  const reply = (body_text: string, user_id?: string) =>
    sendWhatsapp({ org_id: orgId, to: tap.from, body_text, user_id }).catch(() => undefined);
  try {
    const now = Date.now();
    prune(taps, TAP_TTL_MS, now);
    const key = `${orgId}|${tap.id ?? `${tap.from}|${tap.payload}`}`;
    if (taps.has(key)) return 'duplicate';
    taps.set(key, now);

    const who = await findRepByPhone(orgId, tap.from);
    if (!who) return 'not_user';
    if (!payloadIsFor(p, who.id)) {
      logger.warn(`[wa-approvals] tap with a button not sent to this number org=${orgId} user=${who.id}`);
      await reply("That button wasn't sent to this number, so nothing changed. Please decide in the Kinematic app.", who.id);
      return 'bad_signature';
    }
    if (!(await approvalsOn(orgId))) {
      await reply('One-tap approvals are switched off for your team, so nothing changed. Please decide in the Kinematic app.', who.id);
      return 'disabled';
    }
    const ctx = await buildUserContext(who.id);
    if (!ctx) return 'not_user';
    const actor = { id: ctx.id, org_id: ctx.org_id, role: ctx.role ?? null, client_id: ctx.client_id ?? null, data_scope: ctx.org_role_data_scope ?? null };

    const label = ENTITY[p.entity].label;
    const name = await requesterName(p.entity, p.id);
    const what = `${label}${name ? ` from ${name}` : ''}`;
    let escalated = false;
    if (p.entity === 'leave') {
      await leaveSvc.decide(actor, p.id, p.decision, p.decision === 'approved' ? APPROVE_NOTE : REJECT_NOTE);
    } else if (p.entity === 'regularization') {
      await attRegSvc.decide(actor, p.id, p.decision, p.decision === 'approved' ? APPROVE_NOTE : REJECT_NOTE);
    } else {
      // A rejected claim needs a remark; the claimant sees this one.
      const res = await expensesSvc.decide(actor, p.id, { decision: p.decision, note: p.decision === 'approved' ? null : REJECT_NOTE }) as { escalated?: boolean };
      escalated = !!res?.escalated;
    }

    if (escalated) {
      await reply(`✅ ${what} approved at your level. It's above your limit, so it has gone to the next approver.`, who.id);
      return 'escalated';
    }
    await reply(p.decision === 'approved'
      ? `✅ ${what} approved.${name ? ` ${name} has been told in the app.` : ''}`
      : `❌ ${what} rejected${p.entity === 'expense' ? ` with the note "${REJECT_NOTE}"` : ''}.${name ? ` ${name} has been told in the app.` : ''}`, who.id);
    return p.decision;
  } catch (e: any) {
    const code = e?.code as string | undefined;
    if (code === 'BAD_STATE') { await reply('This request was already decided, so nothing changed.'); return 'already_decided'; }
    if (code === 'FORBIDDEN') { await reply("You're not the approver for this request any more, so nothing changed."); return 'forbidden'; }
    if (code === 'NOT_FOUND') { await reply("I couldn't find this request. It may have been withdrawn."); return 'not_found'; }
    logger.error(`[wa-approvals] tap failed org=${orgId}: ${e?.message || e}`);
    await reply("Sorry, I couldn't record that. Please decide in the Kinematic app.");
    return 'failed';
  }
}
