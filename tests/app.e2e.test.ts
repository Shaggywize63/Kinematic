/**
 * Full-stack HTTP E2E tests for the CRM API.
 *
 * These drive the *real* Express app end-to-end with supertest — every request
 * traverses the actual middleware stack: requireAuth → requireModule('crm') →
 * the success-envelope wrapper → the demo fixture middleware. We authenticate
 * with the demo-token bypass (`NODE_ENV=test` enables it), which exercises the
 * whole routing + auth + response-shaping pipeline without a live Supabase.
 *
 * What this proves:
 *   - Auth is enforced (401 without a Bearer token).
 *   - The CRM module gate + routing resolve real endpoints.
 *   - Responses are wrapped in the `{ success, data }` envelope every client
 *     depends on, with pagination where the route provides it.
 *   - Reads return data and writes short-circuit to success-shaped responses.
 */
import request from 'supertest';

// The demo-token path serves fixtures without a database, but the global
// `auditAll` middleware fires on every mutation and lazily constructs the real
// Supabase client (which throws on Node < 22 because realtime-js needs a native
// WebSocket). E2E must never dial a real client — stub the single seam so the
// suite is environment-independent.
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
import app from '../src/app';

const DEMO = 'demo-token-jwt-placeholder';
const bearer = (t = DEMO) => ({ Authorization: `Bearer ${t}` });

describe('health + auth gating', () => {
  it('GET /health is public and reports ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('rejects an unauthenticated CRM request with 401', async () => {
    const res = await request(app).get('/api/v1/crm/leads');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects a malformed Authorization header with 401', async () => {
    const res = await request(app).get('/api/v1/crm/leads').set('Authorization', 'Token abc');
    expect(res.status).toBe(401);
  });
});

describe('CRM reads (demo tenant fixtures)', () => {
  it('lists leads inside the success envelope', async () => {
    const res = await request(app).get('/api/v1/crm/leads').set(bearer());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // demo middleware returns { data: rows, total, ... }; the envelope wraps it.
    const rows = res.body.data.data ?? res.body.data;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('first_name');
    expect(rows[0]).toHaveProperty('status');
  });

  it.each([
    ['deals', 'name'],
    ['accounts', 'name'],
    ['contacts', 'first_name'],
    ['activities', 'type'],
  ])('lists %s with populated fixture rows', async (resource, field) => {
    const res = await request(app).get(`/api/v1/crm/${resource}`).set(bearer());
    expect(res.status).toBe(200);
    const rows = res.body.data.data ?? res.body.data;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]).toHaveProperty(field);
  });

  it('returns pipelines with nested stages', async () => {
    const res = await request(app).get('/api/v1/crm/pipelines').set(bearer());
    expect(res.status).toBe(200);
    const pipelines = res.body.data;
    expect(Array.isArray(pipelines)).toBe(true);
    expect(pipelines[0]).toHaveProperty('stages');
  });

  it('exposes CRM settings with the field_overrides contract shape', async () => {
    const res = await request(app).get('/api/v1/crm/settings').set(bearer());
    expect(res.status).toBe(200);
    const settings = res.body.data;
    expect(settings.business_type).toBeDefined();
    expect(settings.config).toHaveProperty('field_overrides');
    // field_overrides is keyed by entity -> field -> { label, required, visible }
    expect(settings.config.field_overrides.lead).toBeDefined();
  });

  it('fetches a single lead by id', async () => {
    const res = await request(app).get('/api/v1/crm/leads/demo-lead-1').set(bearer());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('id');
  });
});

describe('CRM writes (demo no-op semantics)', () => {
  it('POST /leads returns a 201 success envelope', async () => {
    const res = await request(app)
      .post('/api/v1/crm/leads')
      .set(bearer())
      .send({ first_name: 'Test', last_name: 'Lead', phone: '9876543210' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('POST /leads/:id/won returns a lead-shaped body', async () => {
    const res = await request(app)
      .post('/api/v1/crm/leads/demo-lead-1/won')
      .set(bearer())
      .send({ reason: 'signed' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('status');
  });

  it('DELETE /leads/:id returns 204', async () => {
    const res = await request(app).delete('/api/v1/crm/leads/demo-lead-1').set(bearer());
    expect(res.status).toBe(204);
  });
});
