/**
 * Support tickets: customers raise them, the Kinematic team works them, the customer hears back.
 *
 * Ways in:
 *   - Dashboard → Help & Support (any logged-in user; the ticket belongs to their organisation).
 *   - KINI on WhatsApp → "Raise an issue" (the bot posts here with the shared KINI key; the sender is matched to a
 *     user by mobile number when possible).
 *
 * One queue for every customer, whatever project their data lives in: tickets are always stored in the Kinematic
 * project (SUPPORT_PROJECT). Platform operators (tenantScope.isPlatformOperator) see and update all of them in the
 * dashboard's support inbox; the owner can also update them from WhatsApp through the bot.
 *
 * When the team changes a ticket's status or replies, the customer is told:
 *   - on WhatsApp, from Kinematic's own number (the org whose WhatsApp connection is SUPPORT_WHATSAPP_NUMBER):
 *     free-form inside the 24-hour window the customer's last message opened, else the approved `handoff_reply`
 *     template when it has been synced, else not at all (the response says why);
 *   - in the app, as a notification to the user who raised it (in their own project).
 * When a customer raises a ticket or replies from the dashboard, the team is told on WhatsApp through the support
 * org's own WhatsApp alerts (Client Management → WhatsApp alerts: its template and people). WhatsApp-raised tickets
 * are announced by the bot itself.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClientFor, isKnownProject, listProjectKeys, runWithProject } from '../../lib/projects';
import { logger } from '../../lib/logger';
import { sendWhatsapp } from '../crm/whatsapp.service';
import { WA_SETTING_KEY, toSettings, sendToRecipients, listTemplates, isApproved, normalizePhone } from '../clientWhatsappAlerts.service';
import { emailCustomer, type SupportEmailKind } from './supportEmail';

/**
 * The notification kind for a ticket update, as registered in lib/notificationCatalog. One string identifies it
 * on the row, in the push payload and in Client Management → Notifications. `support_ticket` is kept as an alias
 * there so rows written before this existed still resolve.
 */
export const SUPPORT_NOTIFICATION_KIND = 'support_ticket_update';

export const SUPPORT_PROJECT = (process.env.SUPPORT_PROJECT || 'kinematic').trim();
const SUPPORT_NUMBER = () => (process.env.SUPPORT_WHATSAPP_NUMBER || '919220299228').replace(/\D/g, '');
const WINDOW_MS = 23 * 3600_000;

export const STATUSES = [
  'open', 'triaged', 'in_progress', 'waiting_on_customer', 'release_pending', 'resolved', 'closed', 'rejected',
] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
/** The ticket's type: what the customer is asking for. */
export const CATEGORIES = [
  'how_to', 'issue', 'bug', 'change_request', 'new_module',
  'data_correction', 'billing', 'access_request', 'training', 'other',
] as const;
/** Where the customer hit it. A ticket may name more than one. */
export const PLATFORMS = ['web', 'android', 'ios', 'whatsapp', 'other'] as const;
/**
 * Which part of the product the ticket is about. Deliberately the GENERIC Kinematic modules — a client's own
 * taxonomy belongs in custom fields, never in a hard-coded list here.
 */
export const AREAS = [
  'crm', 'attendance', 'distribution', 'orders', 'hrms', 'payroll', 'reports',
  'dashboard', 'mobile_app', 'whatsapp_kini', 'admin_settings', 'integrations', 'billing', 'other',
] as const;
export const ACTIVE: readonly TicketStatus[] = ['open', 'triaged', 'in_progress', 'waiting_on_customer', 'release_pending'];
/** Nothing more is expected to happen on these. */
export const TERMINAL: readonly TicketStatus[] = ['resolved', 'closed', 'rejected'];
export type TicketStatus = (typeof STATUSES)[number];
export type TicketPriority = (typeof PRIORITIES)[number];
export type TicketCategory = (typeof CATEGORIES)[number];
export type TicketPlatform = (typeof PLATFORMS)[number];
export type TicketArea = (typeof AREAS)[number];

/** Category names from before the v2 taxonomy. Still accepted on input (older app builds, the WhatsApp bot). */
const CATEGORY_ALIASES: Record<string, TicketCategory> = { data: 'data_correction', feature_request: 'new_module' };

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open', triaged: 'Triaged', in_progress: 'In progress', waiting_on_customer: 'Waiting on you',
  release_pending: 'Fix ready, ships in the next release', resolved: 'Resolved', closed: 'Closed', rejected: 'Not planned',
};

export interface Ticket {
  id: string; ref: string; status: TicketStatus; priority: TicketPriority; category: TicketCategory;
  platforms: TicketPlatform[]; area: TicketArea | null;
  subject: string; description: string; channel: 'whatsapp' | 'dashboard' | 'app';
  project_key: string | null; org_id: string | null; org_name: string | null; raised_by_user_id: string | null;
  contact_name: string | null; contact_phone: string | null; contact_email: string | null;
  resolution_note: string | null; created_at: string; updated_at: string; resolved_at: string | null;
  first_response_at: string | null;
  csat_rating: number | null; csat_comment: string | null; csat_at: string | null;
}
export interface TicketEvent {
  id: string; ticket_id: string; kind: 'created' | 'status' | 'comment' | 'feedback'; author_type: 'customer' | 'team' | 'system';
  author_name: string | null; from_status: string | null; to_status: string | null; body: string | null; created_at: string;
}
export interface CustomerNotified {
  whatsapp: 'sent' | 'template' | 'skipped' | 'failed';
  note?: string;
  /** What happened to the email. Absent only if the email path was never reached. */
  email?: 'sent' | 'skipped' | 'failed';
  email_note?: string;
}

export class SupportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The Kinematic project's admin client, where every ticket lives. */
export const supportDb = (): SupabaseClient => adminClientFor(isKnownProject(SUPPORT_PROJECT) ? SUPPORT_PROJECT : undefined);

const clean = (v: unknown, max: number): string => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const key = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** A category, accepting the pre-v2 names; anything unknown becomes `other`. */
export const toCategory = (v: unknown): TicketCategory => {
  const k = key(v);
  if ((CATEGORIES as readonly string[]).includes(k)) return k as TicketCategory;
  return CATEGORY_ALIASES[k] ?? 'other';
};

/** Platforms from an array or a comma-separated string, de-duplicated; unknown values dropped. */
export const toPlatforms = (v: unknown): TicketPlatform[] => {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out: TicketPlatform[] = [];
  for (const x of raw) {
    const k = key(x);
    if ((PLATFORMS as readonly string[]).includes(k) && !out.includes(k as TicketPlatform)) out.push(k as TicketPlatform);
  }
  return out;
};

export const toArea = (v: unknown): TicketArea | null => {
  const k = key(v);
  return (AREAS as readonly string[]).includes(k) ? (k as TicketArea) : null;
};

/** With nothing picked, the channel itself says where they were. */
const platformsFor = (channel: Ticket['channel'], picked: TicketPlatform[]): TicketPlatform[] => {
  if (picked.length) return picked;
  if (channel === 'dashboard') return ['web'];
  if (channel === 'whatsapp') return ['whatsapp'];
  return [];
};

// ── Customer identity ─────────────────────────────────────────────────────────────────────────────────────────

export interface Requester {
  project_key: string | null; org_id: string | null; org_name: string | null; user_id: string | null;
  name: string | null; phone: string | null; email: string | null;
}

async function orgName(db: SupabaseClient, orgId: string | null | undefined): Promise<string | null> {
  if (!orgId) return null;
  const { data } = await db.from('organisations').select('name').eq('id', orgId).maybeSingle();
  return (data as { name?: string | null } | null)?.name ?? null;
}

/** The dashboard user raising a ticket, with their mobile so WhatsApp updates can reach them. */
export async function requesterFromUser(project: string, user: { id: string; org_id: string; name?: string | null; email?: string | null; mobile?: string | null }): Promise<Requester> {
  const db = adminClientFor(project);
  return {
    project_key: project, org_id: user.org_id, org_name: await orgName(db, user.org_id).catch(() => null), user_id: user.id,
    name: user.name ?? null, phone: normalizePhone(user.mobile) ?? null, email: user.email ?? null,
  };
}

/** Who is this WhatsApp number? An active user of any project, matched on the last 10 digits, or just the number. */
export async function requesterFromPhone(phone: string, fallbackName?: string | null): Promise<Requester> {
  const p = digits(phone);
  const last10 = p.slice(-10);
  const base: Requester = { project_key: null, org_id: null, org_name: null, user_id: null, name: fallbackName ?? null, phone: p || null, email: null };
  if (last10.length !== 10) return base;
  for (const key of listProjectKeys()) {
    try {
      const db = adminClientFor(key);
      const { data } = await db.from('users').select('id, org_id, name, email')
        .eq('is_active', true).is('deleted_at', null)
        .or(`mobile.eq.${last10},mobile.eq.+91${last10},mobile.eq.91${last10},mobile.eq.0${last10}`)
        .limit(1).maybeSingle();
      const u = data as { id: string; org_id: string; name: string | null; email: string | null } | null;
      if (u) {
        return { ...base, project_key: key, org_id: u.org_id, org_name: await orgName(db, u.org_id).catch(() => null), user_id: u.id, name: u.name ?? base.name, email: u.email };
      }
    } catch (e: any) {
      logger.warn(`[support] phone lookup failed in project=${key}: ${e?.message || e}`);
    }
  }
  return base;
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ListFilter {
  status?: string; q?: string; scope?: { project_key: string; org_id: string } | null; phone?: string;
  category?: string; platform?: string; area?: string;
}

export async function listTickets(f: ListFilter): Promise<{ tickets: Ticket[]; counts: Record<TicketStatus, number> }> {
  const db = supportDb();
  const scoped = <Q extends { eq: (c: string, v: unknown) => Q; or: (e: string) => Q }>(q: Q): Q => {
    let out = q;
    if (f.scope) out = out.eq('project_key', f.scope.project_key).eq('org_id', f.scope.org_id);
    if (f.phone) {
      const last10 = digits(f.phone).slice(-10);
      out = out.or(`contact_phone.eq.${digits(f.phone)},contact_phone.eq.91${last10},contact_phone.eq.${last10}`);
    }
    return out;
  };
  // Category / platform / area narrow the rows AND the tab counts, so the numbers match what is listed.
  const narrow = <Q extends { eq: (c: string, v: unknown) => Q; contains: (c: string, v: unknown) => Q }>(q: Q): Q => {
    let out = q;
    const cat = key(f.category);
    if (cat && (CATEGORIES as readonly string[]).includes(cat)) out = out.eq('category', cat);
    const plat = key(f.platform);
    if (plat && (PLATFORMS as readonly string[]).includes(plat)) out = out.contains('platforms', [plat]);
    const area = key(f.area);
    if (area && (AREAS as readonly string[]).includes(area)) out = out.eq('area', area);
    return out;
  };

  let q = narrow(scoped(db.from('support_tickets').select('*') as any) as any) as any;
  const status = (f.status || 'active').toLowerCase();
  if (status === 'active') q = q.in('status', ACTIVE as unknown as string[]);
  else if ((STATUSES as readonly string[]).includes(status)) q = q.eq('status', status);
  const term = clean(f.q, 80).replace(/[%,()*\\]/g, ' ').trim();
  if (term) q = q.or(`ref.ilike.%${term}%,subject.ilike.%${term}%,org_name.ilike.%${term}%,contact_name.ilike.%${term}%,contact_phone.ilike.%${term}%`);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(200);
  if (error) throw new Error(error.message);

  const { data: all } = await narrow(scoped(db.from('support_tickets').select('status') as any) as any).limit(5000);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<TicketStatus, number>;
  for (const r of (all ?? []) as Array<{ status: TicketStatus }>) if (r.status in counts) counts[r.status]++;
  return { tickets: (data ?? []) as Ticket[], counts };
}

export async function getTicket(idOrRef: string): Promise<Ticket | null> {
  const col = /^KM-\d+$/i.test(idOrRef) ? 'ref' : 'id';
  if (col === 'id' && !/^[0-9a-f-]{36}$/i.test(idOrRef)) return null;
  const { data } = await supportDb().from('support_tickets').select('*').eq(col, col === 'ref' ? idOrRef.toUpperCase() : idOrRef).maybeSingle();
  return (data as Ticket | null) ?? null;
}

export async function listEvents(ticketId: string): Promise<TicketEvent[]> {
  const { data } = await supportDb().from('support_ticket_events').select('*').eq('ticket_id', ticketId).order('created_at', { ascending: true });
  return (data ?? []) as TicketEvent[];
}

/** May this customer see the ticket? Their organisation's tickets, or (WhatsApp) the ones raised from their number. */
export function belongsTo(t: Ticket, scope: { project_key: string; org_id: string }): boolean {
  return !!t.org_id && t.org_id === scope.org_id && (t.project_key ?? SUPPORT_PROJECT) === scope.project_key;
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────

async function addEvent(e: Omit<TicketEvent, 'id' | 'created_at'>): Promise<void> {
  const { error } = await supportDb().from('support_ticket_events').insert(e);
  if (error) logger.warn(`[support] event insert failed ticket=${e.ticket_id}: ${error.message}`);
}

export interface CreateInput {
  subject?: unknown; description?: unknown; category?: unknown; priority?: unknown;
  platforms?: unknown; area?: unknown; channel: Ticket['channel'];
}

export async function createTicket(input: CreateInput, who: Requester, opts: { notifyTeam: boolean }): Promise<Ticket> {
  const description = clean(input.description, 5000);
  const subject = clean(input.subject, 150) || description.split('\n')[0].slice(0, 80);
  if (subject.length < 3) throw new SupportError(400, 'Add a short subject (at least 3 characters).');
  if (description.length < 10) throw new SupportError(400, 'Describe the issue in a little more detail (at least 10 characters).');
  const row = {
    subject, description,
    category: toCategory(input.category),
    priority: oneOf(PRIORITIES, input.priority, 'normal'),
    platforms: platformsFor(input.channel, toPlatforms(input.platforms)),
    area: toArea(input.area),
    channel: input.channel,
    project_key: who.project_key, org_id: who.org_id, org_name: who.org_name, raised_by_user_id: who.user_id,
    contact_name: who.name, contact_phone: who.phone, contact_email: who.email,
  };
  const { data, error } = await supportDb().from('support_tickets').insert(row).select('*').single();
  if (error || !data) throw new Error(error?.message || 'Could not save the ticket');
  const t = data as Ticket;
  await addEvent({ ticket_id: t.id, kind: 'created', author_type: 'customer', author_name: who.name, from_status: null, to_status: 'open', body: null });
  // Confirm to the customer with the reference they will quote back. Best-effort: a mail problem must never
  // lose a ticket that is already saved.
  await runWithProject(SUPPORT_PROJECT, async () => emailCustomer({
    ticket: t, kind: 'raised', statusLabel: STATUS_LABEL[t.status] ?? t.status, message: null, orgId: await supportOrgId(),
  })).catch(() => undefined);
  if (opts.notifyTeam) await alertTeam(`New support ticket ${t.ref}`, `${who.org_name || who.name || 'A customer'}: ${t.subject}. ${t.description}`);
  return t;
}

export interface Actor { type: 'team' | 'customer'; name: string | null }

export interface UpdateInput {
  status?: unknown; priority?: unknown; note?: unknown;
  category?: unknown; platforms?: unknown; area?: unknown;
}

/**
 * Change status / priority. The team may set anything; a customer may only confirm it's fixed (resolved) or say it
 * still isn't (open, with a note). The note is what the customer (or the team) is told.
 */
export async function updateTicket(t: Ticket, input: UpdateInput, actor: Actor, opts: { notifyTeam: boolean }): Promise<{ ticket: Ticket; customer_notified?: CustomerNotified }> {
  const note = clean(input.note, 2000) || null;
  const status = input.status === undefined || input.status === null || input.status === '' ? undefined : String(input.status);
  const priority = input.priority === undefined || input.priority === null || input.priority === '' ? undefined : String(input.priority);
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw new SupportError(400, `Unknown status "${status}".`);
  if (priority !== undefined && !(PRIORITIES as readonly string[]).includes(priority)) throw new SupportError(400, `Unknown priority "${priority}".`);
  // Triage fields (type / platform / area) are the team's to set; the customer only says fixed or not fixed.
  const triage = input.category !== undefined || input.platforms !== undefined || input.area !== undefined;
  if (actor.type === 'customer') {
    if (priority !== undefined || triage || (status !== 'resolved' && status !== 'open')) throw new SupportError(403, 'You can mark the ticket as fixed, or say it is still not working.');
    if (status === 'open' && !note) throw new SupportError(400, "Tell us what's still not working.");
  }
  if (status === undefined && priority === undefined && !triage && !note) throw new SupportError(400, 'Nothing to update.');

  const prevStatus = t.status;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const statusChanged = status !== undefined && status !== prevStatus;
  if (statusChanged) {
    patch.status = status;
    const done = TERMINAL.includes(status as TicketStatus);
    if (done) patch.resolved_at = t.resolved_at ?? new Date().toISOString();
    else patch.resolved_at = null;
    if (actor.type === 'team' && done && note) patch.resolution_note = note;
  }
  if (priority !== undefined) patch.priority = priority;
  if (input.category !== undefined) patch.category = toCategory(input.category);
  if (input.platforms !== undefined) patch.platforms = toPlatforms(input.platforms);
  if (input.area !== undefined) patch.area = toArea(input.area);
  // The first time the team says anything is the first response the SLA is measured against.
  if (actor.type === 'team' && !t.first_response_at && (statusChanged || note)) patch.first_response_at = new Date().toISOString();
  const { data, error } = await supportDb().from('support_tickets').update(patch).eq('id', t.id).select('*').single();
  if (error || !data) throw new Error(error?.message || 'Could not update the ticket');
  const next = data as Ticket;

  if (statusChanged) {
    await addEvent({ ticket_id: t.id, kind: 'status', author_type: actor.type, author_name: actor.name, from_status: prevStatus, to_status: status!, body: note });
  } else if (note) {
    await addEvent({ ticket_id: t.id, kind: 'comment', author_type: actor.type, author_name: actor.name, from_status: null, to_status: null, body: note });
  }

  if (actor.type === 'team' && (statusChanged || note)) {
    const message = statusChanged ? statusMessage(next, note) : commentMessage(next, note!);
    return { ticket: next, customer_notified: await notifyCustomer(next, message, actor.name, statusChanged ? 'status' : 'comment', note) };
  }
  if (actor.type === 'customer' && opts.notifyTeam && statusChanged) {
    await alertTeam(status === 'resolved' ? `Ticket ${t.ref} confirmed fixed` : `Ticket ${t.ref} reopened`, `${t.org_name || t.contact_name || 'Customer'}: ${note || t.subject}`);
  }
  return { ticket: next };
}

/** A reply on the ticket. A customer reply reopens a resolved / closed ticket; a team reply goes to the customer. */
export async function addComment(t: Ticket, bodyRaw: unknown, actor: Actor, opts: { notifyTeam: boolean }): Promise<{ ticket: Ticket; customer_notified?: CustomerNotified }> {
  const body = clean(bodyRaw, 3000);
  if (!body) throw new SupportError(400, 'Write a message first.');
  let ticket = t;
  const prevStatus = t.status;
  const reopen = actor.type === 'customer'
    && (TERMINAL.includes(prevStatus) || prevStatus === 'waiting_on_customer');
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { updated_at: now };
  if (reopen) { patch.status = 'open'; patch.resolved_at = null; }
  if (actor.type === 'team' && !t.first_response_at) patch.first_response_at = now;
  const { data } = await supportDb().from('support_tickets').update(patch).eq('id', t.id).select('*').single();
  if (data) ticket = data as Ticket;
  await addEvent({ ticket_id: t.id, kind: 'comment', author_type: actor.type, author_name: actor.name, from_status: null, to_status: null, body });
  if (reopen) await addEvent({ ticket_id: t.id, kind: 'status', author_type: 'system', author_name: null, from_status: prevStatus, to_status: 'open', body: null });

  if (actor.type === 'team') return { ticket, customer_notified: await notifyCustomer(ticket, commentMessage(ticket, body), actor.name, 'comment', body) };
  if (opts.notifyTeam) await alertTeam(`Reply on ticket ${t.ref}`, `${t.org_name || t.contact_name || 'Customer'}: ${body}`);
  return { ticket };
}

export interface FeedbackInput { rating?: unknown; comment?: unknown }

/**
 * The customer's rating of how their ticket was handled, with an optional comment.
 *
 * Only the customer may give it, and only once the ticket has finished — rating work still in progress tells us
 * nothing. It is re-submittable on purpose: changing your mind should not need a ticket of its own. The team is
 * told, and the rating joins the timeline so it reads in context rather than hiding in a report.
 */
export async function submitFeedback(t: Ticket, input: FeedbackInput, actor: Actor, opts: { notifyTeam: boolean }): Promise<{ ticket: Ticket }> {
  if (actor.type !== 'customer') throw new SupportError(403, 'Only the customer can rate the ticket.');
  if (!TERMINAL.includes(t.status)) throw new SupportError(400, 'You can rate this ticket once it has been resolved or closed.');
  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new SupportError(400, 'Give the ticket a rating from 1 to 5.');
  const comment = clean(input.comment, 2000) || null;

  const now = new Date().toISOString();
  const { data, error } = await supportDb().from('support_tickets')
    .update({ csat_rating: rating, csat_comment: comment, csat_at: now, updated_at: now })
    .eq('id', t.id).select('*').single();
  if (error || !data) throw new Error(error?.message || 'Could not save your feedback');
  const next = data as Ticket;

  await addEvent({
    ticket_id: t.id, kind: 'feedback', author_type: 'customer', author_name: actor.name,
    from_status: null, to_status: null, body: comment ? `${rating}/5 — ${comment}` : `${rating}/5`,
  });
  if (opts.notifyTeam) {
    await alertTeam(
      `Feedback on ticket ${t.ref}: ${rating}/5`,
      `${t.org_name || t.contact_name || 'A customer'} rated ${t.ref} ${rating}/5${comment ? `: ${comment}` : ''}`,
    );
  }
  return { ticket: next };
}

// ── Telling people ────────────────────────────────────────────────────────────────────────────────────────────

export function statusMessage(t: Ticket, note: string | null): string {
  const n = note ? `\n${note}` : '';
  switch (t.status) {
    case 'resolved':
      return `✅ Your Kinematic support ticket *${t.ref}* (${t.subject}) is resolved.${n}\n\nStill not working? Reply *reopen ${t.ref}* and tell us what you see.`;
    case 'closed':
      return `Your Kinematic support ticket *${t.ref}* (${t.subject}) is closed.${n}`;
    case 'rejected':
      return `Your Kinematic support ticket *${t.ref}* (${t.subject}) won't be taken forward for now.${n}\n\nIf this is blocking you, reply starting with ${t.ref} and tell us why.`;
    case 'triaged':
      return `📋 We've logged your Kinematic support ticket *${t.ref}* (${t.subject}) and it's queued with our team.${n}`;
    case 'release_pending':
      return `🚀 The fix for your Kinematic support ticket *${t.ref}* (${t.subject}) is ready and ships in the next release.${n}`;
    case 'in_progress':
      return `🛠 We're working on your Kinematic support ticket *${t.ref}* (${t.subject}).${n}`;
    case 'waiting_on_customer':
      return `❓ We need a bit more from you on ticket *${t.ref}* (${t.subject}).${n}\n\nReply starting with ${t.ref} and your answer.`;
    default:
      return `🔁 Your Kinematic support ticket *${t.ref}* (${t.subject}) is open again.${n}`;
  }
}

export const commentMessage = (t: Ticket, body: string): string =>
  `💬 Update on your Kinematic support ticket *${t.ref}*:\n${body}\n\nReply starting with ${t.ref} to answer.`;

let supportOrgCache: { at: number; org: string | null } | null = null;
/** Test seam. */
export const _resetSupportState = (): void => { supportOrgCache = null; };

/** The org (Kinematic project) whose WhatsApp connection is Kinematic's own number. */
export async function supportOrgId(): Promise<string | null> {
  if (process.env.SUPPORT_ORG_ID) return process.env.SUPPORT_ORG_ID;
  if (supportOrgCache && Date.now() - supportOrgCache.at < 10 * 60_000) return supportOrgCache.org;
  const want = SUPPORT_NUMBER().slice(-10);
  const { data } = await supportDb().from('crm_whatsapp_connections').select('org_id, from_phone, is_active').eq('is_active', true).limit(500);
  const row = ((data ?? []) as Array<{ org_id: string; from_phone: string | null }>).find((r) => digits(r.from_phone).slice(-10) === want);
  supportOrgCache = { at: Date.now(), org: row?.org_id ?? null };
  return supportOrgCache.org;
}

/** Did this number write to Kinematic's WhatsApp in the last 23 hours? (The bot copies every message to the CRM.) */
async function inWindow(orgId: string, phone: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data } = await supportDb().from('crm_whatsapp_logs').select('id')
    .eq('org_id', orgId).eq('direction', 'inbound').in('from_phone', [phone, `+${phone}`]).gte('created_at', since).limit(1);
  return !!(data && (data as unknown[]).length);
}

const firstName = (n: string | null | undefined) => (String(n ?? '').trim().split(/\s+/)[0] || 'there');

/**
 * Tell the customer: in the app, by email, and on WhatsApp. Never throws — a delivery problem must not undo
 * the status change or reply that triggered it, so each channel reports its own outcome instead.
 */
export async function notifyCustomer(
  t: Ticket,
  /** The WhatsApp message — already carries WhatsApp's `*bold*` and its "reply reopen KM-…" instructions. */
  message: string,
  teamName: string | null,
  kind: SupportEmailKind = 'status',
  /**
   * What the team actually wrote, unformatted. The email quotes THIS, never `message`: the WhatsApp copy is
   * full of asterisks and "reply reopen KM-…" directions that are meaningless in an inbox, and the email
   * template writes its own opening and closing lines anyway.
   */
  mailMessage: string | null = null,
): Promise<CustomerNotified> {
  await notifyInApp(t, message).catch(() => undefined);
  const mail = await runWithProject(SUPPORT_PROJECT, async () => emailCustomer({
    ticket: t, kind, statusLabel: STATUS_LABEL[t.status] ?? t.status, message: mailMessage, orgId: await supportOrgId(),
  })).catch((e: any) => ({ email: 'failed' as const, note: e?.message || 'Email send failed' }));

  const withMail = (r: CustomerNotified): CustomerNotified => ({ ...r, email: mail.email, email_note: mail.note });

  const phone = normalizePhone(t.contact_phone);
  if (!phone) return withMail({ whatsapp: 'skipped', note: 'No WhatsApp number on this ticket. The customer was told in the app.' });
  try {
    return withMail(await runWithProject(SUPPORT_PROJECT, async () => {
      const orgId = await supportOrgId();
      if (!orgId) return { whatsapp: 'skipped' as const, note: "Kinematic's WhatsApp number isn't connected in CRM Settings → WhatsApp, so no WhatsApp was sent." };
      if (await inWindow(orgId, phone)) {
        const r = await sendWhatsapp({ org_id: orgId, to: phone, body_text: message });
        return r.status === 'sent' ? { whatsapp: 'sent' as const } : { whatsapp: 'failed' as const, note: r.error || 'WhatsApp send failed' };
      }
      const tpl = (await listTemplates(orgId, supportDb())).find((x) => x.meta_template_name === 'handoff_reply' && isApproved(x));
      if (!tpl) {
        return { whatsapp: 'skipped' as const, note: "The customer hasn't messaged on WhatsApp in the last 24 hours and the handoff_reply template isn't synced, so no WhatsApp was sent. They were told in the app." };
      }
      const flat = message.replace(/\*/g, '').replace(/\s*\n+\s*/g, ' ').slice(0, 900);
      const r = await sendWhatsapp({
        org_id: orgId, to: phone, template_id: tpl.id,
        template_variables: { 1: firstName(t.contact_name), 2: firstName(teamName) === 'there' ? 'Kinematic support' : firstName(teamName), 3: flat },
      });
      return r.status === 'sent' ? { whatsapp: 'template' as const } : { whatsapp: 'failed' as const, note: r.error || 'WhatsApp send failed' };
    }));
  } catch (e: any) {
    logger.warn(`[support] WhatsApp to customer failed ticket=${t.ref}: ${e?.message || e}`);
    return withMail({ whatsapp: 'failed', note: e?.message || 'WhatsApp send failed' });
  }
}

/** In-app notification for the user who raised it, in their own project. */
async function notifyInApp(t: Ticket, message: string): Promise<void> {
  if (!t.raised_by_user_id || !t.org_id || !t.project_key || !isKnownProject(t.project_key)) return;
  const { error } = await adminClientFor(t.project_key).from('notifications').insert({
    org_id: t.org_id, user_id: t.raised_by_user_id,
    title: `Support ticket ${t.ref}: ${STATUS_LABEL[t.status] ?? t.status}`,
    body: message.replace(/\*/g, '').slice(0, 500),
    type: 'general',
    data: { kind: SUPPORT_NOTIFICATION_KIND, ticket_id: t.id, ref: t.ref },
    is_read: false, sent_at: null,
  });
  if (error) logger.warn(`[support] in-app notification failed ticket=${t.ref}: ${error.message}`);
}

/** Tell the support team, through the support org's own WhatsApp alerts (its template and people). Never throws. */
export async function alertTeam(title: string, body: string): Promise<void> {
  try {
    await runWithProject(SUPPORT_PROJECT, async () => {
      const orgId = await supportOrgId();
      if (!orgId) return;
      const { data } = await supportDb().from('org_settings').select('value').eq('org_id', orgId).eq('key', WA_SETTING_KEY).maybeSingle();
      const s = toSettings((data as { value?: unknown } | null)?.value);
      if (!s.template_id || !s.recipients.length) {
        logger.info(`[support] no WhatsApp alert people set for the support org; "${title}" not sent`);
        return;
      }
      const out = await sendToRecipients(orgId, s, title, body);
      const failed = out.filter((o) => o.status === 'failed');
      if (failed.length) logger.warn(`[support] team alert failed for ${failed.length}/${out.length}: ${failed[0].error}`);
    });
  } catch (e: any) {
    logger.warn(`[support] team alert failed: ${e?.message || e}`);
  }
}
