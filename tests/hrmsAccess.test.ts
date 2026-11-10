/**
 * Who may use HRMS: the master admin as themselves. Not another admin, not the master while viewing as someone,
 * not a client that was granted a module. Checked on the middleware and, end to end, on the mounted router (a refused
 * call must not reach the database).
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import { requireHrmsAccess } from '../src/middleware/hrmsAccess';
import hrmsRouter from '../src/routes/hrms.routes';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };

const ORG = '00000000-0000-4000-8000-0000000000aa';
const MASTER = { id: '33333333-3333-4333-8333-333333333333', org_id: ORG, email: 's@kinematicapp.com', name: 'Master', role: 'super_admin' };

function runMiddleware(user: unknown): { status?: number; code?: string; passed: boolean } {
  let out: { status?: number; code?: string; passed: boolean } = { passed: false };
  requireHrmsAccess({ user } as never, {} as never, ((err?: { statusCode?: number; code?: string }) => {
    out = err ? { status: err.statusCode, code: err.code, passed: false } : { passed: true };
  }) as never);
  return out;
}

describe('requireHrmsAccess', () => {
  it('lets the master admin through, whatever the case of the email', () => {
    expect(runMiddleware(MASTER).passed).toBe(true);
    expect(runMiddleware({ ...MASTER, email: 'S@KinematicApp.com' }).passed).toBe(true);
  });

  it('answers 401 with no user', () => {
    expect(runMiddleware(undefined)).toMatchObject({ status: 401, passed: false });
  });

  it('refuses every other account with 403, whatever its role', () => {
    for (const role of ['super_admin', 'admin', 'main_admin', 'client', 'hr']) {
      expect(runMiddleware({ ...MASTER, email: 'someone@example.com', role })).toMatchObject({ status: 403, code: 'FORBIDDEN', passed: false });
    }
  });

  it('refuses a client that was granted modules: there is no sharing for HRMS', () => {
    expect(runMiddleware({ id: 'u', org_id: ORG, email: 'ops@client.com', role: 'admin', client_id: 'c1', enabled_modules: ['finance', 'hrms'] })).toMatchObject({ status: 403 });
  });

  it('refuses the master admin while impersonating a user (Finance would allow it; HRMS must not)', () => {
    // The impersonation overlay swaps in the target's identity and keeps the master's on impersonated_by.
    const viewingAs = { id: 'target', org_id: ORG, email: 'rep@client.com', role: 'admin', impersonated_by: { id: MASTER.id, email: MASTER.email } };
    expect(runMiddleware(viewingAs)).toMatchObject({ status: 403, passed: false });
    // Even if the overlay somehow kept the master's own email, the marker alone is enough.
    expect(runMiddleware({ ...MASTER, impersonated_by: { id: MASTER.id, email: MASTER.email } })).toMatchObject({ status: 403 });
  });

  it('refuses the master admin acting as another organisation through X-Org-Id', () => {
    // maybeImpersonate swaps org_id on a clone and marks it acting_as_org; without the marker HRMS would read that org's people.
    expect(runMiddleware({ ...MASTER, org_id: 'another-org', acting_as_org: true })).toMatchObject({ status: 403, passed: false });
  });
});

describe('the mounted router', () => {
  let user: unknown;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = user; next(); });
  app.use('/hrms', hrmsRouter);

  beforeEach(() => { __mock.reset(); user = MASTER; });

  const ROUTES: Array<[string, string]> = [
    ['get', '/hrms/bootstrap'], ['post', '/hrms/entities'], ['put', '/hrms/entities/11111111-1111-4111-8111-111111111111'],
    ['delete', '/hrms/locations/11111111-1111-4111-8111-111111111111'], ['post', '/hrms/employees'], ['post', '/hrms/employees/import'],
    ['post', '/hrms/employees/11111111-1111-4111-8111-111111111111/reveal'], ['get', '/hrms/access-log'], ['put', '/hrms/settings/employee_code_prefix'],
  ];

  it.each(ROUTES)('%s %s: a non-master admin gets 403 and nothing reaches the database', async (method, path) => {
    user = { ...MASTER, email: 'admin@client.com', role: 'admin' };
    const res = await (request(app) as any)[method](path).send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect(__mock.chains).toHaveLength(0);
  });

  it.each(ROUTES)('%s %s: the master admin viewing as someone gets 403 and nothing reaches the database', async (method, path) => {
    user = { id: 'target', org_id: ORG, email: 'rep@client.com', role: 'admin', impersonated_by: { id: MASTER.id, email: MASTER.email } };
    const res = await (request(app) as any)[method](path).send({});
    expect(res.status).toBe(403);
    expect(__mock.chains).toHaveLength(0);
  });

  it('an unauthenticated request gets 401', async () => {
    user = undefined;
    const res = await request(app).get('/hrms/bootstrap');
    expect(res.status).toBe(401);
    expect(__mock.chains).toHaveLength(0);
  });

  it('the master admin as themselves reaches the handlers, with caching switched off', async () => {
    const res = await request(app).get('/hrms/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(__mock.chains.length).toBeGreaterThan(0);
  });
});
