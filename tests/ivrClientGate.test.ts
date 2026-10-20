jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { assertIvrEnabledForLead } from '../src/services/crm/telephony.service';

const supa = () => (global as any).__supa;
const LEAD = '22222222-2222-4222-8222-222222222222';
const CLIENT_ON = '33333333-3333-4333-8333-333333333333';
const CLIENT_OFF = '44444444-4444-4444-8444-444444444444';

/** client_modules rows by client. */
const grants = (byClient: Record<string, Array<{ module_id: string; expires_at?: string | null }>>) =>
  supa().setDefault('client_modules', (chain: any) => ({ data: byClient[chain.eqs.client_id] ?? [] }));

beforeEach(() => supa().reset());

describe('IVR is a per-client switch', () => {
  it('allows a lead whose client holds ivr_call', async () => {
    supa().setDefault('crm_leads', { data: { client_id: CLIENT_ON } });
    grants({ [CLIENT_ON]: [{ module_id: 'ivr_call' }] });
    await expect(assertIvrEnabledForLead({ org_id: 'o1', lead_id: LEAD })).resolves.toBeUndefined();
  });

  it('refuses a lead whose client has not been given ivr_call, even for a platform caller', async () => {
    supa().setDefault('crm_leads', { data: { client_id: CLIENT_OFF } });
    grants({ [CLIENT_OFF]: [{ module_id: 'crm_leads' }] });
    await expect(assertIvrEnabledForLead({ org_id: 'o1', lead_id: LEAD, caller_client_id: CLIENT_ON }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses an expired grant', async () => {
    supa().setDefault('crm_leads', { data: { client_id: CLIENT_ON } });
    grants({ [CLIENT_ON]: [{ module_id: 'ivr_call', expires_at: '2020-01-01T00:00:00Z' }] });
    // clientGrantedModuleIds filters on enabled in SQL and on expiry in code
    await expect(assertIvrEnabledForLead({ org_id: 'o1', lead_id: LEAD })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('falls back to the caller\'s client when the lead has none', async () => {
    supa().setDefault('crm_leads', { data: { client_id: null } });
    grants({ [CLIENT_OFF]: [] });
    await expect(assertIvrEnabledForLead({ org_id: 'o1', lead_id: LEAD, caller_client_id: CLIENT_OFF }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('leaves a platform-level lead (no client anywhere) to the caller\'s own entitlement check', async () => {
    supa().setDefault('crm_leads', { data: { client_id: null } });
    await expect(assertIvrEnabledForLead({ org_id: 'o1', lead_id: LEAD })).resolves.toBeUndefined();
    expect(supa().chainsFor('client_modules')).toHaveLength(0);
  });

  it('reads the lead within the caller\'s org only', async () => {
    supa().setDefault('crm_leads', { data: { client_id: null } });
    await assertIvrEnabledForLead({ org_id: 'o1', lead_id: LEAD });
    expect(supa().chainsFor('crm_leads')[0].eqs).toMatchObject({ id: LEAD, org_id: 'o1' });
  });
});
