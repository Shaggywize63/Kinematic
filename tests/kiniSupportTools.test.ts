jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/lib/projects', () => {
  const actual = jest.requireActual('../src/lib/projects');
  return {
    ...actual,
    adminClientFor: () => (global as any).__supa.client,
    listProjectKeys: () => ['kinematic', 'default'],
    isKnownProject: () => true,
  };
});
jest.mock('../src/services/crm/whatsapp.service', () => ({
  sendWhatsapp: jest.fn(async () => ({ id: 'log-1', provider_message_id: 'wamid.out', status: 'sent', error: null })),
}));
jest.mock('../src/services/clientWhatsappAlerts.service', () => {
  const actual = jest.requireActual('../src/services/clientWhatsappAlerts.service');
  return { ...actual, sendToRecipients: jest.fn(async () => []) };
});

import { currentProjectKey } from '../src/lib/projects';
import { tools as v2Tools, executeTool } from '../src/services/crm/ai/kiniToolsV2.service';
import { supportTools } from '../src/services/crm/ai/tools/support.tools';
import { createTicket, _resetSupportState, type Requester, type Ticket } from '../src/services/support/supportTickets.service';
import { SUPPORT_SYSTEM_GUIDANCE, SUPPORT_TOOLS_NAMED_IN_GUIDANCE } from '../src/services/crm/ai/kiniSupportGuidance';

/**
 * KINI's customer-side support tools. The guarantees that matter here are the
 * boundaries: a tool only ever sees the caller's own org, only ever acts as the
 * customer, and refuses cleanly (never throws) when it cannot identify who it
 * is acting for.
 */
const supa = () => (global as any).__supa;
const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const OUTSIDER = '55555555-5555-4555-8555-555555555555';

const tool = (name: string) => {
  const t = supportTools.find((x) => x.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  return t;
};
const run = (name: string, args: Record<string, unknown>, user_id: string | null = USER) =>
  tool(name).exec(ORG, null, args, { user_id });
const errorOf = (r: unknown): string | undefined => (r as { data?: { error?: string } })?.data?.error;
const dataOf = (r: unknown): any => (r as { data: any }).data;

let tickets: Ticket[];

const who = (org_id = ORG): Requester => ({
  project_key: currentProjectKey(), org_id, org_name: 'Acme Foods', user_id: USER,
  name: 'Asha Rao', phone: '919811112222', email: 'asha@acme.in',
});

beforeEach(() => {
  supa().reset();
  _resetSupportState();
  jest.clearAllMocks();
  tickets = [];
  let seq = 5001;
  supa().setDefault('support_tickets', (chain: any) => {
    const ins = chain.ops.find((o: any) => o.method === 'insert');
    if (ins) {
      const now = new Date().toISOString();
      const t = {
        id: `00000000-0000-4000-8000-00000000${seq}`, ref: `KM-${seq++}`, status: 'open', priority: 'normal',
        category: 'other', platforms: [], area: null, resolution_note: null, resolved_at: null,
        first_response_at: null, created_at: now, updated_at: now, ...ins.args[0],
      };
      tickets.push(t as Ticket);
      return { data: t };
    }
    const upd = chain.ops.find((o: any) => o.method === 'update');
    const match = tickets.filter((t: any) => Object.entries(chain.eqs).every(([k, v]) => t[k] === v));
    if (upd) {
      match.forEach((t) => Object.assign(t, upd.args[0]));
      return { data: match[0] ?? null };
    }
    return { data: chain.single ? match[0] ?? null : match };
  });
  supa().setDefault('support_ticket_events', { data: [] });
  supa().setDefault('organisations', { data: { name: 'Acme Foods' } });
  // The caller's own user row, read from the current project to build the contact.
  supa().setDefault('users', (chain: any) => {
    const id = chain.eqs.id;
    if (id === USER) return { data: { id: USER, org_id: ORG, name: 'Asha Rao', email: 'asha@acme.in', mobile: '919811112222' } };
    if (id === OUTSIDER) return { data: { id: OUTSIDER, org_id: OTHER_ORG, name: 'Someone Else', email: 'x@other.in', mobile: '919800000000' } };
    return { data: null };
  });
  supa().setDefault('crm_whatsapp_connections', { data: [] });
  supa().setDefault('crm_whatsapp_logs', { data: [] });
  supa().setDefault('org_settings', { data: null });
  supa().setDefault('notifications', { data: null });
});

describe('registration', () => {
  it('exposes every support tool through the v2 registry and dispatches them', async () => {
    const names = supportTools.map((t) => t.name);
    expect(names).toEqual([
      'support_raise_ticket', 'support_my_tickets', 'support_ticket_status',
      'support_reply_ticket', 'support_confirm_fixed',
    ]);
    for (const n of names) expect(v2Tools.map((t) => t.name)).toContain(n);

    // Dispatch really routes to the module tool, not the legacy CRM registry.
    const r = await executeTool(ORG, null, 'support_my_tickets', {}, { user_id: USER });
    expect(r).toMatchObject({ tool: 'support_my_tickets' });
    expect(errorOf(r)).toBeUndefined();
  });

  it('declares an input schema with only values the server accepts', () => {
    const schema = tool('support_raise_ticket').input_schema as any;
    expect(schema.properties.category.enum).toContain('change_request');
    expect(schema.properties.category.enum).not.toContain('feature_request'); // pre-v2 name, input-only
    expect(schema.properties.platforms.items.enum).toEqual(['web', 'android', 'ios', 'whatsapp', 'other']);
    expect(schema.required).toEqual(['subject', 'description']);
  });
});

describe('support_raise_ticket', () => {
  it('raises against the caller org with them as the contact', async () => {
    const r = await run('support_raise_ticket', {
      subject: 'Attendance not syncing',
      description: 'Since this morning the app shows no check-ins for the Pune team.',
      category: 'bug', platforms: ['android', 'web'], area: 'attendance', priority: 'high',
    });
    expect(dataOf(r).raised).toBe(true);
    expect(dataOf(r).ticket).toMatchObject({
      ref: 'KM-5001', status: 'open', category: 'bug', priority: 'high', area: 'attendance',
      platforms: ['android', 'web'], raised_by: 'Asha Rao',
    });
    expect(tickets[0]).toMatchObject({ org_id: ORG, raised_by_user_id: USER, channel: 'dashboard' });
  });

  it('refuses when it cannot identify the caller, rather than raising an anonymous ticket', async () => {
    expect(errorOf(await run('support_raise_ticket', { subject: 'Hi there', description: 'a long enough description' }, null)))
      .toMatch(/couldn't identify your account/i);
    expect(tickets).toHaveLength(0);
  });

  it("refuses a caller whose own org is not the org in scope", async () => {
    expect(errorOf(await run('support_raise_ticket', { subject: 'Cross org', description: 'should never be raised at all' }, OUTSIDER)))
      .toMatch(/couldn't identify your account/i);
    expect(tickets).toHaveLength(0);
  });

  it('turns a validation failure into a tool error instead of throwing', async () => {
    expect(errorOf(await run('support_raise_ticket', { subject: 'Hi', description: 'a long enough description here' })))
      .toMatch(/subject/i);
    expect(errorOf(await run('support_raise_ticket', { subject: 'Export is blank', description: 'short' })))
      .toMatch(/detail/i);
    expect(tickets).toHaveLength(0);
  });
});

describe('reads', () => {
  const raise = (org_id = ORG) => createTicket(
    { subject: 'Sync broken', description: 'Attendance not syncing since this morning', channel: 'dashboard' },
    who(org_id), { notifyTeam: false },
  );

  it('support_my_tickets scopes to the caller project and org', async () => {
    await raise();
    const r = await run('support_my_tickets', {});
    expect(dataOf(r).tickets.map((t: any) => t.ref)).toEqual(['KM-5001']);
    const listed = supa().chainsFor('support_tickets').filter((c: any) => c.ops.some((o: any) => o.method === 'order')).at(-1);
    expect(listed.eqs).toMatchObject({ org_id: ORG, project_key: currentProjectKey() });
  });

  it('support_my_tickets passes the category / platform / area filters through', async () => {
    await run('support_my_tickets', { category: 'bug', platform: 'ios', area: 'crm' });
    const listed = supa().chainsFor('support_tickets').filter((c: any) => c.ops.some((o: any) => o.method === 'order')).at(-1);
    expect(listed.eqs).toMatchObject({ category: 'bug', area: 'crm' });
    expect(listed.ops.find((o: any) => o.method === 'contains').args).toEqual(['platforms', ['ios']]);
  });

  it('support_ticket_status returns the ticket and its timeline', async () => {
    const t = await raise();
    supa().setDefault('support_ticket_events', {
      data: [
        { id: 'e1', ticket_id: t.id, kind: 'created', author_type: 'customer', author_name: 'Asha Rao', from_status: null, to_status: 'open', body: null, created_at: t.created_at },
        { id: 'e2', ticket_id: t.id, kind: 'comment', author_type: 'team', author_name: 'S', from_status: null, to_status: null, body: 'Looking into it.', created_at: t.created_at },
      ],
    });
    const r = await run('support_ticket_status', { ref: 'KM-5001' });
    expect(dataOf(r).ticket).toMatchObject({ ref: 'KM-5001', status_label: 'Open' });
    expect(dataOf(r).events.map((e: any) => e.kind)).toEqual(['created', 'comment']);
    expect(dataOf(r).waiting_on_customer).toBe(false);
  });

  it("hides another org's ticket behind the same answer as one that does not exist", async () => {
    await raise(OTHER_ORG);
    const theirs = await run('support_ticket_status', { ref: 'KM-5001' });
    const missing = await run('support_ticket_status', { ref: 'KM-9999' });
    expect(errorOf(theirs)).toBe("I can't find ticket KM-5001 on your account.");
    expect(errorOf(missing)).toBe("I can't find ticket KM-9999 on your account.");
  });

  it('asks for a reference when none is given', async () => {
    expect(errorOf(await run('support_ticket_status', { ref: '  ' }))).toMatch(/which ticket/i);
  });
});

describe('writes on an existing ticket', () => {
  const raise = () => createTicket(
    { subject: 'Sync broken', description: 'Attendance not syncing since this morning', channel: 'dashboard' },
    who(), { notifyTeam: false },
  );

  it('support_reply_ticket adds the reply as the customer', async () => {
    await raise();
    const r = await run('support_reply_ticket', { ref: 'KM-5001', message: 'Still happening for the Pune team this morning.' });
    expect(dataOf(r).replied).toBe(true);
    expect(dataOf(r).reopened).toBe(false);
    const ev = supa().chainsFor('support_ticket_events')
      .map((c: any) => c.ops.find((o: any) => o.method === 'insert')?.args[0]).filter(Boolean).at(-1);
    expect(ev).toMatchObject({ kind: 'comment', author_type: 'customer', author_name: 'Asha Rao' });
  });

  it('support_reply_ticket reopens a resolved ticket and says so', async () => {
    const t = await raise();
    Object.assign(tickets.find((x) => x.id === t.id)!, { status: 'resolved' });
    const r = await run('support_reply_ticket', { ref: 'KM-5001', message: 'The fix did not work, it is still broken.' });
    expect(dataOf(r).reopened).toBe(true);
    expect(dataOf(r).ticket.status).toBe('open');
    expect(dataOf(r).tell_the_customer).toMatch(/reopened/i);
  });

  it('support_confirm_fixed resolves it', async () => {
    await raise();
    const r = await run('support_confirm_fixed', { ref: 'KM-5001', note: 'Working again after the restart.' });
    expect(dataOf(r).resolved).toBe(true);
    expect(dataOf(r).ticket.status).toBe('resolved');
  });

  it("will not touch another org's ticket", async () => {
    await createTicket(
      { subject: 'Theirs', description: 'a ticket belonging to a different organisation', channel: 'dashboard' },
      who(OTHER_ORG), { notifyTeam: false },
    );
    expect(errorOf(await run('support_reply_ticket', { ref: 'KM-5001', message: 'trying to comment on this' }))).toMatch(/can't find/i);
    expect(errorOf(await run('support_confirm_fixed', { ref: 'KM-5001' }))).toMatch(/can't find/i);
    expect(tickets[0].status).toBe('open');
  });
});


describe('what KINI is told about support', () => {
  it('names only tools that are really registered', () => {
    const registered = new Set(v2Tools.map((t) => t.name));
    for (const name of SUPPORT_TOOLS_NAMED_IN_GUIDANCE) {
      expect(registered.has(name)).toBe(true);
    }
  });

  it('mentions every support tool, so none is left for the model to discover by luck', () => {
    for (const name of SUPPORT_TOOLS_NAMED_IN_GUIDANCE) {
      expect(SUPPORT_SYSTEM_GUIDANCE).toContain(name);
    }
    // And the list is the whole family — a tool added without guidance is a tool that rarely gets used.
    expect([...SUPPORT_TOOLS_NAMED_IN_GUIDANCE].sort()).toEqual(supportTools.map((t) => t.name).sort());
  });

  it('tells the model to answer first, avoid duplicates, and never guess', () => {
    expect(SUPPORT_SYSTEM_GUIDANCE).toMatch(/ANSWER THE QUESTION FIRST/);
    expect(SUPPORT_SYSTEM_GUIDANCE).toMatch(/duplicate/i);
    expect(SUPPORT_SYSTEM_GUIDANCE).toMatch(/never guess/i);
  });
});
