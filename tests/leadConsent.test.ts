/**
 * The "Data Collection & Consent" block on the lead / contact create forms is the built-in field override
 * `lead.data_consent` (plus `@b2b` / `@b2c`). Hiding it is pure presentation:
 *
 *   - override keys are free-form, so `data_consent` needs no whitelist entry;
 *   - a client that has NOT required consent can create without `_consent` (hidden or not);
 *   - a client with consent.lead_pii.required keeps being enforced even when the block is hidden —
 *     keeping those two settings consistent is the admin's job.
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: '33333333-3333-3333-3333-333333333333', org_id: '00000000-0000-0000-0000-0000000000aa', role: 'admin', client_id: '55555555-5555-5555-5555-555555555555', org_role_data_scope: 'all' };
    next();
  },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requireModule: () => (_req: any, _res: any, next: any) => next(),
  requireModuleAccess: () => (_req: any, _res: any, next: any) => next(),
  requireAnyModuleAccess: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/utils/demoCrm', () => ({ demoCrmMiddleware: (_req: any, _res: any, next: any) => next() }));
jest.mock('../src/services/crm/leads.service', () => ({
  ...jest.requireActual('../src/services/crm/leads.service'),
  createLead: jest.fn(),
}));
jest.mock('../src/services/crm/consent.service', () => ({
  ...jest.requireActual('../src/services/crm/consent.service'),
  recordConsent: jest.fn().mockResolvedValue({}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as v from '../src/validators/crm.validators';
import * as leadsSvc from '../src/services/crm/leads.service';
import * as consentSvc from '../src/services/crm/consent.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const createLead = leadsSvc.createLead as unknown as jest.Mock;
const recordConsent = consentSvc.recordConsent as unknown as jest.Mock;

const HIDDEN = {
  'lead.data_consent': { hidden: true },
  'lead.data_consent@b2b': { hidden: true, required: false },
  'lead.data_consent@b2c': { hidden: true, required: false },
};

describe('settings: the data_consent override key', () => {
  const ok = (field_overrides: unknown) => v.settingsUpdateSchema.safeParse({ config: { field_overrides } });
  it('is accepted on its own and scoped (override keys are free-form: no whitelist to extend)', () => {
    expect(ok(HIDDEN).success).toBe(true);
    expect(ok({ 'lead.data_consent@b2b': { label: 'Consent', required: true } }).success).toBe(true);
    expect(ok({ 'lead.something_new@b2c': { hidden: true } }).success).toBe(true);
  });
  it('can sit next to a consent config and a lead_form without disturbing either', () => {
    expect(v.settingsUpdateSchema.safeParse({ config: {
      field_overrides: HIDDEN, consent: { lead_pii: { required: false } }, lead_form: { segment_labels: { b2b: 'Dealer' } },
    } }).success).toBe(true);
  });
});

describe('lead create: _consent is optional on the wire', () => {
  const lead = { first_name: 'Ramesh', phone: '9876543210' };
  it('accepts a lead with no consent block, and with one', () => {
    expect(v.leadCreateSchema.safeParse(lead).success).toBe(true);
    expect(v.leadCreateSchema.safeParse({ ...lead, _consent: { consented: true } }).success).toBe(true);
  });
  it('accepts a contact with no consent block', () => {
    expect(v.contactSchema.safeParse({ first_name: 'Ramesh' }).success).toBe(true);
  });
});

describe('POST /crm/leads and /crm/contacts', () => {
  const app = express();
  app.use(express.json());
  app.use('/crm', crmRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message, code: err.code }));

  let config: Record<string, unknown> = {};
  beforeEach(() => {
    __mock.reset();
    createLead.mockReset(); recordConsent.mockClear();
    createLead.mockResolvedValue({ id: 'lead-1', first_name: 'Ramesh', phone: '9876543210' });
    __mock.setDefault('crm_settings', () => ({ data: [{ config }] }));
    config = {};
  });
  const body = { first_name: 'Ramesh', phone: '9876543210', is_b2c: false };
  const create = (extra: object = {}) => request(app).post('/crm/leads').send({ ...body, ...extra });

  it('a client that has not required consent can create without _consent, whether the block is hidden or not', async () => {
    for (const cfg of [{}, { field_overrides: HIDDEN }, { consent: { lead_pii: { required: false } }, field_overrides: HIDDEN }, { consent: {} }]) {
      config = cfg; createLead.mockClear();
      const res = await create();
      expect({ cfg, status: res.status }).toEqual({ cfg, status: 201 });
      expect(createLead).toHaveBeenCalledTimes(1);
    }
    expect(recordConsent).not.toHaveBeenCalled();            // nothing was captured, nothing to record
  });

  it('with the block hidden, a create from a stale build that still sends _consent is recorded as before', async () => {
    config = { field_overrides: HIDDEN };
    const res = await create({ _consent: { consented: true, method: 'in_app' } });
    expect(res.status).toBe(201);
    expect(recordConsent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ subjectType: 'lead', subjectId: 'lead-1', purpose: 'lead_pii', consented: true }));
  });

  it('a client that REQUIRES consent is still enforced when the block is hidden', async () => {
    config = { field_overrides: HIDDEN, consent: { lead_pii: { required: true } } };
    const refused = await create();
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('CONSENT_REQUIRED');
    expect(createLead).not.toHaveBeenCalled();

    const declined = await create({ _consent: { consented: false } });
    expect(declined.status).toBe(400);
    expect(createLead).not.toHaveBeenCalled();

    const given = await create({ _consent: { consented: true } });
    expect(given.status).toBe(201);
    expect(createLead).toHaveBeenCalledTimes(1);
  });

  it('a client that requires consent and shows the block is enforced the same way', async () => {
    config = { consent: { lead_pii: { required: true } } };
    expect((await create()).body.error.code).toBe('CONSENT_REQUIRED');
    expect((await create({ _consent: { consented: true } })).status).toBe(201);
  });

  it('contacts have no consent gate: create without _consent works', async () => {
    config = { field_overrides: HIDDEN, consent: { lead_pii: { required: true } } };
    __mock.setDefault('crm_contacts', { data: [{ id: 'c1', first_name: 'Ramesh' }] });
    const res = await request(app).post('/crm/contacts').send({ first_name: 'Ramesh' });
    expect(res.status).toBe(201);
    expect(recordConsent).not.toHaveBeenCalled();
  });
});
