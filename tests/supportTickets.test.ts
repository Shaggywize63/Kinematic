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
jest.mock('../src/services/support/supportEmail', () => {
  const actual = jest.requireActual('../src/services/support/supportEmail');
  return { ...actual, emailCustomer: jest.fn(async () => ({ email: 'sent' })) };
});
jest.mock('../src/services/clientWhatsappAlerts.service', () => {
  const actual = jest.requireActual('../src/services/clientWhatsappAlerts.service');
  return { ...actual, sendToRecipients: jest.fn(async () => [{ phone: '918802274880', name: 'Sagar', status: 'sent', error: null }]) };
});

import {
  createTicket, updateTicket, addComment, requesterFromPhone, listTickets, statusMessage, _resetSupportState, SupportError,
  submitFeedback, SUPPORT_NOTIFICATION_KIND,
  type Ticket, type Requester,
} from '../src/services/support/supportTickets.service';
import * as ctrl from '../src/controllers/support.controller';
import { sendWhatsapp } from '../src/services/crm/whatsapp.service';
import { emailCustomer } from '../src/services/support/supportEmail';
import { sendToRecipients } from '../src/services/clientWhatsappAlerts.service';

const supa = () => (global as any).__supa;
const send = sendWhatsapp as jest.Mock;
const mail = emailCustomer as jest.Mock;
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
    expect(r.customer_notified).toEqual({ whatsapp: 'sent', email: 'sent' });
    expect(send.mock.calls[0][0]).toMatchObject({ org_id: SUPPORT_ORG, to: '919811112222' });
    expect(send.mock.calls[0][0].body_text).toBe(statusMessage(r.ticket, 'The sync job was restarted.'));
    expect(send.mock.calls[0][0].body_text).toContain('Still not working? Reply *reopen KM-5001*');
    expect(evts().at(-1)).toMatchObject({ kind: 'status', author_type: 'team', author_name: 'Sagar Bhargava', from_status: 'open', to_status: 'resolved', body: 'The sync job was restarted.' });
    const note = supa().chainsFor('notifications')[0].ops.find((o: any) => o.method === 'insert').args[0];
    // data.kind must be the kind registered in lib/notificationCatalog — the push dispatcher suppresses any
    // kind that is not in the catalogue, so a drift here silently stops the push reaching the phone.
    expect(note).toMatchObject({ org_id: CUST_ORG, user_id: 'u-asha', title: 'Support ticket KM-5001: Resolved', type: 'general', data: { kind: SUPPORT_NOTIFICATION_KIND, ref: 'KM-5001' } });
    expect(SUPPORT_NOTIFICATION_KIND).toBe('support_ticket_update');
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
    expect(r.customer_notified).toEqual({ whatsapp: 'template', email: 'sent' });
    expect(send.mock.calls[0][0]).toMatchObject({ template_id: TPL, template_variables: { 1: 'Asha', 2: 'Sagar' } });
    expect(send.mock.calls[0][0].template_variables[3]).toMatch(/^✅ Your Kinematic support ticket KM-5001 \(Sync broken\) is resolved\. Fixed\./);
  });

  it('a team reply goes to the customer; reopening clears resolved_at', async () => {
    const t = await raise();
    const r1 = await updateTicket(t, { status: 'resolved' }, { type: 'team', name: 'Sagar' }, { notifyTeam: true });
    const r2 = await updateTicket(r1.ticket, { status: 'open', note: 'Looking again.' }, { type: 'team', name: 'Sagar' }, { notifyTeam: true });
    expect(r2.ticket.resolved_at).toBeNull();
    const r3 = await addComment(r2.ticket, 'Can you share a screenshot?', { type: 'team', name: 'Sagar' }, { notifyTeam: true });
    expect(r3.customer_notified).toEqual({ whatsapp: 'sent', email: 'sent' });
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
    expect(op.body.data.customer_notified).toEqual({ whatsapp: 'sent', email: 'sent' });
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
    expect(upd.body.data.customer_notified).toEqual({ whatsapp: 'sent', email: 'sent' });
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
    expect(main.ops.find((o: any) => o.method === 'in').args)
      .toEqual(['status', ['open', 'triaged', 'in_progress', 'waiting_on_customer', 'release_pending']]);
  });

  it('narrows the rows AND the counts by category / platform / area', async () => {
    await listTickets({ category: 'bug', platform: 'android', area: 'attendance' });
    const chains = supa().chainsFor('support_tickets');
    // Two queries are built: the rows (ordered) and the status counts. Both must carry the filters,
    // or the tab counts would disagree with the list.
    const rows = chains.filter((c: any) => c.ops.some((o: any) => o.method === 'order')).at(-1);
    const counts = chains.filter((c: any) => !c.ops.some((o: any) => o.method === 'order')).at(-1);
    for (const c of [rows, counts]) {
      expect(c.eqs).toMatchObject({ category: 'bug', area: 'attendance' });
      expect(c.ops.find((o: any) => o.method === 'contains').args).toEqual(['platforms', ['android']]);
    }
  });

  it('ignores a category / platform / area that is not ours', async () => {
    await listTickets({ category: 'nonsense', platform: 'windows', area: 'made_up' });
    const rows = supa().chainsFor('support_tickets').filter((c: any) => c.ops.some((o: any) => o.method === 'order')).at(-1);
    expect(rows.eqs).not.toHaveProperty('category');
    expect(rows.eqs).not.toHaveProperty('area');
    expect(rows.ops.find((o: any) => o.method === 'contains')).toBeUndefined();
  });
});

describe('v2 taxonomy', () => {
  it('accepts the pre-v2 category names and falls back to other', async () => {
    const feature = await createTicket({ subject: 'Old name', description: 'raised with the pre-v2 category name', category: 'feature_request', channel: 'dashboard' }, who, { notifyTeam: false });
    expect(feature.category).toBe('new_module');
    const data = await createTicket({ subject: 'Numbers', description: 'the totals on the report look wrong', category: 'data', channel: 'dashboard' }, who, { notifyTeam: false });
    expect(data.category).toBe('data_correction');
    const junk = await createTicket({ subject: 'Junk', description: 'an unknown category should not be stored', category: 'not_a_category', channel: 'dashboard' }, who, { notifyTeam: false });
    expect(junk.category).toBe('other');
  });

  it('defaults platforms from the channel when the customer picks none', async () => {
    const web = await createTicket({ subject: 'From the web', description: 'raised from the dashboard with no platform', channel: 'dashboard' }, who, { notifyTeam: false });
    expect(web.platforms).toEqual(['web']);
    const wa = await createTicket({ subject: 'From WhatsApp', description: 'raised through the KINI bot with no platform', channel: 'whatsapp' }, who, { notifyTeam: false });
    expect(wa.platforms).toEqual(['whatsapp']);
    const app = await createTicket({ subject: 'From the app', description: 'the mobile client says which OS itself', channel: 'app' }, who, { notifyTeam: false });
    expect(app.platforms).toEqual([]);
  });

  it('keeps only real platforms and areas, de-duplicated, from an array or a csv string', async () => {
    const t = await createTicket({ subject: 'Mobile crash', description: 'the app closes when opening attendance', category: 'bug', platforms: ['android', 'ios', 'windows', 'android'], area: 'attendance', channel: 'dashboard' }, who, { notifyTeam: false });
    expect(t.platforms).toEqual(['android', 'ios']);
    expect(t.area).toBe('attendance');
    const csv = await createTicket({ subject: 'Csv form', description: 'platforms arriving as a comma separated string', platforms: 'web, ios', area: 'made_up', channel: 'dashboard' }, who, { notifyTeam: false });
    expect(csv.platforms).toEqual(['web', 'ios']);
    expect(csv.area).toBeNull();
  });

  it('lets the team retriage a ticket but never the customer', async () => {
    const t = await createTicket({ subject: 'Retriage me', description: 'raised as an issue but it is really a bug', channel: 'dashboard' }, who, { notifyTeam: false });
    await expect(updateTicket(t, { category: 'bug' }, { type: 'customer', name: 'Asha Rao' }, { notifyTeam: false }))
      .rejects.toBeInstanceOf(SupportError);
    await expect(updateTicket(t, { area: 'crm' }, { type: 'customer', name: 'Asha Rao' }, { notifyTeam: false }))
      .rejects.toBeInstanceOf(SupportError);
    const r = await updateTicket(t, { status: 'triaged', category: 'bug', area: 'crm', platforms: ['web', 'android'] }, { type: 'team', name: 'S' }, { notifyTeam: false });
    expect(r.ticket).toMatchObject({ status: 'triaged', category: 'bug', area: 'crm', platforms: ['web', 'android'] });
  });

  it('stamps the first team response once, and not for the customer', async () => {
    const t = await createTicket({ subject: 'Response clock', description: 'the SLA clock starts on our first reply', channel: 'dashboard' }, who, { notifyTeam: false });
    expect(t.first_response_at ?? null).toBeNull();
    const mine = await addComment(t, 'Any update on this?', { type: 'customer', name: 'Asha Rao' }, { notifyTeam: false });
    expect(mine.ticket.first_response_at ?? null).toBeNull();
    const first = await addComment(mine.ticket, 'Looking into it now.', { type: 'team', name: 'S' }, { notifyTeam: false });
    const stamped = first.ticket.first_response_at;
    expect(stamped).toBeTruthy();
    const second = await addComment(first.ticket, 'Still looking.', { type: 'team', name: 'S' }, { notifyTeam: false });
    expect(second.ticket.first_response_at).toBe(stamped);
  });

  it('treats rejected as finished, and a customer reply reopens it', async () => {
    const t = await createTicket({ subject: 'Not planned', description: 'a change request we are not taking forward', category: 'change_request', channel: 'dashboard' }, who, { notifyTeam: false });
    const no = await updateTicket(t, { status: 'rejected', note: 'Not on the roadmap this quarter.' }, { type: 'team', name: 'S' }, { notifyTeam: false });
    expect(no.ticket.status).toBe('rejected');
    expect(no.ticket.resolved_at).toBeTruthy();
    expect(no.ticket.resolution_note).toBe('Not on the roadmap this quarter.');
    const back = await addComment(no.ticket, 'This is blocking our Pune rollout.', { type: 'customer', name: 'Asha Rao' }, { notifyTeam: false });
    expect(back.ticket.status).toBe('open');
  });

  it('tells the customer something useful for each new status', async () => {
    const t = await createTicket({ subject: 'Export broken', description: 'the export button does nothing at all', channel: 'dashboard' }, who, { notifyTeam: false });
    expect(statusMessage({ ...t, status: 'triaged' }, null)).toContain('queued with our team');
    expect(statusMessage({ ...t, status: 'release_pending' }, null)).toContain('next release');
    const rejected = statusMessage({ ...t, status: 'rejected' }, 'Not on the roadmap.');
    expect(rejected).toContain("won't be taken forward");
    expect(rejected).toContain('Not on the roadmap.');
  });
});


describe('email to the customer', () => {
  const raise = () => createTicket({ subject: 'Sync broken', description: 'Attendance not syncing since morning', channel: 'dashboard' }, who, { notifyTeam: false });

  it('confirms a new ticket, then follows every team update with the right kind', async () => {
    const t = await raise();
    expect(mail).toHaveBeenCalledWith(expect.objectContaining({ kind: 'raised', message: null }));

    mail.mockClear();
    const upd = await updateTicket(t, { status: 'in_progress', note: 'On it now.' }, { type: 'team', name: 'S' }, { notifyTeam: false });
    expect(mail).toHaveBeenCalledWith(expect.objectContaining({ kind: 'status', statusLabel: 'In progress', message: 'On it now.' }));
    expect(upd.customer_notified?.email).toBe('sent');

    mail.mockClear();
    const rep = await addComment(upd.ticket, 'One more question for you.', { type: 'team', name: 'S' }, { notifyTeam: false });
    expect(mail).toHaveBeenCalledWith(expect.objectContaining({ kind: 'comment' }));
    expect(rep.customer_notified?.email).toBe('sent');
  });

  it('does not email the customer about their own reply', async () => {
    const t = await raise();
    mail.mockClear();
    const r = await addComment(t, 'Any update?', { type: 'customer', name: 'Asha Rao' }, { notifyTeam: false });
    expect(mail).not.toHaveBeenCalled();
    expect(r.customer_notified).toBeUndefined();
  });

  it('reports a failed email without losing the status change', async () => {
    const t = await raise();
    mail.mockResolvedValueOnce({ email: 'failed', note: 'Mailbox does not exist' });
    const r = await updateTicket(t, { status: 'resolved', note: 'Fixed.' }, { type: 'team', name: 'S' }, { notifyTeam: false });
    expect(r.ticket.status).toBe('resolved');
    expect(r.customer_notified).toMatchObject({ email: 'failed', email_note: 'Mailbox does not exist' });
  });

  it('survives the email module throwing', async () => {
    const t = await raise();
    mail.mockRejectedValueOnce(new Error('provider exploded'));
    const r = await updateTicket(t, { status: 'resolved' }, { type: 'team', name: 'S' }, { notifyTeam: false });
    expect(r.ticket.status).toBe('resolved');
    expect(r.customer_notified?.email).toBe('failed');
  });
});

describe('feedback (CSAT)', () => {
  const raise = () => createTicket({ subject: 'Sync broken', description: 'Attendance not syncing since morning', channel: 'dashboard' }, who, { notifyTeam: false });
  const finish = async (status: 'resolved' | 'closed' | 'rejected' = 'resolved') => {
    const t = await raise();
    return (await updateTicket(t, { status }, { type: 'team', name: 'S' }, { notifyTeam: false })).ticket;
  };
  const asCustomer = { type: 'customer' as const, name: 'Asha Rao' };

  it('is refused while the ticket is still being worked', async () => {
    const t = await raise();
    await expect(submitFeedback(t, { rating: 5 }, asCustomer, { notifyTeam: false })).rejects.toThrow(/resolved or closed/);
    expect(t.csat_rating ?? null).toBeNull();
  });

  it('is the customer\'s to give, not the team\'s', async () => {
    const done = await finish();
    await expect(submitFeedback(done, { rating: 5 }, { type: 'team', name: 'S' }, { notifyTeam: false }))
      .rejects.toThrow(/Only the customer/);
  });

  it('takes a whole number from 1 to 5 and nothing else', async () => {
    const done = await finish();
    for (const rating of [0, 6, 4.5, -1, 'five', null, undefined]) {
      await expect(submitFeedback(done, { rating }, asCustomer, { notifyTeam: false })).rejects.toThrow(/1 to 5/);
    }
  });

  it('saves the rating, puts it on the timeline and tells the team', async () => {
    const done = await finish();
    const r = await submitFeedback(done, { rating: 4, comment: 'Quick, thanks.' }, asCustomer, { notifyTeam: true });
    expect(r.ticket).toMatchObject({ csat_rating: 4, csat_comment: 'Quick, thanks.' });
    expect(r.ticket.csat_at).toBeTruthy();
    expect(evts().at(-1)).toMatchObject({ kind: 'feedback', author_type: 'customer', author_name: 'Asha Rao', body: '4/5 — Quick, thanks.' });
    expect(sendToRecipients).toHaveBeenCalledWith(
      SUPPORT_ORG, expect.anything(), 'Feedback on ticket KM-5001: 4/5', expect.stringContaining('4/5'),
    );
  });

  it('records a bare rating with no comment', async () => {
    const done = await finish();
    const r = await submitFeedback(done, { rating: 5 }, asCustomer, { notifyTeam: false });
    expect(r.ticket).toMatchObject({ csat_rating: 5, csat_comment: null });
    expect(evts().at(-1)).toMatchObject({ kind: 'feedback', body: '5/5' });
  });

  it('can be changed afterwards', async () => {
    const done = await finish();
    await submitFeedback(done, { rating: 2, comment: 'Took a while.' }, asCustomer, { notifyTeam: false });
    const again = await submitFeedback(done, { rating: 5, comment: 'Sorted in the end.' }, asCustomer, { notifyTeam: false });
    expect(again.ticket).toMatchObject({ csat_rating: 5, csat_comment: 'Sorted in the end.' });
  });

  it('can be given on a closed or not-planned ticket too', async () => {
    for (const status of ['closed', 'rejected'] as const) {
      supa().reset();
      tickets = [];
      supa().setDefault('support_tickets', (chain: any) => {
        const ins = chain.ops.find((o: any) => o.method === 'insert');
        if (ins) {
          const now = new Date().toISOString();
          const t = { id: '00000000-0000-4000-8000-000000005001', ref: 'KM-5001', status: 'open', priority: 'normal', category: 'other', platforms: [], area: null, resolution_note: null, resolved_at: null, first_response_at: null, csat_rating: null, csat_comment: null, csat_at: null, created_at: now, updated_at: now, ...ins.args[0] };
          tickets.push(t as Ticket);
          return { data: t };
        }
        const upd = chain.ops.find((o: any) => o.method === 'update');
        const match = tickets.filter((x: any) => Object.entries(chain.eqs).every(([k, v]) => x[k] === v));
        if (upd) { match.forEach((x) => Object.assign(x, upd.args[0])); return { data: match[0] ?? null }; }
        return { data: chain.single ? match[0] ?? null : match };
      });
      supa().setDefault('support_ticket_events', { data: [] });
      supa().setDefault('organisations', { data: { name: 'Acme Foods' } });
      const done = await finish(status);
      const r = await submitFeedback(done, { rating: 3 }, asCustomer, { notifyTeam: false });
      expect(r.ticket.csat_rating).toBe(3);
    }
  });
});
