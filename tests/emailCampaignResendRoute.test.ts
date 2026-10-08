/**
 * POST /crm/email-campaigns/:id/resend-failed must be mounted, admin-only and entitlement-gated, and
 * must call the service with the caller's org. Drives the real CRM router over HTTP.
 */
import express from 'express';
import request from 'supertest';

let mockRole = 'admin';
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: '33333333-3333-3333-3333-333333333333', org_id: '00000000-0000-0000-0000-0000000000aa', role: mockRole, client_id: null };
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
let mockEntitled = true;
jest.mock('../src/lib/emailCampaignEntitlement', () => ({
  isEmailCampaignEnabled: jest.fn(async () => mockEntitled),
  EMAIL_CAMPAIGN_DISABLED_MESSAGE: 'Email campaigns are not enabled',
}));
jest.mock('../src/services/crm/emailCampaign.service', () => ({
  ...jest.requireActual('../src/services/crm/emailCampaign.service'),
  resendFailedRecipients: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const resend = (require('../src/services/crm/emailCampaign.service') as { resendFailedRecipients: jest.Mock }).resendFailedRecipients;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppError } = require('../src/utils');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const ID = '44444444-4444-4444-4444-444444444444';
const app = express();
app.use(express.json());
app.use('/crm', crmRouter);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message, code: err.code }));

beforeEach(() => { mockRole = 'admin'; mockEntitled = true; resend.mockReset(); });

describe('POST /crm/email-campaigns/:id/resend-failed', () => {
  it('resends for an admin and returns the re-opened campaign and the count', async () => {
    resend.mockResolvedValue({ campaign: { id: ID, status: 'sending' }, requeued: 3 });
    const res = await request(app).post(`/crm/email-campaigns/${ID}/resend-failed`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { campaign: { id: ID, status: 'sending' }, requeued: 3 } });
    expect(resend).toHaveBeenCalledWith(expect.objectContaining({ orgId: '00000000-0000-0000-0000-0000000000aa' }), ID);
  });

  it('is admin-only', async () => {
    mockRole = 'field_executive';
    const res = await request(app).post(`/crm/email-campaigns/${ID}/resend-failed`).send({});
    expect(res.status).toBe(403);
    expect(resend).not.toHaveBeenCalled();
  });

  it('needs the email-campaign entitlement', async () => {
    mockEntitled = false;
    const res = await request(app).post(`/crm/email-campaigns/${ID}/resend-failed`).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_CAMPAIGN_NOT_ENABLED');
    expect(resend).not.toHaveBeenCalled();
  });

  it('passes the service\'s reason through when there is nothing to resend', async () => {
    resend.mockRejectedValue(new AppError(400, 'There are no failed recipients to resend', 'NO_FAILED_RECIPIENTS'));
    const res = await request(app).post(`/crm/email-campaigns/${ID}/resend-failed`).send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NO_FAILED_RECIPIENTS', message: 'There are no failed recipients to resend' } });
  });
});
