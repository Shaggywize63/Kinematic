/**
 * Connected-B2B account journey (Spark & Ray): recent updates on an account (each optionally from a named
 * contact person) and the "whole path" view — lead -> account -> contacts -> visits & forms -> follow-ups ->
 * deals / quotations -> expenses — in one payload the dashboard draws as a flow.
 *
 * Gated on isB2bClient by the routes, so a tenant whose database has not run migration_account_journey.sql
 * never reaches these queries.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_UPDATE_LEN = 4000;

const fullName = (c: { first_name?: string | null; last_name?: string | null; name?: string | null } | undefined) =>
  [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim() || c?.name || null;

// ── recent updates ──────────────────────────────────────────────────────────

export interface AccountUpdateRow {
  id: string; account_id: string; contact_id: string | null; body: string;
  created_by: string | null; created_at: string; updated_at: string;
  contact_name?: string | null; author_name?: string | null;
}

async function stampUpdateNames(rows: AccountUpdateRow[]): Promise<AccountUpdateRow[]> {
  if (!rows.length) return rows;
  const contactIds = Array.from(new Set(rows.map((r) => r.contact_id).filter(Boolean))) as string[];
  const userIds = Array.from(new Set(rows.map((r) => r.created_by).filter(Boolean))) as string[];
  const contacts = new Map<string, string | null>();
  const users = new Map<string, string>();
  if (contactIds.length) {
    const { data } = await supabaseAdmin.from('crm_contacts').select('id, first_name, last_name').in('id', contactIds);
    for (const c of (data ?? []) as Array<{ id: string; first_name?: string | null; last_name?: string | null }>) contacts.set(c.id, fullName(c));
  }
  if (userIds.length) {
    const { data } = await supabaseAdmin.from('users').select('id, name, email').in('id', userIds);
    for (const u of (data ?? []) as Array<{ id: string; name?: string | null; email?: string | null }>) users.set(u.id, u.name || u.email || '');
  }
  return rows.map((r) => ({
    ...r,
    contact_name: r.contact_id ? (contacts.get(r.contact_id) ?? null) : null,
    author_name: r.created_by ? (users.get(r.created_by) ?? null) : null,
  }));
}

export async function listAccountUpdates(orgId: string, accountId: string, limit = 100): Promise<AccountUpdateRow[]> {
  const { data, error } = await supabaseAdmin.from('crm_account_updates').select('*')
    .eq('org_id', orgId).eq('account_id', accountId).is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(Math.min(limit, 200));
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return stampUpdateNames((data ?? []) as AccountUpdateRow[]);
}

/** The contact must belong to this account (so an update is always "by someone at this company"). */
async function assertContactOfAccount(orgId: string, accountId: string, contactId: string): Promise<void> {
  if (!UUID_RE.test(contactId)) throw new AppError(400, 'Invalid contact', 'VALIDATION');
  const { data } = await supabaseAdmin.from('crm_contacts').select('id')
    .eq('org_id', orgId).eq('id', contactId).eq('account_id', accountId).is('deleted_at', null).maybeSingle();
  if (!data) throw new AppError(400, 'That contact person does not belong to this account', 'VALIDATION');
}

export async function createAccountUpdate(args: {
  orgId: string; clientId: string | null; userId: string | null; accountId: string;
  body: string; contactId?: string | null;
}): Promise<AccountUpdateRow> {
  const body = (args.body ?? '').trim();
  if (!body) throw new AppError(400, 'Write the update first', 'VALIDATION');
  if (body.length > MAX_UPDATE_LEN) throw new AppError(400, `An update can be at most ${MAX_UPDATE_LEN} characters`, 'VALIDATION');
  if (args.contactId) await assertContactOfAccount(args.orgId, args.accountId, args.contactId);
  const { data, error } = await supabaseAdmin.from('crm_account_updates').insert({
    org_id: args.orgId, client_id: args.clientId, account_id: args.accountId,
    contact_id: args.contactId || null, body, created_by: args.userId,
  }).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (await stampUpdateNames([data as AccountUpdateRow]))[0];
}

async function loadUpdate(orgId: string, accountId: string, updateId: string): Promise<AccountUpdateRow> {
  const { data } = await supabaseAdmin.from('crm_account_updates').select('*')
    .eq('org_id', orgId).eq('account_id', accountId).eq('id', updateId).is('deleted_at', null).maybeSingle();
  if (!data) throw new AppError(404, 'Update not found', 'NOT_FOUND');
  return data as AccountUpdateRow;
}

/** Edit or delete: the author, or an admin. */
export async function updateAccountUpdate(args: {
  orgId: string; userId: string | null; isAdmin: boolean; accountId: string; updateId: string;
  body?: string; contactId?: string | null;
}): Promise<AccountUpdateRow> {
  const cur = await loadUpdate(args.orgId, args.accountId, args.updateId);
  if (!args.isAdmin && cur.created_by !== args.userId) throw new AppError(403, 'Only the author can edit this update', 'FORBIDDEN');
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (args.body !== undefined) {
    const b = args.body.trim();
    if (!b) throw new AppError(400, 'An update cannot be empty', 'VALIDATION');
    if (b.length > MAX_UPDATE_LEN) throw new AppError(400, `An update can be at most ${MAX_UPDATE_LEN} characters`, 'VALIDATION');
    patch.body = b;
  }
  if (args.contactId !== undefined) {
    if (args.contactId) await assertContactOfAccount(args.orgId, args.accountId, args.contactId);
    patch.contact_id = args.contactId || null;
  }
  const { data, error } = await supabaseAdmin.from('crm_account_updates').update(patch)
    .eq('id', args.updateId).eq('org_id', args.orgId).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (await stampUpdateNames([data as AccountUpdateRow]))[0];
}

export async function deleteAccountUpdate(args: {
  orgId: string; userId: string | null; isAdmin: boolean; accountId: string; updateId: string;
}): Promise<void> {
  const cur = await loadUpdate(args.orgId, args.accountId, args.updateId);
  if (!args.isAdmin && cur.created_by !== args.userId) throw new AppError(403, 'Only the author can delete this update', 'FORBIDDEN');
  const { error } = await supabaseAdmin.from('crm_account_updates')
    .update({ deleted_at: new Date().toISOString() }).eq('id', args.updateId).eq('org_id', args.orgId);
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
}

// ── the journey ─────────────────────────────────────────────────────────────

export type JourneyStepKey = 'lead' | 'account' | 'contacts' | 'visits' | 'followups' | 'deals' | 'expenses';
export interface JourneyStep {
  key: JourneyStepKey;
  label: string;
  count: number;
  /** done = has happened; current = the furthest step reached; todo = not yet. */
  state: 'done' | 'current' | 'todo';
  /** A short second line, e.g. "2 quotations · 1 won". */
  note: string | null;
  /** When the step first happened (ISO), if known. */
  at: string | null;
}

/**
 * Pure: turns step counts into the flow's steps. The account always exists; every other step is "done" when it
 * has something in it, and the last "done" step is the "current" one. Exported for unit tests.
 */
export function composeSteps(input: {
  leads: number; contacts: number; visits: number; forms: number; activities: number; updates: number;
  deals: number; quotations: number; won: number; expenses: number;
  at: Partial<Record<JourneyStepKey, string | null>>;
}): JourneyStep[] {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const raw: Array<Omit<JourneyStep, 'state'>> = [
    { key: 'lead', label: 'Lead', count: input.leads, note: input.leads ? plural(input.leads, 'lead') : null, at: input.at.lead ?? null },
    { key: 'account', label: 'Account', count: 1, note: null, at: input.at.account ?? null },
    { key: 'contacts', label: 'Contacts', count: input.contacts, note: input.contacts ? plural(input.contacts, 'person', 'people') : null, at: input.at.contacts ?? null },
    {
      key: 'visits', label: 'Visits & forms', count: input.visits + input.forms,
      note: input.visits + input.forms ? [input.visits ? plural(input.visits, 'visit') : '', input.forms ? plural(input.forms, 'form') : ''].filter(Boolean).join(' · ') : null,
      at: input.at.visits ?? null,
    },
    {
      key: 'followups', label: 'Tasks & updates', count: input.activities + input.updates,
      note: input.activities + input.updates ? [input.activities ? plural(input.activities, 'task') : '', input.updates ? plural(input.updates, 'update') : ''].filter(Boolean).join(' · ') : null,
      at: input.at.followups ?? null,
    },
    {
      key: 'deals', label: 'Deals & quotations', count: input.deals,
      note: input.deals ? [plural(input.deals, 'deal'), input.quotations ? plural(input.quotations, 'quotation') : '', input.won ? `${input.won} won` : ''].filter(Boolean).join(' · ') : null,
      at: input.at.deals ?? null,
    },
    { key: 'expenses', label: 'Expenses', count: input.expenses, note: input.expenses ? plural(input.expenses, 'claim') : null, at: input.at.expenses ?? null },
  ];
  let lastDone = -1;
  raw.forEach((s, i) => { if (s.count > 0) lastDone = i; });
  return raw.map((s, i) => ({ ...s, state: s.count <= 0 ? 'todo' : i === lastDone ? 'current' : 'done' }));
}

const earliest = (dates: Array<string | null | undefined>): string | null => {
  const ts = dates.map((d) => Date.parse(d ?? '')).filter((t) => Number.isFinite(t));
  return ts.length ? new Date(Math.min(...ts)).toISOString() : null;
};

/** Loads the pieces the timeline helper does not cover and composes the journey payload. */
export async function buildAccountJourney(args: {
  orgId: string;
  accountId: string;
  /** Output of visitBridge.getAccountTimeline for this account (account + visits/forms/activities + FE rollup). */
  timeline: { account: Record<string, any>; summary: Record<string, any>; timeline: Array<Record<string, any>> };
}) {
  const { orgId, accountId, timeline } = args;
  const safe = async <T>(label: string, run: () => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> => {
    try { const { data, error } = await run(); if (error) throw error; return data ?? []; }
    catch (e) { logger.warn({ err: (e as Error)?.message, label }, 'account journey: a section failed to load'); return []; }
  };

  const [leads, contacts, deals, claims, updates] = await Promise.all([
    safe<any>('leads', () => supabaseAdmin.from('crm_leads')
      .select('id, first_name, last_name, company, status, created_at')
      .eq('org_id', orgId).eq('converted_account_id', accountId).is('deleted_at', null).order('created_at', { ascending: true }).limit(20)),
    safe<any>('contacts', () => supabaseAdmin.from('crm_contacts')
      .select('id, first_name, last_name, title, phone, email, created_at')
      .eq('org_id', orgId).eq('account_id', accountId).is('deleted_at', null).order('created_at', { ascending: true }).limit(100)),
    safe<any>('deals', () => supabaseAdmin.from('crm_deals')
      .select('id, name, amount, currency, status, stage_id, quotation_no, expected_close_date, created_at')
      .eq('org_id', orgId).eq('account_id', accountId).is('deleted_at', null).order('created_at', { ascending: true }).limit(100)),
    safe<any>('expenses', () => supabaseAdmin.from('expense_claims')
      .select('id, claim_no, status, total_amount, user_id, created_at, submitted_at, form_submission_id')
      .eq('org_id', orgId).eq('account_id', accountId).order('created_at', { ascending: true }).limit(100)),
    listAccountUpdates(orgId, accountId, 100).catch(() => [] as AccountUpdateRow[]),
  ]);

  // Deal stage names + each deal's products (price lines).
  const stageIds = Array.from(new Set(deals.map((d: any) => d.stage_id).filter(Boolean)));
  const dealIds = deals.map((d: any) => d.id);
  const [stages, items] = await Promise.all([
    stageIds.length ? safe<any>('stages', () => supabaseAdmin.from('crm_deal_stages').select('id, name, stage_type').in('id', stageIds)) : Promise.resolve([]),
    dealIds.length ? safe<any>('items', () => supabaseAdmin.from('crm_deal_line_items')
      .select('deal_id, name, quantity, unit_price, position').eq('org_id', orgId).in('deal_id', dealIds).order('position', { ascending: true })) : Promise.resolve([]),
  ]);
  const stageById = new Map<string, any>(stages.map((s: any) => [s.id, s]));
  const itemsByDeal = new Map<string, any[]>();
  for (const it of items) { const l = itemsByDeal.get(it.deal_id) ?? []; l.push(it); itemsByDeal.set(it.deal_id, l); }
  const dealRows = deals.map((d: any) => ({
    ...d,
    stage_name: stageById.get(d.stage_id)?.name ?? null,
    stage_type: stageById.get(d.stage_id)?.stage_type ?? null,
    items: (itemsByDeal.get(d.id) ?? []).map((i: any) => ({ name: i.name, quantity: Number(i.quantity), unit_price: Number(i.unit_price) })),
  }));

  // Filled-form serials (SRPR2627-n) for the forms in the timeline and for the expenses' linked forms.
  const formIds = Array.from(new Set([
    ...timeline.timeline.filter((e) => e.kind === 'submission').map((e) => e.id as string),
    ...claims.map((c: any) => c.form_submission_id).filter(Boolean),
  ]));
  const refs = new Map<string, { ref_no: string | null; submitted_at: string | null }>();
  if (formIds.length) {
    for (const r of await safe<any>('form refs', () => supabaseAdmin.from('form_submissions').select('id, ref_no, submitted_at').in('id', formIds))) {
      refs.set(r.id, { ref_no: r.ref_no ?? null, submitted_at: r.submitted_at ?? null });
    }
  }
  const events = timeline.timeline.map((e) =>
    e.kind === 'submission' ? { ...e, ref_no: refs.get(e.id as string)?.ref_no ?? null } : e);
  const expenses = claims.map((c: any) => ({
    ...c,
    form_ref_no: c.form_submission_id ? (refs.get(c.form_submission_id)?.ref_no ?? null) : null,
    form_submitted_at: c.form_submission_id ? (refs.get(c.form_submission_id)?.submitted_at ?? null) : null,
  }));

  const visits = events.filter((e) => e.kind === 'visit');
  const forms = events.filter((e) => e.kind === 'submission');
  const activities = events.filter((e) => e.kind === 'activity');
  const steps = composeSteps({
    leads: leads.length, contacts: contacts.length, visits: visits.length, forms: forms.length,
    activities: activities.length, updates: updates.length,
    deals: dealRows.length, quotations: dealRows.filter((d: any) => !!d.quotation_no).length,
    won: dealRows.filter((d: any) => d.status === 'won' || d.stage_type === 'won').length, expenses: expenses.length,
    at: {
      lead: earliest(leads.map((l: any) => l.created_at)),
      account: (timeline.account.created_at as string) ?? null,
      contacts: earliest(contacts.map((c: any) => c.created_at)),
      visits: earliest(events.filter((e) => e.kind !== 'activity').map((e) => e.at)),
      followups: earliest([...activities.map((e) => e.at), ...updates.map((u) => u.created_at)]),
      deals: earliest(dealRows.map((d: any) => d.created_at)),
      expenses: earliest(expenses.map((c: any) => c.created_at)),
    },
  });

  return {
    account: timeline.account,
    steps,
    summary: timeline.summary,
    leads, contacts, updates, visits, forms, activities, deals: dealRows, expenses,
    // Everything on one clock, newest first, for the "what happened" feed under the flow.
    events: [
      ...events.map((e) => ({ at: e.at ?? null, kind: e.kind as string, title: e.title as string, detail: (e.detail ?? e.form_title ?? null) as string | null, ref: (e.ref_no ?? null) as string | null, who: (e.user_name ?? null) as string | null })),
      ...updates.map((u) => ({ at: u.created_at, kind: 'update', title: 'Account update', detail: u.body, ref: null, who: u.contact_name ? `${u.contact_name}${u.author_name ? ` · logged by ${u.author_name}` : ''}` : (u.author_name ?? null) })),
      ...dealRows.map((d: any) => ({ at: d.created_at, kind: 'deal', title: d.name as string, detail: [d.quotation_no ? `Quotation ${d.quotation_no}` : '', d.stage_name ?? ''].filter(Boolean).join(' · ') || null, ref: d.quotation_no ?? null, who: null })),
      ...expenses.map((c: any) => ({ at: c.created_at, kind: 'expense', title: `Expense ${c.claim_no ?? ''}`.trim(), detail: c.status ?? null, ref: c.form_ref_no ?? null, who: null })),
    ].sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0)),
  };
}
