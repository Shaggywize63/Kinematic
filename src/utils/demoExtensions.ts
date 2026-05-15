/**
 * Demo middleware for the non-CRM modules.
 *
 * Mounted at /api/v1 in app.ts (right after requireAuth) so when a demo-org
 * user calls any of analytics / route-plan / warehouse / wms / planogram /
 * broadcast / misc / audit-log / distribution / salesman, we return canned
 * fixtures instead of letting the controller query an empty database.
 *
 * The CRM module has its own dedicated demoCrmMiddleware mounted on the
 * CRM router — this middleware deliberately skips /crm/* paths so requests
 * fall through to that.
 *
 * Mutations short-circuit to a success-shaped no-op so the demo user can
 * click around (create deal, save settings, etc.) without 500s. Nothing
 * persists across requests.
 *
 * Pattern mirrors demoCrmMiddleware in this same folder.
 */
import { Request, Response, NextFunction } from 'express';
import {
  isDemo,
  // analytics
  getMockSummary, getMockTrends, getMockFeed, getMockHeatmap,
  getMockLocations, getMockAttendanceToday, getMockOutletCoverage,
  getMockCityPerformance, getMockMobileHome,
  // route plan
  getMockRoutePlans, getMockMyRoutePlan,
  // warehouse / wms
  getMockWarehouses, getMockWMSInventory, getMockWMSSummary,
  getMockMovements,
  // misc
  getMockVisitLogs, getMockGrievances, getMockUsers, getMockZones,
  getMockClients, getMockLearningMaterials,
  getMockBroadcasts as getBaseBroadcasts,
  getMockSecurityAlerts as getBaseAlerts,
  getMockSOS,
  getMockLeaderboard,
  getMockFormTemplates,
} from './demoData';
import * as demoDist from './demoDistribution';

const today = () => new Date().toISOString().slice(0, 10);
// Returning void here (rather than the Response object) means every `return
// ok(res, x)` in the middleware below type-checks against the void return type.
const ok = (res: Response, data: unknown): void => { res.json({ success: true, data }); };
const okWithMessage = (res: Response, data: unknown, message = 'OK'): void => {
  res.json({ success: true, message, data });
};
const paginated = (res: Response, data: unknown[], total = data.length): void => {
  res.json({ success: true, data, pagination: { total, page: 1, page_size: total || 50, total_pages: 1 } });
};

// ── Fixtures unique to this middleware ─────────────────────────────────
// (Things demoData.ts doesn't have yet.)

const DEMO_REPS = ['Arjun Sharma', 'Priya Patel', 'Rahul Verma', 'Sneha Rao', 'Amit Singh', 'Demo Admin'];

const getMockAuditLogs = () => {
  const mk = (offsetMin: number, actor: string, role: string, action: string, entity_table: string, entity_id: string, ip = '203.0.113.42') => ({
    id: 'demo-log-' + Math.random().toString(36).slice(2, 10),
    created_at: new Date(Date.now() - offsetMin * 60_000).toISOString(),
    action,
    entity_table,
    entity_id,
    actor: { id: 'demo-user-' + actor.replace(/\s+/g, '-').toLowerCase(), name: actor, email: actor.toLowerCase().replace(/\s+/g, '.') + '@kinematic.demo', role },
    client: { id: 'demo-client-001', name: 'Horizonn Retail (Demo)' },
    ip_address: ip,
    metadata: { user_agent: 'Mozilla/5.0', request_id: 'req_' + Math.random().toString(36).slice(2, 10) },
    payload: {},
  });
  return [
    mk(3,    'Demo Admin',   'super_admin', 'login',           'auth',           'demo-user-id'),
    mk(12,   'Arjun Sharma', 'executive',   'create',          'crm_deals',      'demo-deal-1', '49.36.182.91'),
    mk(25,   'Priya Patel',  'executive',   'attendance.check_in', 'attendance', 'att-2', '110.227.84.12'),
    mk(48,   'Rahul Verma',  'supervisor',  'update',          'route_plans',    'rp1', '203.0.113.42'),
    mk(95,   'Sneha Rao',    'supervisor',  'create',          'crm_activities', 'demo-act-3'),
    mk(140,  'Demo Admin',   'super_admin', 'role.assign',     'users',          'fe1'),
    mk(190,  'Amit Singh',   'executive',   'broadcast.answer','broadcast_responses', 'b1'),
    mk(255,  'Arjun Sharma', 'executive',   'form.submit',     'form_submissions','s1', '49.36.182.91'),
    mk(310,  'Demo Admin',   'super_admin', 'settings.update', 'org_settings',   'demo-org-999'),
    mk(390,  'Priya Patel',  'executive',   'planogram.capture','planogram_captures', 'demo-pgc-2'),
    mk(450,  'Rahul Verma',  'supervisor',  'sos.resolve',     'sos_alerts',     'sos2'),
    mk(540,  'Demo Admin',   'super_admin', 'login',           'auth',           'demo-user-id'),
  ];
};

const PLANOGRAM_STORES = [
  { id: 'demo-store-blr1', name: 'Reliance Fresh - Koramangala', city: 'Bangalore' },
  { id: 'demo-store-blr2', name: 'Big Bazaar - Indiranagar',     city: 'Bangalore' },
  { id: 'demo-store-mum1', name: 'Big Bazaar - Lower Parel',     city: 'Mumbai' },
  { id: 'demo-store-mum2', name: 'D-Mart - Andheri',             city: 'Mumbai' },
  { id: 'demo-store-del1', name: 'Spencer\'s - CP',              city: 'Delhi' },
];

const PLANOGRAM_SKUS = [
  { id: 'demo-sku-pg-1', name: 'Aurora Hazelnut Spread 350g' },
  { id: 'demo-sku-pg-2', name: 'Aurora Wholewheat Cookies 200g' },
  { id: 'demo-sku-pg-3', name: 'Northwind Cola 500ml' },
  { id: 'demo-sku-pg-4', name: 'Northwind Lemon Fizz 500ml' },
  { id: 'demo-sku-pg-5', name: 'Aurora Premium Coffee 100g' },
];

const getMockPlanograms = () => ([
  {
    id: 'demo-pg-1', name: 'Aurora Confectionery Bay – Q2',
    category: 'Confectionery', store_format: 'Modern Trade',
    client_id: 'demo-client-001', version: 3, is_active: true,
    updated_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  },
  {
    id: 'demo-pg-2', name: 'Northwind Beverages – Aisle End',
    category: 'Beverages', store_format: 'General Trade',
    client_id: 'demo-client-001', version: 1, is_active: true,
    updated_at: new Date(Date.now() - 9 * 86400000).toISOString(),
  },
  {
    id: 'demo-pg-3', name: 'Aurora Cookies Endcap',
    category: 'Bakery', store_format: 'Modern Trade',
    client_id: 'demo-client-001', version: 2, is_active: true,
    updated_at: new Date(Date.now() - 18 * 86400000).toISOString(),
  },
  {
    id: 'demo-pg-4', name: 'Premium Coffee Shelf – Plan A',
    category: 'Beverages', store_format: 'Modern Trade',
    client_id: 'demo-client-001', version: 1, is_active: false,
    updated_at: new Date(Date.now() - 35 * 86400000).toISOString(),
  },
]);

const getMockPlanogramCaptures = () => {
  const mk = (i: number, score: number, store: typeof PLANOGRAM_STORES[number], pg: ReturnType<typeof getMockPlanograms>[number]) => ({
    id: `demo-pgc-${i}`,
    captured_at: new Date(Date.now() - i * 86400000 - Math.random() * 3600000).toISOString(),
    fe: { name: DEMO_REPS[i % DEMO_REPS.length] },
    store,
    planogram: { name: pg.name },
    compliance: { score },
  });
  const pgs = getMockPlanograms();
  return [
    mk(0, 92, PLANOGRAM_STORES[0], pgs[0]),
    mk(1, 78, PLANOGRAM_STORES[1], pgs[1]),
    mk(2, 84, PLANOGRAM_STORES[2], pgs[0]),
    mk(3, 65, PLANOGRAM_STORES[3], pgs[2]),
    mk(4, 88, PLANOGRAM_STORES[4], pgs[1]),
    mk(5, 71, PLANOGRAM_STORES[0], pgs[2]),
    mk(7, 95, PLANOGRAM_STORES[1], pgs[0]),
    mk(9, 58, PLANOGRAM_STORES[2], pgs[2]),
  ];
};

const getMockPlanogramTrend = () => {
  // 30-day compliance % per day, fluctuating around 80%.
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (29 - i));
    return {
      date: d.toISOString().slice(0, 10),
      compliance_pct: Math.round(72 + Math.sin(i / 4) * 8 + (Math.random() * 6 - 3)),
      captures: 8 + Math.floor(Math.random() * 6),
    };
  });
};

const getMockPlanogramStoreRanking = () =>
  PLANOGRAM_STORES.map((s, i) => ({
    store_id: s.id, store_name: s.name, city: s.city,
    compliance_pct: 92 - i * 6,
    captures: 18 - i * 2,
    last_captured_at: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
  }));

const getMockPlanogramChronicGaps = () =>
  PLANOGRAM_SKUS.slice(0, 4).map((sku, i) => ({
    sku_id: sku.id, sku_name: sku.name,
    missing_pct: 38 - i * 6,
    occurrences: 24 - i * 4,
    affected_stores: 12 - i * 2,
  }));

const getMockPlanogramSkuVisibility = () =>
  PLANOGRAM_SKUS.map((sku, i) => ({
    sku_id: sku.id, sku_name: sku.name,
    expected_facings: 3,
    actual_facings_avg: +(2.4 - i * 0.2).toFixed(1),
    visibility_pct: 92 - i * 7,
  }));

const getMockPlanogramRiskForecast = () =>
  PLANOGRAM_STORES.map((s, i) => ({
    store_id: s.id, store_name: s.name,
    risk_level: i === 0 ? 'low' : i < 3 ? 'medium' : 'high',
    risk_score: 28 + i * 14,
    next_visit_recommended: new Date(Date.now() + (i + 1) * 2 * 86400000).toISOString().slice(0, 10),
    drivers: ['Declining facings', 'Recent stockouts'].slice(0, 1 + i % 2),
  }));

// Expanded broadcasts + alerts (demoData has too-thin defaults).
const getMockBroadcastsExpanded = () => {
  const base = getBaseBroadcasts();
  return [
    ...base,
    {
      id: 'b2', question: 'Reminder: submit your June expense reports by Friday.',
      options: [{ label: 'Acknowledged', value: 'ack' }],
      correct_option: null, status: 'active', is_urgent: false,
      target_roles: ['executive', 'supervisor'], target_zone_ids: [], target_cities: [],
      response_count: 98, created_at: new Date(Date.now() - 86400000 * 1).toISOString(),
      tally: [{ label: 'Acknowledged', count: 98, index: 0 }],
      responses: [],
    },
    {
      id: 'b3', question: 'Which new SKU should we prioritize for the festive launch?',
      options: [
        { label: 'Aurora Premium Coffee 100g', value: 'coffee' },
        { label: 'Aurora Hazelnut Spread 350g', value: 'spread' },
        { label: 'Northwind Lemon Fizz 500ml',  value: 'fizz' },
      ],
      correct_option: null, status: 'closed', is_urgent: false,
      target_roles: ['executive', 'supervisor'], target_zone_ids: [], target_cities: ['Mumbai', 'Bangalore'],
      response_count: 132, created_at: new Date(Date.now() - 86400000 * 5).toISOString(),
      tally: [
        { label: 'Aurora Premium Coffee 100g', count: 74, index: 0 },
        { label: 'Aurora Hazelnut Spread 350g', count: 38, index: 1 },
        { label: 'Northwind Lemon Fizz 500ml',  count: 20, index: 2 },
      ],
      responses: [],
    },
    {
      id: 'b4', question: 'Heads up — heavy rain forecast in Mumbai today, leave early if needed.',
      options: [{ label: 'Got it', value: 'ack' }],
      correct_option: null, status: 'active', is_urgent: true,
      target_roles: ['executive', 'supervisor'], target_zone_ids: [], target_cities: ['Mumbai'],
      response_count: 27, created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      tally: [{ label: 'Got it', count: 27, index: 0 }],
      responses: [],
    },
  ];
};

const getMockSecurityAlertsExpanded = () => {
  const td = today();
  const base = getBaseAlerts(td);
  return [
    ...base,
    { id: 'sa3', type: 'GPS_DISABLED',     action: 'ATTENDANCE',       lat: 12.9716, lng: 77.5946,
      created_at: new Date(Date.now() - 90 * 60_000).toISOString(),
      user: { name: 'Rahul Verma', employee_id: 'KIN-003' } },
    { id: 'sa4', type: 'DEVELOPER_OPTIONS', action: 'FORM_SUBMISSION',  lat: 19.0760, lng: 72.8777,
      created_at: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
      user: { name: 'Sneha Rao', employee_id: 'KIN-004' } },
    { id: 'sa5', type: 'JAILBROKEN_DEVICE', action: 'LOGIN',            lat: 28.6139, lng: 77.2090,
      created_at: new Date(Date.now() - 22 * 60 * 60_000).toISOString(),
      user: { name: 'Amit Singh', employee_id: 'KIN-005' } },
    { id: 'sa6', type: 'GEOFENCE_VIOLATION',action: 'CHECK_IN',         lat: 17.3850, lng: 78.4867,
      created_at: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(),
      user: { name: 'Sneha Rao', employee_id: 'KIN-004' } },
  ];
};

// ── Settings shape the dashboard's /settings page expects ──────────────
// (Org preferences, modules, integrations, retention.) Returning a plausible
// payload here keeps the settings page from blowing up on the demo account.
const getMockOrgSettings = () => ({
  id: 'demo-org-999',
  name: 'Horizonn Retail (Demo)',
  contact_email: 'admin@horizonn.demo',
  contact_phone: '+91 99887 66554',
  business_type: 'b2b',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  modules: [
    'analytics', 'live_tracking', 'broadcast', 'attendance',
    'work_activities', 'visit_logs', 'inventory', 'skus', 'assets',
    'grievances', 'form_builder', 'cities', 'reports',
    'distribution_brands', 'distribution_distributors', 'distribution_pricing',
    'distribution_orders', 'distribution_invoicing', 'distribution_payments',
    'distribution_ledger', 'distribution_schemes', 'distribution_returns',
    'crm',
  ],
  features: {
    geofence_radius_m: 100,
    selfie_required: true,
    auto_logout_minutes: 30,
    mock_location_detection: true,
    vpn_detection: true,
  },
  branding: { primary_color: '#0F3D6E', logo_url: null },
  retention: { audit_log_days: 365, submissions_days: 730 },
  updated_at: new Date().toISOString(),
});

// ── Path matchers ──────────────────────────────────────────────────────

const DEMO_MODULE_PREFIXES = [
  '/analytics', '/route-plan', '/route-plans', '/warehouse', '/warehouses',
  '/planograms', '/broadcast', '/misc', '/audit-log', '/distribution',
  '/salesman', '/management', '/clients', '/cities', '/zones', '/stores',
  '/skus', '/users', '/learning', '/visits', '/sos', '/grievances',
  '/leaderboard', '/notifications', '/forms', '/builder', '/stock',
  '/activities', '/activity-mappings', '/assets',
];

const startsWithModule = (path: string) =>
  DEMO_MODULE_PREFIXES.some(m => path === m || path.startsWith(m + '/'));

// ── Main middleware ────────────────────────────────────────────────────

export function demoExtensionsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: { org_id?: string; role?: string } }).user;
  // If requireAuth hasn't populated req.user yet (we're mounted before some
  // route auth chains too) just defer — the per-route requireAuth will run
  // and the actual handler will deal with it. We do NOT serve demo data for
  // unauthenticated requests.
  if (!user) return next();
  if (!isDemo(user)) return next();

  const method = req.method;
  // req.path is relative to the mount point. To make our path-matching
  // work no matter where the middleware is mounted (at /api/v1, at
  // /api/v1/analytics, etc.) we recompute the path relative to /api/v1
  // using req.originalUrl.
  const fullPath = (req.originalUrl || '').split('?')[0];
  const path = fullPath.replace(/^\/api\/v1/, '') || '/';
  const td = today();

  // CRM has its own demoCrmMiddleware mounted on the CRM router — let it
  // handle anything under /crm so we don't double-intercept.
  if (path === '/crm' || path.startsWith('/crm/')) return next();

  if (method === 'GET') {
    // ── Analytics ────────────────────────────────────────────────
    if (path === '/analytics/summary')          return ok(res, getMockSummary(td));
    if (path === '/analytics/tff-trends')       return ok(res, getMockTrends());
    if (path === '/analytics/activity-feed')    return ok(res, getMockFeed());
    if (path === '/analytics/contact-heatmap')  return ok(res, getMockHeatmap());
    if (path === '/analytics/hourly')           return ok(res, getMockHeatmap());
    if (path === '/analytics/weekly-contacts')  return ok(res, getMockHeatmap());
    if (path === '/analytics/live-locations')   return ok(res, getMockLocations(td));
    if (path === '/analytics/attendance-today') return ok(res, getMockAttendanceToday(td));
    if (path === '/analytics/outlet-coverage')  return ok(res, getMockOutletCoverage());
    if (path === '/analytics/city-performance') return ok(res, getMockCityPerformance());
    if (path === '/analytics/mobile-home')      return ok(res, getMockMobileHome());
    if (path === '/analytics/dashboard-init') return ok(res, {
      summary: getMockSummary(td),
      trends: getMockTrends(),
      heatmap: getMockHeatmap(),
      feed: getMockFeed(),
      locations: getMockLocations(td),
      attendance: getMockAttendanceToday(td),
      outlet_coverage: getMockOutletCoverage(),
    });
    if (path === '/analytics/broadcasts')       return ok(res, getMockBroadcastsExpanded());
    if (path === '/analytics/learning')         return ok(res, getMockLearningMaterials());

    // ── Route plan (singular and plural alias) ─────────────────
    if (path === '/route-plan' || path === '/route-plans')             return ok(res, getMockRoutePlans(td));
    if (path === '/route-plan/summary' || path === '/route-plans/summary') return ok(res, {
      total_fes: 5, plans_today: 5, completion_avg: 65,
      total_outlets: 25, visited_outlets: 16, missed_outlets: 0, pending_outlets: 9,
    });
    if (path === '/route-plan/me' || path === '/route-plans/me'
        || path === '/route-plan/my-plan' || path === '/route-plans/my-plan') return ok(res, getMockMyRoutePlan(td));
    if (path === '/route-plan/imports' || path === '/route-plans/imports') return ok(res, []);
    if (path === '/route-plan/outlet-frequency' || path === '/route-plans/outlet-frequency') return ok(res, []);

    // ── Warehouse + WMS ─────────────────────────────────────────
    if (path === '/warehouse/summary')          return ok(res, getMockWMSSummary());
    if (path === '/warehouse/inventory')        return ok(res, getMockWMSInventory());
    if (path === '/warehouses' || path === '/warehouses/') return ok(res, getMockWarehouses());
    if (path === '/warehouses/summary')         return ok(res, getMockWMSSummary());
    if (/^\/warehouses\/[^/]+\/movements$/.test(path)) return ok(res, getMockMovements());
    if (/^\/warehouses\/[^/]+$/.test(path)) {
      const m = path.match(/^\/warehouses\/([^/]+)$/);
      const w = getMockWarehouses().find(x => x.id === m![1]) ?? getMockWarehouses()[0];
      return ok(res, w);
    }

    // ── Planograms ──────────────────────────────────────────────
    if (path === '/planograms' || path === '/planograms/') return ok(res, getMockPlanograms());
    if (path === '/planograms/captures')               return ok(res, getMockPlanogramCaptures());
    if (path === '/planograms/analytics/trend')        return ok(res, getMockPlanogramTrend());
    if (path === '/planograms/analytics/store-ranking')return ok(res, getMockPlanogramStoreRanking());
    if (path === '/planograms/analytics/chronic-gaps') return ok(res, getMockPlanogramChronicGaps());
    if (path === '/planograms/analytics/sku-visibility')return ok(res, getMockPlanogramSkuVisibility());
    if (path === '/planograms/analytics/risk-forecast') return ok(res, getMockPlanogramRiskForecast());
    if (/^\/planograms\/[0-9a-fA-F-]{36}$/.test(path) || /^\/planograms\/demo-pg-\d+$/.test(path)) {
      const m = path.match(/^\/planograms\/([^/]+)$/);
      const pg = getMockPlanograms().find(p => p.id === m![1]) ?? getMockPlanograms()[0];
      return ok(res, pg);
    }
    if (/^\/planograms\/[^/]+\/assignments$/.test(path)) return ok(res, []);
    if (/^\/planograms\/captures\/[^/]+$/.test(path)) {
      const m = path.match(/^\/planograms\/captures\/([^/]+)$/);
      const cap = getMockPlanogramCaptures().find(c => c.id === m![1]) ?? getMockPlanogramCaptures()[0];
      return ok(res, { capture: cap, recognition: null, compliance: { score: cap.compliance?.score ?? 80 } });
    }

    // ── Broadcasts ───────────────────────────────────────────────
    if (path === '/broadcast' || path === '/broadcast/')     return ok(res, getMockBroadcastsExpanded());
    if (path === '/broadcast/admin')                          return ok(res, getMockBroadcastsExpanded());
    if (/^\/broadcast\/[^/]+\/results$/.test(path)) {
      const m = path.match(/^\/broadcast\/([^/]+)\/results$/);
      const b = getMockBroadcastsExpanded().find(x => x.id === m![1]) ?? getMockBroadcastsExpanded()[0];
      return ok(res, b);
    }

    // ── Audit log ────────────────────────────────────────────────
    if (path === '/audit-log' || path === '/audit-log/') {
      return ok(res, { rows: getMockAuditLogs(), limit: 100, offset: 0, has_more: false });
    }

    // ── Misc (security alerts, visits, etc.) ────────────────────
    if (path === '/misc/security/alerts/all') {
      return paginated(res, getMockSecurityAlertsExpanded());
    }
    if (path === '/misc/visits')             return okWithMessage(res, getMockVisitLogs(td));
    if (path === '/misc/dashboard-summary')  return okWithMessage(res, getMockSummary(td));
    if (path === '/misc/activity-feed')      return okWithMessage(res, getMockFeed());
    if (path === '/misc/users')              return ok(res, getMockUsers());
    if (path === '/misc/zones')              return ok(res, getMockZones());
    if (path === '/misc/clients')            return ok(res, getMockClients());
    if (path === '/misc/learning')           return ok(res, getMockLearningMaterials());
    if (path === '/misc/grievances' || path === '/misc/grievances/all') return ok(res, getMockGrievances());
    if (path === '/misc/quote/daily')        return ok(res, { quote: 'Small steps every day add up to remarkable results.', author: 'Anonymous' });
    if (/^\/misc\/users\/[^/]+$/.test(path)) {
      const m = path.match(/^\/misc\/users\/([^/]+)$/);
      const u = getMockUsers().find(x => x.id === m![1]) ?? getMockUsers()[0];
      return ok(res, u);
    }

    // ── Distribution module ─────────────────────────────────────
    if (path === '/distribution/brands')         return ok(res, demoDist.getDemoBrands());
    if (path === '/distribution/distributors')   return ok(res, demoDist.getDemoDistributors());
    if (path === '/distribution/price-lists')    return ok(res, demoDist.getDemoPriceLists());
    if (path === '/distribution/schemes')        return ok(res, demoDist.getDemoSchemes());
    if (path === '/distribution/orders')         return ok(res, demoDist.getDemoOrderList());
    if (/^\/distribution\/orders\/[^/]+$/.test(path)) return ok(res, demoDist.getDemoOrder());
    if (path === '/distribution/invoices')       return ok(res, [demoDist.getDemoInvoice()]);
    if (/^\/distribution\/invoices\/[^/]+$/.test(path)) return ok(res, demoDist.getDemoInvoice());
    if (path === '/distribution/payments')       return ok(res, demoDist.getDemoPayments());
    if (path === '/distribution/returns')        return ok(res, demoDist.getDemoReturns());
    if (path === '/distribution/secondary-sales')return ok(res, []);
    if (path === '/distribution/dispatches')     return ok(res, []);
    if (path === '/distribution/deliveries')     return ok(res, []);
    if (path === '/distribution/ledger/ageing/summary') return ok(res, demoDist.getDemoAgeingSummary());
    if (/^\/distribution\/ledger\/[^/]+$/.test(path)) return ok(res, demoDist.getDemoLedger());

    // ── Salesman (mobile/orders for the demo route flow) ────────
    if (path === '/salesman/route/today')        return ok(res, demoDist.getDemoRouteToday());
    if (/^\/salesman\/cart\/[^/]+\/suggest$/.test(path)) return ok(res, demoDist.getDemoCartSuggest());

    // ── Management / settings-page side data ────────────────────
    // Settings page reads modules + clients to populate its tabs; without
    // these the page renders blank or crashes in some builds.
    if (path === '/management' || path === '/management/')     return ok(res, getMockOrgSettings());
    if (path === '/management/settings')                       return ok(res, getMockOrgSettings());
    if (path === '/management/preferences')                    return ok(res, getMockOrgSettings().features);
    if (path === '/clients' || path === '/clients/')           return ok(res, getMockClients());
    if (/^\/clients\/[^/]+$/.test(path)) {
      const m = path.match(/^\/clients\/([^/]+)$/);
      const c = getMockClients().find(x => x.id === m![1]) ?? getMockClients()[0];
      return ok(res, c);
    }

    // ── Common lookups the settings/management pages also need ──
    if (path === '/cities' || path === '/cities/')             return ok(res, []);
    if (path === '/zones'  || path === '/zones/')              return ok(res, getMockZones());
    if (path === '/users'  || path === '/users/')              return ok(res, getMockUsers());
    if (path === '/stores' || path === '/stores/')             return ok(res, []);
    if (path === '/skus'   || path === '/skus/')               return ok(res, []);
    if (path === '/assets' || path === '/assets/')             return ok(res, []);
    if (path === '/activities' || path === '/activities/')     return ok(res, []);
    if (path === '/activity-mappings' || path === '/activity-mappings/') return ok(res, []);
    if (path === '/forms' || path === '/forms/')               return ok(res, getMockFormTemplates());
    if (path === '/builder' || path === '/builder/')           return ok(res, getMockFormTemplates());
    if (path === '/learning' || path === '/learning/')         return ok(res, getMockLearningMaterials());
    if (path === '/leaderboard' || path === '/leaderboard/')   return ok(res, getMockLeaderboard());
    if (path === '/notifications' || path === '/notifications/') return ok(res, []);
    if (path === '/sos' || path === '/sos/')                   return ok(res, getMockSOS());
    if (path === '/grievances' || path === '/grievances/')     return ok(res, getMockGrievances());
    if (path === '/visits' || path === '/visits/')             return okWithMessage(res, getMockVisitLogs(td));
    if (path === '/stock' || path === '/stock/')               return ok(res, getMockWMSInventory());
  }

  // ── Mutations: pretend-success no-op ───────────────────────────────
  // Limited to the same module set we intercept GETs for, so we don't
  // accidentally short-circuit auth/login or other repos that the demo
  // user might legitimately need to call.
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    if (!startsWithModule(path)) return next();
    if (method === 'DELETE') { res.status(204).end(); return; }
    res.status(method === 'POST' ? 201 : 200).json({
      success: true,
      data: { id: 'demo-noop-' + Math.random().toString(36).slice(2, 8), ok: true },
      demo: true,
    });
    return;
  }

  return next();
}

export default demoExtensionsMiddleware;
