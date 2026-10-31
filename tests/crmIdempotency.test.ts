/**
 * Offline hardening — CRM write replay protection.
 *
 * The mobile apps queue CRM creates while offline and replay them when the
 * network returns, attaching an Idempotency-Key per queued mutation (Android
 * CrmRepository: `lead-<uuid>`; iOS passes `idempotencyKey` through its request
 * layer). Without server-side dedup a flaky-ack retry inserts a DUPLICATE lead
 * / activity. The `idempotency` middleware already guards attendance and every
 * distribution write; this proves (a) its contract, and (b) that it is now
 * wired onto the CRM create routes the offline queue actually replays.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

// Jest hoists this factory above the imports; only names prefixed with `mock`
// may be referenced from inside it. One mock serves both the middleware unit
// tests and importing the CRM router (which transitively loads supabase).
const mockSb = createSupabaseMock();
jest.mock('../src/lib/supabase', () => ({
  supabaseAdmin: mockSb.client,
  supabase: mockSb.client,
  getUserClient: () => mockSb.client,
}));

import { idempotency } from '../src/middleware/idempotency';
import crmRouter from '../src/routes/crm.routes';

const KEYS = 'idempotency_keys';
const USER = { id: 'user-1', org_id: 'org-1' };

function fakeReq(over: Record<string, unknown> = {}): any {
  return { method: 'POST', originalUrl: '/api/v1/crm/leads', headers: {}, body: { first_name: 'Asha' }, user: { ...USER }, ...over };
}
function fakeRes(): any {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}
const tick = () => new Promise<void>((r) => setImmediate(r));
const insertsFor = (table: string) =>
  mockSb.chainsFor(table).map((c) => c.ops.find((o) => o.method === 'insert')).filter(Boolean) as Array<{ args: unknown[] }>;

beforeEach(() => mockSb.reset());

describe('idempotency middleware — contract', () => {
  it('no Idempotency-Key → proceeds, never touches the keys table', async () => {
    const req = fakeReq({ headers: {} });
    const next = jest.fn();
    await idempotency(req, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockSb.chainsFor(KEYS)).toHaveLength(0);
  });

  it('new key → proceeds, then persists the response (status < 500)', async () => {
    mockSb.setDefault(KEYS, { data: [] }); // no existing row
    const res = fakeRes();
    const next = jest.fn();
    await idempotency(fakeReq({ headers: { 'idempotency-key': 'k-new' } }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    res.status(201).json({ success: true, data: { id: 'lead-1' } }); // controller responds
    await tick(); // let the fire-and-forget persist settle
    const row = insertsFor(KEYS)[0]?.args[0] as Record<string, unknown>;
    expect(row).toMatchObject({ key: 'k-new', user_id: USER.id, response_status: 201 });
  });

  it('a 5xx response is NOT persisted, so the failed write can be retried', async () => {
    mockSb.setDefault(KEYS, { data: [] });
    const res = fakeRes();
    await idempotency(fakeReq({ headers: { 'idempotency-key': 'k-500' } }), res, jest.fn());
    res.status(500).json({ success: false, error: 'boom' });
    await tick();
    expect(insertsFor(KEYS)).toHaveLength(0);
  });

  it('replay (same key + same body) → returns the cached response, handler never runs', async () => {
    // Phase 1: capture exactly what the first request persists.
    mockSb.setDefault(KEYS, { data: [] });
    const res1 = fakeRes();
    await idempotency(fakeReq({ headers: { 'idempotency-key': 'k-replay' } }), res1, jest.fn());
    res1.status(201).json({ success: true, data: { id: 'lead-1' } });
    await tick();
    const stored = insertsFor(KEYS)[0].args[0] as Record<string, unknown>;

    // Phase 2: an identical retry now finds that row.
    mockSb.reset();
    mockSb.setDefault(KEYS, { data: [stored] });
    const res2 = fakeRes();
    const next2 = jest.fn();
    await idempotency(fakeReq({ headers: { 'idempotency-key': 'k-replay' } }), res2, next2);
    expect(next2).not.toHaveBeenCalled(); // handler short-circuited
    expect(res2.statusCode).toBe(201);
    expect(res2.body).toEqual(stored.response_body);
  });

  it('same key + DIFFERENT body → 409 (never silently overwrites)', async () => {
    mockSb.setDefault(KEYS, { data: [{ key: 'k-x', user_id: USER.id, request_hash: 'a-stale-hash', response_status: 201, response_body: {}, expires_at: null }] });
    const res = fakeRes();
    const next = jest.fn();
    await idempotency(fakeReq({ headers: { 'idempotency-key': 'k-x' }, body: { first_name: 'Changed' } }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(String((res.body as { error: string }).error)).toMatch(/different request body/i);
  });

  it('key owned by a different user → 409', async () => {
    mockSb.setDefault(KEYS, { data: [{ key: 'k-u', user_id: 'someone-else', request_hash: 'x', response_status: 201, response_body: {}, expires_at: null }] });
    const res = fakeRes();
    const next = jest.fn();
    await idempotency(fakeReq({ headers: { 'idempotency-key': 'k-u' } }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(String((res.body as { error: string }).error)).toMatch(/different user/i);
  });

  it('expired key → purged and the request proceeds as fresh', async () => {
    mockSb.setDefault(KEYS, { data: [{ key: 'k-exp', user_id: USER.id, request_hash: 'x', response_status: 201, response_body: {}, expires_at: '2000-01-01T00:00:00.000Z' }] });
    const next = jest.fn();
    await idempotency(fakeReq({ headers: { 'idempotency-key': 'k-exp' } }), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockSb.chainsFor(KEYS).some((c) => c.ops.some((o) => o.method === 'delete'))).toBe(true);
  });
});

describe('idempotency middleware — wired onto the CRM create routes', () => {
  type Hit = { mount: string; method: string; path: string; handlers: string[] };

  // Reconstruct the mount segment from an Express layer's regexp, e.g. the
  // regexp for `.use('/leads', …)` → "leads".
  const seg = (re: RegExp): string => {
    const m = /^\^\\\/([A-Za-z0-9_]+)/.exec(re.source);
    return m ? m[1] : '';
  };

  const collect = (stack: any[], prefix: string, out: Hit[]): void => {
    for (const layer of stack) {
      if (layer.route) {
        const handlers = (layer.route.stack || []).map((l: any) => (l.handle && l.handle.name) || '');
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) out.push({ mount: prefix, method, path: layer.route.path, handlers });
        }
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        collect(layer.handle.stack, prefix + '/' + seg(layer.regexp), out);
      }
    }
  };

  const hits: Hit[] = [];
  collect((crmRouter as any).stack, '', hits);

  const CREATE_ENTITIES = ['leads', 'contacts', 'accounts', 'deals', 'activities', 'notes', 'tasks'];

  it.each(CREATE_ENTITIES)('POST /%s runs the idempotency middleware', (entity) => {
    const hit = hits.find((h) => h.mount.endsWith('/' + entity) && h.method === 'post' && h.path === '/');
    expect(hit).toBeTruthy();
    expect(hit!.handlers).toContain('idempotency');
  });

  it('every CRM create route that carries idempotency is a POST "/" (sanity on the walker)', () => {
    const carrying = hits.filter((h) => h.handlers.includes('idempotency'));
    expect(carrying.length).toBeGreaterThanOrEqual(CREATE_ENTITIES.length);
    for (const h of carrying) { expect(h.method).toBe('post'); expect(h.path).toBe('/'); }
  });
});
