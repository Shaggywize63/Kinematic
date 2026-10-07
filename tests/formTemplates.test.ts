/**
 * GET /forms/templates is what the mobile apps use to list the forms a rep can fill in.
 * iOS sends ?is_active=true (published only); Android sends no filter at all, so it used to be
 * offered every form — including ones an admin had archived. An archived (retired) form must
 * not be offered unless a caller asks for non-published forms explicitly.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import { getTemplates } from '../src/controllers/forms.controller';

const USER = { id: '33333333-3333-3333-3333-333333333333', org_id: '00000000-0000-0000-0000-0000000000aa', role: 'field_executive' };

async function listTemplates(query: Record<string, string>) {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await (getTemplates as any)({ user: USER, query }, res, jest.fn());
  return res;
}

const statusFilters = () =>
  __mock.chainsFor('builder_forms')[0].ops
    .filter((o) => (o.method === 'eq' || o.method === 'neq') && o.args[0] === 'status')
    .map((o) => `${o.method}:${o.args[1]}`);

beforeEach(() => {
  __mock.reset();
  __mock.setDefault('builder_forms', { data: [] });
});

describe('GET /forms/templates', () => {
  it('leaves archived forms out when no is_active filter is sent (the Android app)', async () => {
    await listTemplates({});
    expect(statusFilters()).toEqual(['neq:archived']);
  });

  it('is_active=true still means published only (the iOS app)', async () => {
    await listTemplates({ is_active: 'true' });
    expect(statusFilters()).toEqual(['eq:published']);
  });

  it('is_active=false still returns the non-published forms, archived included, when asked for', async () => {
    await listTemplates({ is_active: 'false' });
    expect(statusFilters()).toEqual(['neq:published']);
  });
});
