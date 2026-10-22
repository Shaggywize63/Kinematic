/**
 * Regression for the Form Builder form-level PATCH (`PATCH /builder/forms/:id`).
 *
 * The bug: the handler guarded the :id (a FORM id) by looking it up in
 * builder_questions via assertChildReachable, so it NEVER matched and every
 * form save / publish answered 404 ("Could not change the form status: Not
 * found"). The fix guards the form itself with assertFormReachable. These tests
 * pin that a form in the caller's org updates, and a form in another org 404s.
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
  requireAuth: (req: any, _res: any, next: any) => { req.user = { ...(global as any).__testUser }; next(); },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const builderRouter = require('../src/routes/builder.routes').default as express.Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../src/middleware/errorHandler') as { errorHandler: express.ErrorRequestHandler };

const ORG = '00000000-0000-0000-0000-0000000000aa';
const OTHER_ORG = '00000000-0000-0000-0000-0000000000bb';
const FORM = '5ce0ad15-6485-450f-afc0-3f3b0e88f10e';

const app = express();
app.use(express.json());
app.use('/builder', builderRouter);
app.use(errorHandler);

beforeEach(() => {
  __mock.reset();
  (global as any).__testUser = { id: 'u1', org_id: ORG, role: 'admin', email: 'admin@tenant.test' };
});

describe('PATCH /builder/forms/:id', () => {
  it('publishes a form in the caller org (regression: no false 404 from a question lookup)', async () => {
    // 1) assertFormReachable: builder_forms lookup → same org.
    __mock.queue('builder_forms', { data: { org_id: ORG } });
    // 2) the update itself.
    __mock.queue('builder_forms', { data: { id: FORM, status: 'published', org_id: ORG } });

    const res = await request(app).patch(`/builder/forms/${FORM}`).send({ status: 'published' });
    expect(res.status).toBe(200);
    expect(res.body?.data?.status).toBe('published');

    // The reachability lookup must hit builder_forms, never builder_questions.
    expect(__mock.chainsFor('builder_questions')).toHaveLength(0);
    expect(__mock.chainsFor('builder_forms').length).toBeGreaterThanOrEqual(2);
  });

  it('404s a form that belongs to another org', async () => {
    __mock.queue('builder_forms', { data: { org_id: OTHER_ORG } });
    const res = await request(app).patch(`/builder/forms/${FORM}`).send({ status: 'published' });
    expect(res.status).toBe(404);
  });

  it('404s a form that does not exist', async () => {
    __mock.queue('builder_forms', { data: null });
    const res = await request(app).patch(`/builder/forms/${FORM}`).send({ status: 'draft' });
    expect(res.status).toBe(404);
  });
});
