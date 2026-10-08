/**
 * Express matches routes in registration order, so a literal GET such as `/export-area-leads-report`
 * registered AFTER `GET /:id` is handed to the by-id handler as an id and answers 404 — which is exactly
 * how the Area-wise Leads report broke for Rajkamal ("HTTP 404" on Run Report). Nothing failed to compile
 * and the route existed, so only a request through the real router (or this ordering check) can catch it.
 *
 * 1. Structural: no CRM sub-router registers a single-segment literal route after a `/:param` route
 *    with the same method. This covers every current and future report/export route at once.
 * 2. Behavioural: every report endpoint the dashboard's Reports page calls resolves to its own handler
 *    (200 + the table shape the page renders), not to the by-id lookup.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => {
    // CRM Admin: the SRS-format reports are role-gated (ASO / CRM Admin / Consumer Champion Manager).
    req.user = { id: '33333333-3333-3333-3333-333333333333', org_id: '00000000-0000-0000-0000-0000000000aa', role: 'admin', client_id: null, org_role_name: 'CRM Admin', org_role_data_scope: 'all' };
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
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

interface RouteLayer { path: string; methods: string[] }
interface RouterLike { stack: any[] }

/** Every router reachable from `root`, each with its own routes in registration order. */
function collectRouters(root: RouterLike, trail = 'crm', out: Array<{ trail: string; routes: RouteLayer[] }> = []) {
  const routes: RouteLayer[] = [];
  const children: Array<{ trail: string; router: RouterLike }> = [];
  for (const layer of root.stack) {
    if (layer.route) {
      routes.push({ path: String(layer.route.path), methods: Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]) });
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      children.push({ trail: `${trail}${layer.regexp?.fast_slash ? '' : `>${String(layer.regexp).slice(0, 40)}`}`, router: layer.handle });
    }
  }
  out.push({ trail, routes });
  children.forEach((c, i) => collectRouters(c.router, `${c.trail}#${i}`, out));
  return out;
}

describe('route registration order', () => {
  it('has no literal single-segment route registered after a /:param route of the same method', () => {
    const offenders: string[] = [];
    const routers = collectRouters(crmRouter as unknown as RouterLike);
    expect(routers.length).toBeGreaterThan(5); // we did walk into the mounted sub-routers
    for (const { trail, routes } of routers) {
      const firstParam = new Map<string, string>(); // method -> the /:param path seen first
      for (const r of routes) {
        for (const method of r.methods) {
          if (/^\/:\w+$/.test(r.path)) {
            if (!firstParam.has(method)) firstParam.set(method, r.path);
          } else if (/^\/[A-Za-z0-9_-]+$/.test(r.path) && firstParam.has(method)) {
            offenders.push(`${method.toUpperCase()} ${r.path} is registered after ${method.toUpperCase()} ${firstParam.get(method)} (${trail}) and can never be reached`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the Reports page endpoints', () => {
  const app = express();
  app.use(express.json());
  app.use('/crm', crmRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message }));

  // The exact paths kinematic-dashboard's ReportRunner calls (src/app/dashboard/crm/reports/*/page.tsx).
  const endpoints = [
    '/crm/leads/export-srs-report',
    '/crm/leads/export-test-report',
    '/crm/leads/export-area-leads-report',
    '/crm/activities/export-activity-report',
    '/crm/activities/export-daywise-report',
    '/crm/activities/export-field-visits-report',
  ];

  it.each(endpoints)('%s answers with its own table (not a 404 from the by-id route)', async (path) => {
    const res = await request(app).get(path).query({ format: 'json', from: '2026-10-01', to: '2026-10-08' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.columns)).toBe(true);
    expect(Array.isArray(res.body.data.rows)).toBe(true);
  });

  it('the area-wise report has its documented columns and a Grand Total row, even with no leads', async () => {
    const res = await request(app).get('/crm/leads/export-area-leads-report').query({ format: 'json' });
    expect(res.body.data.columns).toEqual(['Area', 'Total Leads', 'Open', 'Converted']);
    expect(res.body.data.rows).toEqual([['Grand Total', 0, 0, 0]]);
  });

  it('CSV download works too', async () => {
    const res = await request(app).get('/crm/leads/export-area-leads-report');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/area-leads-report-\d{4}-\d{2}-\d{2}\.csv/);
  });
});
