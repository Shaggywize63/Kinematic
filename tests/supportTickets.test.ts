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
  return { ...actual, sendToRecipients: jest.fn(async () => [{ phone: '918802274880', name: 'Sagar', status: 'sent', error: null }]) };
});

import {
  createTicket, updateTicket, addComment, requesterFromPhone, listTickets, statusMessage, _resetSupportState, SupportError,
  type Ticket, type Requester,
} from '../src/services/support/supportTickets.service';
import * as ctrl from '../src/controllers/support.controller';
import { sendWhatsapp } from '../src/services/crm/whatsapp.service';
import { sendToRecipients } from '../src/services/clientWhatsappAlerts.service';

const supa = () => (global as any).__supa;
const send = sendWhatsapp as jest.Mock;
const SUPPORT_ORG = 'org-kinematic';
const CUST_ORG = 'org-acme';
const TPL = 'tpl-handoff';

let tickets: Ticket[];
let inbound: boolean;
let templates: any[];

const who: Requester = { project_key: 'kinematic', org_id: CUST_ORG, org_name: 'Acme Foods', user_id: 'u-asha', name: 'Asha Rao', phone: '919811112222', email: 'asha@acme.in' };

beforeEach(() => {
  supa().reset();
  _resetSupportState();
  jest.clearAllMocks();
  send.mockResolvedValue({ id: 'log-1', provider_message_id: 'wamid.out', status: 'sent', error: null });
  tickets = [];
  inbound = true;
  templates = [];
  process.env.KINI_WEB_CHAT_KEY = 'bot-key';
  let seq = 5001;
  supa().setDefault('support_tickets', (chain: any) => {
    const ins = chain.ops.find((o: any) => o.method === 'insert');
    if (ins) {
      const now = new Date().toISOString();
      const t = { id: `00000000-0000-4000-8000-00000000${seq}`, ref: `KM-${seq++}`, status: 'open', priority: 'normal', category: 'other', resolution_note: null, resolved_at: null, created_at: now, updated_at: now, ...ins.args[0] };
      tickets.push(t);
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
  supa().setDefault('crm_whatsapp_connections', { data: [{ org_id: SUPPORT_ORG, from_phone: '+91 92202 99228', is_active: true }] });
  supa().setDefault('crm_whatsapp_logs', () => ({ data: inbound ? [{ id: 'in-1' }] : [] }));
  supa().setDefault('crm_whatsapp_templates', () => ({ data: templates }));
  supa().setDefault('org_settings', { data: { value: { enabled: true, template_id: '44444444-4444-4444-8444-444444444444', recipients: [{ name: 'Sagar', phone: '918802274880' }], kinds: [] } } });
});

const evts = () => supa().chainsFor('support_ticket_events').map((c: any) => c.ops.find((o: any) => o.method === 'insert')?.args[0]).filter(Boolean);

describe('createTicket', () => {
  it('saves the ticket with who raised it, logs it, and tells the team', async () => {
    const t = await createTicket({ subject: 'Attendance not syncing', description: 'Since morning the app shows no check-ins for Pune.', priority: 'high', category: 'bug', channel: 'dashboard' }, who, { notifyTeam: true });
    expect(t).toMatchObject({ ref: 'KM-5001', status: 'open', priority: 'high', category: 'bug', channel: 'dashboard', org_id: CUST_ORG, org_name: 'Acme Foods', raised_by_user_id: 'u-asha', contact_phone: '919811112222' });
    expect(evts()[0]).toMatchObject({ kind: 'created', author_type: 'customer', author_name: 'Asha Rao', to_status: 'open' });
    expect(sendToRecipients).toHaveBeenCalledWith(SUPPORT_ORG, expect.objectContaining({ template_id: '44444444-4444-4444-8444-444444444444' }), 'New support ticket KM-5001', expect.stringContaining('Acme Foods: Attendance not syncing'));
  });

  it('takes the first line as the subject when there is none, and checks lengths', async () => {
    const t = await createTicket({ description: 'Expense report export is blank\nTried twice', channel: 'whatsapp' }, who, { notifyTeam: false });
    expect(t.subject).toBe('Expense report export is blank');
    expect(sendToRecipients).not.toHaveBeenCalled();
    await expect(createTicket({ description: 'help', channel: 'dashboard' }, who, { notifyTeam: false })).rejects.toThrow(SupportError);
    await expect(createTicket({ subject: 'x', description: 'a long enough description', channel: 'dashboard' }, who, { notifyTeam: false })).rejects.toThrow(/subject/);
  });
});

describe('updateTicket (team)', () => {
  const raise = () => createTicket({ subject: 'Sync broken', description: 'Attendance not syncing since morning', channel: 'dashboard' }, who, { notifyTeam: false });

  it('resolves, records the note, and tells the customer on WhatsApp and in the app', async () => {
    const t = await raise();
    const r = await updateTicket(t, { status: 'resolved', note: 'The sync job was restarted.' }, { type: 'team', name: 'Sagar Bhargava' }, { notifyTeam: true });
    expect(r.ticket).toMatchObject({ status: 'resolved', resolution_note: 'The sync job was restarted.' });
    expect(r.ticket.resolved_at).toBeTruthy();
    expect(r.customer_notified).toEqual({ whatsapp: 'sent' });
    expect(send.mock.calls[0][0]).toMatchObject({ org_id: SUPPORT_ORG, to: '919811112222' });
    expect(send.mock.calls[0][0].body_text).toBe(statusMessage(r.ticket, 'The sync job was restarted.'));
    expect(send.mock.calls[0][0].body_text).toContain('Still not working? Reply *reopen KM-5001*');
    expect(evts().at(-1)).toMatchObject({ kind: 'status', author_type: 'team', author_name: 'Sagar Bhargava', from_status: 'open', to_status: 'resolved', body: 'The sync job was restarted.' });
    const note = supa().chainsFor('notifications')[0].ops.find((o: any) => o.method === 'insert').args[0];
    expect(note).toMatchObject({ org_id: CUST_ORG, user_id: 'u-asha', title: 'Support ticket KM-5001: Resolved', type: 'general', data: { kind: 'support_ticket', ref: 'KM-5001' } });
    // The customer's 24-hour window was checked on Kinematic's own number.
    expect(supa().chainsFor('crm_whatsapp_logs')[0].eqs).toMatchObject({ org_id: SUPPORT_ORG, direction: 'inbound' });
  });

  it('uses the handoff_reply template outside the 24-hour window, or says why nothing was sent', async () => {
    const t = await raise();
    inbound = false;
    let r = await updateTicket(t, { status: 'in_progress' }, { type: 'team', name: 'Sagar' }, { notifyTeam: true });
    expect(r.customer_notified?.whatsapp).toBe('skipped');
    expect(r.customer_notified?.note).toMatch(/handoff_reply template isn't synced/);
    expect(send).not.toHaveBeenCalled();

    templates = [{ id: TPL, meta_template_name: 'handoff_reply', status: 'APPROVED', body_text: 'Hi {{1}}, {{2}} from Kinematic here… {{3}}' }];
    r = await updateTicket(r.ticket, { status: 'resolved', note: 'Fixed.' }, { type: 'team', name: 'Sagar Bhargava' }, { notifyTeam: true });
    expect(r.customer_notified).toEqual({ whatsapp: 'template' });
    expect(send.mock.calls[0][0]).toMatchObject({ template_id: TPL, template_variables: { 1: 'Asha', 2: 'Sagar' } });
    expect(send.mock.calls[0][0].template_variables[3]).toMatch(/^✅ Your Kinematic support ticket KM-5001 \(Sync broken\) is resolved\. Fixed\./);
  });

  it('a team reply goes to the customer; reopening clears resolved_at', async () => {
    const t = await raise();
    const r1 = await updateTicket(t, { status: 'resolved' }, { type: 'team', name: 'Sagar' }, { notifyTeam: true });
    const r2 = await updateTicket(r1.ticket, { status: 'open', note: 'Looking again.' }, { type: 'team', name: 'Sagar' }, { notifyTeam: true });
    expect(r2.ticket.resolved_at).toBeNull();
    const r3 = await addComment(r2.ticket, 'Can you share a screenshot?', { type: 'team', name: 'Sagar' }, { notifyTeam: true });
    expect(r3.customer_notified).toEqual({ whatsapp: 'sent' });
    expect(send.mock.calls.at(-1)[0].body_text).toContain('Can you share a screenshot?');
    await expect(updateTicket(t, { status: 'done' }, { type: 'team', name: 'Sagar' }, { notifyTeam: true })).rejects.toThrow(/Unknown status/);
  });
});

describe('customers', () => {
  const raise = () => createTicket({ subject: 'Sync broken', description: 'Attendance not syncing since morning', channel: 'dashboard' }, who, { notifyTeam: false });

  it('can only confirm it is fixed, or say it still is not (with a note)', async () => {
    const t = await raise();
    const me = { type: 'customer' as const, name: 'Asha Rao' };
    await expect(updateTicket(t, { status: 'in_progress' }, me, { notifyTeam: true })).rejects.toThrow(/mark the ticket as fixed/);
    await expect(updateTicket(t, { priority: 'urgent', status: 'resolved' }, me, { notifyTeam: true })).rejects.toThrow(SupportError);
    const fixed = await updateTicket(t, { status: 'resolved' }, me, { notifyTeam: true });
    expect(fixed.ticket.status).toBe('resolved');
    expect(fixed.customer_notified).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(sendToRecipients).toHaveBeenCalledWith(SUPPORT_ORG, expect.anything(), 'Ticket KM-5001 confirmed fixed', expect.any(String));
    await expect(updateTicket(fixed.ticket, { status: 'open' }, me, { notifyTeam: true })).rejects.toThrow(/still not working/);
  });

  it('a reply on a resolved ticket reopens it and tells the team', async () => {
    const t = await raise();
    const r1 = await updateTicket(t, { status: 'resolved' }, { type: 'team', name: 'Sagar' }, { notifyTeam: true });
    const r2 = await addComment(r1.ticket, 'Still blank for Pune', { type: 'customer', name: 'Asha Rao' }, { notifyTeam: true });
    expect(r2.ticket.status).toBe('open');
    expect(evts().slice(-2)).toEqual([
      expect.objectContaining({ kind: 'comment', author_type: 'customer', body: 'Still blank for Pune' }),
      expect.objectContaining({ kind: 'status', author_type: 'system', from_status: 'resolved', to_status: 'open' }),
    ]);
    expect(sendToRecipients).toHaveBeenLastCalledWith(SUPPORT_ORG, expect.anything(), 'Reply on ticket KM-5001', 'Acme Foods: Still blank for Pune');
  });
});

describe('requesterFromPhone', () => {
  it('finds the user in any project by the last 10 digits, else keeps the number', async () => {
    let call = 0;
    supa().setDefault('users', () => (call++ === 0 ? { data: null } : { data: { id: 'u-tata', org_id: 'org-tata', name: 'Ravi', email: null } }));
    supa().setDefault('organisations', { data: { name: 'Tata Consumer' } });
    expect(await requesterFromPhone('+91 98111 12222', 'Ravi K')).toMatchObject({ project_key: 'default', org_id: 'org-tata', org_name: 'Tata Consumer', user_id: 'u-tata', name: 'Ravi', phone: '919811112222' });
    expect(supa().chainsFor('users')[0].ors[0]).toBe('mobile.eq.9811112222,mobile.eq.+919811112222,mobile.eq.919811112222,mobile.eq.09811112222');
    supa().setDefault('users', { data: null });
    expect(await requesterFromPhone('919811112222', 'Ravi K')).toMatchObject({ org_id: null, user_id: null, name: 'Ravi K', phone: '919811112222' });
  });
});

// ── Controller ─────────────────────────────────────────────────────────────────────────────────────────────────

const call = (handler: any, req: any) => new Promise<{ status: number; body: any }>((resolve, reject) => {
  let status = 200;
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: unknown) => { resolve({ status, body: b }); return res; } };
  handler({ params: {}, body: {}, query: {}, headers: {}, ...req }, res, (e: unknown) => reject(e));
});
const customer = { id: 'u-asha', org_id: CUST_ORG, role: 'admin', name: 'Asha Rao', email: 'asha@acme.in', mobile: '9811112222' };
const operator = { id: 'u-sagar', org_id: SUPPORT_ORG, role: 'super_admin', name: 'Sagar', email: 's@kinematicapp.com', client_id: null };

describe('dashboard API', () => {
  it('customers see only their organisation; operators see everyone', async () => {
    const mine = await createTicket({ subject: 'Mine', description: 'Our sync is broken today', channel: 'dashboard' }, { ...who, project_key: 'default' }, { notifyTeam: false });
    await createTicket({ subject: 'Theirs', description: 'Another customer issue', channel: 'dashboard' }, { ...who, org_id: 'org-other', project_key: 'default' }, { notifyTeam: false });

    const asCustomer = await call(ctrl.list, { user: customer });
    expect(asCustomer.body.data.is_operator).toBe(false);
    const scoped = supa().chainsFor('support_tickets').filter((c: any) => c.ops.some((o: any) => o.method === 'order')).at(-1);
    expect(scoped.eqs).toMatchObject({ org_id: CUST_ORG });
    expect(asCustomer.body.data.tickets.map((t: Ticket) => t.subject)).toEqual(['Mine']);

    const asOperator = await call(ctrl.list, { user: operator });
    expect(asOperator.body.data.is_operator).toBe(true);
    expect(asOperator.body.data.tickets).toHaveLength(2);

    const other = tickets.find((t) => t.subject === 'Theirs')!;
    expect((await call(ctrl.detail, { user: customer, params: { id: other.id } })).status).toBe(404);
    expect((await call(ctrl.detail, { user: customer, params: { id: mine.id } })).status).toBe(200);
  });

  it('raising a ticket uses the user as the contact; only operators can set any status', async () => {
    const r = await call(ctrl.create, { user: customer, body: { subject: 'Cannot export', description: 'The export button does nothing', category: 'bug' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ channel: 'dashboard', raised_by_user_id: 'u-asha', contact_phone: '919811112222', contact_email: 'asha@acme.in' });
    const bad = await call(ctrl.create, { user: customer, body: { subject: 'Hi', description: 'short' } });
    expect(bad.status).toBe(400);

    const id = r.body.data.id;
    expect((await call(ctrl.update, { user: customer, params: { id }, body: { status: 'closed' } })).status).toBe(403);
    const op = await call(ctrl.update, { user: operator, params: { id }, body: { status: 'resolved', note: 'Export fixed in 4.2' } });
    expect(op.status).toBe(200);
    expect(op.body.data.ticket.status).toBe('resolved');
    expect(op.body.data.customer_notified).toEqual({ whatsapp: 'sent' });
  });
});

describe('bot API', () => {
  it('needs the shared key', async () => {
    const r = await call(ctrl.botCreate, { headers: {}, body: { phone: '919811112222', text: 'Our sync is broken' } });
    expect(r.status).toBe(401);
  });

  it('raises from WhatsApp, lists by number, and only lets the same number reply or reopen', async () => {
    supa().setDefault('users', { data: null });
    const h = { 'x-kini-key': 'bot-key' };
    const r = await call(ctrl.botCreate, { headers: h, body: { phone: '919811112222', name: 'Asha', text: 'Our attendance sync is broken' } });
    expect(r.status).toBe(201);
    expect(r.body.data.ticket).toMatchObject({ ref: 'KM-5001', status: 'open', contact_phone: '919811112222' });
    expect(tickets[0].channel).toBe('whatsapp');
    expect(sendToRecipients).not.toHaveBeenCalled(); // the bot announces WhatsApp tickets itself

    const list = await call(ctrl.botList, { headers: h, query: { phone: '919811112222' } });
    expect(list.body.data.tickets.map((t: any) => t.ref)).toEqual(['KM-5001']);

    expect((await call(ctrl.botComment, { headers: h, params: { ref: 'KM-5001' }, body: { phone: '919800000000', text: 'hi' } })).status).toBe(404);
    const upd = await call(ctrl.botTeamUpdate, { headers: h, params: { ref: 'km-5001' }, body: { status: 'resolved', note: 'Restarted the sync', by: 'Sagar' } });
    expect(upd.body.data.ticket.status).toBe('resolved');
    expect(upd.body.data.customer_notified).toEqual({ whatsapp: 'sent' });
    const reopen = await call(ctrl.botReopen, { headers: h, params: { ref: 'KM-5001' }, body: { phone: '9811112222', text: 'Still broken in Pune' } });
    expect(reopen.body.data.ticket.status).toBe('open');
  });
});

describe('listTickets', () => {
  it('counts every status and filters active by default', async () => {
    const t = await createTicket({ subject: 'One', description: 'first ticket text', channel: 'dashboard' }, who, { notifyTeam: false });
    await createTicket({ subject: 'Two', description: 'second ticket text', channel: 'dashboard' }, who, { notifyTeam: false });
    await updateTicket(t, { status: 'resolved' }, { type: 'team', name: 'S' }, { notifyTeam: false });
    await listTickets({});
    const main = supa().chainsFor('support_tickets').filter((c: any) => c.ops.some((o: any) => o.method === 'order')).at(-1);
    expect(main.ops.find((o: any) => o.method === 'in').args).toEqual(['status', ['open', 'in_progress', 'waiting_on_customer']]);
  });
});
