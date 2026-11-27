/**
 * Support-ticket tools exposed to KINI agentic v2 — the customer side of the
 * ticketing module.
 *
 * These let a logged-in customer raise a ticket, ask where one stands, reply on
 * it and confirm a fix, all in conversation, instead of going to
 * Help & Support. Same queue, same events, same notifications as the web page:
 * everything goes through services/support/supportTickets.service.
 *
 * Two deliberate constraints:
 *
 *  1. **Customer-side only.** Every tool acts as `{ type: 'customer' }` and
 *     every read is scoped to the caller's own project + org. KINI's tool
 *     context carries no email, so `isPlatformOperator` cannot be evaluated
 *     here — rather than guess, these tools never grant team powers. An
 *     operator asking KINI sees their own org like anyone else; the support
 *     inbox in the dashboard is where they work other customers' tickets.
 *     This means a customer can never set status (beyond confirming a fix),
 *     priority, or the triage fields through KINI; the service rejects those
 *     with a 403 anyway.
 *
 *  2. **Org-wide, like the web page.** A ticket belongs to the organisation,
 *     not the person who typed it, so these tools show the caller's whole org
 *     — exactly what `/dashboard/support` shows a non-operator today.
 *
 * Timestamps are returned raw; `istifyForModel` in aiClient rewrites them to
 * IST before the model ever sees them, so nothing here formats dates.
 */
import { supabaseAdmin } from '../../../../lib/supabase';
import { currentProjectKey } from '../../../../lib/projects';
import type { KiniTool, KiniToolContext } from '../kiniTools.service';
import {
  AREAS, CATEGORIES, PLATFORMS, STATUSES, STATUS_LABEL, SupportError,
  addComment, createTicket, getTicket, listEvents, listTickets, requesterFromUser, updateTicket, belongsTo,
  type Requester, type Ticket,
} from '../../../support/supportTickets.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

/** A tool error in the shape every KINI tool uses — never a thrown exception. */
const fail = (message: string) => ({ data: { error: message } });

/** The message behind a SupportError (a validation / permission answer), or a generic one. */
const reason = (e: unknown, fallback: string): string =>
  e instanceof SupportError ? e.message : String((e as { message?: string })?.message || fallback);

/** The one org + project every read and write in this file is confined to. */
const scopeOf = (org_id: string) => ({ project_key: currentProjectKey(), org_id });

/**
 * The caller as a ticket contact. Reads the user in the CURRENT project (the
 * proxy client resolves per-request), and refuses if the user's own org is not
 * the org in scope — so a mismatched context can never raise a ticket against
 * someone else's organisation.
 */
async function requesterFor(org_id: string, ctx?: KiniToolContext): Promise<Requester | null> {
  if (!isUuid(ctx?.user_id)) return null;
  const { data } = await supabaseAdmin
    .from('users').select('id, org_id, name, email, mobile').eq('id', ctx!.user_id!).maybeSingle();
  const u = data as { id: string; org_id: string; name: string | null; email: string | null; mobile: string | null } | null;
  if (!u || u.org_id !== org_id) return null;
  return requesterFromUser(currentProjectKey(), u);
}

/** Everything the model needs about a ticket, and nothing it doesn't. */
const compact = (t: Ticket) => ({
  ref: t.ref,
  status: t.status,
  status_label: STATUS_LABEL[t.status] ?? t.status,
  subject: t.subject,
  category: t.category,
  priority: t.priority,
  platforms: t.platforms ?? [],
  area: t.area,
  channel: t.channel,
  raised_by: t.contact_name,
  resolution_note: t.resolution_note,
  created_at: t.created_at,
  updated_at: t.updated_at,
  resolved_at: t.resolved_at,
  first_response_at: t.first_response_at,
});

/**
 * The ticket named by `ref`, only if it belongs to the caller's org. A ticket
 * that exists but is someone else's reads as "not found" — the same answer the
 * dashboard gives, so a ref can't be used to probe for other customers.
 */
async function ownTicket(org_id: string, refOrId: unknown): Promise<Ticket | { data: { error: string } }> {
  const ref = str(refOrId);
  if (!ref) return fail('Which ticket? Give me its reference, e.g. KM-5002.');
  const t = await getTicket(ref);
  if (!t || !belongsTo(t, scopeOf(org_id))) return fail(`I can't find ticket ${ref} on your account.`);
  return t;
}
const isError = (v: unknown): v is { data: { error: string } } =>
  !!v && typeof v === 'object' && 'data' in v && !!(v as { data?: { error?: unknown } }).data?.error;

export const supportTools: KiniTool[] = [
  {
    name: 'support_raise_ticket',
    description:
      "Raise a support ticket with the Kinematic team on behalf of the person you are talking to. Use this when they report something broken, ask for a change or a new module, or want help you cannot give from the product's own data — and only after you have enough detail to describe the problem. Infer `category`, `platforms` and `area` from what they told you rather than interrogating them. Returns the ticket reference to quote back.",
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'One line naming the problem, e.g. "Attendance not syncing for the Pune team".' },
        description: {
          type: 'string',
          description: 'What happens, where, and what they expected. Include any steps, dates, outlets or users they mentioned, and the error text if they gave one. At least 10 characters.',
        },
        category: {
          type: 'string',
          enum: [...CATEGORIES],
          description: "The type of ask: `issue` when something isn't working, `bug` for a clear defect, `how_to` for a question, `change_request` to change existing behaviour, `new_module` for something new, `data_correction` when the data looks wrong, `access_request` for logins and permissions.",
        },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: [...PLATFORMS] },
          description: 'Where they hit it. Leave empty if they did not say.',
        },
        area: { type: 'string', enum: [...AREAS], description: 'Which part of Kinematic. Omit if unclear.' },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: 'Leave at normal unless they say it is blocking work (high) or stopping it entirely (urgent).',
        },
      },
      required: ['subject', 'description'],
    },
    exec: async (org_id, _client_id, args, ctx) => {
      const who = await requesterFor(org_id, ctx);
      if (!who) return fail("I couldn't identify your account, so I can't raise a ticket for you. Please use Help & Support in the dashboard.");
      try {
        const t = await createTicket({
          subject: args.subject,
          description: args.description,
          category: args.category,
          priority: args.priority,
          platforms: args.platforms,
          area: args.area,
          channel: 'dashboard',
        }, who, { notifyTeam: true });
        return {
          data: {
            raised: true,
            ticket: compact(t),
            tell_the_customer: `Raised as ${t.ref}. The Kinematic team has been notified and will reply here and on WhatsApp.`,
          },
        };
      } catch (e) {
        return fail(reason(e, 'I could not raise the ticket just now.'));
      }
    },
  },
  {
    name: 'support_my_tickets',
    description:
      "The support tickets on this customer's account, newest first, with a count per status. Use for 'what support tickets are open for us', 'did anyone report this already', or before raising a ticket to check it isn't a duplicate. Shows the whole organisation's tickets, not only the ones this person raised.",
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'all', ...STATUSES],
          description: '`active` (the default) is everything not yet resolved, closed or rejected. `all` includes finished ones.',
        },
        category: { type: 'string', enum: [...CATEGORIES] },
        platform: { type: 'string', enum: [...PLATFORMS] },
        area: { type: 'string', enum: [...AREAS] },
        q: { type: 'string', description: 'Free text matched against the reference and subject.' },
        limit: { type: 'number', default: 20 },
      },
    },
    exec: async (org_id, _client_id, args) => {
      try {
        const { tickets, counts } = await listTickets({
          status: str(args.status) || 'active',
          q: str(args.q),
          category: str(args.category),
          platform: str(args.platform),
          area: str(args.area),
          scope: scopeOf(org_id),
        });
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
        return {
          data: {
            total: tickets.length,
            counts,
            tickets: tickets.slice(0, limit).map(compact),
            truncated: tickets.length > limit,
          },
        };
      } catch (e) {
        return fail(reason(e, 'I could not read your support tickets just now.'));
      }
    },
  },
  {
    name: 'support_ticket_status',
    description:
      "Where one support ticket stands, with its conversation so far. Use whenever someone asks about a ticket by reference ('what's happening with KM-5002', 'any update on my ticket'). Only this customer's own tickets are visible.",
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The ticket reference, e.g. KM-5002.' },
        events_limit: { type: 'number', default: 15, description: 'How many of the most recent timeline entries to include.' },
      },
      required: ['ref'],
    },
    exec: async (org_id, _client_id, args) => {
      const t = await ownTicket(org_id, args.ref);
      if (isError(t)) return t;
      const limit = Math.min(Math.max(Number(args.events_limit) || 15, 1), 50);
      const events = await listEvents(t.id);
      return {
        data: {
          ticket: compact(t),
          waiting_on_customer: t.status === 'waiting_on_customer',
          events: events.slice(-limit).map((e) => ({
            kind: e.kind,
            author_type: e.author_type,
            author_name: e.author_name,
            from_status: e.from_status,
            to_status: e.to_status,
            body: e.body,
            created_at: e.created_at,
          })),
          events_omitted: Math.max(0, events.length - limit),
        },
      };
    },
  },
  {
    name: 'support_reply_ticket',
    description:
      "Add the customer's reply to one of their support tickets. Use when they answer something the team asked, or add detail to a ticket that already exists. The Kinematic team is notified. A reply on a ticket that was resolved, closed or rejected reopens it, so use this rather than raising a duplicate when they say a fix did not work.",
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The ticket reference, e.g. KM-5002.' },
        message: { type: 'string', description: "The customer's words, in enough detail for the team to act on." },
      },
      required: ['ref', 'message'],
    },
    exec: async (org_id, _client_id, args, ctx) => {
      const t = await ownTicket(org_id, args.ref);
      if (isError(t)) return t;
      const who = await requesterFor(org_id, ctx);
      // Read the status as a primitive before the write — never compare against
      // `t.status` afterwards, which assumes the object we hold is a separate copy.
      const before = t.status;
      try {
        const r = await addComment(t, args.message, { type: 'customer', name: who?.name ?? t.contact_name }, { notifyTeam: true });
        const reopened = r.ticket.status === 'open' && before !== 'open';
        return {
          data: {
            replied: true,
            reopened,
            ticket: compact(r.ticket),
            tell_the_customer: reopened
              ? `Added to ${t.ref} and reopened it, since it had been marked ${STATUS_LABEL[before] ?? before}. The team has been notified.`
              : `Added to ${t.ref}. The team has been notified.`,
          },
        };
      } catch (e) {
        return fail(reason(e, 'I could not add your reply just now.'));
      }
    },
  },
  {
    name: 'support_confirm_fixed',
    description:
      "Mark one of this customer's tickets as resolved because they say it is working now. Only use when they clearly confirm the problem is gone — if they are unsure, or it is still broken, use support_reply_ticket instead. This is the only status change a customer may make.",
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The ticket reference, e.g. KM-5002.' },
        note: { type: 'string', description: 'Optional: what fixed it or how they confirmed, for the record.' },
      },
      required: ['ref'],
    },
    exec: async (org_id, _client_id, args, ctx) => {
      const t = await ownTicket(org_id, args.ref);
      if (isError(t)) return t;
      const who = await requesterFor(org_id, ctx);
      try {
        const r = await updateTicket(
          t,
          { status: 'resolved', note: str(args.note) || undefined },
          { type: 'customer', name: who?.name ?? t.contact_name },
          { notifyTeam: true },
        );
        return {
          data: {
            resolved: true,
            ticket: compact(r.ticket),
            tell_the_customer: `Marked ${t.ref} as resolved. If it comes back, reply on the ticket and we'll pick it up again.`,
          },
        };
      } catch (e) {
        return fail(reason(e, 'I could not close that ticket just now.'));
      }
    },
  },
];
