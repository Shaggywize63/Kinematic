import { demoExtensionsMiddleware } from '../src/utils/demoExtensions';
import { DEMO_ORG_ID } from '../src/utils/demoData';

function run(method: string, url: string, org = DEMO_ORG_ID) {
  const req: any = { method, originalUrl: `/api/v1${url}`, user: { org_id: org, role: 'super_admin' } };
  const out: { status?: number; body?: any; passed: boolean } = { passed: false };
  const res: any = {
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
    end() { return res; },
  };
  demoExtensionsMiddleware(req, res, () => { out.passed = true; });
  return out;
}

describe('demo principal fence', () => {
  it.each([
    ['GET', '/environments'], ['POST', '/environments/promote'], ['GET', '/admin/anything'], ['POST', '/admin/mcp-connector'],
    ['GET', '/candidates'], ['PATCH', '/candidates/abc'], ['PATCH', '/roles/abc'], ['POST', '/roles'],
  ])('%s %s never reaches the handler', (method, url) => {
    const r = run(method, url);
    expect(r.passed).toBe(false);
  });

  it('reads of /roles still reach the handler', () => {
    expect(run('GET', '/roles').passed).toBe(true);
  });

  it('a real org is never fenced', () => {
    expect(run('GET', '/environments', 'a0000000-0000-4000-8000-000000000001').passed).toBe(true);
    expect(run('GET', '/candidates', 'a0000000-0000-4000-8000-000000000001').passed).toBe(true);
  });

  it('existing canned demo reads keep working', () => {
    const r = run('GET', '/analytics/summary');
    expect(r.passed).toBe(false);
    expect(r.body.success).toBe(true);
  });
});
