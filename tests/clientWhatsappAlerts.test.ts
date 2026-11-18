jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/crm/whatsapp.service', () => ({
  sendWhatsapp: jest.fn(async () => ({ id: 'log-1', provider_message_id: 'wamid.1', status: 'sent', error: null })),
}));

import { getClientWhatsappAlerts, setClientWhatsappAlerts, testClientWhatsappAlerts } from '../src/controllers/client.controller';
import {
  parseSettingsInput, normalizePhone, templateVariables, placeholderCount, forwardToClientWhatsapp, eventKey,
  _resetAlertState, AlertSettingsError, WA_SETTING_KEY, MAX_EVENTS_PER_ORG_PER_RUN,
} from '../src/services/clientWhatsappAlerts.service';
import { _resetPolicyCache } from '../src/services/notificationPolicy';
import { sendWhatsapp } from '../src/services/crm/whatsapp.service';

const supa = () => (global as any).__supa;
const sendMock = sendWhatsapp as jest.Mock;
const CLIENT = '11111111-1111-4111-8111-111111111111';
const TPL = '22222222-2222-4222-8222-222222222222';
const DRAFT = '33333333-3333-4333-8333-333333333333';
const operator = { id: 'u-admin', org_id: 'org-parent', role: 'admin', email: 'ops@kinematicapp.com' };

const call = (handler: any, req: any) => new Promise<{ status: number; body: any }>((resolve, reject) => {
  let status = 200;
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: unknown) => { resolve({ status, body: b }); return res; } };
  handler({ params: { id: CLIENT }, body: {}, query: {}, ...req }, res, (e: unknown) => reject(e));
});

const templates = [
  { id: TPL, meta_template_name: 'kinematic_alert', language: 'en', category: 'UTILITY', status: 'APPROVED', body_text: 'Update: {{1}}. Details: {{2}}.' },
  { id: DRAFT, meta_template_name: 'draft_one', language: 'en', category: 'UTILITY', status: 'PENDING', body_text: 'Hi {{1}}' },
];
const saved = { enabled: true, template_id: TPL, recipients: [{ name: 'Asha', phone: '919811112222' }, { name: 'Ravi', phone: '919833334444' }], kinds: ['sos', 'new_lead'] };

beforeEach(() => {
  supa().reset();
  _resetPolicyCache();
  _resetAlertState();
  sendMock.mockClear();
  process.env.NOTIFICATION_POLICY = 'on';
  process.env.NOTIFICATIONS_DISABLED_PROJECTS = '';
  process.env.CLIENT_WHATSAPP_ALERTS = 'on';
  supa().setDefault('clients', { data: { id: CLIENT, org_id: 'org-client' } });
  supa().setDefault('crm_whatsapp_templates', { data: templates });
  supa().setDefault('crm_whatsapp_connections', { data: { is_active: true, from_phone: '+919220299228', display_name: 'Acme' } });
});

describe('settings input', () => {
  it('normalises Indian 10-digit numbers and rejects junk', () => {
    expect(normalizePhone('98111 12222')).toBe('919811112222');
    expect(normalizePhone('+91-98111-12222')).toBe('919811112222');
    expect(normalizePhone('09811112222')).toBe('919811112222');
    expect(normalizePhone('12345')).toBeNull();
  });

  it('refuses to switch on without a template, a person and an update', () => {
    expect(() => parseSettingsInput({ enabled: true, recipients: [{ phone: '9811112222' }], kinds: ['sos'] })).toThrow(/template/);
    expect(() => parseSettingsInput({ enabled: true, template_id: TPL, kinds: ['sos'] })).toThrow(/at least one person/);
    expect(() => parseSettingsInput({ enabled: true, template_id: TPL, recipients: [{ phone: '9811112222' }] })).toThrow(/at least one update, or the daily summary/);
    // Switched off, an incomplete setup can still be saved as a draft.
    expect(parseSettingsInput({ enabled: false, recipients: [{ phone: '9811112222' }] }).recipients).toEqual([{ name: '', phone: '919811112222' }]);
  });

  it('rejects updates that are not offered on WhatsApp and bad numbers, de-duplicates people', () => {
    expect(() => parseSettingsInput({ kinds: ['lead_assigned'] })).toThrow(AlertSettingsError);
    expect(() => parseSettingsInput({ recipients: [{ phone: 'abc' }] })).toThrow(/not a valid WhatsApp number/);
    const s = parseSettingsInput({ recipients: [{ name: 'A', phone: '9811112222' }, { name: 'B', phone: '+91 98111 12222' }] });
    expect(s.recipients).toHaveLength(1);
  });

  it('maps an alert onto the template placeholders, flattening new lines', () => {
    expect(placeholderCount('Hi {{1}}, see {{2}} and {{ 3 }}')).toBe(3);
    expect(templateVariables(2, 'SOS raised', 'Ravi raised an SOS\nnear Andheri')).toEqual({ '1': 'SOS raised', '2': 'Ravi raised an SOS near Andheri' });
    expect(templateVariables(1, 'New lead', 'Acme Ltd')).toEqual({ '1': 'New lead: Acme Ltd' });
    expect(templateVariables(3, 'T', 'B')).toEqual({ '1': 'T', '2': 'B', '3': '-' });
    expect(templateVariables(0, 'T', 'B')).toEqual({});
  });
});

describe('GET /clients/:id/whatsapp-alerts', () => {
  it('reads from the client\'s org and offers only approved templates', async () => {
    supa().setDefault('org_settings', (chain: any) => (chain.eqs.key === WA_SETTING_KEY ? { data: { value: saved } } : { data: { value: ['sos'] } }));
    const { status, body } = await call(getClientWhatsappAlerts, { user: operator });
    expect(status).toBe(200);
    expect(body.data.enabled).toBe(true);
    expect(body.data.recipients).toHaveLength(2);
    expect(body.data.templates.map((t: any) => t.id)).toEqual([TPL]);
    expect(body.data.templates[0].placeholders).toBe(2);
    expect(body.data.connection).toMatchObject({ configured: true, active: true });
    const sos = body.data.catalog.find((c: any) => c.kind === 'sos');
    expect(sos).toMatchObject({ enabled: true, in_app_enabled: true });
    expect(body.data.catalog.find((c: any) => c.kind === 'new_lead')).toMatchObject({ enabled: true, in_app_enabled: false });
    const waRead = supa().chainsFor('org_settings').find((c: any) => c.eqs.key === WA_SETTING_KEY);
    expect(waRead.eqs).toMatchObject({ org_id: 'org-client' });
    expect(supa().chainsFor('clients')[0].eqs).toMatchObject({ id: CLIENT, owner_org_id: 'org-parent' });
  });

  it('starts switched off with nobody and nothing chosen', async () => {
    supa().setDefault('org_settings', { data: null });
    const { body } = await call(getClientWhatsappAlerts, { user: operator });
    expect(body.data).toMatchObject({ enabled: false, template_id: null, recipients: [], kinds: [] });
    expect(body.data.suggested_template.category).toBe('UTILITY');
  });
});

describe('PUT /clients/:id/whatsapp-alerts', () => {
  it('stores normalised settings on the client\'s org', async () => {
    supa().setDefault('org_settings', { data: null });
    const { status } = await call(setClientWhatsappAlerts, {
      user: operator,
      body: { enabled: true, template_id: TPL, recipients: [{ name: ' Asha ', phone: '98111 12222' }], kinds: ['sos', 'leave_request'] },
    });
    expect(status).toBe(200);
    const ins = supa().chainsFor('org_settings').find((c: any) => c.ops.some((o: any) => o.method === 'insert'));
    expect(ins.ops.find((o: any) => o.method === 'insert').args[0]).toEqual({
      org_id: 'org-client', key: WA_SETTING_KEY, updated_by: 'u-admin',
      value: { enabled: true, template_id: TPL, recipients: [{ name: 'Asha', phone: '919811112222' }], kinds: ['sos', 'leave_request'], daily_summary: false, voice_leads: false },
    });
  });

  it('400s on a template that is not approved, and writes nothing', async () => {
    const { status, body } = await call(setClientWhatsappAlerts, { user: operator, body: { enabled: false, template_id: DRAFT } });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/not approved/);
    expect(supa().chainsFor('org_settings').some((c: any) => c.ops.some((o: any) => o.method === 'insert'))).toBe(false);
  });

  it('400s with a clear message when switching on half set up', async () => {
    const { status, body } = await call(setClientWhatsappAlerts, { user: operator, body: { enabled: true, kinds: ['sos'] } });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/Choose an approved WhatsApp template/);
  });
});

describe('POST /clients/:id/whatsapp-alerts/test', () => {
  it('sends the saved template to every saved person', async () => {
    supa().setDefault('org_settings', { data: { value: saved } });
    const { status, body } = await call(testClientWhatsappAlerts, { user: operator });
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ sent: 2, failed: 0 });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ org_id: 'org-client', to: '919811112222', template_id: TPL, template_variables: { '1': 'Test alert' } });
  });

  it('400s when nothing has been saved yet', async () => {
    supa().setDefault('org_settings', { data: null });
    expect((await call(testClientWhatsappAlerts, { user: operator })).status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('forwardToClientWhatsapp (push dispatcher hook)', () => {
  const rows = (n: number, extra: Partial<{ kind: string; orgId: string; data: unknown }> = {}) =>
    Array.from({ length: n }, () => ({ orgId: 'org-client', kind: 'sos', title: 'SOS raised', body: 'Ravi needs help', data: { sos_id: 's1' }, ...extra }));

  it('sends one message per event per person, even when the event made a row per manager', async () => {
    supa().setDefault('org_settings', { data: [{ org_id: 'org-client', value: saved }] });
    const attempted = await forwardToClientWhatsapp(rows(4));
    expect(attempted).toBe(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls.map((c) => c[0].to).sort()).toEqual(['919811112222', '919833334444']);
    expect(sendMock.mock.calls[0][0].template_variables).toEqual({ '1': 'SOS raised', '2': 'Ravi needs help' });
    // The same event seen again on the next run is not re-sent.
    await forwardToClientWhatsapp(rows(1));
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('sends only the chosen updates, only when switched on', async () => {
    supa().setDefault('org_settings', { data: [{ org_id: 'org-client', value: saved }] });
    expect(await forwardToClientWhatsapp(rows(1, { kind: 'leave_request', data: { leave_id: 'l1' } }))).toBe(0);
    _resetAlertState();
    supa().setDefault('org_settings', { data: [{ org_id: 'org-client', value: { ...saved, enabled: false } }] });
    expect(await forwardToClientWhatsapp(rows(1))).toBe(0);
    _resetAlertState();
    supa().setDefault('org_settings', { data: [] });
    expect(await forwardToClientWhatsapp(rows(1))).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('caps how many events one client gets from one run', async () => {
    supa().setDefault('org_settings', { data: [{ org_id: 'org-client', value: { ...saved, recipients: [saved.recipients[0]] } }] });
    const many = Array.from({ length: 25 }, (_, i) => ({ orgId: 'org-client', kind: 'sos', title: 'SOS', body: `#${i}`, data: { sos_id: `s${i}` } }));
    expect(await forwardToClientWhatsapp(many)).toBe(MAX_EVENTS_PER_ORG_PER_RUN);
  });

  it('sends nothing for a project with notifications switched off (Tata by default)', async () => {
    process.env.NOTIFICATIONS_DISABLED_PROJECTS = 'default';
    supa().setDefault('org_settings', { data: [{ org_id: 'org-client', value: saved }] });
    expect(await forwardToClientWhatsapp(rows(1))).toBe(0);
    expect(supa().chainsFor('org_settings')).toHaveLength(0);
  });

  it('collapses copies of one event by its record id, else by its text', () => {
    const a = eventKey({ orgId: 'o', kind: 'new_lead', title: 'New lead', body: 'x', data: { lead_id: 'L1' } });
    const b = eventKey({ orgId: 'o', kind: 'new_lead', title: 'New lead for Asha', body: 'y', data: { lead_id: 'L1' } });
    expect(a).toBe(b);
    expect(eventKey({ orgId: 'o', kind: 'low_stock', title: 'Low', body: 'SKU A' })).not.toBe(eventKey({ orgId: 'o', kind: 'low_stock', title: 'Low', body: 'SKU B' }));
  });
});
