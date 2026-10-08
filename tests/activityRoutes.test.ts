/**
 * The LIVE /crm/activities and /crm/tasks handlers must run the tenant's activity automations.
 * (They used to not: the code that fired them lived in an unmounted controller.) This drives the real
 * router over HTTP with the automation engine stubbed, so the wiring itself is what's under test.
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/crm/automations.service', () => ({
  ...jest.requireActual('../src/services/crm/automations.service'),
  fireForTrigger: jest.fn().mockResolvedValue({ fired: 0, matched: 0 }),
}));
// Authenticated as an org admin; module gates open.
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: '33333333-3333-3333-3333-333333333333', org_id: '00000000-0000-0000-0000-0000000000aa', role: 'admin', client_id: null };
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fire = (require('../src/services/crm/automations.service') as { fireForTrigger: jest.Mock }).fireForTrigger;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const LEAD = '11111111-1111-1111-1111-111111111111';
const ACT = '44444444-4444-4444-4444-444444444444';
const base = { id: ACT, org_id: '00000000-0000-0000-0000-0000000000aa', type: 'call', subject: 'Call Asha', lead_id: LEAD, client_id: null, owner_id: '33333333-3333-3333-3333-333333333333' };

const app = express();
app.use(express.json());
app.use('/crm', crmRouter);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message }));

/** crm_activities answers by operation: insert -> the created row, update -> the updated row, select -> the existing row. */
function stubActivities(existing: Record<string, unknown> | null, after: Record<string, unknown>) {
  __mock.setDefault('crm_activities', (chain) => {
    const m = chain.ops.map((o) => o.method);
    if (m.includes('insert')) return { data: after };
    if (m.includes('update')) return { data: after };
    return { data: existing };
  });
}

const triggers = () => fire.mock.calls.map((c) => c[0]);
/** The handlers fire without being awaited: let the microtask queue drain before asserting. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  __mock.reset();
  fire.mockClear();
  __mock.setDefault('crm_leads', { data: { id: LEAD, first_name: 'Asha', phone: '9876543210', owner_id: 'owner-1', client_id: null } });
  __mock.setDefault('users', { data: [] });
});

describe('POST /crm/activities', () => {
  it('fires activity_created', async () => {
    stubActivities(null, { ...base, status: 'planned', completed_at: null });
    const res = await request(app).post('/crm/activities').send({ type: 'call', subject: 'Call Asha', lead_id: LEAD, status: 'planned' });
    expect(res.status).toBe(201);
    await settle();
    expect(triggers()).toEqual(['activity_created']);
    expect(fire.mock.calls[0][1]).toMatchObject({ entity: 'lead', entity_id: LEAD });
    expect(fire.mock.calls[0][1].data.lead).toMatchObject({ phone: '9876543210' });
  });

  it('fires created and completed for an activity logged already completed', async () => {
    stubActivities(null, { ...base, status: 'completed', completed_at: '2026-10-08T10:00:00.000Z' });
    const res = await request(app).post('/crm/activities').send({ type: 'call', subject: 'Call Asha', lead_id: LEAD, status: 'completed', completed_at: '2026-10-08T10:00:00.000Z' });
    expect(res.status).toBe(201);
    await settle();
    expect(triggers()).toEqual(['activity_created', 'activity_completed']);
  });
});

describe('PATCH /crm/activities/:id', () => {
  it('fires activity_completed when the patch completes it', async () => {
    stubActivities({ ...base, status: 'planned', completed_at: null }, { ...base, status: 'completed', completed_at: '2026-10-08T10:00:00.000Z' });
    const res = await request(app).patch(`/crm/activities/${ACT}`).send({ status: 'completed', completed_at: '2026-10-08T10:00:00.000Z' });
    expect(res.status).toBe(200);
    await settle();
    expect(triggers()).toEqual(['activity_completed']);
  });

  it('does not fire again when an already-completed activity is edited', async () => {
    const done = { ...base, status: 'completed', completed_at: '2026-10-08T10:00:00.000Z' };
    stubActivities(done, { ...done, subject: 'edited' });
    const res = await request(app).patch(`/crm/activities/${ACT}`).send({ subject: 'edited' });
    expect(res.status).toBe(200);
    await settle();
    expect(fire).not.toHaveBeenCalled();
  });

  it('does not fire when it is reopened', async () => {
    stubActivities({ ...base, status: 'completed', completed_at: '2026-10-08T10:00:00.000Z' }, { ...base, status: 'open', completed_at: null });
    const res = await request(app).patch(`/crm/activities/${ACT}`).send({ status: 'open', completed_at: null });
    expect(res.status).toBe(200);
    await settle();
    expect(fire).not.toHaveBeenCalled();
  });

  it('a failing automation engine does not fail the update', async () => {
    fire.mockRejectedValueOnce(new Error('engine down'));
    stubActivities({ ...base, status: 'planned', completed_at: null }, { ...base, status: 'completed', completed_at: '2026-10-08T10:00:00.000Z' });
    const res = await request(app).patch(`/crm/activities/${ACT}`).send({ status: 'completed', completed_at: '2026-10-08T10:00:00.000Z' });
    expect(res.status).toBe(200);
  });
});

describe('/crm/tasks (tasks are activities of type "task")', () => {
  it('POST fires activity_created', async () => {
    stubActivities(null, { ...base, type: 'task', status: 'open', completed_at: null });
    const res = await request(app).post('/crm/tasks').send({ subject: 'Send brochure', lead_id: LEAD });
    expect(res.status).toBe(201);
    await settle();
    expect(triggers()).toEqual(['activity_created']);
  });

  it('PATCH marking it done fires activity_completed', async () => {
    stubActivities({ ...base, type: 'task', status: 'open', completed_at: null }, { ...base, type: 'task', status: 'done', completed_at: '2026-10-08T10:00:00.000Z' });
    const res = await request(app).patch(`/crm/tasks/${ACT}`).send({ status: 'done' });
    expect(res.status).toBe(200);
    await settle();
    expect(triggers()).toEqual(['activity_completed']);
  });
});
