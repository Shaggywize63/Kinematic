/**
 * /api/v1/distribution/integrations/* hardening (Gomant C2):
 *   - admin-only (requireAdminOrAbove) — a field rep / supervisor can no longer list, read or edit integrations
 *   - agent_secret (a bearer credential for the Tally bridge agent) is returned ONLY by the create response,
 *     never by a read or an update
 *   - the bridge agent keeps authenticating with its OWN key on the public routes (not behind the admin gate)
 */
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

import express from 'express';
import request from 'supertest';
import adminRouter from '../src/routes/distribution/integrations.routes';
import agentRouter from '../src/routes/tally-agent-public.routes';
import { requireAdminOrAbove } from '../src/middleware/auth';
import {
  sanitiseIntegration, listIntegrations, getIntegration, createIntegration, updateIntegration,
} from '../src/controllers/distribution/integrations.controller';

const supa = () => (global as any).__supa;
const ORG = '11111111-1111-4111-8111-111111111111';
const INT = '55555555-5555-4555-8555-555555555555';
const SECRET = 'super-secret-agent-key';

function call(handler: any, req: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(b: any) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    handler(req, res, reject);
  });
}
const adminReq = (o: Record<string, unknown> = {}) => ({ user: { id: 'u1', org_id: ORG, role: 'admin' }, params: {}, query: {}, body: {}, headers: {}, ...o });

const row = () => ({
  id: INT, org_id: ORG, provider: 'tally', label: 'Tally', status: 'active', config: {},
  agent_secret: SECRET, credentials_encrypted: 'cipher', created_at: 'x', updated_at: 'y',
});

beforeEach(() => supa().reset());

describe('admin gate', () => {
  it('requireAdminOrAbove is the first layer on the whole admin router', () => {
    const first = (adminRouter as any).stack[0];
    expect(first.route).toBeUndefined();            // a router-level .use(), not a single route
    expect(first.handle).toBe(requireAdminOrAbove);
  });

  it('blocks non-admin roles with 403 and lets admin roles through', () => {
    const run = (role: string) => {
      const res: any = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
      const next = jest.fn();
      requireAdminOrAbove({ user: { role } } as any, res, next);
      return { status: res.statusCode, nexted: next.mock.calls.length === 1 };
    };
    for (const role of ['field_executive', 'sub_admin', 'supervisor']) expect(run(role)).toEqual({ status: 403, nexted: false });
    for (const role of ['admin', 'main_admin', 'super_admin', 'client']) expect(run(role).nexted).toBe(true);
  });

  it('end to end: a field executive gets 403 on every verb before any controller runs', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.user = { id: 'rep', org_id: ORG, role: 'field_executive' }; next(); });
    app.use('/i', adminRouter);
    for (const [method, path] of [['get', '/i'], ['get', `/i/${INT}`], ['post', '/i'], ['patch', `/i/${INT}`], ['delete', `/i/${INT}`], ['get', `/i/${INT}/events`], ['get', '/i/events/e1/xml']] as const) {
      const r = await (request(app) as any)[method](path).send({});
      expect({ path, status: r.status }).toEqual({ path, status: 403 });
    }
    expect(supa().chains).toHaveLength(0);
  });
});

describe('agent_secret exposure', () => {
  it('sanitiseIntegration strips both secrets', () => {
    const s = sanitiseIntegration(row()) as any;
    expect(s).not.toHaveProperty('agent_secret');
    expect(s).not.toHaveProperty('credentials_encrypted');
    expect(s.id).toBe(INT);
  });

  it('GET list never selects the secret', async () => {
    supa().setDefault('distribution_integrations', { data: [] });
    await call(listIntegrations, adminReq());
    const select = supa().chainsFor('distribution_integrations')[0].ops.find((o: any) => o.method === 'select').args[0];
    expect(select).not.toContain('agent_secret');
  });

  it('GET /:id does not select or return the secret (even if the row somehow carries it)', async () => {
    supa().setDefault('distribution_integrations', { data: row() });
    const r = await call(getIntegration, adminReq({ params: { id: INT } }));
    expect(r.status).toBe(200);
    expect(r.body.data).not.toHaveProperty('agent_secret');
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    const select = supa().chainsFor('distribution_integrations')[0].ops.find((o: any) => o.method === 'select').args[0];
    expect(select).not.toContain('agent_secret');
  });

  it('PATCH /:id (select *) does not return the secret', async () => {
    supa().setDefault('distribution_integrations', { data: row() });
    const r = await call(updateIntegration, adminReq({ params: { id: INT }, body: { label: 'Renamed' } }));
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
  });

  it('POST create returns the secret exactly once, in the create response (top level + agent_config)', async () => {
    supa().setDefault('distribution_integrations', (chain: any) => {
      const ins = chain.ops.find((o: any) => o.method === 'insert');
      return { data: ins ? { id: INT, org_id: ORG, status: 'pending', credentials_encrypted: null, ...ins.args[0] } : null };
    });
    const r = await call(createIntegration, adminReq({ body: { provider: 'tally', label: 'Tally' } }));
    expect(r.status).toBe(201);
    const secret = r.body.data.agent_secret;
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThanOrEqual(24);
    expect(r.body.data.agent_config.agent_secret).toBe(secret);
    expect(r.body.data.agent_config.polling_endpoint).toContain(`key=${secret}`);
    expect(r.body.data).not.toHaveProperty('credentials_encrypted');
  });
});

describe('the bridge agent still authenticates with its own key (public routes, not admin-gated)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/integrations/tally', agentRouter);   // mounted with NO req.user, exactly like app.ts

  it('a wrong key is rejected by the agent check (403 bad agent key), not by the admin gate', async () => {
    supa().setDefault('distribution_integrations', { data: { id: INT, org_id: ORG, provider: 'tally', status: 'active', config: {}, agent_secret: SECRET } });
    const r = await request(app).get(`/api/v1/integrations/tally/jobs/${INT}?key=nope`);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, error: 'bad agent key' });
  });

  it('the right key polls successfully with no JWT / admin role', async () => {
    supa().setDefault('distribution_integrations', { data: { id: INT, org_id: ORG, provider: 'tally', status: 'active', config: {}, agent_secret: SECRET } });
    supa().setDefault('distribution_integration_events', { data: [] });
    const r = await request(app).get(`/api/v1/integrations/tally/jobs/${INT}?key=${SECRET}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, jobs: [], commands: [], company_name: null });   // commands is additive; v1 agents ignore it
  });

  it('result reporting is key-authenticated too', async () => {
    supa().setDefault('distribution_integrations', { data: { id: INT, agent_secret: SECRET } });
    const bad = await request(app).post(`/api/v1/integrations/tally/jobs/${INT}/result?key=nope`).send({ event_id: 'e1', ok: true });
    expect(bad.status).toBe(403);
  });
});

describe('a Tally connection pinned to a company', () => {
  const CO = '22222222-2222-4222-8222-222222222222';
  beforeEach(() => supa().reset());

  it('create refuses a company outside the org, and writes nothing', async () => {
    supa().queue('clients', { data: null, error: null });
    const r = await call(createIntegration, adminReq({ body: { provider: 'tally', label: 'T', config: { client_id: CO } } }));
    expect(r.status).toBe(400);
    expect(supa().chainsFor('clients')[0].eqs).toMatchObject({ id: CO, org_id: ORG });
    expect(supa().chainsFor('distribution_integrations')).toHaveLength(0);
  });
  it('create refuses a malformed company id without a lookup', async () => {
    const r = await call(createIntegration, adminReq({ body: { provider: 'tally', label: 'T', config: { client_id: 'nope' } } }));
    expect(r.status).toBe(400);
    expect(supa().chains).toHaveLength(0);
  });
  it('update refuses a company outside the org', async () => {
    supa().queue('clients', { data: null, error: null });
    const r = await call(updateIntegration, adminReq({ params: { id: INT }, body: { config: { client_id: CO } } }));
    expect(r.status).toBe(400);
    expect(supa().chainsFor('distribution_integrations')).toHaveLength(0);
  });
  it('a config without client_id needs no lookup (existing behaviour)', async () => {
    supa().queue('distribution_integrations', { data: { id: INT }, error: null });
    const r = await call(updateIntegration, adminReq({ params: { id: INT }, body: { config: { company_name: 'X' } } }));
    expect(r.status).toBe(200);
    expect(supa().chainsFor('clients')).toHaveLength(0);
  });
});

describe('a client-pinned admin cannot pin a connection to another client', () => {
  const OWN = '22222222-2222-4222-8222-222222222222';
  const OTHER = '55555555-5555-4555-8555-555555555555';
  const scoped = (config: any, extra: any = {}) => adminReq({ user: { id: 'u1', org_id: ORG, role: 'admin', client_id: OWN }, body: { provider: 'tally', label: 'T', config }, ...extra });
  beforeEach(() => supa().reset());

  it('create refuses another client without even looking it up', async () => {
    const r = await call(createIntegration, scoped({ client_id: OTHER }));
    expect(r.status).toBe(400);
    expect(supa().chains).toHaveLength(0);
  });
  it('update refuses another client too', async () => {
    const r = await call(updateIntegration, scoped({ client_id: OTHER }, { params: { id: INT } }));
    expect(r.status).toBe(400);
    expect(supa().chains).toHaveLength(0);
  });
});

describe('a client-pinned admin only sees their own Tally connections', () => {
  const OWN = '22222222-2222-4222-8222-222222222222';
  const scopedUser = { id: 'u1', org_id: ORG, role: 'admin', client_id: OWN };
  const sreq = (o: any = {}) => adminReq({ user: scopedUser, ...o });
  const inOp = (c: any) => c.ops.find((o: any) => o.method === 'in');
  beforeEach(() => supa().reset());

  it('list is filtered to connections pinned to their company', async () => {
    await call(listIntegrations, sreq());
    expect(inOp(supa().chainsFor('distribution_integrations')[0]).args).toEqual(['config->>client_id', [OWN]]);
  });
  it('an org-wide admin is not filtered', async () => {
    await call(listIntegrations, adminReq());
    expect(inOp(supa().chainsFor('distribution_integrations')[0])).toBeUndefined();
  });
  it('get is filtered to their company and returns nothing for someone else\'s connection', async () => {
    const g = await call(getIntegration, sreq({ params: { id: INT } }));
    expect(g.status).not.toBe(200);   // (the mock's maybeSingle errors on no rows; the real one gives 404)
    expect(g.body.data).toBeUndefined();
    expect(inOp(supa().chainsFor('distribution_integrations')[0]).args[1]).toEqual([OWN]);
  });
  it('delete and the event log check visibility first and touch nothing otherwise', async () => {
    const { deleteIntegration, listIntegrationEvents } = require('../src/controllers/distribution/integrations.controller');
    expect((await call(deleteIntegration, sreq({ params: { id: INT } }))).status).toBe(404);
    expect((await call(listIntegrationEvents, sreq({ params: { id: INT } }))).status).toBe(404);
    expect(supa().chainsFor('distribution_integrations').every((c: any) => !c.ops.some((o: any) => o.method === 'delete'))).toBe(true);
    expect(supa().chainsFor('distribution_integration_events')).toHaveLength(0);
  });
  it('a connection they create is pinned to their company automatically', async () => {
    supa().queue('clients', { data: { id: OWN }, error: null });
    supa().queue('distribution_integrations', { data: { id: INT, config: {} }, error: null });
    await call(createIntegration, sreq({ body: { provider: 'tally', label: 'T' } }));
    const ins = supa().chainsFor('distribution_integrations').flatMap((c: any) => c.ops.filter((o: any) => o.method === 'insert'))[0];
    expect(ins.args[0].config.client_id).toBe(OWN);
  });
});
