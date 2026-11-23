/**
 * GET /users?scope=assignable: a field executive or the client admin (role `client`) of ANY client gets a MINIMAL
 * list of their own client's active users (the picker), never the full directory. A caller with no client/org
 * pinning and no directory role still needs one of admin/super_admin/supervisor/hr.
 */
const calls: Array<[string, unknown[]]> = [];
const result = { data: [{ id: 'u1', name: 'Asha', email: 'a@x.in', role: 'executive' }], error: null as null | { message: string } };
jest.mock('../src/lib/supabase', () => {
  const chain: any = {};
  for (const m of ['select', 'eq', 'is', 'order']) chain[m] = jest.fn((...a: unknown[]) => { calls.push([m, a]); return chain; });
  chain.limit = jest.fn((...a: unknown[]) => { calls.push(['limit', a]); return Promise.resolve(result); });
  return { supabaseAdmin: { from: jest.fn(() => chain) } };
});
jest.mock('../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { getUsers } from '../src/controllers/misc.controller';
import { SPARK_CLIENT_ID } from '../src/lib/b2bClients';

const ORG = '7c022ef5-f07d-449d-8970-7067a0b8d4e4';
const OTHER_CLIENT_ID = '99999999-9999-4999-8999-999999999999'; // e.g. Mr. Water — not a connected-B2B client
function run(user: Record<string, unknown>, query: Record<string, unknown>) {
  const req: any = { user, query, headers: {} };
  const res: any = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  return new Promise<{ res: any; err?: any }>((resolve) => {
    (getUsers as any)(req, res, (err: any) => resolve({ res, err }));
    // asyncHandler resolves after the response is written
    setTimeout(() => resolve({ res }), 50);
  });
}

beforeEach(() => { calls.length = 0; });

describe('assignable users picker', () => {
  it('gives a Spark executive a minimal list of their own client only', async () => {
    const { res } = await run({ id: 'x', role: 'executive', org_id: ORG, client_id: SPARK_CLIENT_ID }, { scope: 'assignable' });
    expect(res.statusCode).toBe(200);
    const sel = calls.find(([m]) => m === 'select');
    expect(sel![1][0]).toBe('id, name, email, role');           // no '*', no permissions / attendance
    expect(calls).toEqual(expect.arrayContaining([['eq', ['org_id', ORG]], ['eq', ['client_id', SPARK_CLIENT_ID]], ['eq', ['is_active', true]]]));
  });
  it('gives the Spark client admin the same minimal list', async () => {
    const { res } = await run({ id: 'x', role: 'client', org_id: ORG, client_id: SPARK_CLIENT_ID }, { scope: 'assignable' });
    expect(res.statusCode).toBe(200);
  });
  it('gives a non-B2B client admin (e.g. Mr. Water) the same minimal list of their own client', async () => {
    const { res } = await run({ id: 'x', role: 'client', org_id: ORG, client_id: OTHER_CLIENT_ID }, { scope: 'assignable' });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(expect.arrayContaining([['eq', ['org_id', ORG]], ['eq', ['client_id', OTHER_CLIENT_ID]], ['eq', ['is_active', true]]]));
  });
  it('gives a non-B2B client executive the same minimal list of their own client', async () => {
    const { res } = await run({ id: 'x', role: 'executive', org_id: ORG, client_id: OTHER_CLIENT_ID }, { scope: 'assignable' });
    expect(res.statusCode).toBe(200);
  });
  it('refuses the picker to a non-directory caller with no client/org pinning', async () => {
    const { err } = await run({ id: 'x', role: 'executive', org_id: null, client_id: null }, { scope: 'assignable' });
    expect(err?.statusCode ?? err?.status).toBe(403);
  });
});
