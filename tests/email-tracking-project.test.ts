/**
 * Public email-tracking hits (open pixel / click / unsubscribe) carry no auth
 * and no X-Kinematic-Project header. They must be routed to the project that
 * actually holds the message's crm_email_logs row — otherwise a Kinematic-tenant
 * open is looked up in the default (Tata) DB, not found, and silently dropped
 * ("Opened 0" in the campaign report).
 */
process.env.KINEMATIC_SUPABASE_URL = 'http://kinematic.test';
process.env.KINEMATIC_SUPABASE_ANON_KEY = 'k-anon';
process.env.KINEMATIC_SUPABASE_SERVICE_ROLE_KEY = 'k-service';

const probes: string[] = [];
// token -> project url that "owns" it
const owners: Record<string, string> = {};

jest.mock('@supabase/supabase-js', () => ({
  createClient: (url: string) => ({
    from: () => {
      const q: any = {
        select: () => q,
        eq: (_col: string, val: string) => { q.token = val; return q; },
        limit: () => q,
        abortSignal: () => q,
        maybeSingle: async () => {
          probes.push(url);
          return { data: owners[q.token] === url ? { id: 'row-1' } : null, error: null };
        },
      };
      return q;
    },
  }),
}));

import {
  resolveProjectForEmailTrackingTokenAsync,
  currentProjectKey,
} from '../src/lib/projects';
import { withEmailTrackingProject, withEmailUnsubscribeProject } from '../src/middleware/withProject';

beforeEach(() => { probes.length = 0; });

describe('resolveProjectForEmailTrackingTokenAsync', () => {
  it('finds a Kinematic-tenant token in the kinematic project', async () => {
    owners['tok-kin'] = 'http://kinematic.test';
    expect(await resolveProjectForEmailTrackingTokenAsync('tok-kin')).toBe('kinematic');
  });

  it('finds a Tata (default) token in the default project', async () => {
    owners['tok-tata'] = process.env.SUPABASE_URL as string;
    expect(await resolveProjectForEmailTrackingTokenAsync('tok-tata')).toBe('default');
  });

  it('falls back to the default project for an unknown token', async () => {
    expect(await resolveProjectForEmailTrackingTokenAsync('nope')).toBe('default');
  });

  it('serves repeat hits from the cache without re-probing', async () => {
    owners['tok-cache'] = 'http://kinematic.test';
    await resolveProjectForEmailTrackingTokenAsync('tok-cache');
    const n = probes.length;
    expect(await resolveProjectForEmailTrackingTokenAsync('tok-cache')).toBe('kinematic');
    expect(probes.length).toBe(n);
  });

  it('does no DB work for an empty token', async () => {
    expect(await resolveProjectForEmailTrackingTokenAsync('')).toBe('default');
    expect(probes.length).toBe(0);
  });
});

describe('tracking middleware', () => {
  it('runs the open/click handler inside the owning project (path token)', async () => {
    owners['tok-mw'] = 'http://kinematic.test';
    let seen = '';
    await withEmailTrackingProject({ params: { token: 'tok-mw' } } as any, {} as any, () => { seen = currentProjectKey(); });
    expect(seen).toBe('kinematic');
  });

  it('runs the unsubscribe handler inside the owning project (?t= token)', async () => {
    owners['tok-unsub'] = 'http://kinematic.test';
    let seen = '';
    await withEmailUnsubscribeProject({ query: { t: 'tok-unsub' } } as any, {} as any, () => { seen = currentProjectKey(); });
    expect(seen).toBe('kinematic');
  });
});
