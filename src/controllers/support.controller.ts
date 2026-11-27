/**
 * Support tickets API.
 *
 *   /api/v1/support/tickets…          dashboard (JWT). Customers: their organisation's tickets. Platform operators:
 *                                     every ticket (the support inbox) and status / priority changes.
 *   /api/v1/support/public/tickets…   KINI WhatsApp bot (shared KINI key). Customers by WhatsApp number; the owner's
 *                                     WhatsApp commands ("resolve KM-5001 …") come through here as team updates.
 *
 * Logic in services/support/supportTickets.service.ts.
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';
import type { AuthRequest } from '../types';
import { asyncHandler, ok, created, badRequest, notFound, forbidden } from '../utils';
import { currentProjectKey, runWithProject } from '../lib/projects';
import { isPlatformOperator } from '../lib/tenantScope';
import {
  SupportError, SUPPORT_PROJECT, listTickets, getTicket, listEvents, belongsTo, createTicket, updateTicket, addComment,
  submitFeedback, requesterFromUser, requesterFromPhone, type Ticket, type Actor,
} from '../services/support/supportTickets.service';

function fail(res: Response, e: unknown): void {
  if (e instanceof SupportError) {
    if (e.status === 403) { forbidden(res, e.message); return; }
    if (e.status === 404) { notFound(res, e.message); return; }
    badRequest(res, e.message);
    return;
  }
  throw e;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────────────────────────────────────

const scopeOf = (req: AuthRequest) => ({ project_key: currentProjectKey(), org_id: req.user!.org_id });

/** The ticket, if this user may see it (operators: any). Sends the 404 itself. */
async function visibleTicket(req: AuthRequest, res: Response): Promise<Ticket | null> {
  const t = await getTicket(String(req.params.id ?? ''));
  if (!t || (!isPlatformOperator(req.user!) && !belongsTo(t, scopeOf(req)))) { notFound(res, 'Ticket not found'); return null; }
  return t;
}

const actorOf = (req: AuthRequest): Actor => ({ type: isPlatformOperator(req.user!) ? 'team' : 'customer', name: req.user!.name ?? null });

export const list = asyncHandler(async (req: AuthRequest, res: Response) => {
  const operator = isPlatformOperator(req.user!);
  const r = await listTickets({
    status: String(req.query.status ?? 'active'), q: String(req.query.q ?? ''),
    category: String(req.query.category ?? ''), platform: String(req.query.platform ?? ''), area: String(req.query.area ?? ''),
    scope: operator ? null : scopeOf(req),
  });
  ok(res, { ...r, is_operator: operator });
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  try {
    const project = currentProjectKey();
    const who = await requesterFromUser(project, req.user!);
    const b = req.body ?? {};
    const t = await createTicket({
      subject: b.subject, description: b.description, category: b.category, priority: b.priority,
      platforms: b.platforms, area: b.area, channel: 'dashboard',
    }, who, { notifyTeam: true });
    created(res, t);
  } catch (e) { fail(res, e); }
});

export const detail = asyncHandler(async (req: AuthRequest, res: Response) => {
  const t = await visibleTicket(req, res);
  if (!t) return;
  ok(res, { ticket: t, events: await listEvents(t.id) });
});

export const comment = asyncHandler(async (req: AuthRequest, res: Response) => {
  const t = await visibleTicket(req, res);
  if (!t) return;
  try {
    const r = await addComment(t, (req.body ?? {}).body, actorOf(req), { notifyTeam: true });
    ok(res, { ...r, events: await listEvents(t.id) });
  } catch (e) { fail(res, e); }
});

export const update = asyncHandler(async (req: AuthRequest, res: Response) => {
  const t = await visibleTicket(req, res);
  if (!t) return;
  try {
    const b = req.body ?? {};
    const r = await updateTicket(t, {
      status: b.status, priority: b.priority, note: b.note,
      category: b.category, platforms: b.platforms, area: b.area,
    }, actorOf(req), { notifyTeam: true });
    ok(res, { ...r, events: await listEvents(t.id) });
  } catch (e) { fail(res, e); }
});

/** POST /tickets/:id/feedback { rating, comment? } — how the customer rates a finished ticket. */
export const feedback = asyncHandler(async (req: AuthRequest, res: Response) => {
  const t = await visibleTicket(req, res);
  if (!t) return;
  try {
    const b = req.body ?? {};
    const r = await submitFeedback(t, { rating: b.rating, comment: b.comment }, actorOf(req), { notifyTeam: true });
    ok(res, { ...r, events: await listEvents(t.id) });
  } catch (e) { fail(res, e); }
});

// ── KINI WhatsApp bot (shared key) ────────────────────────────────────────────────────────────────────────────

function keyOk(req: Request): boolean {
  const expected = (process.env.SUPPORT_BOT_KEY || process.env.KINI_WEB_CHAT_KEY || '').trim();
  if (!expected) return false; // never accept when unconfigured
  const provided = String((req.headers['x-kini-key'] as string | undefined) ?? '');
  if (provided.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected)); } catch { return false; }
}

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const samePhone = (a: unknown, b: unknown) => digits(a).length >= 10 && digits(a).slice(-10) === digits(b).slice(-10);

/** Wraps a bot handler: key check, then the Kinematic project. */
const bot = (fn: (req: Request, res: Response) => Promise<void>) => asyncHandler(async (req: Request, res: Response) => {
  if (!keyOk(req)) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
  await runWithProject(SUPPORT_PROJECT, () => fn(req, res));
});

const compact = (t: Ticket) => ({
  id: t.id, ref: t.ref, status: t.status, priority: t.priority, category: t.category, platforms: t.platforms, area: t.area,
  subject: t.subject, org_name: t.org_name,
  contact_name: t.contact_name, contact_phone: t.contact_phone, created_at: t.created_at, updated_at: t.updated_at, resolution_note: t.resolution_note,
});

/** POST /public/tickets { phone, name?, text, subject?, category? } — a customer's "Raise an issue" on WhatsApp. */
export const botCreate = bot(async (req, res) => {
  const b = req.body ?? {};
  if (digits(b.phone).length < 10) { badRequest(res, 'phone is required'); return; }
  try {
    const who = await requesterFromPhone(b.phone, typeof b.name === 'string' ? b.name.slice(0, 80) : null);
    const t = await createTicket({
      subject: b.subject, description: b.text, category: b.category,
      platforms: b.platforms, area: b.area, channel: 'whatsapp',
    }, who, { notifyTeam: false });
    created(res, { ticket: compact(t) });
  } catch (e) { fail(res, e); }
});

/** GET /public/tickets?phone=…&status=… (a customer's own tickets) or ?team=1&status=… (the owner's open list). */
export const botList = bot(async (req, res) => {
  const team = req.query.team === '1';
  const phone = String(req.query.phone ?? '');
  if (!team && digits(phone).length < 10) { badRequest(res, 'phone is required'); return; }
  const r = await listTickets({ status: String(req.query.status ?? (team ? 'active' : 'all')), phone: team ? undefined : phone });
  ok(res, { tickets: r.tickets.slice(0, 20).map(compact), counts: r.counts });
});

async function botTicket(req: Request, res: Response): Promise<Ticket | null> {
  const t = await getTicket(String(req.params.ref ?? ''));
  if (!t) { notFound(res, 'Ticket not found'); return null; }
  return t;
}

/** POST /public/tickets/:ref/comments { phone, text } — a customer's WhatsApp reply on their ticket. */
export const botComment = bot(async (req, res) => {
  const t = await botTicket(req, res);
  if (!t) return;
  const b = req.body ?? {};
  if (!samePhone(b.phone, t.contact_phone)) { notFound(res, 'Ticket not found'); return; }
  try {
    const r = await addComment(t, b.text, { type: 'customer', name: t.contact_name }, { notifyTeam: false });
    ok(res, { ticket: compact(r.ticket) });
  } catch (e) { fail(res, e); }
});

/** POST /public/tickets/:ref/reopen { phone, text } — "still not working". */
export const botReopen = bot(async (req, res) => {
  const t = await botTicket(req, res);
  if (!t) return;
  const b = req.body ?? {};
  if (!samePhone(b.phone, t.contact_phone)) { notFound(res, 'Ticket not found'); return; }
  try {
    const note = String(b.text ?? '').trim() || 'Customer says it is still not working.';
    const r = await updateTicket(t, { status: 'open', note }, { type: 'customer', name: t.contact_name }, { notifyTeam: false });
    ok(res, { ticket: compact(r.ticket) });
  } catch (e) { fail(res, e); }
});

/** PATCH /public/tickets/:ref { status?, priority?, note?, by? } — the owner's WhatsApp commands (team update). */
export const botTeamUpdate = bot(async (req, res) => {
  const t = await botTicket(req, res);
  if (!t) return;
  const b = req.body ?? {};
  try {
    const r = await updateTicket(t, { status: b.status, priority: b.priority, note: b.note }, { type: 'team', name: typeof b.by === 'string' ? b.by.slice(0, 60) : 'Kinematic support' }, { notifyTeam: false });
    ok(res, { ticket: compact(r.ticket), customer_notified: r.customer_notified });
  } catch (e) { fail(res, e); }
});
