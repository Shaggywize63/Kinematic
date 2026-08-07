/**
 * KINI human-in-the-loop approval gate.
 *
 * A "confirmation-required" tool is a CRM MUTATION (create / update / convert /
 * move) plus `crm_send_whatsapp`. During /chat we NEVER execute these — instead
 * we record a single `pending_action` (first write the model calls wins) and
 * hand the model a "not executed" tool_result so it wraps up by asking the user
 * to confirm. The client then POSTs the echoed action to
 * `POST /api/v1/kini/v2/confirm`, which re-validates and executes it
 * deterministically (no Anthropic call).
 *
 * Reads never require confirmation. Two writes are intentionally EXEMPT and stay
 * automatic:
 *   - `remember_fact`   — writes only per-user memory (contract: stays automatic)
 *   - `crm_draft_email` — produces draft text; it never sends or persists a CRM
 *                          mutation, so it is not a "mutation tool".
 * Field-Force module tools (`ff_*`) are reads and are likewise not gated.
 *
 * This is an EXPLICIT allow-list (not "everything not in READ_ONLY_TOOLS") so the
 * set is unambiguous and so newly-added non-CRM read tools can never be gated by
 * accident. It matches the contract's primary definition — "every CRM MUTATION
 * tool + crm_send_whatsapp".
 */
import { randomUUID } from 'crypto';

/**
 * The tools that must be confirmed by the user before they run. Keep this in
 * sync with the CRM mutation tools in kiniTools.service.ts — a new create /
 * update / convert / send tool MUST be added here on the day it ships.
 */
export const CONFIRM_REQUIRED_TOOLS: readonly string[] = [
  // send
  'crm_send_whatsapp',
  // create
  'crm_create_lead',
  'crm_create_deal',
  'crm_create_contact',
  'crm_create_account',
  'crm_create_task',
  'crm_log_activity',
  // update / convert / move
  'crm_update_lead',
  'crm_convert_lead',
  'crm_update_deal',
  'crm_move_deal_stage',
  'crm_update_contact',
  'crm_update_account',
];

const CONFIRM_SET = new Set<string>(CONFIRM_REQUIRED_TOOLS);

/** True when `tool` must be confirmed by the user before it executes. */
export function isConfirmRequired(tool: string): boolean {
  return CONFIRM_SET.has(tool);
}

/** The pending action echoed to the client and back to /confirm. */
export interface PendingAction {
  id: string;
  tool: string;
  /** Human title, e.g. "Send WhatsApp". */
  label: string;
  /** Human sentence describing exactly what will happen, incl. key args. */
  summary: string;
  /** The tool_use input object (executed verbatim on confirm). */
  args: Record<string, unknown>;
}

// ── Human labels + summaries ────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  crm_send_whatsapp: 'Send WhatsApp',
  crm_create_lead: 'Create lead',
  crm_create_deal: 'Create deal',
  crm_create_contact: 'Create contact',
  crm_create_account: 'Create account',
  crm_create_task: 'Create task',
  crm_log_activity: 'Log activity',
  crm_update_lead: 'Update lead',
  crm_convert_lead: 'Convert lead',
  crm_update_deal: 'Update deal',
  crm_move_deal_stage: 'Move deal stage',
  crm_update_contact: 'Update contact',
  crm_update_account: 'Update account',
};

export function labelForTool(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
}

function truncate(s: string, n = 80): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** "key: value, key2: value2" for the args that changed (id/keys excluded). */
function fieldList(args: Record<string, unknown>, exclude: string[]): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (exclude.includes(k) || v === undefined || v === null || v === '') continue;
    parts.push(`${k}: ${truncate(str(v), 40)}`);
  }
  return parts.join(', ');
}

/**
 * A verb-phrase sentence describing exactly what the tool will do, e.g.
 * "Send a WhatsApp message to +919812345678: \"Hi Rahul…\"". Starts with a
 * capital and has no trailing period so it reads both as a standalone summary
 * and, decapitalised, inside "Ready to … — confirm to proceed."
 */
export function summarizePendingAction(tool: string, rawArgs: Record<string, unknown>): string {
  const a = rawArgs ?? {};
  switch (tool) {
    case 'crm_send_whatsapp': {
      const to = str(a.to) || (str(a.lead_id) ? `lead ${str(a.lead_id)}` : '') || (str(a.contact_id) ? `contact ${str(a.contact_id)}` : '') || 'the recipient';
      const body = str(a.body);
      return body ? `Send a WhatsApp message to ${to}: "${truncate(body)}"` : `Send a WhatsApp message to ${to}`;
    }
    case 'crm_create_lead': {
      const name = [str(a.first_name), str(a.last_name)].filter(Boolean).join(' ') || 'a new lead';
      const company = str(a.company);
      return company ? `Create a new lead for ${name} at ${company}` : `Create a new lead for ${name}`;
    }
    case 'crm_create_deal': {
      const name = str(a.name) || 'a new deal';
      const amount = a.amount != null && a.amount !== '' ? ` worth ₹${str(a.amount)}` : '';
      return `Create a new deal "${name}"${amount}`;
    }
    case 'crm_create_contact': {
      const name = [str(a.first_name), str(a.last_name)].filter(Boolean).join(' ') || str(a.email) || str(a.phone) || 'a new contact';
      return `Create a new contact for ${name}`;
    }
    case 'crm_create_account':
      return `Create a new account "${str(a.name) || 'Untitled'}"`;
    case 'crm_create_task': {
      const subject = str(a.subject) || 'a task';
      const due = str(a.due_at);
      return due ? `Create a task "${subject}" due ${due}` : `Create a task "${subject}"`;
    }
    case 'crm_log_activity': {
      const type = str(a.type) || 'activity';
      const subject = str(a.subject);
      return subject ? `Log a ${type}: "${truncate(subject)}"` : `Log a ${type}`;
    }
    case 'crm_update_lead': {
      const changes = fieldList(a, ['id']);
      return changes ? `Update lead ${str(a.id)} (${changes})` : `Update lead ${str(a.id)}`;
    }
    case 'crm_convert_lead':
      return `Convert lead ${str(a.id)} into a contact${a.create_deal ? ' and a new deal' : ''}`;
    case 'crm_update_deal': {
      const changes = fieldList(a, ['id']);
      return changes ? `Update deal ${str(a.id)} (${changes})` : `Update deal ${str(a.id)}`;
    }
    case 'crm_move_deal_stage': {
      const target = str(a.stage_name) || str(a.stage_id) || 'a new stage';
      return `Move deal ${str(a.deal_id)} to ${target}`;
    }
    case 'crm_update_contact': {
      const changes = fieldList(a, ['id']);
      return changes ? `Update contact ${str(a.id)} (${changes})` : `Update contact ${str(a.id)}`;
    }
    case 'crm_update_account': {
      const changes = fieldList(a, ['id']);
      return changes ? `Update account ${str(a.id)} (${changes})` : `Update account ${str(a.id)}`;
    }
    default: {
      const changes = fieldList(a, []);
      return changes ? `${labelForTool(tool)} (${changes})` : labelForTool(tool);
    }
  }
}

/** Build a fresh pending action (with a new uuid) for a confirm-required tool. */
export function buildPendingAction(tool: string, args: Record<string, unknown>): PendingAction {
  return {
    id: randomUUID(),
    tool,
    label: labelForTool(tool),
    summary: summarizePendingAction(tool, args),
    args: args ?? {},
  };
}

/** Decapitalise the first character so a summary reads inside "Ready to …". */
function decapitalize(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** The short chat line that accompanies a pending action. */
export function pendingActionText(action: PendingAction): string {
  return `Ready to ${decapitalize(action.summary)} — confirm to proceed.`;
}

/**
 * Tool_result handed back to the model in place of executing a confirm-required
 * tool, so it wraps up the turn by asking the user to confirm rather than
 * assuming the write happened.
 */
export const PENDING_TOOL_RESULT =
  'NOT EXECUTED — queued for user confirmation. Do not call any more write tools; ' +
  'briefly tell the user you are ready and ask them to confirm before it runs.';

/** Past-tense confirmation shown after a confirmed action executes. */
export function doneText(tool: string, data: unknown): string {
  const msg = (data as { message?: unknown } | null | undefined)?.message;
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  const DONE: Record<string, string> = {
    crm_send_whatsapp: 'WhatsApp sent.',
    crm_create_lead: 'Lead created.',
    crm_create_deal: 'Deal created.',
    crm_create_contact: 'Contact created.',
    crm_create_account: 'Account created.',
    crm_create_task: 'Task created.',
    crm_log_activity: 'Activity logged.',
    crm_update_lead: 'Lead updated.',
    crm_convert_lead: 'Lead converted.',
    crm_update_deal: 'Deal updated.',
    crm_move_deal_stage: 'Deal moved to the new stage.',
    crm_update_contact: 'Contact updated.',
    crm_update_account: 'Account updated.',
  };
  return DONE[tool] ?? 'Done.';
}

/**
 * Collects the FIRST confirm-required tool call in a chat turn. Every
 * confirm-required call is recorded through this, but only the first sets the
 * pending action; the rest are still refused (never executed).
 */
export interface PendingCollector {
  record(tool: string, args: Record<string, unknown>): void;
  get(): PendingAction | null;
  has(): boolean;
}

export function createPendingCollector(): PendingCollector {
  let pending: PendingAction | null = null;
  return {
    record(tool, args) {
      if (!pending) pending = buildPendingAction(tool, args);
    },
    get() {
      return pending;
    },
    has() {
      return pending !== null;
    },
  };
}
